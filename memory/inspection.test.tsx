import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { birthMemoryEnvelope, emptyMemoryStore, recordMemoryEnvelope, type MemoryStore } from './model';
import { createMemoryInspectionSnapshot } from './inspection';
import { memoryInspectionBadge, memoryInspectionPanel } from './workspace';

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

describe('memory inspection workspace UI', () => {
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

  it('renders usage counters as signals, not trust scores', () => {
    let store = emptyMemoryStore();
    store = add(store, { verb: 'lesson', title: 'Base', content: 'Base.', evidenceLocators: ['test:base'] }, '2026-07-01T00:00:00.000Z');
    const baseId = store.records[0].id;
    store = add(store, { verb: 'lesson', title: 'Derived', content: 'Derived.', evidenceLocators: [baseId] }, '2026-07-02T00:00:00.000Z');
    store.records[0] = { ...store.records[0], readCount: 7, status: 'disputed' };

    const snapshot = createMemoryInspectionSnapshot(store);
    const html = renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: snapshot, onClose: () => undefined }) as any);

    expect(html).toContain('Base');
    expect(html).toContain('reads 7');
    expect(html).toContain('cited 1');
    expect(html).toContain('disputed');
    expect(html).not.toContain('trust score');
    expect(html).not.toContain('score 7');
    expect(memoryInspectionBadge.count({ data: snapshot, active: false })).toBe(2);
  });
});
