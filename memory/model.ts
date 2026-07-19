import MiniSearch from 'minisearch';

export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  scope: string;
  tags: string[];
  evidence: string;
  createdAt: string;
  updatedAt: string;
  verb?: MemoryWriteVerb;
  corpusClass?: MemoryCorpusClass;
  provisional?: boolean;
  status?: MemoryRoutingStatus;
  freshness?: MemoryFreshness;
  recallCue?: string;
  provenance?: string;
  evidenceLocators?: string[];
  recordedAt?: string;
  lastVerified?: MemoryVerification;
  locator?: string;
  source?: string;
  capturedAt?: string;
  quoteSource?: string;
  supersedes?: string;
  readCount?: number;
  lastReadAt?: string;
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
  /** Explicit off wins over the plugin's configured semantic mode. */
  semantic?: 'configured' | 'off';
}

/**
 * Configuration for the deliberately local-only semantic candidate seam.
 * It is separate from plugin enablement: disabling semantic recall never
 * changes the Memory plugin's lexical recall availability.
 */
export interface MemorySemanticConfig {
  mode: 'off' | 'local-experimental';
  modelFingerprint?: string;
  cache: 'session' | 'project';
}

export const DEFAULT_MEMORY_SEMANTIC_CONFIG: Readonly<MemorySemanticConfig> = Object.freeze({
  mode: 'off',
  cache: 'session',
});

/**
 * Fail closed to the default lexical mode for malformed external config. This
 * normalizes only the typed C0 seam; it neither creates a cache nor acquires a
 * model/backend resource.
 */
export function normalizeMemorySemanticConfig(value: unknown): MemorySemanticConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_MEMORY_SEMANTIC_CONFIG;
  const raw = value as Record<string, unknown>;
  if ((raw.mode !== 'off' && raw.mode !== 'local-experimental')
    || (raw.cache !== 'session' && raw.cache !== 'project')
    || (raw.modelFingerprint !== undefined && typeof raw.modelFingerprint !== 'string')) {
    return DEFAULT_MEMORY_SEMANTIC_CONFIG;
  }
  const modelFingerprint = raw.modelFingerprint?.trim();
  if (raw.modelFingerprint !== undefined && !modelFingerprint) return DEFAULT_MEMORY_SEMANTIC_CONFIG;
  return Object.freeze({
    mode: raw.mode,
    cache: raw.cache,
    ...(modelFingerprint ? { modelFingerprint: modelFingerprint.slice(0, 200) } : {}),
  });
}

/**
 * Provenance for a recall score. A candidate can carry more than one score,
 * but its first source stays the rank band that placed it in the result.
 */
export type RecallSource =
  | { kind: 'lexical'; provenance: 'minisearch' }
  | { kind: 'semantic'; provenance: 'session-local'; modelFingerprint: string }
  | { kind: 'recency'; provenance: 'updatedAt' };

export interface RecallScore {
  source: RecallSource;
  value: number;
}

/** Internal recall material; candidates are signals, never recalled truth. */
export interface MemoryRecallCandidate {
  record: MemoryRecord;
  /** The band that determines this candidate's rank position. */
  source: RecallSource;
  /** Immutable score/provenance evidence; lexical+semantic keeps lexical first. */
  scores: readonly RecallScore[];
}

/** A backend-neutral semantic signal. It deliberately has no blended rank. */
export interface SemanticRecallMatch {
  id: string;
  score: number;
  modelFingerprint?: string;
}

/**
 * Optional semantic input to the pure local ranker. Supplying no `semantic`
 * value means the exact lexical path; an empty array means a live semantic
 * backend found no additional candidates and permits recency fill.
 */
export interface MemoryRecallCandidateOptions {
  semantic?: readonly SemanticRecallMatch[];
  semanticModelFingerprint?: string;
}

export type MemoryWriteVerb = 'locator' | 'snapshot' | 'lesson' | 'transcript';
export type MemoryCorpusClass = 2 | 3 | 4 | 5;
export type MemoryRoutingStatus = 'current' | 'stale' | 'superseded' | 'disputed';
export type MemoryFreshness = 'verified' | 'unverified';

export interface MemoryVerification {
  at: string;
  locator: string;
}

export interface MemoryEnvelopeRecord {
  id: string;
  verb: MemoryWriteVerb;
  corpusClass: MemoryCorpusClass;
  provisional: boolean;
  title: string;
  content: string;
  recallCue: string;
  provenance: string;
  status: MemoryRoutingStatus;
  /** Carries raw-input omission across the birth-to-update boundary. */
  statusProvided: boolean;
  freshness: MemoryFreshness;
  evidenceLocators: string[];
  recordedAt: string;
  updatedAt: string;
  lastVerified?: MemoryVerification;
  locator?: string;
  source?: string;
  capturedAt?: string;
  quoteSource?: string;
  supersedes?: string;
}

export interface MemoryBirthError {
  code: string;
  message: string;
}

export type MemoryBirthResult =
  | { ok: true; record: MemoryEnvelopeRecord }
  | { ok: false; errors: MemoryBirthError[] };

export type MemoryEnvelopeInput = Record<string, unknown> & {
  verb?: unknown;
  title?: unknown;
  content?: unknown;
  locator?: unknown;
  source?: unknown;
  capturedAt?: unknown;
  quote?: unknown;
  quoteSource?: unknown;
  recallCue?: unknown;
  provenance?: unknown;
  evidenceLocators?: unknown;
  status?: unknown;
  freshness?: unknown;
  lastVerifiedLocator?: unknown;
  supersedes?: unknown;
};

export interface MemoryRecordResult {
  store: MemoryStore;
  record: MemoryRecord;
  created: boolean;
}

export interface MemoryStatusTransitionResult {
  ok: boolean;
  store: MemoryStore;
  record?: MemoryRecord;
  error?: string;
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

export function memoryEnvelopeIdFor(verb: MemoryWriteVerb, title: string, provenance: string): string {
  return `mem-${slugify(title)}-${hashText(`${verb}\0${provenance}\0${title}`)}`;
}

/** Accept either a stored id or its canonical `memory:<id>` reference form. */
export function normalizeMemoryRefId(value: unknown): string {
  const id = clampText(value, 160);
  return id.startsWith('memory:') ? clampText(id.slice('memory:'.length), 160) : id;
}

const MEMORY_STATUSES: readonly MemoryRoutingStatus[] = ['current', 'stale', 'superseded', 'disputed'];
const MEMORY_FRESHNESS: readonly MemoryFreshness[] = ['verified', 'unverified'];

export function normalizeMemoryStatus(value: unknown): MemoryRoutingStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
    ? value as MemoryRoutingStatus
    : 'stale';
}

/** New births are current by default; updates retain their existing route when omitted. */
export function resolveBirthStatus(value: unknown, existing?: MemoryRoutingStatus): MemoryRoutingStatus {
  return value === undefined ? existing ?? 'current' : normalizeMemoryStatus(value);
}

export function normalizeMemoryFreshness(value: unknown): MemoryFreshness {
  return typeof value === 'string' && (MEMORY_FRESHNESS as readonly string[]).includes(value)
    ? value as MemoryFreshness
    : 'unverified';
}

export function memoryClassForVerb(verb: MemoryWriteVerb): MemoryCorpusClass {
  switch (verb) {
    case 'locator': return 2;
    case 'snapshot': return 3;
    case 'lesson': return 4;
    case 'transcript': return 5;
  }
}

function isMemoryVerb(value: unknown): value is MemoryWriteVerb {
  return value === 'locator' || value === 'snapshot' || value === 'lesson' || value === 'transcript';
}

function error(code: string, message: string): MemoryBirthError {
  return { code, message };
}

function normalizeLocatorList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n;]/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const locator = clampText(item, 500);
    const key = locator.toLowerCase();
    if (!locator || seen.has(key)) continue;
    seen.add(key);
    out.push(locator);
  }
  return out;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = normalizeContent(value);
    if (text) return text;
  }
  return '';
}

export function birthMemoryEnvelope(input: MemoryEnvelopeInput, nowIso = new Date().toISOString()): MemoryBirthResult {
  const errors: MemoryBirthError[] = [];
  if (input.class !== undefined) errors.push(error('class.forbidden', 'Memory class is derived from the write verb.'));
  if (input.type !== undefined) errors.push(error('type.forbidden', 'Memory type/class axis is derived from the write verb.'));

  const verb = input.verb;
  if (!isMemoryVerb(verb)) {
    errors.push(error('verb.invalid', 'Memory birth needs a valid verb: locator, snapshot, lesson, or transcript.'));
  }

  const title = clampText(input.title, MAX_TITLE);
  const recallCue = clampText(input.recallCue, 600);
  const provenance = clampText(input.provenance, 500);
  if (!title) errors.push(error('title.required', 'Memory birth needs a non-empty title.'));
  if (!recallCue) errors.push(error('recallCue.required', 'Memory birth needs a Recall cue.'));
  if (!provenance) errors.push(error('provenance.required', 'Memory birth needs provenance.'));

  const evidenceLocators = normalizeLocatorList(input.evidenceLocators);
  const statusProvided = input.status !== undefined;
  const status = resolveBirthStatus(input.status);
  const freshness = normalizeMemoryFreshness(input.freshness);
  const lastVerifiedLocator = clampText(input.lastVerifiedLocator, 500);
  const supersedes = normalizeMemoryRefId(input.supersedes);
  let content = '';
  let locator = '';
  let source = '';
  let capturedAt = '';
  let quoteSource = '';

  if (isMemoryVerb(verb)) {
    switch (verb) {
      case 'locator':
        locator = clampText(input.locator, 500);
        content = locator;
        if (!locator) errors.push(error('locator.locator.required', 'Locator memories need a locator.'));
        if ([input.conclusion, input.claim, input.content].some((value) => normalizeContent(value))) {
          errors.push(error('locator.conclusion.forbidden', 'Locator memories carry a pointer only, not a conclusion.'));
        }
        break;
      case 'snapshot':
        content = normalizeContent(input.content);
        source = clampText(input.source, 500);
        capturedAt = clampText(input.capturedAt, 80);
        if (!content) errors.push(error('snapshot.content.required', 'Snapshot memories need copied content.'));
        if (!source) errors.push(error('snapshot.source.required', 'Snapshot memories need a source locator.'));
        if (!capturedAt) errors.push(error('snapshot.capturedAt.required', 'Snapshot memories need a capture time.'));
        break;
      case 'lesson':
        content = firstText(input.content, input.claim);
        if (!content) errors.push(error('lesson.content.required', 'Lesson memories need a claim/content body.'));
        if (!evidenceLocators.length) {
          errors.push(error('lesson.evidenceLocators.required', 'Lesson memories need at least one evidence locator.'));
        }
        break;
      case 'transcript':
        content = normalizeContent(input.quote);
        quoteSource = clampText(input.quoteSource, 500);
        if (!content) errors.push(error('transcript.quote.required', 'Transcript memories need a verbatim quote.'));
        if (!quoteSource) errors.push(error('transcript.quoteSource.required', 'Transcript memories need a quote source.'));
        break;
    }
  }

  if (freshness === 'verified' && !lastVerifiedLocator) {
    errors.push(error('lastVerified.locator.required', 'Verified memories need the locator they were verified against.'));
  }

  if (errors.length) return { ok: false, errors };
  const finalVerb = verb as MemoryWriteVerb;
  const corpusClass = memoryClassForVerb(finalVerb);
  return {
    ok: true,
    record: {
      id: memoryEnvelopeIdFor(finalVerb, title, provenance),
      verb: finalVerb,
      corpusClass,
      provisional: finalVerb === 'lesson' || freshness === 'unverified',
      title,
      content,
      recallCue,
      provenance,
      status,
      statusProvided,
      freshness,
      evidenceLocators,
      recordedAt: nowIso,
      updatedAt: nowIso,
      lastVerified: freshness === 'verified' ? { at: nowIso, locator: lastVerifiedLocator } : undefined,
      locator: locator || undefined,
      source: source || undefined,
      capturedAt: capturedAt || undefined,
      quoteSource: quoteSource || undefined,
      supersedes: supersedes || undefined,
    },
  };
}

function envelopeToRecord(envelope: MemoryEnvelopeRecord, existing: MemoryRecord | undefined, input: MemoryRecordInput, nowIso: string): MemoryRecord {
  const evidence = envelope.evidenceLocators.join('\n');
  const hasScope = typeof input.scope === 'string' && !!input.scope.trim();
  const hasTags = Array.isArray(input.tags) || typeof input.tags === 'string';
  return {
    id: envelope.id,
    title: envelope.title,
    content: envelope.content,
    scope: hasScope ? normalizeScope(input.scope) : existing?.scope ?? DEFAULT_SCOPE,
    tags: hasTags ? normalizeTags(input.tags) : existing?.tags ?? [],
    evidence,
    createdAt: existing?.createdAt ?? envelope.recordedAt,
    updatedAt: nowIso,
    verb: envelope.verb,
    corpusClass: envelope.corpusClass,
    provisional: envelope.provisional,
    status: resolveBirthStatus(envelope.statusProvided ? envelope.status : undefined, existing?.status),
    freshness: envelope.freshness,
    recallCue: envelope.recallCue,
    provenance: envelope.provenance,
    evidenceLocators: envelope.evidenceLocators,
    recordedAt: envelope.recordedAt,
    lastVerified: envelope.lastVerified,
    locator: envelope.locator,
    source: envelope.source,
    capturedAt: envelope.capturedAt,
    quoteSource: envelope.quoteSource,
    supersedes: envelope.supersedes,
  };
}

export function recordMemoryEnvelope(store: MemoryStore, envelope: MemoryEnvelopeRecord, input: MemoryRecordInput = {}, nowIso = new Date().toISOString()): MemoryRecordResult {
  const normalized = normalizeMemoryStore(store);
  const existingIndex = normalized.records.findIndex((record) => record.id === envelope.id);
  const existing = existingIndex >= 0 ? normalized.records[existingIndex] : undefined;
  const record = envelopeToRecord(envelope, existing, input, nowIso);
  const records = normalized.records.slice();
  if (existingIndex >= 0) records[existingIndex] = record;
  else records.push(record);
  return { store: { version: 1, records }, record, created: existingIndex < 0 };
}

export type DirectSupersessionResult =
  | { ok: true; store: MemoryStore }
  | { ok: false; store: MemoryStore; error: 'supersedes.self' | 'supersedes.not_found' };

/**
 * Demote the direct predecessor without mutating either input. The caller owns
 * recording the successor first, then persists this returned store atomically.
 */
export function applyDirectSupersession(store: MemoryStore, successor: Pick<MemoryRecord, 'id' | 'supersedes'>): DirectSupersessionResult {
  const normalized = normalizeMemoryStore(store);
  const successorId = normalizeMemoryRefId(successor.id);
  const priorId = normalizeMemoryRefId(successor.supersedes);
  if (!priorId) return { ok: true, store: normalized };
  if (priorId === successorId) return { ok: false, store: normalized, error: 'supersedes.self' };
  const priorIndex = normalized.records.findIndex((record) => record.id === priorId);
  if (priorIndex < 0) return { ok: false, store: normalized, error: 'supersedes.not_found' };
  const records = normalized.records.slice();
  records[priorIndex] = { ...records[priorIndex], status: 'superseded' };
  return { ok: true, store: { version: 1, records } };
}

export function transitionMemoryStatus(store: MemoryStore, id: unknown, status: unknown, nowIso = new Date().toISOString()): MemoryStatusTransitionResult {
  const normalized = normalizeMemoryStore(store);
  const cleanId = normalizeMemoryRefId(id);
  if (!cleanId) return { ok: false, store: normalized, error: 'memory status transition needs a record id.' };
  if (typeof status !== 'string' || !(MEMORY_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, store: normalized, error: `memory status transition needs one of: ${MEMORY_STATUSES.join(', ')}.` };
  }
  const index = normalized.records.findIndex((record) => record.id === cleanId);
  if (index < 0) return { ok: false, store: normalized, error: `memory record not found: ${cleanId}` };
  const records = normalized.records.slice();
  const record = { ...records[index], status: status as MemoryRoutingStatus, updatedAt: nowIso };
  records[index] = record;
  return { ok: true, store: { version: 1, records }, record };
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
      verb: isMemoryVerb(record.verb) ? record.verb : undefined,
      corpusClass: record.corpusClass === 2 || record.corpusClass === 3 || record.corpusClass === 4 || record.corpusClass === 5 ? record.corpusClass : undefined,
      provisional: typeof record.provisional === 'boolean' ? record.provisional : undefined,
      status: normalizeMemoryStatus(record.status),
      freshness: record.freshness ? normalizeMemoryFreshness(record.freshness) : undefined,
      recallCue: clampText(record.recallCue, 600) || undefined,
      provenance: clampText(record.provenance, 500) || undefined,
      evidenceLocators: normalizeLocatorList(record.evidenceLocators),
      recordedAt: clampText(record.recordedAt, 64) || undefined,
      lastVerified: record.lastVerified &&
        typeof record.lastVerified === 'object' &&
        typeof record.lastVerified.at === 'string' &&
        typeof record.lastVerified.locator === 'string'
        ? { at: clampText(record.lastVerified.at, 64), locator: clampText(record.lastVerified.locator, 500) }
        : undefined,
      locator: clampText(record.locator, 500) || undefined,
      source: clampText(record.source, 500) || undefined,
      capturedAt: clampText(record.capturedAt, 80) || undefined,
      quoteSource: clampText(record.quoteSource, 500) || undefined,
      supersedes: normalizeMemoryRefId(record.supersedes) || undefined,
      readCount: typeof record.readCount === 'number' && Number.isFinite(record.readCount) && record.readCount > 0 ? Math.floor(record.readCount) : undefined,
      lastReadAt: clampText(record.lastReadAt, 64) || undefined,
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

export function tokenizeMemoryText(value: string): string[] {
  const normalized = value
    .normalize('NFKC')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  const raw = normalized.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  const out: string[] = [];
  for (const part of raw) {
    out.push(part);
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(part)) {
      const chars = [...part];
      out.push(...chars);
      for (let i = 0; i < chars.length - 1; i += 1) out.push(`${chars[i]}${chars[i + 1]}`);
      for (let i = 0; i < chars.length - 2; i += 1) out.push(`${chars[i]}${chars[i + 1]}${chars[i + 2]}`);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

export function parseRecallLimit(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_RECALL_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RECALL_LIMIT;
  return Math.max(1, Math.min(MAX_RECALL_LIMIT, parsed));
}

export interface MemorySearchDocument {
  id: string;
  title: string;
  tags: string;
  scope: string;
  recallCue: string;
  content: string;
  evidence: string;
  evidenceLocators: string;
}

export interface MemoryFacet {
  value: string;
  count: number;
}

export interface MemoryFacetStats {
  total: number;
  scopes: MemoryFacet[];
  tags: MemoryFacet[];
  statuses: MemoryFacet[];
  classes: MemoryFacet[];
}

export interface MemorySearchBucket {
  records: MemoryRecord[];
  byId: Map<string, MemoryRecord>;
  search: MiniSearch<MemorySearchDocument>;
}

export interface MemoryRecallIndex {
  records: MemoryRecord[];
  facets: MemoryFacetStats;
  all: MemorySearchBucket;
  scopes: Map<string, MemorySearchBucket>;
}

export interface MemoryOverviewOptions {
  threshold: number;
  scopeLimit?: number;
  tagLimit?: number;
  statusLimit?: number;
  classLimit?: number;
}

const MEMORY_SEARCH_FIELDS = ['title', 'tags', 'scope', 'recallCue', 'content', 'evidence', 'evidenceLocators'];
const MEMORY_SEARCH_BOOST = {
  title: 8,
  tags: 5,
  scope: 4,
  recallCue: 4,
  content: 2,
  evidence: 1,
  evidenceLocators: 1,
};

function memorySearchDocument(record: MemoryRecord): MemorySearchDocument {
  return {
    id: record.id,
    title: record.title,
    tags: record.tags.join(' '),
    scope: record.scope,
    recallCue: record.recallCue ?? '',
    content: record.content,
    evidence: record.evidence,
    evidenceLocators: (record.evidenceLocators ?? []).join(' '),
  };
}

function buildMemorySearch(records: MemoryRecord[]): MiniSearch<MemorySearchDocument> {
  const search = new MiniSearch<MemorySearchDocument>({
    idField: 'id',
    fields: MEMORY_SEARCH_FIELDS,
    storeFields: ['id'],
    tokenize: tokenizeMemoryText,
  });
  search.addAll(records.map(memorySearchDocument));
  return search;
}

function buildMemoryBucket(records: MemoryRecord[]): MemorySearchBucket {
  return {
    records,
    byId: new Map(records.map((record) => [record.id, record])),
    search: buildMemorySearch(records),
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function facetList(map: Map<string, number>): MemoryFacet[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function deriveMemoryFacetStats(records: readonly MemoryRecord[]): MemoryFacetStats {
  const scopes = new Map<string, number>();
  const tags = new Map<string, number>();
  const statuses = new Map<string, number>();
  const classes = new Map<string, number>();
  for (const record of records) {
    increment(scopes, record.scope || DEFAULT_SCOPE);
    for (const tag of record.tags) increment(tags, tag);
    increment(statuses, record.status ?? 'unspecified');
    increment(classes, record.corpusClass !== undefined ? String(record.corpusClass) : 'unspecified');
  }
  return {
    total: records.length,
    scopes: facetList(scopes),
    tags: facetList(tags),
    statuses: facetList(statuses),
    classes: facetList(classes),
  };
}

function facetSummary(label: string, facets: readonly MemoryFacet[], limit: number): string {
  const shown = facets
    .slice(0, limit)
    .map((facet) => `${facet.value}=${facet.count}`)
    .join(' · ');
  const hidden = facets.length > limit ? ` · …(+${facets.length - limit})` : '';
  return `${label}: ${shown || '(none)'}${hidden}`;
}

export function formatMemoryOverview(facets: MemoryFacetStats, options: MemoryOverviewOptions): string {
  const scopeLimit = options.scopeLimit ?? 20;
  const tagLimit = options.tagLimit ?? 40;
  const statusLimit = options.statusLimit ?? 8;
  const classLimit = options.classLimit ?? 8;
  return [
    `[Braid memory overview] Total: ${facets.total} memories. Complete catalog omitted because total exceeds threshold ${options.threshold}.`,
    facetSummary('By scope', facets.scopes, scopeLimit),
    facetSummary('By tag', facets.tags, tagLimit),
    facetSummary('By status', facets.statuses, statusLimit),
    facetSummary('By class', facets.classes, classLimit),
    '',
    'This overview is aggregate navigation only; it contains no host-curated relevant/high-value memory list.',
    'Use braid.memory_recall(query, scope?, limit?) to search candidates.',
    'Use braid.memory_get(id) to read one full record before relying on details.',
    'Use braid.memory_catalog(scope?, tag?, status?, class?, page?) to browse a bounded mechanical slice.',
    'Write with braid.memory_record using verb=locator|snapshot|lesson|transcript.',
  ].join('\n');
}

export function createMemoryRecallIndex(store: MemoryStore): MemoryRecallIndex {
  const normalized = normalizeMemoryStore(store);
  return {
    records: normalized.records,
    facets: deriveMemoryFacetStats(normalized.records),
    all: buildMemoryBucket(normalized.records),
    scopes: new Map(),
  };
}

function scopedBucket(index: MemoryRecallIndex, scope: string): MemorySearchBucket {
  if (!scope) return index.all;
  const key = scope.toLowerCase();
  const existing = index.scopes.get(key);
  if (existing) return existing;
  const bucket = buildMemoryBucket(index.records.filter((record) => record.scope.toLowerCase() === key));
  index.scopes.set(key, bucket);
  return bucket;
}

function newestCandidates(records: MemoryRecord[], limit: number): MemoryRecord[] {
  return records
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

const LEXICAL_SOURCE: RecallSource = Object.freeze({ kind: 'lexical', provenance: 'minisearch' });
const RECENCY_SOURCE: RecallSource = Object.freeze({ kind: 'recency', provenance: 'updatedAt' });

function semanticSource(modelFingerprint: string): RecallSource {
  return Object.freeze({ kind: 'semantic', provenance: 'session-local', modelFingerprint });
}

function candidate(record: MemoryRecord, source: RecallSource, value: number): MemoryRecallCandidate {
  return Object.freeze({
    record,
    source,
    scores: Object.freeze([Object.freeze({ source, value })]),
  });
}

function candidateWithSemanticScore(candidate: MemoryRecallCandidate, score: number, modelFingerprint: string): MemoryRecallCandidate {
  const source = semanticSource(modelFingerprint);
  return Object.freeze({
    ...candidate,
    scores: Object.freeze([...candidate.scores, Object.freeze({ source, value: score })]),
  });
}

function recencyCandidates(records: MemoryRecord[], limit: number): MemoryRecallCandidate[] {
  const newest = newestCandidates(records, limit);
  return newest.map((record, index) => candidate(record, RECENCY_SOURCE, newest.length - index));
}

function lexicalCandidates(bucket: MemorySearchBucket, query: string): MemoryRecallCandidate[] {
  const results = bucket.search.search(query, {
    boost: MEMORY_SEARCH_BOOST,
    combineWith: 'OR',
    prefix: (term) => term.length >= 2,
    fuzzy: (term) => term.length >= 4 ? 0.2 : false,
    maxFuzzy: 2,
    weights: { prefix: 0.8, fuzzy: 0.45 },
  });

  return results
    .map((result) => {
      const record = bucket.byId.get(String(result.id));
      return record ? { record, score: result.score } : undefined;
    })
    .filter((entry): entry is { record: MemoryRecord; score: number } => !!entry)
    .sort((a, b) =>
      b.score - a.score ||
      recallRoutingDemotion(a.record) - recallRoutingDemotion(b.record) ||
      b.record.updatedAt.localeCompare(a.record.updatedAt) ||
      a.record.title.localeCompare(b.record.title))
    .map((entry) => candidate(entry.record, LEXICAL_SOURCE, entry.score));
}

function recallRoutingDemotion(record: MemoryRecord): number {
  return record.status === 'superseded' || record.status === 'disputed' ? 1 : 0;
}

export interface MemoryRecallCandidateMergeInput {
  lexical: readonly MemoryRecallCandidate[];
  semantic: readonly SemanticRecallMatch[];
  records: readonly MemoryRecord[];
  recency: readonly MemoryRecord[];
  limit: number;
  semanticModelFingerprint?: string;
}

/**
 * Pure, deterministic rank bands: lexical order is immutable; semantic-only
 * follows; recency only fills remaining slots. Scores are provenance, not a
 * numerical blended relevance claim.
 */
export function mergeRecallCandidateBands(input: MemoryRecallCandidateMergeInput): MemoryRecallCandidate[] {
  const limit = Math.max(0, input.limit);
  if (!limit) return [];

  const records = new Map(input.records.map((record) => [record.id, record]));
  const semanticById = new Map<string, SemanticRecallMatch>();
  for (const match of input.semantic) {
    if (!match.id || !Number.isFinite(match.score) || !records.has(match.id)) continue;
    const existing = semanticById.get(match.id);
    if (!existing || match.score > existing.score || (match.score === existing.score && match.id < existing.id)) {
      semanticById.set(match.id, match);
    }
  }

  const out: MemoryRecallCandidate[] = [];
  const seen = new Set<string>();
  for (const lexical of input.lexical) {
    if (seen.has(lexical.record.id)) continue;
    seen.add(lexical.record.id);
    const semantic = semanticById.get(lexical.record.id);
    out.push(semantic
      ? candidateWithSemanticScore(lexical, semantic.score, semantic.modelFingerprint ?? input.semanticModelFingerprint ?? 'unknown')
      : lexical);
    if (out.length === limit) return out;
  }

  const semanticOnly = [...semanticById.values()]
    .filter((match) => !seen.has(match.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  for (const match of semanticOnly) {
    const record = records.get(match.id);
    if (!record) continue;
    seen.add(record.id);
    out.push(candidate(record, semanticSource(match.modelFingerprint ?? input.semanticModelFingerprint ?? 'unknown'), match.score));
    if (out.length === limit) return out;
  }

  for (const record of input.recency) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(candidate(record, RECENCY_SOURCE, input.recency.length - out.length));
    if (out.length === limit) break;
  }
  return out;
}

export function recallCandidatesFromIndex(
  index: MemoryRecallIndex,
  input: MemoryRecallInput,
  options: MemoryRecallCandidateOptions = {},
): MemoryRecallCandidate[] {
  const query = clampText(input.query, 500);
  const queryTokens = tokenizeMemoryText(query);
  const scope = clampText(input.scope, MAX_SCOPE);
  const limit = parseRecallLimit(input.limit);
  const bucket = scopedBucket(index, scope);
  const semanticEnabled = options.semantic !== undefined;
  // Never dead-end while memories exist (ADR-10): a scope matching nothing falls back to newest candidates
  // across the whole store; a token-less query falls back to newest within the resolved scope.
  const fallbackRecords = bucket.records.length ? bucket.records : index.records;
  if (!queryTokens.length || !bucket.records.length) {
    if (!semanticEnabled) return recencyCandidates(fallbackRecords, limit);
    return mergeRecallCandidateBands({
      lexical: [], semantic: options.semantic ?? [], records: fallbackRecords,
      recency: newestCandidates(fallbackRecords, limit), limit,
      semanticModelFingerprint: options.semanticModelFingerprint,
    });
  }

  const lexical = lexicalCandidates(bucket, query);
  if (!semanticEnabled) {
    return lexical.length ? lexical.slice(0, limit) : recencyCandidates(bucket.records, limit);
  }
  return mergeRecallCandidateBands({
    lexical,
    semantic: options.semantic ?? [],
    records: bucket.records,
    recency: newestCandidates(bucket.records, limit),
    limit,
    semanticModelFingerprint: options.semanticModelFingerprint,
  });
}

export function recallMemoriesFromIndex(index: MemoryRecallIndex, input: MemoryRecallInput): MemoryRecord[] {
  return recallCandidatesFromIndex(index, input).map((candidate) => candidate.record);
}

export function recallMemories(store: MemoryStore, input: MemoryRecallInput): MemoryRecord[] {
  return recallMemoriesFromIndex(createMemoryRecallIndex(store), input);
}

export function recordMemoryReads(store: MemoryStore, ids: readonly string[], nowIso = new Date().toISOString()): MemoryStore {
  const normalized = normalizeMemoryStore(store);
  const hit = new Set(ids);
  if (!hit.size) return normalized;
  return {
    version: 1,
    records: normalized.records.map((record) => {
      if (!hit.has(record.id)) return record;
      return {
        ...record,
        readCount: (record.readCount ?? 0) + 1,
        lastReadAt: nowIso,
        updatedAt: record.updatedAt,
      };
    }),
  };
}

// A locator cites another memory only by an EXACT id or a `memory:<id>` token — never by arbitrary
// substring. The old `locator.includes(id)` scan was O(records) per locator (→ O(records²) overall) and
// produced false positives; this keeps derivation O(total locators) so large stores stay linear.
const MEMORY_ID_REF_RE = /memory:([A-Za-z0-9._-]+)/g;

function referencedMemoryIds(locator: string, ids: ReadonlySet<string>): string[] {
  const trimmed = locator.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  if (ids.has(trimmed)) out.push(trimmed);
  MEMORY_ID_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEMORY_ID_REF_RE.exec(locator)) !== null) {
    if (ids.has(match[1]) && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

export function deriveEvidenceCitationCounts(store: MemoryStore): Record<string, number> {
  const normalized = normalizeMemoryStore(store);
  const ids = new Set(normalized.records.map((record) => record.id));
  const counts: Record<string, number> = {};
  for (const record of normalized.records) {
    for (const locator of record.evidenceLocators ?? []) {
      for (const referencedId of referencedMemoryIds(locator, ids)) {
        if (referencedId === record.id) continue;
        counts[referencedId] = (counts[referencedId] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export interface MemoryCatalogOptions {
  staleIds?: ReadonlySet<string>;
}

const GROUPS: Array<{ verb: MemoryWriteVerb; label: string }> = [
  { verb: 'lesson', label: '教训(agent 解读,承重前走它带的证据复验)' },
  { verb: 'locator', label: '线索(纯指针,零风险)' },
  { verb: 'snapshot', label: '快照(逐字拷贝,会腐)' },
  { verb: 'transcript', label: '用户原话(逐字)' },
];

function recordVerb(record: MemoryRecord): MemoryWriteVerb {
  return isMemoryVerb(record.verb) ? record.verb : 'lesson';
}

function compactCatalogText(value: string | undefined, max = 80): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

export function formatMemoryCatalog(store: MemoryStore, options: MemoryCatalogOptions = {}): string {
  const normalized = normalizeMemoryStore(store);
  const citations = deriveEvidenceCitationCounts(normalized);
  const lines: string[] = [
    `[Braid memory] ${normalized.records.length} 条。深读:memory_recall 或 memory id;搜:memory_recall;记:四动词。`,
    '标记:⚠ = 记录后源码变过,先复验 | † = 非 current(stale/disputed) | ←N = 被 N 条记录引为证据',
    '',
  ];

  for (const group of GROUPS) {
    const records = normalized.records
      .filter((record) => recordVerb(record) === group.verb)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
    if (!records.length) continue;
    lines.push(`■ ${group.label} — ${records.length} 条`);
    for (const record of records) {
      const marks = [
        record.status && record.status !== 'current' ? '†' : '',
        options.staleIds?.has(record.id) ? '⚠' : '',
        citations[record.id] ? `←${citations[record.id]}` : '',
      ].filter(Boolean).join(' ');
      const cue = compactCatalogText(record.recallCue || record.content || record.locator || record.evidence);
      lines.push(`- ${compactCatalogText(record.title, 64)} — ${cue} → memory:${record.id}${marks ? ` ${marks}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
