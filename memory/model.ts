export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  scope: string;
  tags: string[];
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStore {
  version: 1;
  records: MemoryRecord[];
}

export interface MemoryRecordInput {
  title?: string;
  content?: string;
  scope?: string;
  tags?: string | string[];
  evidence?: string;
}

export interface MemoryRecallInput {
  query?: string;
  scope?: string;
  limit?: string;
}

export interface MemoryRecordResult {
  store: MemoryStore;
  record: MemoryRecord;
  created: boolean;
}

const DEFAULT_SCOPE = 'project';
const MAX_TITLE = 160;
const MAX_CONTENT = 6000;
const MAX_SCOPE = 120;
const MAX_EVIDENCE = 1200;
const MAX_TAGS = 12;
const MAX_TAG = 48;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 10;

export function emptyMemoryStore(): MemoryStore {
  return { version: 1, records: [] };
}

const clampText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max).trim() : '';

const normalizeContent = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, MAX_CONTENT).trim() : '';

const normalizeScope = (value: unknown): string => clampText(value, MAX_SCOPE) || DEFAULT_SCOPE;

export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = clampText(item, MAX_TAG).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'memory';
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 8);
}

export function memoryIdFor(title: string, scope: string): string {
  return `${slugify(title)}-${hashText(`${scope}\0${title}`)}`;
}

function isRecord(value: unknown): value is MemoryRecord {
  const record = value as Partial<MemoryRecord>;
  return !!record &&
    typeof record.id === 'string' && !!record.id.trim() &&
    typeof record.title === 'string' && !!record.title.trim() &&
    typeof record.content === 'string' && !!record.content.trim() &&
    typeof record.scope === 'string' && !!record.scope.trim() &&
    Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === 'string') &&
    typeof record.evidence === 'string' &&
    typeof record.createdAt === 'string' && !!record.createdAt.trim() &&
    typeof record.updatedAt === 'string' && !!record.updatedAt.trim();
}

export function normalizeMemoryStore(raw: unknown): MemoryStore {
  const input = raw as Partial<MemoryStore>;
  if (!input || input.version !== 1 || !Array.isArray(input.records)) return emptyMemoryStore();
  const records = input.records
    .filter(isRecord)
    .map((record) => ({
      id: clampText(record.id, 120),
      title: clampText(record.title, MAX_TITLE),
      content: normalizeContent(record.content),
      scope: normalizeScope(record.scope),
      tags: normalizeTags(record.tags),
      evidence: clampText(record.evidence, MAX_EVIDENCE),
      createdAt: clampText(record.createdAt, 64),
      updatedAt: clampText(record.updatedAt, 64),
    }))
    .filter((record) => record.id && record.title && record.content && record.createdAt && record.updatedAt);
  return { version: 1, records };
}

export function recordMemory(store: MemoryStore, input: MemoryRecordInput, nowIso = new Date().toISOString()): MemoryRecordResult {
  const title = clampText(input.title, MAX_TITLE);
  const content = normalizeContent(input.content);
  if (!title) throw new Error('memory_record needs a non-empty title.');
  if (!content) throw new Error('memory_record needs non-empty content.');

  const normalized = normalizeMemoryStore(store);
  const scope = normalizeScope(input.scope);
  const id = memoryIdFor(title, scope);
  const tags = normalizeTags(input.tags);
  const evidence = clampText(input.evidence, MAX_EVIDENCE);
  const existingIndex = normalized.records.findIndex((record) => record.id === id);
  const existing = existingIndex >= 0 ? normalized.records[existingIndex] : undefined;
  const record: MemoryRecord = {
    id,
    title,
    content,
    scope,
    tags,
    evidence,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  const records = normalized.records.slice();
  if (existingIndex >= 0) records[existingIndex] = record;
  else records.push(record);
  return { store: { version: 1, records }, record, created: existingIndex < 0 };
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function textHas(text: string, token: string): boolean {
  return tokens(text).includes(token);
}

export function parseRecallLimit(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_RECALL_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RECALL_LIMIT;
  return Math.max(1, Math.min(MAX_RECALL_LIMIT, parsed));
}

function scoreRecord(record: MemoryRecord, queryTokens: string[]): number {
  let score = 0;
  for (const token of queryTokens) {
    if (textHas(record.title, token)) score += 8;
    if (record.tags.some((tag) => textHas(tag, token))) score += 5;
    if (textHas(record.scope, token)) score += 4;
    if (textHas(record.content, token)) score += 2;
    if (textHas(record.evidence, token)) score += 1;
  }
  return score;
}

export function recallMemories(store: MemoryStore, input: MemoryRecallInput): MemoryRecord[] {
  const query = clampText(input.query, 500);
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return [];
  const scope = clampText(input.scope, MAX_SCOPE);
  const limit = parseRecallLimit(input.limit);
  const normalized = normalizeMemoryStore(store);
  return normalized.records
    .filter((record) => !scope || record.scope.toLowerCase() === scope.toLowerCase())
    .map((record) => ({ record, score: scoreRecord(record, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      b.record.updatedAt.localeCompare(a.record.updatedAt) ||
      a.record.title.localeCompare(b.record.title))
    .slice(0, limit)
    .map((entry) => entry.record);
}
