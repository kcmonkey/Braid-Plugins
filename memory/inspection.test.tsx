import { describe, expect, it } from 'vitest';
import { birthMemoryEnvelope, emptyMemoryStore, recordMemoryEnvelope, type MemoryStore } from './model';
import {
  MEMORY_INSPECTION_SCHEMA_VERSION,
  createMemoryInspectionSnapshot,
  errorMemoryInspectionSnapshot,
  normalizeMemoryInspectionPanelSnapshot,
  parseMemoryInspectionAction,
} from './inspection';

// Essential non-E2E exception: malformed host payloads and privacy-boundary
// violations cannot be produced safely through the shipped UI without corrupting
// persistent data. Remove these checks when the protocol seam has a shared,
// independently verified schema validator.

function add(store: MemoryStore, input: Record<string, unknown>, now: string): MemoryStore {
  const born = birthMemoryEnvelope({
    title: 'Record',
    recallCue: 'When inspecting memory records.',
    provenance: 'inspection.test',
    status: 'current',
    ...input,
  }, now);
  if (!born.ok) throw new Error(born.errors.map((err) => err.code).join(','));
  return recordMemoryEnvelope(store, born.record).store;
}

function validInspectionSnapshot() {
  const record = {
    id: 'snapshot-1', title: 'Safe snapshot', verb: 'snapshot', corpusClass: 3,
    status: 'current', freshness: 'verified', provisional: false, scope: 'memory',
    tags: ['safe'], recallCue: 'Find this safely.', provenance: 'inspection.test',
    evidenceLocatorCount: 0, readCount: 0, citedByCount: 0,
    updatedAt: '2026-07-06T00:00:00.000Z', sourceCheck: 'locator-missing',
  };
  return {
    kind: 'ready' as const, schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
    generatedAt: '2026-07-06T00:00:00.000Z', availability: 'available' as const,
    total: 1, records: [record],
    counts: {
      total: 1, locator: 0, snapshot: 1, lesson: 0, transcript: 0,
      current: 1, stale: 0, superseded: 0, disputed: 0, verified: 1, unverified: 0,
      provisional: 0, final: 1, sourceNotChecked: 0, sourceLocatorPresent: 0, sourceLocatorMissing: 1,
    },
  };
}

describe('memory inspection fail-closed contracts', () => {
  it('keeps the action grammar closed to metadata-only detail and payload-free refresh', () => {
    expect(parseMemoryInspectionAction('inspectDetail', { id: ' memory-1 ' })).toEqual({ ok: true, action: 'inspectDetail', id: 'memory-1' });
    expect(parseMemoryInspectionAction('refreshInspection', undefined)).toEqual({ ok: true, action: 'refreshInspection' });
    expect(parseMemoryInspectionAction('inspectDetail', { id: 'memory-1', includeBody: true })).toMatchObject({ ok: false });
    expect(parseMemoryInspectionAction('refreshInspection', {})).toMatchObject({ ok: false });
    expect(parseMemoryInspectionAction('mutateMemory', undefined)).toMatchObject({ ok: false });
  });

  it('creates a discriminated, list-safe ready snapshot with bounded metadata and independent lifecycle axes', () => {
    let store = emptyMemoryStore();
    store = add(store, {
      verb: 'snapshot',
      title: 'Snapshot',
      content: 'PRIVATE BODY MUST NOT CROSS THE INSPECTION SEAM',
      source: 'docs/private-snapshot.md',
      capturedAt: '2026-07-05T00:00:00.000Z',
      status: 'current',
      freshness: 'verified',
      lastVerifiedLocator: 'docs/private-snapshot.md',
      provisional: false,
      recallCue: ` ${'cue '.repeat(80)}`,
      provenance: ` ${'provenance '.repeat(40)}`,
      evidenceLocators: ['raw://private-evidence-a', 'raw://private-evidence-b'],
    }, '2026-07-05T00:00:00.000Z');
    // A persisted record can outlive an unavailable source; inspection must surface
    // that independently rather than downgrade its routing status.
    store.records[0] = {
      ...store.records[0],
      source: '',
      lastVerified: undefined,
      tags: Array.from({ length: 20 }, (_, index) => `${index}-${'tag '.repeat(20)}`),
    };

    const snapshot = createMemoryInspectionSnapshot(store, '2026-07-06T00:00:00.000Z');
    const row = snapshot.records[0];

    expect(snapshot).toMatchObject({
      kind: 'ready',
      schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
      generatedAt: '2026-07-06T00:00:00.000Z',
      availability: 'available',
      total: 1,
      counts: {
        total: 1, snapshot: 1, current: 1, verified: 1, final: 1,
        sourceLocatorMissing: 1, stale: 0, unverified: 0, provisional: 0,
      },
    });
    expect(row).toMatchObject({ status: 'current', freshness: 'verified', provisional: false, sourceCheck: 'locator-missing', evidenceLocatorCount: 2 });
    expect(Object.keys(row).sort()).toEqual([
      'citedByCount', 'corpusClass', 'evidenceLocatorCount', 'freshness', 'id', 'provenance',
      'readCount', 'recallCue', 'scope', 'sourceCheck', 'status', 'tags', 'title', 'updatedAt', 'verb', 'provisional',
    ].sort());
    expect(row.recallCue.length).toBeLessThanOrEqual(240);
    expect(row.provenance.length).toBeLessThanOrEqual(160);
    expect(row.tags.length).toBeGreaterThan(0);
    expect(row.tags.length).toBeLessThanOrEqual(16);
    expect(row.tags.every((tag) => tag.length <= 64)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE BODY');
    expect(JSON.stringify(snapshot)).not.toContain('raw://private-evidence');
  });

  it('uses unavailable error snapshots and normalizes legacy payloads to stale list-safe rows', () => {
    const error = errorMemoryInspectionSnapshot('host offline', '2026-07-06T00:00:00.000Z');
    expect(error).toMatchObject({
      kind: 'error', schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION,
      generatedAt: '2026-07-06T00:00:00.000Z', availability: 'unavailable', error: 'host offline', total: 0,
    });

    const legacy = normalizeMemoryInspectionPanelSnapshot({
      records: [{ id: 'legacy', title: 'Legacy', verb: 'locator', status: 'current', evidenceLocators: ['raw://old'], sourceCheck: 'locator-missing' }],
    });
    expect(legacy).toMatchObject({ kind: 'ready', schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, availability: 'stale', total: 1 });
    expect(legacy?.records[0]).toMatchObject({ status: 'current', sourceCheck: 'locator-missing', evidenceLocatorCount: 1 });
    expect(JSON.stringify(legacy)).not.toContain('evidenceLocators');
    expect(JSON.stringify(legacy)).not.toContain('raw://old');
  });

  it.each([
    { kind: 'ready', schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, records: {}, counts: {} },
    { kind: 'ready', schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, records: [{ id: 7, title: null, tags: 'not-an-array' }], counts: { total: 'one' } },
    { kind: 'ready', schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, records: [], counts: { total: -1, locator: Number.NaN, disputed: 'invalid' } },
  ])('fails closed without crashing for malformed v2 inspection payload %#', (payload) => {
    expect(() => normalizeMemoryInspectionPanelSnapshot(payload)).not.toThrow();
    expect(normalizeMemoryInspectionPanelSnapshot(payload)).toMatchObject({ kind: 'error', availability: 'unavailable' });
  });

  it.each([
    ['content', 'PRIVATE CONTENT'],
    ['evidence', 'PRIVATE EVIDENCE'],
    ['evidenceLocators', ['raw://private-evidence']],
    ['locator', 'file:///private-locator'],
    ['source', 'docs/private-source.md'],
    ['quote', 'PRIVATE QUOTE'],
  ])('fails closed for a schema-v2 row carrying forbidden %s', (field, value) => {
    const snapshot = validInspectionSnapshot();
    const payload = { ...snapshot, records: [{ ...snapshot.records[0], [field]: value }] };
    const normalized = normalizeMemoryInspectionPanelSnapshot(payload as any);

    expect(normalized).toMatchObject({ kind: 'error', availability: 'unavailable' });
    expect(JSON.stringify(normalized)).not.toContain(JSON.stringify(value));
  });

  it.each([
    ['verb', { locator: 1, snapshot: 0 }],
    ['status', { current: 0, stale: 1 }],
    ['freshness', { verified: 0, unverified: 1 }],
    ['provisional', { provisional: 1, final: 0 }],
    ['sourceCheck', { sourceNotChecked: 1, sourceLocatorMissing: 0 }],
  ])('fails closed for a schema-v2 snapshot with forged %s aggregates', (axis, forgedCounts) => {
    const snapshot = validInspectionSnapshot();
    const payload = { ...snapshot, counts: { ...snapshot.counts, ...forgedCounts } };
    const normalized = normalizeMemoryInspectionPanelSnapshot(payload as any);

    expect(normalized).toMatchObject({ kind: 'error', availability: 'unavailable' });
    expect(JSON.stringify(normalized)).not.toContain('Safe snapshot');
  });

  it('builds inspection state for every memory class with lifecycle fields', () => {
    let store = emptyMemoryStore();
    store = add(store, { verb: 'locator', title: 'Locator', locator: 'docs/a.md', freshness: 'verified', lastVerifiedLocator: 'docs/a.md' }, '2026-07-01T00:00:00.000Z');
    store = add(store, { verb: 'snapshot', title: 'Snapshot', content: 'Copied text', source: 'docs/b.md', capturedAt: '2026-07-02T00:00:00.000Z' }, '2026-07-02T00:00:00.000Z');
    store = add(store, { verb: 'lesson', title: 'Lesson', content: 'A lesson.', evidenceLocators: ['test:lesson'] }, '2026-07-03T00:00:00.000Z');
    store = add(store, { verb: 'transcript', title: 'Transcript', quote: 'User said this.', quoteSource: 'user:turn-1' }, '2026-07-04T00:00:00.000Z');

    const snapshot = createMemoryInspectionSnapshot(store);
    expect(snapshot.total).toBe(4);
    expect(snapshot.records.map((record) => record.corpusClass).sort()).toEqual([2, 3, 4, 5]);
    expect(snapshot.records.find((record) => record.title === 'Locator')).toMatchObject({
      status: 'current',
      freshness: 'verified',
      provenance: 'inspection.test',
    });
  });

  it('keeps usage counters as independent inspection metadata rather than a routing score', () => {
    let store = emptyMemoryStore();
    store = add(store, { verb: 'lesson', title: 'Base', content: 'Base.', evidenceLocators: ['test:base'] }, '2026-07-01T00:00:00.000Z');
    const baseId = store.records[0].id;
    store = add(store, { verb: 'lesson', title: 'Derived', content: 'Derived.', evidenceLocators: [baseId] }, '2026-07-02T00:00:00.000Z');
    store.records[0] = { ...store.records[0], readCount: 7, status: 'disputed' };

    const snapshot = createMemoryInspectionSnapshot(store);
    const base = snapshot.records.find((record) => record.title === 'Base');
    expect(base).toMatchObject({ readCount: 7, citedByCount: 1, status: 'disputed' });
    expect(snapshot.total).toBe(2);
  });
});
