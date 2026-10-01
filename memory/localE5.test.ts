import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalE5SemanticCandidateSource, LOCAL_E5_FILES } from './localE5';
import type { MemoryRecord } from './model';

// Controlled adapter failure tests. Real model/real checksums are exercised by
// localE5.integration.test; these fixture files stand in for large model bytes.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, createHash: (algorithm: string) => {
    const bytes: Buffer[] = [];
    const hash = {
      update(value: string | Buffer) { bytes.push(Buffer.from(value)); return hash; },
      digest(encoding: 'hex') {
        const data = Buffer.concat(bytes);
        return data.toString().startsWith('fixture-sha:') ? data.toString().slice(12) : actual.createHash(algorithm).update(data).digest(encoding);
      },
    };
    return hash;
  } };
});

const fixtureGlobal = globalThis as unknown as { __memorySourceFixture?: { load: () => Promise<unknown> } };
const record = (id: string, content = 'document body'): MemoryRecord => ({
  id, title: `Title ${id}`, content, scope: 'memory', tags: [], evidence: '', status: 'current',
  createdAt: '2026-09-01', updatedAt: '2026-09-01',
});
let dir: string;
let runtimePath: string;
let modelPath: string;
let extractor: ReturnType<typeof makeExtractor>;
function makeExtractor() {
  const encode = Object.assign(vi.fn(async (_text: string) => ({ data: Float32Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) })), {
    tokenizer: Object.assign(async (text: string) => ({ input_ids: text.split(/\s+/).map((_, i) => i) }), {
      decode: (ids: number[]) => ids.map(() => 'token').join(' '),
    }),
    dispose: vi.fn(async () => undefined),
  });
  return encode;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-e5-source-'));
  runtimePath = path.join(dir, 'runtime'); modelPath = path.join(dir, 'model');
  fs.mkdirSync(path.join(runtimePath, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(runtimePath, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version: '4.3.0', type: 'module' }));
  fs.writeFileSync(path.join(runtimePath, 'dist', 'transformers.node.mjs'), 'export async function pipeline() { return globalThis.__memorySourceFixture.load(); }');
  for (const [file, hash] of Object.entries(LOCAL_E5_FILES)) fs.writeFileSync(path.join(modelPath, file), `fixture-sha:${hash}`);
  extractor = makeExtractor();
  fixtureGlobal.__memorySourceFixture = { load: async () => extractor };
});
afterEach(() => {
  delete fixtureGlobal.__memorySourceFixture;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local E5 source ownership and derived cache', () => {
  it('retains a newly loaded handle when cancellation cleanup fails, until explicit disposal succeeds', async () => {
    const controller = new AbortController();
    const source = new LocalE5SemanticCandidateSource({ runtimePath, modelPath });
    fixtureGlobal.__memorySourceFixture!.load = async () => { controller.abort(new Error('cancel after load')); return extractor; };
    extractor.dispose.mockRejectedValueOnce(new Error('native release rejected'));
    await expect(source.prepare(controller.signal)).rejects.toThrow('native release rejected');
    expect(extractor.dispose).toHaveBeenCalledOnce();
    await expect(source.query({ query: 'target', records: [record('a')] })).rejects.toThrow('not prepared');
    await source.dispose();
    expect(extractor.dispose).toHaveBeenCalledTimes(2);
  });

  it('retains the handle if component-change cleanup rejects after loading', async () => {
    const source = new LocalE5SemanticCandidateSource({ runtimePath, modelPath });
    fixtureGlobal.__memorySourceFixture!.load = async () => {
      fs.appendFileSync(path.join(modelPath, 'config.json'), 'changed while loading');
      return extractor;
    };
    extractor.dispose.mockRejectedValueOnce(new Error('release failed'));
    await expect(source.prepare()).rejects.toThrow('release failed');
    await source.dispose();
    expect(extractor.dispose).toHaveBeenCalledTimes(2);
  });

  it('reuses unchanged vectors, re-encodes only changed content, drops deleted records, and releases once', async () => {
    const source = new LocalE5SemanticCandidateSource({ runtimePath, modelPath });
    await source.prepare();
    const records = [record('a', 'long '.repeat(950)), record('b')];
    await source.query({ query: 'target', records });
    const cold = extractor.mock.calls.length;
    expect(cold).toBe(5); // query + three chunks for a + one for b
    await source.query({ query: 'target', records: records.map((r) => ({ ...r, readCount: 999 })) });
    expect(extractor.mock.calls.length - cold).toBe(1);
    const scopedBefore = extractor.mock.calls.length;
    await source.query({ query: 'target', records: [records[1]], liveRecordIds: ['a', 'b'] });
    await source.query({ query: 'target', records, liveRecordIds: ['a', 'b'] });
    expect(extractor.mock.calls.length - scopedBefore).toBe(2); // query only across full -> scope -> full
    const before = extractor.mock.calls.length;
    await source.query({ query: 'target', records: [records[0], { ...records[1], content: 'changed body' }] });
    expect(extractor.mock.calls.length - before).toBe(2);
    expect((await source.query({ query: 'target', records: [records[1]] })).map((m) => m.id)).toEqual(['b']);
    const cache = (source as unknown as { vectors: Map<string, unknown> }).vectors;
    expect([...cache.keys()]).toEqual(['b']);
    await source.dispose(); await source.dispose();
    expect(extractor.dispose).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it('rejects corrupt or missing components without importing a runtime', async () => {
    const load = vi.fn(async () => extractor);
    fixtureGlobal.__memorySourceFixture!.load = load;
    fs.writeFileSync(path.join(modelPath, 'config.json'), 'corrupt');
    await expect(new LocalE5SemanticCandidateSource({ runtimePath, modelPath }).prepare()).rejects.toThrow('checksum mismatch');
    fs.unlinkSync(path.join(modelPath, 'config.json'));
    await expect(new LocalE5SemanticCandidateSource({ runtimePath, modelPath }).prepare()).rejects.toThrow('ENOENT');
    expect(load).not.toHaveBeenCalled();
  });
});
