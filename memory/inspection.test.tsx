import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { birthMemoryEnvelope, emptyMemoryStore, recordMemoryEnvelope, type MemoryStore } from './model';
import {
  MEMORY_INSPECTION_SCHEMA_VERSION,
  createMemoryInspectionSnapshot,
  errorMemoryInspectionSnapshot,
  normalizeMemoryInspectionPanelSnapshot,
  parseMemoryInspectionAction,
} from './inspection';
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

function renderWithPanelState(data: unknown, state: unknown[]): string {
  const stateSpy = vi.spyOn(React, 'useState') as any;
  stateSpy.mockImplementation((initial: unknown) => [state.length ? state.shift() : initial, () => undefined]);
  try {
    return renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data, onClose: () => undefined }) as any);
  } finally {
    stateSpy.mockRestore();
  }
}

function findElement(node: React.ReactNode, predicate: (element: React.ReactElement) => boolean): React.ReactElement | undefined {
  if (!React.isValidElement(node)) return undefined;
  if (predicate(node)) return node;
  return React.Children.toArray((node.props as { children?: React.ReactNode }).children)
    .map((child) => findElement(child, predicate))
    .find((element): element is React.ReactElement => element !== undefined);
}

function refreshButton(data: unknown, requestAction: ReturnType<typeof vi.fn>, state: unknown[] = []): React.ReactElement | undefined {
  const stateSpy = vi.spyOn(React, 'useState') as any;
  // This intentional hook harness preserves one ref across the simulated renders.
  // It keeps the production same-render latch observable without calling a real
  // renderer's event system or weakening the component's useRef behavior.
  const actionInFlightRef = { current: false };
  const refSpy = vi.spyOn(React, 'useRef') as any;
  let stateIndex = 0;
  stateSpy.mockImplementation((initial: unknown) => {
    const index = stateIndex++;
    if (index === state.length) state.push(initial);
    return [state[index], (next: unknown) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
  });
  refSpy.mockReturnValue(actionInFlightRef);
  try {
    const panel = memoryInspectionPanel.renderPanel({ data, onClose: () => undefined, requestAction } as any) as React.ReactElement;
    const shell = (panel.type as (props: unknown) => React.ReactElement)(panel.props);
    const renderedShell = (shell.type as (props: unknown) => React.ReactElement)(shell.props);
    return findElement(renderedShell, (element) => element.type === 'button' && element.props.title === 'Refresh list-safe inspection metadata');
  } finally {
    refSpy.mockRestore();
    stateSpy.mockRestore();
  }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('memory inspection workspace UI', () => {
  it('renders as an accessible modal isolated from canvas interactions', () => {
    const html = renderToStaticMarkup(memoryInspectionPanel.renderPanel({
      data: validInspectionSnapshot(),
      onClose: () => undefined,
    }) as any);

    expect(html).toContain('class="memory-inspection-modal nodrag nopan nowheel"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="memory-inspection-title"');
    expect(html).toContain('tabindex="-1"');
  });

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
    expect(() => renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: payload, onClose: () => undefined }) as any)).not.toThrow();
    expect(renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: payload, onClose: () => undefined }) as any)).toContain('Inspection unavailable');
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
    const html = renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: payload, onClose: () => undefined }) as any);

    expect(normalized).toMatchObject({ kind: 'error', availability: 'unavailable' });
    expect(html).toContain('Inspection unavailable');
    expect(html).not.toContain(JSON.stringify(value));
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
    const html = renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: payload, onClose: () => undefined }) as any);

    expect(normalized).toMatchObject({ kind: 'error', availability: 'unavailable' });
    expect(html).toContain('Inspection unavailable');
    expect(html).not.toContain('Safe snapshot');
  });

  it('offers one focusable, de-duplicated metadata-only refresh action while unavailable or in flight', () => {
    const requestAction = vi.fn(() => new Promise<unknown>(() => undefined));
    const state: unknown[] = [];
    const unavailable = refreshButton(errorMemoryInspectionSnapshot('host offline'), requestAction, state);
    expect(unavailable?.props.type).toBe('button');
    expect(unavailable?.props.children).toMatch(/Refresh|Retry/);
    expect(typeof unavailable?.props.onClick).toBe('function');
    unavailable?.props.onClick();
    expect(requestAction).toHaveBeenCalledTimes(1);
    expect(requestAction).toHaveBeenCalledWith('refreshInspection', undefined);
    expect(refreshButton(errorMemoryInspectionSnapshot('host offline'), requestAction, state)?.props.disabled).toBe(true);
  });

  it.each([
    { outcome: 'resolves', settle: (pending: ReturnType<typeof deferred<{ data: unknown }>>) => pending.resolve({ data: { ok: true, action: 'refreshInspection' } }) },
    { outcome: 'rejects', settle: (pending: ReturnType<typeof deferred<{ data: unknown }>>) => pending.reject(new Error('offline')) },
  ])('single-flights a same-render Refresh double click and clears its latch when the request $outcome', async ({ settle }) => {
    const pending = deferred<{ data: unknown }>();
    const requestAction = vi.fn(() => pending.promise);
    const state: unknown[] = [];
    const currentRenderRefresh = refreshButton(errorMemoryInspectionSnapshot('host offline'), requestAction, state);

    currentRenderRefresh?.props.onClick();
    currentRenderRefresh?.props.onClick();

    const refreshing = refreshButton(errorMemoryInspectionSnapshot('host offline'), requestAction, state);
    expect(refreshing?.props.children).toBe('Refreshing…');
    expect(refreshing?.props.disabled).toBe(true);
    expect(requestAction).toHaveBeenCalledTimes(1);
    expect(requestAction).toHaveBeenCalledWith('refreshInspection', undefined);

    settle(pending);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshButton(errorMemoryInspectionSnapshot('host offline'), requestAction, state)?.props.disabled).toBe(false);
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

  it('renders deterministic recent-first rows plus metadata controls, state copy, compatible badge titles, and inert detail access', () => {
    const records = [
      { id: 'c', title: 'Zulu', verb: 'lesson', corpusClass: 4, status: 'current', freshness: 'verified', provisional: false, scope: 'deploy', tags: ['findable-tag'], recallCue: 'searchable cue', provenance: 'fixture', evidenceLocatorCount: 0, readCount: 0, citedByCount: 0, updatedAt: '2026-07-03T00:00:00.000Z', sourceCheck: 'not-checked' },
      { id: 'a', title: 'Alpha', verb: 'locator', corpusClass: 2, status: 'disputed', freshness: 'unverified', provisional: true, scope: 'auth', tags: ['review'], recallCue: '', provenance: '', evidenceLocatorCount: 1, readCount: 0, citedByCount: 0, updatedAt: '2026-07-02T00:00:00.000Z', sourceCheck: 'locator-present' },
      { id: 'b', title: 'Bravo', verb: 'snapshot', corpusClass: 3, status: 'stale', freshness: 'verified', provisional: false, scope: 'store', tags: [], recallCue: '', provenance: '', evidenceLocatorCount: 0, readCount: 0, citedByCount: 0, updatedAt: '2026-07-01T00:00:00.000Z', sourceCheck: 'locator-missing' },
    ] as const;
    const snapshot = { kind: 'ready' as const, schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, generatedAt: '2026-07-06T00:00:00.000Z', availability: 'available' as const, total: 3, records: [...records], counts: { total: 3, locator: 1, snapshot: 1, lesson: 1, transcript: 0, current: 1, stale: 1, superseded: 0, disputed: 1, verified: 2, unverified: 1, provisional: 1, final: 2, sourceNotChecked: 1, sourceLocatorPresent: 1, sourceLocatorMissing: 1 } };
    const html = renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: snapshot, onClose: () => undefined }) as any);

    expect(html.indexOf('Zulu')).toBeLessThan(html.indexOf('Alpha'));
    expect(html.indexOf('Alpha')).toBeLessThan(html.indexOf('Bravo'));
    for (const label of ['Search metadata', 'Routing', 'Freshness', 'Provisional', 'Source check', 'Sort results']) expect(html).toContain(`aria-label=\"${label}\"`);
    expect(html).toContain('Review priority is only a routing queue.');
    expect(html).toContain('type=\"button\"');
    expect(html).toContain('aria-pressed=\"false\"');
    expect(memoryInspectionBadge.title({ data: snapshot, active: false })).toBe('Memory — 3 records, 1 disputed, 1 stale');
    expect(memoryInspectionBadge.title({ data: errorMemoryInspectionSnapshot('offline'), active: false })).toBe('Memory — inspection unavailable');
    expect(renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: null, onClose: () => undefined }) as any)).toContain('Loading inspection');
    expect(renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: { ...snapshot, total: 0, records: [], counts: { total: 0, locator: 0, snapshot: 0, lesson: 0, transcript: 0, current: 0, stale: 0, superseded: 0, disputed: 0, verified: 0, unverified: 0, provisional: 0, final: 0, sourceNotChecked: 0, sourceLocatorPresent: 0, sourceLocatorMissing: 0 } }, onClose: () => undefined }) as any)).toContain('No memory records');
    expect(renderToStaticMarkup(memoryInspectionPanel.renderPanel({ data: errorMemoryInspectionSnapshot('offline'), onClose: () => undefined }) as any)).toContain('Inspection unavailable');
  });

  it('applies metadata search and each lifecycle filter independently, with title and review queues deterministic in SSR', () => {
    const records = [
      { id: 'c', title: 'Zulu', verb: 'lesson', corpusClass: 4, status: 'current', freshness: 'verified', provisional: false, scope: 'deploy', tags: ['findable-tag'], recallCue: 'searchable cue', provenance: 'fixture', evidenceLocatorCount: 0, readCount: 0, citedByCount: 0, updatedAt: '2026-07-03T00:00:00.000Z', sourceCheck: 'not-checked' },
      { id: 'a', title: 'Alpha', verb: 'locator', corpusClass: 2, status: 'disputed', freshness: 'unverified', provisional: true, scope: 'auth', tags: ['review'], recallCue: '', provenance: '', evidenceLocatorCount: 1, readCount: 0, citedByCount: 0, updatedAt: '2026-07-02T00:00:00.000Z', sourceCheck: 'locator-present' },
      { id: 'b', title: 'Bravo', verb: 'snapshot', corpusClass: 3, status: 'stale', freshness: 'verified', provisional: false, scope: 'store', tags: [], recallCue: '', provenance: '', evidenceLocatorCount: 0, readCount: 0, citedByCount: 0, updatedAt: '2026-07-01T00:00:00.000Z', sourceCheck: 'locator-missing' },
    ];
    const snapshot = { kind: 'ready' as const, schemaVersion: MEMORY_INSPECTION_SCHEMA_VERSION, generatedAt: '2026-07-06T00:00:00.000Z', availability: 'available' as const, total: 3, records, counts: { total: 3, locator: 1, snapshot: 1, lesson: 1, transcript: 0, current: 1, stale: 1, superseded: 0, disputed: 1, verified: 2, unverified: 1, provisional: 1, final: 2, sourceNotChecked: 1, sourceLocatorPresent: 1, sourceLocatorMissing: 1 } };
    const states = (query: string, status = 'all', freshness = 'all', provisional = 'all', source = 'all', sort = 'updated') => [query, status, freshness, provisional, source, sort, null, null];
    const titles = (html: string) => ['Alpha', 'Bravo', 'Zulu'].filter((title) => html.includes(title));

    expect(titles(renderWithPanelState(snapshot, states('findable-tag')))).toEqual(['Zulu']);
    expect(titles(renderWithPanelState(snapshot, states('', 'current')))).toEqual(['Zulu']);
    expect(titles(renderWithPanelState(snapshot, states('', 'all', 'unverified')))).toEqual(['Alpha']);
    expect(titles(renderWithPanelState(snapshot, states('', 'all', 'all', 'provisional')))).toEqual(['Alpha']);
    expect(titles(renderWithPanelState(snapshot, states('', 'all', 'all', 'all', 'locator-missing')))).toEqual(['Bravo']);
    const titleSorted = renderWithPanelState(snapshot, states('', 'all', 'all', 'all', 'all', 'title'));
    expect(titleSorted.indexOf('Alpha')).toBeLessThan(titleSorted.indexOf('Bravo'));
    expect(titleSorted.indexOf('Bravo')).toBeLessThan(titleSorted.indexOf('Zulu'));
    const reviewSorted = renderWithPanelState(snapshot, states('', 'all', 'all', 'all', 'all', 'review'));
    expect(reviewSorted.indexOf('Alpha')).toBeLessThan(reviewSorted.indexOf('Bravo'));
    expect(reviewSorted.indexOf('Bravo')).toBeLessThan(reviewSorted.indexOf('Zulu'));
    expect(renderWithPanelState(snapshot, states('absent metadata'))).toContain('No matching metadata');
  });
});
