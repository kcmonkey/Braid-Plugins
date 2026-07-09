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
