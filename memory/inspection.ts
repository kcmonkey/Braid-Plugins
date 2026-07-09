import {
  deriveEvidenceCitationCounts,
  normalizeMemoryStore,
  type MemoryRecord,
  type MemoryStore,
} from './model';

export const MEMORY_INSPECTION_STATE_KEY = 'memoryInspection';

export interface MemoryInspectionRecord {
  id: string;
  title: string;
  verb: string;
  corpusClass: number | undefined;
  status: string;
  freshness: string;
  recallCue: string;
  provenance: string;
  evidenceLocators: string[];
  readCount: number;
  citedByCount: number;
  updatedAt: string;
}

export interface MemoryInspectionSnapshot {
  total: number;
  records: MemoryInspectionRecord[];
  counts: {
    locator: number;
    snapshot: number;
    lesson: number;
    transcript: number;
    disputed: number;
    stale: number;
  };
}

export function emptyMemoryInspectionSnapshot(): MemoryInspectionSnapshot {
  return {
    total: 0,
    records: [],
    counts: { locator: 0, snapshot: 0, lesson: 0, transcript: 0, disputed: 0, stale: 0 },
  };
}

export function createMemoryInspectionSnapshot(store: MemoryStore): MemoryInspectionSnapshot {
  const normalized = normalizeMemoryStore(store);
  const citations = deriveEvidenceCitationCounts(normalized);
  const records = normalized.records
    .map((record) => inspectRecord(record, citations[record.id] ?? 0))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  const counts = emptyMemoryInspectionSnapshot().counts;
  for (const record of records) {
    if (record.verb === 'locator') counts.locator += 1;
    else if (record.verb === 'snapshot') counts.snapshot += 1;
    else if (record.verb === 'transcript') counts.transcript += 1;
    else counts.lesson += 1;
    if (record.status === 'disputed') counts.disputed += 1;
    if (record.status === 'stale') counts.stale += 1;
  }
  return { total: records.length, records, counts };
}

function inspectRecord(record: MemoryRecord, citedByCount: number): MemoryInspectionRecord {
  return {
    id: record.id,
    title: record.title,
    verb: record.verb ?? 'lesson',
    corpusClass: record.corpusClass,
    status: record.status ?? 'stale',
    freshness: record.freshness ?? 'unverified',
    recallCue: record.recallCue ?? '',
    provenance: record.provenance ?? '',
    evidenceLocators: record.evidenceLocators ?? [],
    readCount: record.readCount ?? 0,
    citedByCount,
    updatedAt: record.updatedAt,
  };
}
