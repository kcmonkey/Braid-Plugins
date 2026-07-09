import * as fs from 'fs';
import * as path from 'path';
import { ArtifactStore } from '../../../src/persistence/artifactStore';
import type { ApplyInlinePayloadBatchInput, ArtifactPayloadRead } from '../../../src/persistence/artifactStore';
import type { ArtifactProducerRef } from '../../../src/protocol';
import {
  emptyMemoryStore,
  memoryEnvelopeIdFor,
  normalizeMemoryFreshness,
  normalizeMemoryStatus,
  normalizeMemoryStore,
  type MemoryCorpusClass,
  type MemoryRecord,
  type MemoryStore,
  type MemoryWriteVerb,
} from './model';
import { bumpMemoryRevisionToken } from './indexCache';

export const MEMORY_DIR = path.join('.braid', 'memory');
export const MEMORY_FILE = 'memories.json';
export const MEMORY_USAGE_FILE = 'memory-usage.json';
const MEMORY_DATA_TYPE = 'memory-record';
const MEMORY_MIME = 'application/json';

interface MemoryUsageRecord {
  readCount: number;
  lastReadAt?: string;
}

interface MemoryUsageStore {
  version: 1;
  records: Record<string, MemoryUsageRecord>;
}

export interface MemoryPaths {
  workspace: string;
  dir: string;
  file: string;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function memoryPaths(cwd: string): MemoryPaths {
  const workspace = path.resolve(cwd || process.cwd());
  const dir = path.resolve(workspace, MEMORY_DIR);
  const file = path.resolve(dir, MEMORY_FILE);
  if (!isContained(workspace, dir) || !isContained(dir, file)) {
    throw new Error('Memory storage path escaped the workspace.');
  }
  return { workspace, dir, file };
}

export function memoryUsagePath(cwd: string): string {
  const workspace = path.resolve(cwd || process.cwd());
  const file = path.resolve(workspace, '.braid', 'artifacts', MEMORY_USAGE_FILE);
  if (!isContained(workspace, file)) {
    throw new Error('Memory usage path escaped the workspace.');
  }
  return file;
}

export async function readMemoryStore(cwd: string): Promise<MemoryStore> {
  try {
    if (!fs.existsSync(path.resolve(cwd || process.cwd()))) return emptyMemoryStore();
    const artifactStore = ArtifactStore.forWorkspace(cwd);
    const refs = await artifactStore.latestRefsByDataType(MEMORY_DATA_TYPE);
    if (!refs.length) return emptyMemoryStore();
    const records: MemoryRecord[] = [];
    for (const ref of refs) {
      const payload = await artifactStore.readPayload(ref);
      const record = parseArtifactMemoryPayload(payload);
      if (record) records.push(record);
    }
    return normalizeMemoryStore({ version: 1, records: applyMemoryUsage(records, readMemoryUsageStore(cwd)) });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyMemoryStore();
    throw error;
  }
}

export async function writeArtifactMemoryStore(cwd: string, store: MemoryStore, producer: ArtifactProducerRef): Promise<MemoryStore> {
  const legacyRecords = readLegacyMarkdownRecords(cwd);
  const normalized = normalizeMemoryStore({
    version: 1,
    records: mergeMemoryRecords(legacyRecords, normalizeMemoryStore(store).records),
  });
  seedMemoryUsageFromRecords(cwd, normalized.records);
  const artifactStore = ArtifactStore.forWorkspace(cwd);
  const latestPayloads = await artifactStore.latestInlinePayloadsByDataType(MEMORY_DATA_TYPE);
  const latestById = new Map(latestPayloads.map((payload) => [payload.ref.id, payload]));
  const records: MemoryRecord[] = [];
  const batchInputs: ApplyInlinePayloadBatchInput[] = [];
  for (const raw of normalized.records) {
    const record = normalizeRecordForArtifact(raw);
    const bytes = serializeArtifactMemoryRecord(record);
    const latest = latestById.get(record.id);
    if (latest) {
      const currentRecord = parseArtifactMemoryText(latest.text);
      if (sameDurableMemoryContent(latest.text, bytes)) {
        records.push(currentRecord ?? record);
        continue;
      }
    }
    batchInputs.push({
      id: record.id,
      class: 'declared',
      dataType: MEMORY_DATA_TYPE,
      mime: MEMORY_MIME,
      label: record.title,
      producer,
      bytes,
    });
    records.push(record);
  }
  if (batchInputs.length) await artifactStore.applyInlinePayloadBatch(batchInputs);
  const removedLegacy = removeLegacyMarkdownFiles(cwd);
  if (batchInputs.length || removedLegacy) bumpMemoryRevisionToken(cwd);
  return { version: 1, records };
}

function mergeMemoryRecords(...groups: readonly MemoryRecord[][]): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const group of groups) {
    for (const record of group) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function readLegacyMarkdownRecords(cwd: string): MemoryRecord[] {
  const paths = memoryPaths(cwd);
  let entries: string[] = [];
  try { entries = fs.readdirSync(paths.dir); } catch { return []; }
  const records: MemoryRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    const file = path.join(paths.dir, name);
    const record = parseLegacyMarkdownRecord(file, fs.readFileSync(file, 'utf8'));
    if (!record) throw new Error(`Unable to migrate legacy markdown memory: ${path.relative(paths.workspace, file)}`);
    records.push(record);
  }
  return records;
}

function parseLegacyMarkdownRecord(file: string, raw: string): MemoryRecord | undefined {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  const frontmatter = match ? parseFrontmatter(match[1]) : {};
  const body = match ? raw.slice(match[0].length) : raw;
  const statTime = legacyFileTime(file);
  const title = textField(frontmatter.title) || firstMarkdownHeading(body) || path.basename(file, '.md');
  const content = textField(frontmatter.content) || markdownBodyWithoutTitle(body) || textField(frontmatter.locator);
  if (!title || !content) return undefined;
  const verb = normalizeVerb(frontmatter.verb);
  const evidenceLocators = listField(frontmatter.evidenceLocators ?? frontmatter.evidenceLocator);
  const readCount = numberField(frontmatter.readCount);
  const lastReadAt = textField(frontmatter.lastReadAt);
  const record: MemoryRecord = {
    id: textField(frontmatter.id) || memoryEnvelopeIdFor(verb, title, textField(frontmatter.provenance) || 'legacy-markdown'),
    title,
    content,
    scope: textField(frontmatter.scope) || 'project',
    tags: listField(frontmatter.tags),
    evidence: textField(frontmatter.evidence) || evidenceLocators.join('\n'),
    createdAt: textField(frontmatter.createdAt) || textField(frontmatter.recordedAt) || statTime,
    updatedAt: textField(frontmatter.updatedAt) || statTime,
    verb,
    corpusClass: normalizeCorpusClass(numberField(frontmatter.corpusClass ?? frontmatter.class), verb),
    provisional: booleanField(frontmatter.provisional),
    status: normalizeMemoryStatus(frontmatter.status),
    freshness: normalizeMemoryFreshness(frontmatter.freshness),
    recallCue: textField(frontmatter.recallCue) || title,
    provenance: textField(frontmatter.provenance) || 'legacy-markdown',
    evidenceLocators,
    recordedAt: textField(frontmatter.recordedAt) || textField(frontmatter.createdAt) || statTime,
    lastVerified: lastVerifiedFromFrontmatter(frontmatter),
    locator: textField(frontmatter.locator) || undefined,
    source: textField(frontmatter.source) || undefined,
    capturedAt: textField(frontmatter.capturedAt) || undefined,
    quoteSource: textField(frontmatter.quoteSource) || undefined,
    supersedes: textField(frontmatter.supersedes) || undefined,
    ...(readCount > 0 ? { readCount } : {}),
    ...(lastReadAt ? { lastReadAt } : {}),
  };
  return normalizeMemoryStore({ version: 1, records: [record] }).records[0];
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | undefined;
  for (const line of raw.split(/\r?\n/g)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const list = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    if (list && currentKey) {
      const current = Array.isArray(out[currentKey]) ? out[currentKey] as unknown[] : [];
      current.push(parseScalar(list[1]));
      out[currentKey] = current;
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    currentKey = pair[1];
    out[currentKey] = pair[2].trim() ? parseScalar(pair[2]) : [];
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    try { return JSON.parse(value); } catch {
      return value.slice(1, -1).split(',').map((part) => parseScalar(part)).filter((part) => textField(part));
    }
  }
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function listField(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = textField(item);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

function legacyFileTime(file: string): string {
  try { return fs.statSync(file).mtime.toISOString(); }
  catch { return new Date().toISOString(); }
}

function firstMarkdownHeading(body: string): string {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '';
}

function markdownBodyWithoutTitle(body: string): string {
  const lines = body.replace(/^\s+/, '').split(/\r?\n/g);
  if (lines[0]?.startsWith('# ')) lines.shift();
  return lines.join('\n').trim();
}

function lastVerifiedFromFrontmatter(frontmatter: Record<string, unknown>): MemoryRecord['lastVerified'] {
  const at = textField(frontmatter.lastVerifiedAt);
  const locator = textField(frontmatter.lastVerifiedLocator);
  return at && locator ? { at, locator } : undefined;
}

function parseArtifactMemoryPayload(payload: ArtifactPayloadRead): MemoryRecord | undefined {
  if ('error' in payload || !('text' in payload)) return undefined;
  return parseArtifactMemoryText(payload.text);
}

function parseArtifactMemoryText(text: string): MemoryRecord | undefined {
  try {
    return normalizeRecordForArtifact(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function serializeArtifactMemoryRecord(record: MemoryRecord): string {
  return JSON.stringify(record, null, 2);
}

function durableComparable(record: MemoryRecord): string {
  const comparable = { ...record } as any;
  delete comparable.updatedAt;
  delete comparable.recordedAt;
  delete comparable.readCount;
  delete comparable.lastReadAt;
  return JSON.stringify(comparable);
}

function sameDurableMemoryContent(a: string, b: string): boolean {
  try {
    return durableComparable(normalizeRecordForArtifact(JSON.parse(a))) === durableComparable(normalizeRecordForArtifact(JSON.parse(b)));
  } catch {
    return a === b;
  }
}

function normalizeRecordForArtifact(record: MemoryRecord): MemoryRecord {
  const verb = normalizeVerb(record.verb);
  const title = record.title || record.id || 'Memory';
  const provenance = record.provenance || 'legacy-memory-record';
  const id = record.id?.trim() || memoryEnvelopeIdFor(verb, title, provenance);
  const evidenceLocators = record.evidenceLocators?.length
    ? record.evidenceLocators
    : record.evidence
      ? record.evidence.split(/[\n;]/g).map((s) => s.trim()).filter(Boolean)
      : [];
  const status = normalizeMemoryStatus(record.status ?? 'stale');
  const freshness = normalizeMemoryFreshness(record.freshness);
  const corpusClass = normalizeCorpusClass(record.corpusClass, verb);
  const normalized: MemoryRecord = {
    ...record,
    id,
    title,
    verb,
    corpusClass,
    provisional: typeof record.provisional === 'boolean' ? record.provisional : corpusClass === 4 || freshness === 'unverified',
    status,
    freshness,
    recallCue: record.recallCue || title,
    provenance,
    evidenceLocators,
    recordedAt: record.recordedAt || record.createdAt || new Date().toISOString(),
    createdAt: record.createdAt || record.recordedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString(),
    content: record.content || record.locator || '',
    evidence: record.evidence || evidenceLocators.join('\n'),
  };
  delete (normalized as any).readCount;
  delete (normalized as any).lastReadAt;
  return normalized;
}

function normalizeVerb(value: unknown): MemoryWriteVerb {
  return value === 'locator' || value === 'snapshot' || value === 'transcript' || value === 'lesson' ? value : 'lesson';
}

function normalizeCorpusClass(value: unknown, verb: MemoryWriteVerb): MemoryCorpusClass {
  if (value === 2 || value === 3 || value === 4 || value === 5) return value;
  if (verb === 'locator') return 2;
  if (verb === 'snapshot') return 3;
  if (verb === 'transcript') return 5;
  return 4;
}

function removeLegacyMarkdownFiles(cwd: string): boolean {
  const paths = memoryPaths(cwd);
  let entries: string[] = [];
  try { entries = fs.readdirSync(paths.dir); } catch { return false; }
  let removed = false;
  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    try {
      fs.rmSync(path.join(paths.dir, name), { force: true });
      removed = true;
    } catch { /* best effort legacy cleanup */ }
  }
  return removed;
}

function emptyMemoryUsageStore(): MemoryUsageStore {
  return { version: 1, records: {} };
}

function readMemoryUsageStore(cwd: string): MemoryUsageStore {
  const file = memoryUsagePath(cwd);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MemoryUsageStore;
    const records: Record<string, MemoryUsageRecord> = {};
    for (const [id, raw] of Object.entries(parsed.records ?? {})) {
      if (!id || typeof raw !== 'object' || !raw) continue;
      const readCount = Number((raw as any).readCount);
      const lastReadAt = typeof (raw as any).lastReadAt === 'string' ? (raw as any).lastReadAt : undefined;
      records[id] = {
        readCount: Number.isFinite(readCount) && readCount > 0 ? Math.floor(readCount) : 0,
        ...(lastReadAt ? { lastReadAt } : {}),
      };
    }
    return { version: 1, records };
  } catch {
    return emptyMemoryUsageStore();
  }
}

function writeMemoryUsageStore(cwd: string, store: MemoryUsageStore): void {
  const file = memoryUsagePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
}

function seedMemoryUsageFromRecords(cwd: string, records: readonly MemoryRecord[]): void {
  const withUsage = records.filter((record) => (record.readCount ?? 0) > 0 || record.lastReadAt);
  if (!withUsage.length) return;
  const store = readMemoryUsageStore(cwd);
  let changed = false;
  for (const record of withUsage) {
    const existing = store.records[record.id];
    const readCount = Math.max(existing?.readCount ?? 0, record.readCount ?? 0);
    const lastReadAt = record.lastReadAt ?? existing?.lastReadAt;
    if ((existing?.readCount ?? 0) === readCount && existing?.lastReadAt === lastReadAt) continue;
    store.records[record.id] = { readCount, ...(lastReadAt ? { lastReadAt } : {}) };
    changed = true;
  }
  if (changed) writeMemoryUsageStore(cwd, store);
}

function applyMemoryUsage(records: readonly MemoryRecord[], usage: MemoryUsageStore): MemoryRecord[] {
  return records.map((record) => {
    const usageRecord = usage.records[record.id];
    if (!usageRecord) return record;
    return {
      ...record,
      readCount: Math.max(record.readCount ?? 0, usageRecord.readCount ?? 0),
      lastReadAt: usageRecord.lastReadAt ?? record.lastReadAt,
    };
  });
}

export function recordMemoryUsage(
  cwd: string,
  records: readonly Pick<MemoryRecord, 'id' | 'readCount' | 'lastReadAt'>[],
  nowIso = new Date().toISOString(),
): void {
  if (!records.length) return;
  const store = readMemoryUsageStore(cwd);
  for (const record of records) {
    const existing = store.records[record.id];
    const readCount = Math.max(existing?.readCount ?? 0, record.readCount ?? 0) + 1;
    store.records[record.id] = { readCount, lastReadAt: nowIso };
  }
  writeMemoryUsageStore(cwd, store);
}
