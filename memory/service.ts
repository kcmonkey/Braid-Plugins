import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentToolContext,
  HostService,
  HostServicePlugin,
  HostTurnSettledEvent,
  PluginManifest,
  TurnContextPlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import {
  birthMemoryEnvelope,
  formatMemoryCatalog,
  formatMemoryOverview,
  recallMemoriesFromIndex,
  recordMemoryEnvelope,
  recordMemory,
  transitionMemoryStatus,
  type MemoryCorpusClass,
  type MemoryRoutingStatus,
  type MemoryRecallInput,
  type MemoryRecord,
  type MemoryRecordInput,
} from './model';
import {
  createMemoryAgentTools,
  type MemoryCatalogToolRequest,
  type MemoryGetToolRequest,
  type MemoryRecallToolRequest,
  type MemoryRecordToolRequest,
} from './agentTool';
import manifestJson from './plugin.json';
import { readMemoryStore, recordMemoryUsage, writeArtifactMemoryStore } from './storage';
import type { Obligation } from '../../../src/obligations';
import { createMemoryInspectionSnapshot, MEMORY_INSPECTION_STATE_KEY } from './inspection';
import { getMemoryIndexSnapshot } from './indexCache';

const manifest = manifestJson as PluginManifest;
export const MEMORY_COMPLETE_CATALOG_THRESHOLD = 24;
const MAX_RESULT_CHARS = 4000;
const MAX_CONTENT_CHARS = 700;

const compactLine = (value: string, max = MAX_CONTENT_CHARS): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, max).trim();

function formatRecordResult(record: MemoryRecord, created: boolean): string {
  const classText = record.corpusClass ? ` class=${record.corpusClass}` : '';
  const statusText = record.status ? ` status=${record.status}` : '';
  return `${created ? 'Recorded' : 'Updated'} Braid memory ${record.id}: ${record.title}.${classText}${statusText} Stored in artifact memory store.`;
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

function formatRecallResult(records: MemoryRecord[], input: MemoryRecallInput): string {
  const query = (input.query ?? '').trim();
  if (!records.length) return `No matching Braid memories for query "${query}".`;
  const lines = [
    `Braid memory recall: ${records.length} candidate${records.length === 1 ? '' : 's'} for "${query}".`,
    'These are ranked lexical candidates; if they look off, use memory_catalog to browse a bounded slice or retry with a narrower query.',
  ];
  for (const record of records) {
    const tags = record.tags.length ? ` tags=${record.tags.join(',')}` : '';
    const scope = record.scope ? ` [${record.scope}]` : '';
    lines.push(`- ${record.title}${scope}${tags} updated=${record.updatedAt}`);
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
  private readonly memoryWritesByTurn = new Set<string>();

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
          const store = await readMemoryStore(this.host.cwd());
          if (req.action === 'status') {
            const transition = transitionMemoryStatus(store, req.id, req.status);
            if (!transition.ok) return { ok: false, result: transition.error ?? 'memory status transition failed.' };
          await writeArtifactMemoryStore(this.host.cwd(), transition.store, memoryProducer(ctx));
          await this.publishMemoryState(ctx.canvasId);
          return {
            ok: true,
            result: `Updated Braid memory ${transition.record!.id} status=${transition.record!.status}.`,
          };
        }
        if (!req.verb) {
          if (req.class !== undefined || req.type !== undefined) {
            return { ok: false, result: formatBirthErrors([
              { code: 'verb.required', message: 'New taxonomy-native memories need a class-bound verb.' },
            ]) };
          }
          const result = recordMemory(store, req as MemoryRecordInput);
          await writeArtifactMemoryStore(this.host.cwd(), result.store, memoryProducer(ctx));
          this.markMemoryWrite(ctx);
          await this.publishMemoryState(ctx.canvasId);
          return { ok: true, result: formatRecordResult(result.record, result.created) };
        }
        const born = birthMemoryEnvelope({
          ...req,
          evidenceLocators: req.evidenceLocators ?? req.evidence,
        });
        if (!born.ok) return { ok: false, result: formatBirthErrors(born.errors) };
        const result = recordMemoryEnvelope(store, born.record, req as MemoryRecordInput);
        await writeArtifactMemoryStore(this.host.cwd(), result.store, memoryProducer(ctx));
        this.markMemoryWrite(ctx);
        await this.publishMemoryState(ctx.canvasId);
        return { ok: true, result: formatRecordResult(result.record, result.created) };
      } catch (error: any) {
        return { ok: false, result: error?.message ?? 'memory_record failed.' };
      }
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleRecall(ctx: AgentToolContext, req: MemoryRecallToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory recall canceled.' };
    if (!req.query?.trim()) return { ok: false, result: 'memory_recall needs a non-empty query.' };
    await this.writeQueue;
    const snapshot = await getMemoryIndexSnapshot(this.host.cwd(), () => readMemoryStore(this.host.cwd()));
    const records = recallMemoriesFromIndex(snapshot.index, req as MemoryRecallInput);
    // Recall stays read-only and OFF the O(N) full-store-reload + inspection-rebuild path: read usage is
    // persisted to the lightweight usage store, and inspection refreshes on the next write / status change /
    // canvas-ready. (memory-supply Finding 1)
    if (records.length) recordMemoryUsage(this.host.cwd(), records);
    return { ok: true, result: formatRecallResult(records, req) };
  }

  private async handleGet(ctx: AgentToolContext, req: MemoryGetToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory get canceled.' };
    const id = req.id?.trim();
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

  private async publishMemoryState(originCanvasId?: string): Promise<void> {
    const canvasIds = [...new Set([...(originCanvasId ? [originCanvasId] : []), ...this.host.openCanvasIds()])];
    if (!canvasIds.length) return;
    const snapshot = createMemoryInspectionSnapshot(await readMemoryStore(this.host.cwd()));
    this.host.publishWorkspaceState({
      pluginId: manifest.id,
      stateKey: MEMORY_INSPECTION_STATE_KEY,
      canvasIds,
      snapshotForCanvas: () => snapshot,
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
