import { describe, expect, it } from 'vitest';
import {
  emptyMemoryStore,
  normalizeMemoryStore,
  recallMemories,
  recordMemory,
} from './model';

describe('memory model', () => {
  it('records and updates deterministic memories by title and scope', () => {
    let store = emptyMemoryStore();

    const first = recordMemory(store, {
      title: 'Codex auth method guard',
      content: 'Subscription turns must reject API-key accounts.',
      scope: 'codex',
      tags: 'auth, billing',
      evidence: 'src/engine/codex/adapter.ts',
    }, '2026-07-01T01:00:00.000Z');
    store = first.store;

    const second = recordMemory(store, {
      title: 'Codex auth method guard',
      content: 'Subscription turns reject API-key accounts before work starts.',
      scope: 'codex',
      tags: 'auth, safety',
      evidence: 'codex adapter test',
    }, '2026-07-01T02:00:00.000Z');

    expect(first.record.id).toBe(second.record.id);
    expect(second.store.records).toHaveLength(1);
    expect(second.record.createdAt).toBe('2026-07-01T01:00:00.000Z');
    expect(second.record.updatedAt).toBe('2026-07-01T02:00:00.000Z');
    expect(second.record.content).toContain('before work starts');
    expect(second.record.tags).toEqual(['auth', 'safety']);
  });

  it('ranks bounded recall results by relevant title, tags, scope, and content', () => {
    let store = emptyMemoryStore();
    store = recordMemory(store, {
      title: 'Provider-neutral memory tools',
      content: 'Expose memory_record and memory_recall through generic host agent tools.',
      scope: 'memory-plugin',
      tags: 'host, tools',
    }, '2026-07-01T01:00:00.000Z').store;
    store = recordMemory(store, {
      title: 'Coordinator wait semantics',
      content: 'Pending claims are not granted until active.',
      scope: 'coordinator',
      tags: 'resources',
    }, '2026-07-01T02:00:00.000Z').store;
    store = recordMemory(store, {
      title: 'Memory settings follow-up',
      content: 'Plugin Settings visibility is a later phase.',
      scope: 'memory-plugin',
      tags: 'settings',
    }, '2026-07-01T03:00:00.000Z').store;

    const recalled = recallMemories(store, {
      query: 'memory host tools',
      scope: 'memory-plugin',
      limit: '1',
    });

    expect(recalled.map((m) => m.title)).toEqual(['Provider-neutral memory tools']);
  });

  it('normalizes missing or malformed stores to an empty current store', () => {
    expect(normalizeMemoryStore(undefined)).toEqual(emptyMemoryStore());
    expect(normalizeMemoryStore({ version: 1, records: [{ title: 'no id' }] })).toEqual(emptyMemoryStore());
    expect(normalizeMemoryStore({
      version: 1,
      records: [{
        id: 'valid',
        title: 'Valid',
        content: 'Kept',
        scope: 'project',
        tags: ['ok'],
        evidence: '',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }],
    }).records).toHaveLength(1);
  });
});
