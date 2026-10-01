import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  MemoryIndexCache,
  bumpMemoryRevisionToken,
  memoryRevisionToken,
} from './indexCache';
import {
  emptyMemoryStore,
  hybridEligibleRecords,
  hybridRecallCandidates,
  recallMemoriesFromIndex,
  recordMemory,
  type MemoryStore,
} from './model';
import { memoryUsagePath } from './storage';

function storeWith(title: string, scope = 'memory'): MemoryStore {
  return recordMemory(emptyMemoryStore(), {
    title,
    content: `${title} content for cache tests.`,
    scope,
    tags: 'cache, recall',
    evidence: 'test:index-cache',
  }, '2026-07-08T00:00:00.000Z').store;
}

describe('memory index cache', () => {
  it('reuses canonical current/scope indexes and invalidates them with the canonical revision', async () => {
    let token = 'A';
    const cache = new MemoryIndexCache(() => token);
    const store = storeWith('Canonical target');
    store.records[0].status = 'current';
    let canonical = { store, corpusRevision: 'revision-A' };
    const first = await cache.getCanonical('.', async () => canonical);
    hybridEligibleRecords(first.index, { scope: 'memory' });
    const bucket = first.index.current!.scopes.get('memory');
    hybridRecallCandidates(first.index, { query: 'Canonical target', scope: 'memory' }, [], 'model');
    const second = await cache.getCanonical('.', async () => canonical);
    expect(second.index).toBe(first.index);
    expect(second.index.current!.scopes.get('memory')).toBe(bucket);
    expect((await cache.get('.', async () => { throw new Error('Should reuse the same cache'); })).index).toBe(first.index);
    token = 'B';
    canonical = { store: { version: 1, records: [{ ...store.records[0], status: 'superseded' }] }, corpusRevision: 'revision-B' };
    const changed = await cache.getCanonical('.', async () => canonical);
    expect(changed.index).not.toBe(first.index);
    expect(hybridEligibleRecords(changed.index, {})).toEqual([]);
  });

  it('never tags an old canonical read with a newer token published during that read', async () => {
    let token = 'A';
    const cache = new MemoryIndexCache(() => token);
    const a = storeWith('Before write');
    const b = storeWith('After write');
    const old = await cache.getCanonical('.', async () => {
      const snapshot = { store: a, corpusRevision: 'revision-A' };
      token = 'B'; // B commits after A was read but before cache publication.
      return snapshot;
    });
    expect(old.token).toBe('A');
    const lexical = await cache.get('.', async () => b);
    expect(lexical.token).toBe('B');
    expect(lexical.index.records[0].title).toBe('After write');
    expect(lexical.index).not.toBe(old.index);
  });

  it('reuses one built index for repeated recall while the revision token is unchanged', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-index-cache-'));
    try {
      const store = storeWith('Cached recall target');
      let token = 'token-a';
      let loads = 0;
      const cache = new MemoryIndexCache(() => token);
      const load = async () => {
        loads += 1;
        return store;
      };

      const first = await cache.get(project, load);
      const firstResult = recallMemoriesFromIndex(first.index, {
        query: 'cached recall target',
        scope: 'memory',
        limit: '1',
      });
      const second = await cache.get(project, load);
      const secondResult = recallMemoriesFromIndex(second.index, {
        query: 'cached recall target',
        scope: 'memory',
        limit: '1',
      });

      expect(token).toBe('token-a');
      expect(loads).toBe(1);
      expect(second).toBe(first);
      expect(second.index).toBe(first.index);
      expect(firstResult.map((record) => record.title)).toEqual(['Cached recall target']);
      expect(secondResult.map((record) => record.title)).toEqual(['Cached recall target']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('invalidates and rebuilds when the cross-process revision token changes', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-index-invalidate-'));
    try {
      let token = 'token-a';
      let store = storeWith('First target');
      let loads = 0;
      const cache = new MemoryIndexCache(() => token);
      const load = async () => {
        loads += 1;
        return store;
      };

      const first = await cache.get(project, load);
      token = 'token-b';
      store = storeWith('Second target');
      const second = await cache.get(project, load);

      expect(loads).toBe(2);
      expect(second).not.toBe(first);
      expect(recallMemoriesFromIndex(second.index, {
        query: 'second target',
        scope: 'memory',
        limit: '1',
      }).map((record) => record.title)).toEqual(['Second target']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('shares one in-flight build across concurrent cache requests', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-index-inflight-'));
    try {
      const store = storeWith('In flight target');
      let loads = 0;
      let resolveLoad: ((store: MemoryStore) => void) | undefined;
      const cache = new MemoryIndexCache(() => 'token-a');
      const load = async () => {
        loads += 1;
        return new Promise<MemoryStore>((resolve) => {
          resolveLoad = resolve;
        });
      };

      const first = cache.get(project, load);
      const second = cache.get(project, load);
      const third = cache.get(project, load);
      expect(loads).toBe(1);
      resolveLoad?.(store);
      const snapshots = await Promise.all([first, second, third]);

      expect(loads).toBe(1);
      expect(snapshots[1]).toBe(snapshots[0]);
      expect(snapshots[2]).toBe(snapshots[0]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('uses a cheap artifact revision token and ignores usage telemetry writes', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-index-token-'));
    try {
      const artifactDir = path.join(project, '.braid', 'artifacts');
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'index.sqlite'), 'artifact-db', 'utf8');
      const before = memoryRevisionToken(project);

      fs.writeFileSync(memoryUsagePath(project), JSON.stringify({
        version: 1,
        records: { a: { readCount: 1, lastReadAt: '2026-07-08T00:00:00.000Z' } },
      }), 'utf8');
      expect(memoryRevisionToken(project)).toBe(before);

      bumpMemoryRevisionToken(project);
      expect(memoryRevisionToken(project)).not.toBe(before);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
