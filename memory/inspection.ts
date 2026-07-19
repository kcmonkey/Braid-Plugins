import {
  deriveEvidenceCitationCounts,
  normalizeMemoryStore,
  type MemoryCorpusClass,
  type MemoryFreshness,
  type MemoryRecord,
  type MemoryRoutingStatus,
  type MemoryStore,
  type MemoryWriteVerb,
} from './model';

export const MEMORY_INSPECTION_STATE_KEY = 'memoryInspection';
export const MEMORY_INSPECTION_SCHEMA_VERSION = 2;
export const MEMORY_INSPECTION_ACTIONS = ['inspectDetail', 'refreshInspection'] as const;

export type MemoryInspectionAction = typeof MEMORY_INSPECTION_ACTIONS[number];

export type MemoryInspectionAvailability = 'available' | 'stale' | 'unavailable';
export type MemoryInspectionSourceCheck = 'not-checked' | 'locator-present' | 'locator-missing';

export interface MemoryInspectionRecord {
  id: string;
  title: string;
  verb: MemoryWriteVerb;
  corpusClass: MemoryCorpusClass;
  status: MemoryRoutingStatus;
  freshness: MemoryFreshness;
  provisional: boolean;
  scope: string;
  tags: string[];
  recallCue: string;
  provenance: string;
  evidenceLocatorCount: number;
  readCount: number;
  citedByCount: number;
  updatedAt: string;
  sourceCheck: MemoryInspectionSourceCheck;
}

export interface MemoryInspectionCounts {
  total: number;
  locator: number;
  snapshot: number;
  lesson: number;
  transcript: number;
  current: number;
  stale: number;
  superseded: number;
  disputed: number;
  verified: number;
  unverified: number;
  provisional: number;
  final: number;
  sourceNotChecked: number;
  sourceLocatorPresent: number;
  sourceLocatorMissing: number;
}

const MEMORY_INSPECTION_RECORD_KEYS: ReadonlyArray<keyof MemoryInspectionRecord> = [
  'id',
  'title',
  'verb',
  'corpusClass',
  'status',
  'freshness',
  'provisional',
  'scope',
  'tags',
  'recallCue',
  'provenance',
  'evidenceLocatorCount',
  'readCount',
  'citedByCount',
  'updatedAt',
  'sourceCheck',
];

const MEMORY_INSPECTION_COUNT_KEYS: ReadonlyArray<keyof MemoryInspectionCounts> = [
  'total',
  'locator',
  'snapshot',
  'lesson',
  'transcript',
  'current',
  'stale',
  'superseded',
  'disputed',
  'verified',
  'unverified',
  'provisional',
  'final',
  'sourceNotChecked',
  'sourceLocatorPresent',
  'sourceLocatorMissing',
];

interface MemoryInspectionSnapshotBase {
  schemaVersion: typeof MEMORY_INSPECTION_SCHEMA_VERSION;
  generatedAt: string;
  availability: MemoryInspectionAvailability;
  total: number;
  records: MemoryInspectionRecord[];
  counts: MemoryInspectionCounts;
}

export interface MemoryInspectionReadySnapshot extends MemoryInspectionSnapshotBase {
  kind: 'ready';
  availability: 'available' | 'stale';
}

export interface MemoryInspectionErrorSnapshot extends MemoryInspectionSnapshotBase {
  kind: 'error';
  availability: 'unavailable';
  error: string;
}

export type MemoryInspectionSnapshot = MemoryInspectionReadySnapshot | MemoryInspectionErrorSnapshot;

export type MemoryInspectionActionResult =
  | { ok: true; action: 'inspectDetail'; record: MemoryInspectionRecord }
  | { ok: true; action: 'refreshInspection' }
  | { ok: false; error: string };

/** Old state can survive a webview reload while the host and panel update independently. */
export interface LegacyMemoryInspectionSnapshot {
  total?: number;
  records?: Array<Partial<MemoryInspectionRecord> & { evidenceLocators?: string[] }>;
  counts?: Partial<MemoryInspectionCounts>;
}

export type MemoryInspectionPanelSnapshot = MemoryInspectionSnapshot | LegacyMemoryInspectionSnapshot;

export function emptyMemoryInspectionSnapshot(generatedAt = new Date().toISOString()): MemoryInspectionReadySnapshot {
  return {
    kind: 'ready',
    schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
    generatedAt,
    availability: 'available',
    total: 0,
    records: [],
    counts: emptyCounts(),
  };
}

export function errorMemoryInspectionSnapshot(error: string, generatedAt = new Date().toISOString()): MemoryInspectionErrorSnapshot {
  return {
    ...emptyMemoryInspectionSnapshot(generatedAt),
    kind: 'error',
    availability: 'unavailable',
    error,
  };
}

export function createMemoryInspectionSnapshot(store: MemoryStore, generatedAt = new Date().toISOString()): MemoryInspectionReadySnapshot {
  const normalized = normalizeMemoryStore(store);
  const citations = deriveEvidenceCitationCounts(normalized);
  const records = normalized.records
    .map((record) => inspectRecord(record, citations[record.id] ?? 0))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return {
    kind: 'ready',
    schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
    generatedAt,
    availability: 'available',
    total: records.length,
    records,
    counts: countRecords(records),
  };
}

export function parseMemoryInspectionAction(action: unknown, payload: unknown):
  | { ok: true; action: 'inspectDetail'; id: string }
  | { ok: true; action: 'refreshInspection' }
  | { ok: false; error: string } {
  if (!MEMORY_INSPECTION_ACTIONS.includes(action as MemoryInspectionAction)) {
    return { ok: false, error: 'Unsupported memory inspection action.' };
  }
  if (action === 'inspectDetail') {
    const id = payload && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === 1 && typeof (payload as { id?: unknown }).id === 'string'
      ? (payload as { id: string }).id.trim()
      : '';
    return id ? { ok: true, action, id } : { ok: false, error: 'inspectDetail requires a non-empty memory id.' };
  }
  if (action === 'refreshInspection') {
    return payload === undefined
      ? { ok: true, action }
      : { ok: false, error: 'refreshInspection does not accept a payload.' };
  }
  return { ok: false, error: 'Malformed memory inspection action.' };
}

export function isMemoryInspectionActionResult(value: unknown): value is MemoryInspectionActionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as { ok?: unknown; action?: unknown; record?: unknown; error?: unknown };
  if (result.ok === false) return typeof result.error === 'string';
  return result.ok === true && (
    result.action === 'refreshInspection'
    || (result.action === 'inspectDetail' && isMemoryInspectionRecord(result.record))
  );
}

function isMemoryInspectionRecord(value: unknown): value is MemoryInspectionRecord {
  if (!isObjectRecord(value) || !hasExactKeys(value, MEMORY_INSPECTION_RECORD_KEYS)) return false;
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && isVerb(value.verb)
    && isCorpusClass(value.corpusClass)
    && isStatus(value.status)
    && isFreshness(value.freshness)
    && typeof value.provisional === 'boolean'
    && typeof value.scope === 'string'
    && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')
    && typeof value.recallCue === 'string'
    && typeof value.provenance === 'string'
    && isNonNegativeCount(value.evidenceLocatorCount)
    && isNonNegativeCount(value.readCount)
    && isNonNegativeCount(value.citedByCount)
    && typeof value.updatedAt === 'string'
    && isSourceCheck(value.sourceCheck);
}

/**
 * Converts an in-flight v1 panel payload to list-safe v2 rows. A legacy payload is
 * marked stale because its schema is older, never because a record lacks a locator.
 */
export function normalizeMemoryInspectionPanelSnapshot(data: MemoryInspectionPanelSnapshot | null | undefined): MemoryInspectionSnapshot | null {
  if (data == null) return null;
  if (isMemoryInspectionSnapshot(data)) return data;
  if (isV2SchemaPayload(data) || !isObjectRecord(data)) {
    return errorMemoryInspectionSnapshot('Malformed memory inspection snapshot.');
  }
  const legacyRows = Array.isArray(data.records) ? data.records.filter(isObjectRecord) : [];
  const records = legacyRows.map((record) => normalizeLegacyRecord(record as Partial<MemoryInspectionRecord> & { evidenceLocators?: string[] }));
  return {
    kind: 'ready',
    schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    availability: 'stale',
    total: records.length,
    records,
    counts: countRecords(records),
  };
}

function isMemoryInspectionSnapshot(data: unknown): data is MemoryInspectionSnapshot {
  if (!isObjectRecord(data) || data.schemaVersion !== MEMORY_INSPECTION_SCHEMA_VERSION || !Array.isArray(data.records)) return false;
  if (typeof data.generatedAt !== 'string' || !isNonNegativeCount(data.total) || !isMemoryInspectionCounts(data.counts)) return false;
  if (data.total !== data.records.length || !data.records.every(isMemoryInspectionRecord)) return false;
  const canonicalCounts = countRecords(data.records);
  if (!memoryInspectionCountsEqual(data.counts, canonicalCounts)) return false;
  if (data.kind === 'ready') return data.availability === 'available' || data.availability === 'stale';
  return data.kind === 'error'
    && data.availability === 'unavailable'
    && typeof data.error === 'string'
    && data.records.length === 0;
}

function isMemoryInspectionCounts(value: unknown): value is MemoryInspectionCounts {
  if (!isObjectRecord(value) || !hasExactKeys(value, MEMORY_INSPECTION_COUNT_KEYS)) return false;
  return isNonNegativeCount(value.total)
    && isNonNegativeCount(value.locator)
    && isNonNegativeCount(value.snapshot)
    && isNonNegativeCount(value.lesson)
    && isNonNegativeCount(value.transcript)
    && isNonNegativeCount(value.current)
    && isNonNegativeCount(value.stale)
    && isNonNegativeCount(value.superseded)
    && isNonNegativeCount(value.disputed)
    && isNonNegativeCount(value.verified)
    && isNonNegativeCount(value.unverified)
    && isNonNegativeCount(value.provisional)
    && isNonNegativeCount(value.final)
    && isNonNegativeCount(value.sourceNotChecked)
    && isNonNegativeCount(value.sourceLocatorPresent)
    && isNonNegativeCount(value.sourceLocatorMissing);
}

function memoryInspectionCountsEqual(actual: MemoryInspectionCounts, expected: MemoryInspectionCounts): boolean {
  return MEMORY_INSPECTION_COUNT_KEYS.every((key) => actual[key] === expected[key]);
}

function isV2SchemaPayload(value: unknown): boolean {
  return isObjectRecord(value) && value.schemaVersion === MEMORY_INSPECTION_SCHEMA_VERSION;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isSourceCheck(value: unknown): value is MemoryInspectionSourceCheck {
  return value === 'not-checked' || value === 'locator-present' || value === 'locator-missing';
}

function emptyCounts(): MemoryInspectionCounts {
  return {
    total: 0,
    locator: 0,
    snapshot: 0,
    lesson: 0,
    transcript: 0,
    current: 0,
    stale: 0,
    superseded: 0,
    disputed: 0,
    verified: 0,
    unverified: 0,
    provisional: 0,
    final: 0,
    sourceNotChecked: 0,
    sourceLocatorPresent: 0,
    sourceLocatorMissing: 0,
  };
}

function countRecords(records: MemoryInspectionRecord[]): MemoryInspectionCounts {
  const counts = emptyCounts();
  counts.total = records.length;
  for (const record of records) {
    counts[record.verb] += 1;
    counts[record.status] += 1;
    counts[record.freshness] += 1;
    counts[record.provisional ? 'provisional' : 'final'] += 1;
    if (record.sourceCheck === 'not-checked') counts.sourceNotChecked += 1;
    if (record.sourceCheck === 'locator-present') counts.sourceLocatorPresent += 1;
    if (record.sourceCheck === 'locator-missing') counts.sourceLocatorMissing += 1;
  }
  return counts;
}

function inspectRecord(record: MemoryRecord, citedByCount: number): MemoryInspectionRecord {
  return {
    id: record.id,
    title: record.title,
    verb: record.verb ?? 'lesson',
    corpusClass: record.corpusClass ?? 4,
    status: record.status ?? 'stale',
    freshness: record.freshness ?? 'unverified',
    provisional: record.provisional ?? true,
    scope: boundedText(record.scope, 160),
    tags: (record.tags ?? []).slice(0, 16).map((tag) => boundedText(tag, 64)).filter(Boolean),
    recallCue: boundedText(record.recallCue, 240),
    provenance: boundedText(record.provenance, 160),
    evidenceLocatorCount: record.evidenceLocators?.length ?? 0,
    readCount: record.readCount ?? 0,
    citedByCount,
    updatedAt: record.updatedAt,
    sourceCheck: sourceCheckFor(record),
  };
}

function normalizeLegacyRecord(record: Partial<MemoryInspectionRecord> & { evidenceLocators?: string[] }): MemoryInspectionRecord {
  const verb = isVerb(record.verb) ? record.verb : 'lesson';
  const status = isStatus(record.status) ? record.status : 'stale';
  const freshness = isFreshness(record.freshness) ? record.freshness : 'unverified';
  return {
    id: record.id ?? '',
    title: boundedText(record.title, 240) || 'Untitled memory',
    verb,
    corpusClass: isCorpusClass(record.corpusClass) ? record.corpusClass : 4,
    status,
    freshness,
    provisional: record.provisional ?? (verb === 'lesson' || freshness === 'unverified'),
    scope: boundedText(record.scope, 160),
    tags: Array.isArray(record.tags) ? record.tags.slice(0, 16).map((tag) => boundedText(tag, 64)).filter(Boolean) : [],
    recallCue: boundedText(record.recallCue, 240),
    provenance: boundedText(record.provenance, 160),
    evidenceLocatorCount: Array.isArray(record.evidenceLocators) ? record.evidenceLocators.length : record.evidenceLocatorCount ?? 0,
    readCount: record.readCount ?? 0,
    citedByCount: record.citedByCount ?? 0,
    updatedAt: record.updatedAt ?? '',
    sourceCheck: record.sourceCheck ?? 'not-checked',
  };
}

function sourceCheckFor(record: MemoryRecord): MemoryInspectionSourceCheck {
  const locator = record.locator ?? record.source ?? record.quoteSource ?? record.lastVerified?.locator;
  if (locator?.trim()) return 'locator-present';
  return record.verb === 'locator' || record.verb === 'snapshot' || record.verb === 'transcript'
    ? 'locator-missing'
    : 'not-checked';
}

function boundedText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function isVerb(value: unknown): value is MemoryWriteVerb {
  return value === 'locator' || value === 'snapshot' || value === 'lesson' || value === 'transcript';
}

function isCorpusClass(value: unknown): value is MemoryCorpusClass {
  return value === 2 || value === 3 || value === 4 || value === 5;
}

function isStatus(value: unknown): value is MemoryRoutingStatus {
  return value === 'current' || value === 'stale' || value === 'superseded' || value === 'disputed';
}

function isFreshness(value: unknown): value is MemoryFreshness {
  return value === 'verified' || value === 'unverified';
}
