import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentToolContext,
  HostService,
  HostServicePlugin,
  HostTurnSettledEvent,
  PluginManifest,
  TurnContextPlugin,
  WebviewMessagePlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import {
  applyDirectSupersession,
  birthMemoryEnvelope,
  DEFAULT_MEMORY_SEMANTIC_CONFIG,
  formatMemoryCatalog,
  formatMemoryOverview,
  normalizeMemorySemanticConfig,
  normalizeMemoryRefId,
  recallCandidatesFromIndex,
  recordMemoryEnvelope,
  recordMemory,
  transitionMemoryStatus,
  type MemoryCorpusClass,
  type MemoryRecallCandidate,
  type MemoryRoutingStatus,
  type MemoryRecallInput,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryStore,
} from './model';
import {
  createMemoryAgentTools,
  type MemoryCatalogToolRequest,
  type MemoryGetToolRequest,
  type MemoryRecallToolRequest,
  type MemoryRecordToolRequest,
} from './agentTool';
import manifestJson from './plugin.json';
import {
  readCanonicalMemorySnapshot,
  readMemoryStore,
  recordMemoryUsage,
  writeArtifactMemoryStore,
} from './storage';
import type { Obligation } from '../../../src/obligations';
import {
  createMemoryInspectionSnapshot,
  errorMemoryInspectionSnapshot,
  MEMORY_INSPECTION_STATE_KEY,
  parseMemoryInspectionAction,
  type MemoryInspectionActionResult,
  type MemoryInspectionSnapshot,
} from './inspection';
import { getMemoryIndexSnapshot } from './indexCache';
import {
  DeterministicSessionSemanticCandidateSource,
  querySemanticCandidates,
  resolveSemanticRecallExecution,
  type SemanticCandidateSource,
  type SemanticCandidateSourceDescription,
} from './semantic';

const manifest = manifestJson as PluginManifest;
export const MEMORY_COMPLETE_CATALOG_THRESHOLD = 24;
const MAX_RESULT_CHARS = 4000;
const MAX_CONTENT_CHARS = 700;

type CanonicalMutation<T> =
  | { ok: true; store: MemoryStore; value: T }
  | { ok: false; error: string };

type RecallCandidatesOutcome = {
  status: 'ready';
  candidates: MemoryRecallCandidate[];
  semantic?: { description: SemanticCandidateSourceDescription; candidates: readonly MemoryRecallCandidate[] };
  notice?: string;
};

const compactLine = (value: string, max = MAX_CONTENT_CHARS): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, max).trim();

function formatRecordResult(record: MemoryRecord, created: boolean): string {
  const classText = record.corpusClass ? ` class=${record.corpusClass}` : '';
  const statusText = record.status ? ` status=${record.status}` : '';
  const supersessionText = record.supersedes ? ' Direct supersession was persisted in the same write.' : '';
  return `${created ? 'Recorded' : 'Updated'} Braid memory ${record.id}: ${record.title}.${classText}${statusText} Stored in artifact memory store.${supersessionText}`;
}

function formatBirthErrors(errors: { code: string; message: string }[]): string {
  return [
    'memory_record rejected by birth gate:',
    ...errors.map((err) => `- ${err.code}: ${err.message}`),
  ].join('\n');
}

function memoryProtocolText(): string {
  return [
    '[Braid memory]',
    'Recall with memory_recall before relying on project memory; use memory_get for an exact record.',
    'Write with memory_record class-bound verbs; class is derived from the verb, and a memory is recorded only after a successful memory_record result.',
  ].join('\n');
}

function formatRecallResult(
  records: MemoryRecord[],
  input: MemoryRecallInput,
  staleIds: ReadonlySet<string>,
  semantic?: { description: SemanticCandidateSourceDescription; candidates: readonly MemoryRecallCandidate[] },
): string {
  const query = (input.query ?? '').trim();
  if (!records.length) return `No matching Braid memories for query "${query}".`;
  const lines = [
    `Braid memory recall: ${records.length} candidate${records.length === 1 ? '' : 's'} for "${query}".`,
    semantic
      ? 'These are ranked recall candidates; inspect source labels before relying on semantic expansion.'
      : 'These are ranked lexical candidates; if they look off, use memory_catalog to browse a bounded slice or retry with a narrower query.',
  ];
  if (semantic) {
    lines.push(`Semantic expansion is candidate-not-truth; modelFingerprint=${semantic.description.modelFingerprint}.`);
  }
  for (const [index, record] of records.entries()) {
    const tags = record.tags.length ? ` tags=${record.tags.join(',')}` : '';
    const scope = record.scope ? ` [${record.scope}]` : '';
    const status = ` status: ${record.status ?? 'stale'}`;
    const freshness = ` freshness: ${record.freshness ?? 'unverified'}`;
    const marks = [
      record.status && record.status !== 'current' ? '†' : '',
      staleIds.has(record.id) ? '⚠' : '',
    ].filter(Boolean).join(' ');
    const candidate = semantic?.candidates[index];
    const semanticMetadata = candidate
      ? ` source=${candidate.source.kind}/${candidate.source.provenance} scoreFamily=${[...new Set(candidate.scores.map((score) => score.source.kind))].join('+')}`
      : '';
    lines.push(`- ${record.title}${scope}${tags}${status}${freshness} memory:${record.id}${marks ? ` ${marks}` : ''} updated=${record.updatedAt}${semanticMetadata}`);
    lines.push(`  ${compactLine(record.content)}`);
    if (record.evidence) lines.push(`  evidence: ${compactLine(record.evidence, 240)}`);
    if (lines.join('\n').length >= MAX_RESULT_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_RESULT_CHARS);
}

function formatGetResult(record: MemoryRecord): string {
  const lines = [
    `Braid memory ${record.id}: ${record.title}`,
    `scope: ${record.scope}`,
    `tags: ${record.tags.join(',') || '(none)'}`,
    `verb: ${record.verb ?? '(legacy)'}`,
    `class: ${record.corpusClass ?? '(unspecified)'}`,
    `status: ${record.status ?? '(unspecified)'}`,
    `freshness: ${record.freshness ?? '(unspecified)'}`,
    `provenance: ${record.provenance ?? '(unspecified)'}`,
    `updatedAt: ${record.updatedAt}`,
    record.recallCue ? `recallCue: ${record.recallCue}` : undefined,
    record.lastVerified ? `lastVerified: ${record.lastVerified.at} via ${record.lastVerified.locator}` : undefined,
    record.supersedes ? `supersedes: ${record.supersedes}` : undefined,
    '',
    'content:',
    record.content,
  ].filter((line): line is string => line !== undefined);
  if (record.evidence) lines.push('', 'evidence:', record.evidence);
  if (record.evidenceLocators?.length) lines.push('', 'evidenceLocators:', ...record.evidenceLocators.map((locator) => `- ${locator}`));
  if (record.locator) lines.push('', `locator: ${record.locator}`);
  if (record.source) lines.push('', `source: ${record.source}`);
  if (record.capturedAt) lines.push(`capturedAt: ${record.capturedAt}`);
  if (record.quoteSource) lines.push('', `quoteSource: ${record.quoteSource}`);
  return lines.join('\n').slice(0, MAX_RESULT_CHARS);
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function parseCatalogClass(value: unknown): MemoryCorpusClass | undefined {
  if (value === '2' || value === 2) return 2;
  if (value === '3' || value === 3) return 3;
  if (value === '4' || value === 4) return 4;
  if (value === '5' || value === 5) return 5;
  return undefined;
}

function parseCatalogStatus(value: unknown): MemoryRoutingStatus | undefined {
  return value === 'current' || value === 'stale' || value === 'superseded' || value === 'disputed'
    ? value
    : undefined;
}

function filterCatalogRecords(records: readonly MemoryRecord[], req: MemoryCatalogToolRequest): MemoryRecord[] {
  const scope = (req.scope ?? '').trim().toLowerCase();
  const tag = (req.tag ?? '').trim().toLowerCase();
  const status = parseCatalogStatus(req.status);
  const corpusClass = parseCatalogClass(req.class);
  return records
    .filter((record) => !scope || record.scope.toLowerCase() === scope)
    .filter((record) => !tag || record.tags.some((candidate) => candidate.toLowerCase() === tag))
    .filter((record) => !status || record.status === status)
    .filter((record) => corpusClass === undefined || record.corpusClass === corpusClass)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

function formatCatalogPage(records: readonly MemoryRecord[], req: MemoryCatalogToolRequest): string {
  const filtered = filterCatalogRecords(records, req);
  const pageSize = parsePositiveInt(req.pageSize, 20, 50);
  const page = parsePositiveInt(req.page, 1, Number.MAX_SAFE_INTEGER);
  const start = (page - 1) * pageSize;
  const pageRecords = filtered.slice(start, start + pageSize);
  const filters = [
    req.scope?.trim() ? `scope=${req.scope.trim()}` : undefined,
    req.tag?.trim() ? `tag=${req.tag.trim()}` : undefined,
    req.status?.trim() ? `status=${req.status.trim()}` : undefined,
    req.class?.trim() ? `class=${req.class.trim()}` : undefined,
  ].filter(Boolean).join(' ');
  const lines = [
    `Braid memory catalog: ${pageRecords.length} of ${filtered.length} record${filtered.length === 1 ? '' : 's'} (page ${page}, pageSize ${pageSize}).`,
    filters ? `Filters: ${filters}` : 'Filters: none',
    'Ordering: updatedAt desc, title asc. Usage counters are not used.',
  ];
  for (const record of pageRecords) {
    const tags = record.tags.length ? ` tags=${record.tags.join(',')}` : '';
    const status = record.status ? ` status=${record.status}` : '';
    const klass = record.corpusClass ? ` class=${record.corpusClass}` : '';
    const cue = record.recallCue || record.content || record.evidence;
    lines.push(`- ${record.title} [${record.scope}]${tags}${status}${klass} updated=${record.updatedAt}`);
    lines.push(`  id: memory:${record.id}`);
    lines.push(`  ${compactLine(cue)}`);
    if (lines.join('\n').length >= MAX_RESULT_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_RESULT_CHARS);
}

class MemoryHostService implements HostService {
  id = 'memory.hostService';
  label = 'Memory Host Service';
  manifest = manifest;
  private writeQueue: Promise<void> = Promise.resolve();
  private semanticQueue: Promise<void> = Promise.resolve();
  private readonly memoryWritesByTurn = new Set<string>();
  private semanticSource?: SemanticCandidateSource;
  private semanticSourceFingerprint?: string;
  private semanticGeneration = 0;
  private readonly semanticAbortController = new AbortController();
  private disposed = false;

  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}

  agentTools() {
    return createMemoryAgentTools({
      record: (ctx, req) => this.handleRecord(ctx, req),
      recall: (ctx, req) => this.handleRecall(ctx, req),
      get: (ctx, req) => this.handleGet(ctx, req),
      catalog: (ctx, req) => this.handleCatalog(ctx, req),
    });
  }

  turnContext(): TurnContextPlugin[] {
    return [{
      id: 'memory.turnContext',
      label: 'Memory Turn Context',
      manifest,
      provideTurnContext: () => this.memoryTurnContext(),
    }];
  }

  webviewMessages(): WebviewMessagePlugin[] {
    return [{
      id: 'memory.inspectionActions',
      label: 'Memory inspection actions',
      manifest,
      handleMessage: async ({ canvasId, message }) => {
        if (message.type !== 'workspacePluginAction' || message.pluginId !== manifest.id) return null;
        const request = parseMemoryInspectionAction(message.action, message.payload);
        if (!request.ok) {
          this.publishInspectionActionResult(canvasId, message.requestId, { ok: false, error: request.error });
          return { handled: true };
        }
        try {
          if (request.action === 'refreshInspection') {
            const snapshot = await this.publishMemoryState(canvasId);
            this.publishInspectionActionResult(canvasId, message.requestId, snapshot.kind === 'error'
              ? { ok: false, error: snapshot.error }
              : { ok: true, action: 'refreshInspection' });
            return { handled: true };
          }
          await this.writeQueue;
          const snapshot = createMemoryInspectionSnapshot(await readMemoryStore(this.host.cwd()));
          const record = snapshot.records.find((candidate) => candidate.id === request.id);
          this.publishInspectionActionResult(canvasId, message.requestId, record
            ? { ok: true, action: 'inspectDetail', record }
            : { ok: false, error: 'Memory record is no longer available.' });
        } catch {
          this.publishInspectionActionResult(canvasId, message.requestId, { ok: false, error: 'Memory inspection request failed.' });
        }
        return { handled: true };
      },
    }];
  }

  async onCanvasReady(canvasId: string): Promise<void> {
    await this.publishMemoryState(canvasId);
  }

  async onTurnSettled(event: HostTurnSettledEvent): Promise<void> {
    const key = turnKey(event.canvasId, event.boardId, event.turnIndex);
    if (mentionsMemoryRecording(event.answer) && !this.memoryWritesByTurn.has(key)) {
      this.host.attachObligation?.(createMemoryRecordingGapObligation(event));
    }
    this.memoryWritesByTurn.delete(key);
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.semanticGeneration += 1;
      this.semanticAbortController.abort(this.semanticDisposedError());
    }
    const source = this.semanticSource;
    this.semanticSource = undefined;
    this.semanticSourceFingerprint = undefined;
    if (source) {
      await this.enqueueSemantic(() => Promise.resolve(source.dispose()));
      return;
    }
    // A replacement clears the active source before its deferred disposal runs.
    // Settling this tail keeps service disposal behind that cleanup window.
    await this.semanticQueue;
  }

  private memoryTurnContext(): string | null | Promise<string | null> {
    const artifactIndex = path.join(this.host.cwd(), '.braid', 'artifacts', 'index.sqlite');
    if (!fs.existsSync(artifactIndex)) return null;
    return this.memoryTurnContextAsync();
  }

  private async memoryTurnContextAsync(): Promise<string | null> {
    const snapshot = await getMemoryIndexSnapshot(this.host.cwd(), () => readMemoryStore(this.host.cwd()));
    const store = snapshot.store;
    if (!store.records.length) return null;
    const supply = store.records.length <= MEMORY_COMPLETE_CATALOG_THRESHOLD
      ? formatMemoryCatalog(store, { staleIds: this.staleMemoryIds(store.records) })
      : formatMemoryOverview(snapshot.facets, { threshold: MEMORY_COMPLETE_CATALOG_THRESHOLD });
    return [
      memoryProtocolText(),
      '',
      supply,
    ].join('\n');
  }

  private async handleRecord(ctx: AgentToolContext, req: MemoryRecordToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory record canceled.' };
    const run = this.writeQueue.then(async () => {
      try {
          if (req.action === 'status') {
          const mutation = await this.commitCanonicalMutation(ctx, (store) => {
            const transition = transitionMemoryStatus(store, req.id, req.status);
            return transition.ok
              ? { ok: true, store: transition.store, value: transition }
              : { ok: false, error: transition.error ?? 'memory status transition failed.' };
          });
          if (!mutation.ok) return { ok: false, result: mutation.error };
          await this.publishMemoryState(ctx.canvasId);
          return {
            ok: true,
            result: `Updated Braid memory ${mutation.value.record!.id} status=${mutation.value.record!.status}.`,
          };
        }
        if (!req.verb) {
          if (req.class !== undefined || req.type !== undefined) {
            return { ok: false, result: formatBirthErrors([
              { code: 'verb.required', message: 'New taxonomy-native memories need a class-bound verb.' },
            ]) };
          }
          const mutation = await this.commitCanonicalMutation(ctx, (store) => {
            const result = recordMemory(store, req as MemoryRecordInput);
            return { ok: true, store: result.store, value: result };
          });
          if (!mutation.ok) return { ok: false, result: mutation.error };
          this.markMemoryWrite(ctx);
          await this.publishMemoryState(ctx.canvasId);
          return { ok: true, result: formatRecordResult(mutation.value.record, mutation.value.created) };
        }
        const born = birthMemoryEnvelope({
          ...req,
          evidenceLocators: req.evidenceLocators ?? req.evidence,
        });
        if (!born.ok) return { ok: false, result: formatBirthErrors(born.errors) };
        const mutation = await this.commitCanonicalMutation(ctx, (store) => {
          const result = recordMemoryEnvelope(store, born.record, req as MemoryRecordInput);
          const supersession = applyDirectSupersession(result.store, result.record);
          return supersession.ok
            ? { ok: true, store: supersession.store, value: result }
            : { ok: false, error: supersession.error };
        });
        if (!mutation.ok) return { ok: false, result: mutation.error };
        this.markMemoryWrite(ctx);
        await this.publishMemoryState(ctx.canvasId);
        return { ok: true, result: formatRecordResult(mutation.value.record, mutation.value.created) };
      } catch (error: any) {
        return { ok: false, result: error?.message ?? 'memory_record failed.' };
      }
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleRecall(ctx: AgentToolContext, req: MemoryRecallToolRequest): Promise<AgentToolResult> {
    this.throwIfCallerAborted(ctx.signal);
    if (!req.query?.trim()) return { ok: false, result: 'memory_recall needs a non-empty query.' };
    await this.writeQueue;
    this.throwIfCallerAborted(ctx.signal);
    const snapshot = await getMemoryIndexSnapshot(this.host.cwd(), () => readMemoryStore(this.host.cwd()));
    this.throwIfCallerAborted(ctx.signal);
    const recall = await this.recallCandidates(snapshot.index, req as MemoryRecallInput, ctx.signal);
    this.throwIfCallerAborted(ctx.signal);
    const records = recall.candidates.map((candidate) => candidate.record);
    // Recall stays read-only and OFF the O(N) full-store-reload + inspection-rebuild path: read usage is
    // persisted to the lightweight usage store, and inspection refreshes on the next write / status change /
    // canvas-ready. (memory-supply Finding 1)
    if (records.length) {
      this.throwIfCallerAborted(ctx.signal);
      recordMemoryUsage(this.host.cwd(), records);
      this.throwIfCallerAborted(ctx.signal);
    }
    this.throwIfCallerAborted(ctx.signal);
    const result = formatRecallResult(records, req, this.staleMemoryIds(records), recall.semantic);
    this.throwIfCallerAborted(ctx.signal);
    return { ok: true, result: recall.notice ? `${result}\n${recall.notice}` : result };
  }

  private async recallCandidates(
    index: Parameters<typeof recallCandidatesFromIndex>[0],
    input: MemoryRecallInput,
    signal: AbortSignal,
  ): Promise<RecallCandidatesOutcome> {
    this.throwIfCallerAborted(signal);
    const generation = this.semanticGeneration;
    return this.enqueueSemantic(async () => {
      this.throwIfSemanticActive(generation, signal);
      const lexical = () => {
        this.throwIfSemanticActive(generation, signal);
        const candidates = recallCandidatesFromIndex(index, input);
        this.throwIfSemanticActive(generation, signal);
        return candidates;
      };
      const execution = resolveSemanticRecallExecution(input, this.readMemorySemanticConfig());
      if (execution.status === 'unavailable') {
        return {
          status: 'ready',
          candidates: lexical(),
          notice: `Semantic recall unavailable: ${execution.reason}. Lexical candidates were retained.`,
        };
      }
      if (execution.status !== 'enabled') return { status: 'ready', candidates: lexical() };

      const linkedSignal = this.linkSemanticSignal(signal);
      try {
        const source = await this.semanticSourceFor(execution.config.modelFingerprint, generation, signal);
        this.throwIfSemanticActive(generation, signal);
        const outcome = await querySemanticCandidates(source, {
          query: input.query ?? '',
          records: index.records,
          signal: linkedSignal.signal,
        });
        this.throwIfSemanticActive(generation, signal);
        if (outcome.status !== 'ready') {
          return { status: 'ready', candidates: lexical() };
        }
        const candidates = recallCandidatesFromIndex(index, input, {
          semantic: outcome.matches,
          semanticModelFingerprint: outcome.description.modelFingerprint,
        });
        this.throwIfSemanticActive(generation, signal);
        return { status: 'ready', candidates, semantic: { description: outcome.description, candidates } };
      } catch (error) {
        this.throwIfSemanticActive(generation, signal);
        return { status: 'ready', candidates: lexical() };
      } finally {
        linkedSignal.release();
      }
    });
  }

  private readMemorySemanticConfig() {
    try {
      return normalizeMemorySemanticConfig(this.host.readPluginConfig?.(manifest.id, DEFAULT_MEMORY_SEMANTIC_CONFIG).config);
    } catch {
      return DEFAULT_MEMORY_SEMANTIC_CONFIG;
    }
  }

  private async semanticSourceFor(
    modelFingerprint: string | undefined,
    generation: number,
    signal: AbortSignal,
  ): Promise<SemanticCandidateSource> {
    this.throwIfSemanticActive(generation, signal);
    const fingerprint = modelFingerprint ?? 'deterministic-session-v1';
    if (this.semanticSource && this.semanticSourceFingerprint === fingerprint) return this.semanticSource;
    const previous = this.semanticSource;
    this.semanticSource = undefined;
    this.semanticSourceFingerprint = undefined;
    if (previous) {
      await previous.dispose();
      this.throwIfSemanticActive(generation, signal);
    }
    const source = new DeterministicSessionSemanticCandidateSource({ modelFingerprint: fingerprint });
    try {
      this.throwIfSemanticActive(generation, signal);
    } catch (error) {
      await source.dispose();
      throw error;
    }
    this.semanticSource = source;
    this.semanticSourceFingerprint = fingerprint;
    return source;
  }

  private enqueueSemantic<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.semanticQueue.then(operation);
    this.semanticQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Re-evaluate a domain operation against one fresh canonical snapshot after
   * a CAS conflict. The second conflict is returned as a domain conflict, not
   * a lease/recovery/publish failure, and never falls back to a stale replay.
   */
  private async commitCanonicalMutation<T>(
    ctx: AgentToolContext,
    evaluate: (store: MemoryStore) => CanonicalMutation<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (ctx.signal.aborted) return { ok: false, error: 'Memory record canceled.' };
      const snapshot = await readCanonicalMemorySnapshot(this.host.cwd());
      const mutation = evaluate(snapshot.store);
      if (!mutation.ok) return mutation;
      const committed = await writeArtifactMemoryStore(this.host.cwd(), snapshot, mutation.store, memoryProducer(ctx));
      if (committed.status === 'committed') return { ok: true, value: mutation.value };
      if (attempt === 1) {
        return {
          ok: false,
          error: `Memory record conflicted with a concurrent canonical update (${committed.conflicts.map((conflict) => conflict.id).join(', ')}); retry the operation.`,
        };
      }
    }
    return { ok: false, error: 'Memory record conflicted with a concurrent canonical update.' };
  }

  private throwIfCallerAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (signal.reason !== undefined) throw signal.reason;
    const error = new Error('Memory semantic recall was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  private semanticDisposedError(): Error {
    return new Error('Memory semantic service is disposed.');
  }

  private throwIfSemanticActive(generation: number, callerSignal: AbortSignal): void {
    this.throwIfCallerAborted(callerSignal);
    if (!this.disposed && generation === this.semanticGeneration) return;
    const reason = this.semanticAbortController.signal.reason;
    if (reason !== undefined) throw reason;
    throw this.semanticDisposedError();
  }

  private linkSemanticSignal(callerSignal: AbortSignal): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const abortFrom = (source: AbortSignal) => {
      if (!controller.signal.aborted) controller.abort(source.reason);
    };
    const onCallerAbort = () => abortFrom(callerSignal);
    const serviceSignal = this.semanticAbortController.signal;
    const onServiceAbort = () => abortFrom(serviceSignal);
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    if (serviceSignal.aborted) onServiceAbort();
    else serviceSignal.addEventListener('abort', onServiceAbort, { once: true });
    return {
      signal: controller.signal,
      release: () => {
        callerSignal.removeEventListener('abort', onCallerAbort);
        serviceSignal.removeEventListener('abort', onServiceAbort);
      },
    };
  }

  private async handleGet(ctx: AgentToolContext, req: MemoryGetToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory get canceled.' };
    const id = normalizeMemoryRefId(req.id);
    if (!id) return { ok: false, result: 'memory_get needs a memory id.' };
    await this.writeQueue;
    const snapshot = await getMemoryIndexSnapshot(this.host.cwd(), () => readMemoryStore(this.host.cwd()));
    const record = snapshot.index.all.byId.get(id);
    if (!record) return { ok: false, result: `memory record not found: ${id}` };
    return { ok: true, result: formatGetResult(record) };
  }

  private async handleCatalog(ctx: AgentToolContext, req: MemoryCatalogToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory catalog canceled.' };
    await this.writeQueue;
    const snapshot = await getMemoryIndexSnapshot(this.host.cwd(), () => readMemoryStore(this.host.cwd()));
    return { ok: true, result: formatCatalogPage(snapshot.store.records, req) };
  }

  private markMemoryWrite(ctx: AgentToolContext): void {
    this.memoryWritesByTurn.add(turnKey(ctx.canvasId, ctx.boardId, ctx.turnIndex));
  }

  private staleMemoryIds(records: readonly MemoryRecord[]): Set<string> {
    const stale = new Set<string>();
    const cwd = this.host.cwd();
    for (const record of records) {
      const locator = record.lastVerified?.locator;
      const at = record.lastVerified?.at;
      if (!locator || !at) continue;
      const file = workspacePath(cwd, locator);
      if (!file) continue;
      try {
        if (fs.statSync(file).mtimeMs > new Date(at).getTime()) stale.add(record.id);
      } catch {
        // Missing locators are not proof of staleness; they remain a cue for manual verification.
      }
    }
    return stale;
  }

  private async publishMemoryState(originCanvasId?: string): Promise<MemoryInspectionSnapshot> {
    const canvasIds = [...new Set([...(originCanvasId ? [originCanvasId] : []), ...this.host.openCanvasIds()])];
    let snapshot: MemoryInspectionSnapshot;
    try {
      snapshot = createMemoryInspectionSnapshot(await readMemoryStore(this.host.cwd()));
    } catch {
      snapshot = errorMemoryInspectionSnapshot('Unable to read memory inspection metadata.');
    }
    if (!canvasIds.length) return snapshot;
    this.host.publishWorkspaceState({
      pluginId: manifest.id,
      stateKey: MEMORY_INSPECTION_STATE_KEY,
      canvasIds,
      snapshotForCanvas: () => snapshot,
    });
    return snapshot;
  }

  private publishInspectionActionResult(canvasId: string, requestId: string, data: MemoryInspectionActionResult): void {
    (this.host.publishWorkspaceEvent as (event: {
      requestId: string;
      pluginId: string;
      eventKey: string;
      canvasId: string;
      data: MemoryInspectionActionResult;
    }) => void)({
      requestId,
      pluginId: manifest.id,
      eventKey: 'inspectionAction',
      canvasId,
      data,
    });
  }
}

export const memoryHostServicePlugin: HostServicePlugin = {
  id: 'memory.hostService',
  label: 'Memory Host Service',
  manifest,
  create(ctx) {
    return new MemoryHostService(ctx);
  },
};

function memoryProducer(ctx: AgentToolContext) {
  return { canvasId: ctx.canvasId, boardId: ctx.boardId, pluginId: 'memory' };
}

function turnKey(canvasId: string, boardId: string, turnIndex: number): string {
  return `${canvasId}\0${boardId}\0${turnIndex}`;
}

function mentionsMemoryRecording(answer: string): boolean {
  return /(记下|已记|记录了|已记录|saved (?:the )?(?:lesson|memory)|recorded (?:the )?(?:lesson|memory)|memory_record)/i.test(answer);
}

function createMemoryRecordingGapObligation(event: HostTurnSettledEvent): Obligation {
  const id = `memory.recording-gap.${event.canvasId}.${event.boardId}.${event.turnIndex}`;
  return {
    id,
    kind: 'memory-recording-gap',
    source: {
      kind: 'memory-recording-gap',
      pluginId: manifest.id,
      label: 'Memory recording gap',
    },
    target: { canvasId: event.canvasId, boardId: event.boardId, turnIndex: event.turnIndex },
    status: 'active',
    spec: {
      kind: 'predicate',
      predicates: [{ kind: 'grep1', pattern: id, id: 'memory-recording-gap' }],
    },
    enforcement: {
      mode: 'advisory',
      maxRepairs: 0,
      repairPrompt: 'You said a durable lesson was recorded, but no memory_record write succeeded in that turn. Record it with verb=lesson and evidenceLocators, or state that it is not durable and should not be recorded.',
      displayPrompt: 'Memory reminder: record the claimed durable lesson with braid.memory_record, or explicitly say it is not durable.',
    },
    evidence: [{ kind: 'answer-claim', detail: 'turn answer claimed a lesson/memory was recorded' }],
  };
}

function workspacePath(cwd: string, raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed || /^[a-z]+:/i.test(trimmed)) return undefined;
  const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  const relative = path.relative(cwd, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return candidate;
}
