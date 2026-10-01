import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import type { MemoryRecord, MemorySemanticConfig, SemanticRecallMatch } from './model';
import type { SemanticCandidateQuery, SemanticCandidateSource, SemanticCandidateSourceDescription } from './semantic';

// The evaluated model revision, not a user-supplied label. Installation is an
// explicit external step; this source neither downloads nor installs anything.
export const LOCAL_E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const LOCAL_E5_FILES = Object.freeze({
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'special_tokens_map.json': 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
});
const RUNTIME_VERSION = '4.3.0';
const FINGERPRINT = `e5-small:${LOCAL_E5_REVISION}:q8:transformers-${RUNTIME_VERSION}:content-v1:448:mean:l2:maxchunk`;

interface Tokenizer {
  (text: string, options: { add_special_tokens?: boolean; return_tensor: false }): Promise<{ input_ids: number[] }>;
  decode(ids: number[], options: { skip_special_tokens: true }): string;
}
interface Extractor {
  (text: string, options: { pooling: 'mean'; normalize: true }): Promise<{ data: ArrayLike<number> }>;
  tokenizer: Tokenizer;
  dispose(): Promise<void>;
}
interface TransformersRuntime {
  pipeline(task: 'feature-extraction', model: string, options: unknown): Promise<Extractor>;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Memory semantic recall was cancelled.');
}

/** Exact expression used by the frozen content-vector experiment. */
export function localE5DocumentText(record: MemoryRecord): string {
  return [record.title, `Scope: ${record.scope}`, `Tags: ${record.tags.join(' ')}`, record.recallCue, record.content]
    .filter(Boolean).join('\n');
}

function fileStamp(files: readonly string[]): string {
  return files.map((file) => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Local E5 component is not a file: ${file}`);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join('|');
}

async function sha256(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) {
    check(signal);
    hash.update(bytes);
  }
  check(signal);
  return hash.digest('hex');
}

/** Source-local, disposable derived vectors. Artifact-backed Memory remains canonical.
 * MemoryHostService serializes source access and checks corpus/config after awaits.
 */
export class LocalE5SemanticCandidateSource implements SemanticCandidateSource {
  private extractor?: Extractor;
  private disposed = false;
  private componentFiles: string[] = [];
  private componentStamp?: string;
  private readonly vectors = new Map<string, { textHash: string; chunks: Float32Array[] }>();

  constructor(private readonly config: Pick<MemorySemanticConfig, 'runtimePath' | 'modelPath'>) {}

  describe(): SemanticCandidateSourceDescription {
    return { kind: 'local-e5', cache: 'session', modelFingerprint: FINGERPRINT, candidateNotTruth: true };
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    check(signal);
    if (this.disposed) throw new Error('Memory local E5 source is disposed.');
    if (this.extractor) {
      this.checkComponents();
      return;
    }
    const { runtimePath, modelPath } = this.config;
    if (!runtimePath || !modelPath || !path.isAbsolute(runtimePath) || !path.isAbsolute(modelPath)) {
      throw new Error('Local E5 runtimePath and modelPath must be absolute installed-component directories.');
    }
    const runtimeManifest = path.join(runtimePath, 'package.json');
    const metadata = JSON.parse(await fs.promises.readFile(runtimeManifest, 'utf8'));
    if (metadata.name !== '@huggingface/transformers' || metadata.version !== RUNTIME_VERSION) {
      throw new Error(`Local E5 requires installed @huggingface/transformers@${RUNTIME_VERSION}.`);
    }
    const entry = path.join(runtimePath, 'dist', 'transformers.node.mjs');
    this.componentFiles = [runtimeManifest, entry, ...Object.keys(LOCAL_E5_FILES).map((file) => path.join(modelPath, file))];
    const before = fileStamp(this.componentFiles);
    for (const [file, expected] of Object.entries(LOCAL_E5_FILES)) {
      if (await sha256(path.join(modelPath, file), signal) !== expected) {
        throw new Error(`Local E5 model checksum mismatch: ${file}; expected revision ${LOCAL_E5_REVISION}.`);
      }
    }
    check(signal);
    // A variable file URL keeps the optional native runtime out of the host bundle.
    const runtime: TransformersRuntime = await import(pathToFileURL(entry).href);
    check(signal);
    const extractor = await runtime.pipeline('feature-extraction', path.resolve(modelPath).replace(/\\/g, '/'), {
      dtype: 'q8', device: 'cpu', local_files_only: true,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' },
    });
    // Own the native handle immediately, including the cancellation/stamp-check
    // window below. A failed cleanup must leave it available to service disposal.
    this.extractor = extractor;
    try {
      check(signal);
      if (this.disposed) throw new Error('Memory local E5 source is disposed.');
      if (fileStamp(this.componentFiles) !== before) throw new Error('Local E5 components changed during loading.');
      this.componentStamp = before;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private checkComponents(): void {
    if (fileStamp(this.componentFiles) !== this.componentStamp) throw new Error('Local E5 components changed; reload required.');
  }

  private async encode(text: string, signal?: AbortSignal): Promise<Float32Array> {
    check(signal);
    const extractor = this.extractor!;
    const ids = (await extractor.tokenizer(text, { return_tensor: false })).input_ids;
    check(signal);
    if (ids.length > 512) throw new Error(`Local E5 input exceeds 512 tokens (${ids.length}); no silent truncation.`);
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    check(signal);
    const vector = Float32Array.from(result.data);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (vector.length !== 384 || !vector.every(Number.isFinite) || Math.abs(norm - 1) > 0.001) {
      throw new Error('Local E5 produced an invalid normalized 384-dimensional vector.');
    }
    return vector;
  }

  async query(input: SemanticCandidateQuery): Promise<readonly SemanticRecallMatch[]> {
    check(input.signal);
    if (this.disposed || !this.extractor) throw new Error('Memory local E5 source is not prepared.');
    this.checkComponents();
    const live = new Set(input.liveRecordIds ?? input.records.map((record) => record.id));
    for (const id of this.vectors.keys()) if (!live.has(id)) this.vectors.delete(id);
    if (!input.records.length) return [];
    const query = await this.encode(`query: ${input.query}`, input.signal);
    const matches: SemanticRecallMatch[] = [];
    for (const record of input.records) {
      check(input.signal);
      const text = localE5DocumentText(record);
      const textHash = createHash('sha256').update(text).digest('hex');
      let cached = this.vectors.get(record.id);
      if (cached?.textHash !== textHash) {
        const ids = (await this.extractor.tokenizer(text, { add_special_tokens: false, return_tensor: false })).input_ids;
        const chunks: Float32Array[] = [];
        for (let start = 0; start < ids.length; start += 448) {
          check(input.signal);
          const piece = this.extractor.tokenizer.decode(ids.slice(start, start + 448), { skip_special_tokens: true });
          chunks.push(await this.encode(`passage: ${piece}`, input.signal));
        }
        check(input.signal);
        cached = { textHash, chunks };
        this.vectors.set(record.id, cached);
      }
      let best = -Infinity;
      for (const vector of cached.chunks) {
        let score = 0;
        for (let dimension = 0; dimension < 384; dimension++) score += query[dimension] * vector[dimension];
        best = Math.max(best, score);
      }
      if (Number.isFinite(best)) matches.push({ id: record.id, score: best, modelFingerprint: FINGERPRINT });
    }
    check(input.signal);
    this.checkComponents();
    return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const extractor = this.extractor;
    this.vectors.clear();
    await extractor?.dispose();
    this.extractor = undefined;
  }
}
