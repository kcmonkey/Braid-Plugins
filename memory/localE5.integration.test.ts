import { expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { LocalE5SemanticCandidateSource } from './localE5';
import { memoryHostServicePlugin } from './service';
import { normalizeMemoryStore, type MemoryRecord, type MemorySemanticConfig } from './model';
import { readCanonicalMemorySnapshot, writeArtifactMemoryStore } from './storage';
import type { HostServiceContext, AgentToolPlugin } from '../../../src/plugin-api/types';

// Opt-in: no test downloads, package installs, or product paths to experiment files.
const runtimePath = process.env.BRAID_MEMORY_E5_RUNTIME;
const modelPath = process.env.BRAID_MEMORY_E5_MODEL;
const ids = (text: string) => [...text.matchAll(/ memory:([^\s]+)/g)].map((match) => match[1]);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

it.skipIf(!runtimePath || !modelPath)('runs installed real E5 through MemoryHostService, with offline lifecycle and cache evidence', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-real-e5-'));
  const corpusPath = process.env.BRAID_MEMORY_E5_CORPUS;
  const corpusBytes = corpusPath ? fs.readFileSync(corpusPath) : undefined;
  const corpus: MemoryRecord[] = corpusBytes ? JSON.parse(corpusBytes.toString('utf8')).records : Array.from({ length: 6 }, (_, n) => ({
    id: `fixture-${n}`, title: `Agent lifecycle evidence ${n}`, scope: 'runtime', tags: ['agent'], evidence: '',
    content: n === 0 ? 'Closing a window does not stop the headless agent execution.' : `Runtime owns execution and resource disposal. Record ${n}.`,
    status: 'current', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  let config: MemorySemanticConfig = { mode: 'local-e5', cache: 'session', runtimePath, modelPath };
  const host = {
    cwd: () => project, openCanvasIds: () => [], readPluginConfig: () => ({ enabled: true, config }),
    publishWorkspaceState: () => undefined,
  } as unknown as HostServiceContext;
  const service = memoryHostServicePlugin.create(host);
  const tools = new Map(service.agentTools!().map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (args: Record<string, unknown>, signal = new AbortController().signal) => tools.get('memory_recall')!
    .call({ provider: 'codex', turnIndex: 0, signal }, args);
  const query = 'Why does a headless agent keep running after closing its window?';
  let networkAttempts = 0;
  vi.stubGlobal('fetch', async () => { networkAttempts++; throw new Error('Real integration is offline.'); });
  let encodeCalls = 0;
  let onEncode: (() => void) | undefined;
  const prepared = new WeakSet<object>();
  const prepare = LocalE5SemanticCandidateSource.prototype.prepare;
  // Observe actual native calls, forwarding every argument/result unchanged.
  const prepareSpy = vi.spyOn(LocalE5SemanticCandidateSource.prototype, 'prepare').mockImplementation(async function (this: LocalE5SemanticCandidateSource, signal) {
    await prepare.call(this, signal);
    const source = this as unknown as { extractor: object };
    if (prepared.has(source.extractor)) return;
    source.extractor = new Proxy(source.extractor, {
      apply(target, receiver, args) {
        encodeCalls++;
        const result = Reflect.apply(target as (...args: unknown[]) => unknown, receiver, args);
        onEncode?.();
        return result;
      },
    });
    prepared.add(source.extractor);
  });
  const releaseSpy = vi.spyOn(LocalE5SemanticCandidateSource.prototype, 'dispose');
  const querySpy = vi.spyOn(LocalE5SemanticCandidateSource.prototype, 'query');
  const evidence: Record<string, unknown> = {
    at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model,
    corpusSha256: corpusBytes ? createHash('sha256').update(corpusBytes).digest('hex') : 'synthetic-six-record-lifecycle-fixture',
    records: corpus.length, runtimePath, modelPath,
  };
  try {
    const write = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), normalizeMemoryStore({ version: 1, records: corpus }), { pluginId: 'memory' });
    expect(write.status).toBe('committed');
    const baseline = await call({ query, limit: '5', semantic: 'off' });
    expect(await call({ query, limit: '5' })).toEqual(baseline);
    expect(prepareSpy).not.toHaveBeenCalled();
    const nativeStarted = deferred();
    onEncode = nativeStarted.resolve;
    const coldStart = performance.now();
    const coldPromise = call({ query, limit: '5', semantic: 'configured' });
    await Promise.race([nativeStarted.promise, coldPromise.then((result) => { throw new Error(`No native inference started: ${result.result}`); })]);
    expect(service.hasActiveWork?.()).toBe(true);
    const offStart = performance.now();
    expect(await call({ query, limit: '5', semantic: 'off' })).toEqual(baseline);
    evidence.offWhileIndexingMs = performance.now() - offStart;
    const cold = await coldPromise;
    evidence.coldRecallMs = performance.now() - coldStart;
    evidence.coldEncodeCalls = encodeCalls;
    evidence.coldOutput = cold.result;
    evidence.returnedIds = ids(cold.result);
    evidence.rssAfterCold = process.memoryUsage().rss;
    expect(cold.result).toContain('candidate-not-truth');
    expect(cold.result).toContain('e5-small:761b726');
    expect(ids(cold.result)[0]).toBe(ids(baseline.result)[0]);
    expect(ids(cold.result).length).toBeGreaterThan(1);
    const warmBefore = encodeCalls;
    const warmStart = performance.now();
    expect(ids((await call({ query, limit: '5', semantic: 'configured' })).result)).toEqual(ids(cold.result));
    evidence.warmRecallMs = performance.now() - warmStart;
    evidence.warmEncodeCalls = encodeCalls - warmBefore;
    expect(encodeCalls - warmBefore).toBe(1); // Usage telemetry did not re-encode documents.

    const snapshot = await readCanonicalMemorySnapshot(project);
    const target = snapshot.store.records.find((record) => record.id === ids(cold.result)[0])!;
    const updated = { ...target, content: `${target.content}\nUpdated integration evidence.`, updatedAt: new Date().toISOString() };
    await writeArtifactMemoryStore(project, snapshot, { version: 1, records: snapshot.store.records.map((record) => record.id === target.id ? updated : record) }, { pluginId: 'memory' });
    const updateBefore = encodeCalls;
    const update = await call({ query, limit: '5', semantic: 'configured' });
    evidence.updateEncodeCalls = encodeCalls - updateBefore;
    expect(encodeCalls - updateBefore).toBeGreaterThan(1);
    expect(encodeCalls - updateBefore).toBeLessThan(encodeCalls - warmBefore);
    expect(update.result).toContain('candidate-not-truth');

    const moved = await readCanonicalMemorySnapshot(project);
    await writeArtifactMemoryStore(project, moved, { version: 1, records: moved.store.records.map((record) => record.id === target.id ? { ...record, scope: 'isolated-integration-scope' } : record) }, { pluginId: 'memory' });
    const scoped = await call({ query, scope: 'isolated-integration-scope', limit: '5', semantic: 'configured' });
    expect(ids(scoped.result)).toEqual([target.id]);
    expect(querySpy.mock.calls.at(-1)![0].records.map((record) => record.id)).toEqual([target.id]);
    const scopeReturnBefore = encodeCalls;
    await call({ query, semantic: 'configured' });
    expect(encodeCalls - scopeReturnBefore).toBe(1);
    evidence.scopeReturnEncodeCalls = encodeCalls - scopeReturnBefore;
    const stale = await readCanonicalMemorySnapshot(project);
    await writeArtifactMemoryStore(project, stale, { version: 1, records: stale.store.records.map((record) => record.id === target.id ? { ...record, status: 'superseded' } : record) }, { pluginId: 'memory' });
    expect(ids((await call({ query, scope: 'isolated-integration-scope', semantic: 'configured' })).result)).toEqual([]);
    expect(querySpy.mock.calls.at(-1)![0].records).toEqual([]);
    evidence.scopeAndStatus = 'only exact scope/current records reached the real source; superseded record absent';

    const cancelled = new AbortController();
    cancelled.abort(new Error('real caller cancel'));
    await expect(call({ query, semantic: 'configured' }, cancelled.signal)).rejects.toThrow('real caller cancel');
    config = { ...config, modelPath: path.join(project, 'missing-model') };
    const failed = await call({ query, semantic: 'configured' });
    expect(failed.result).toContain('Semantic recall unavailable:');
    expect(failed.result).not.toContain('candidate-not-truth');
    expect(ids(failed.result).length).toBeGreaterThan(0);
    evidence.failureOutput = failed.result;
    config = { ...config, modelPath };
    const closingNative = deferred();
    onEncode = closingNative.resolve;
    const active = call({ query, semantic: 'configured' });
    const rejection = expect(active).rejects.toThrow('disposed');
    await Promise.race([closingNative.promise, active.then((result) => { throw new Error(`No closing inference started: ${result.result}`); })]);
    await service.dispose?.();
    await rejection;
    expect(service.hasActiveWork?.()).toBe(false);
    expect(releaseSpy.mock.results.length).toBeGreaterThanOrEqual(3);
    evidence.releases = releaseSpy.mock.results.length;
    evidence.dispose = 'waited for the in-flight native call, rejected late result, and awaited extractor disposal';
    evidence.networkAttempts = networkAttempts;
    evidence.maxRSSKiB = process.resourceUsage().maxRSS;
    expect(networkAttempts).toBe(0);
    const output = process.env.BRAID_MEMORY_E5_EVIDENCE;
    if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, coldOutput: undefined, failureOutput: undefined, runtimePath: undefined, modelPath: undefined }));
  } finally {
    onEncode = undefined;
    await service.dispose?.();
    prepareSpy.mockRestore();
    releaseSpy.mockRestore();
    querySpy.mockRestore();
    vi.unstubAllGlobals();
    fs.rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
