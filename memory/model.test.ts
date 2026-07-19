import { describe, expect, it } from 'vitest';
import {
  birthMemoryEnvelope,
  applyDirectSupersession,
  emptyMemoryStore,
  normalizeMemoryFreshness,
  normalizeMemoryStatus,
  normalizeMemoryStore,
  formatMemoryCatalog,
  recallMemories,
  recordMemoryEnvelope,
  recordMemoryReads,
  recordMemory,
  deriveEvidenceCitationCounts,
  DEFAULT_MEMORY_SEMANTIC_CONFIG,
  normalizeMemorySemanticConfig,
  tokenizeMemoryText,
} from './model';

describe('memory model', () => {
  it('normalizes missing and malformed semantic config to a frozen lexical default', () => {
    const expected = { mode: 'off', cache: 'session' };
    const cases: unknown[] = [undefined, null, 'local-experimental', [],
      { mode: 'enabled', cache: 'durable', modelFingerprint: 42 },
      { mode: 'local-experimental', cache: 'invalid', modelFingerprint: '   ' }];

    expect(DEFAULT_MEMORY_SEMANTIC_CONFIG).toEqual(expected);
    expect(Object.isFrozen(DEFAULT_MEMORY_SEMANTIC_CONFIG)).toBe(true);
    for (const value of cases) {
      const normalized = normalizeMemorySemanticConfig(value);
      expect(normalized).toEqual(expected);
      expect(Object.isFrozen(normalized)).toBe(true);
    }
  });

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

  it('recalls prefix, fuzzy, and identifier-token variants through MiniSearch', () => {
    let store = emptyMemoryStore();
    store = recordMemory(store, {
      title: 'Authentication retry backoff',
      content: 'ChatViewGenerating uses driveBoardAgain after authentication retries.',
      scope: 'memory-plugin',
      tags: 'auth, retry',
    }, '2026-07-01T01:00:00.000Z').store;

    const recalled = recallMemories(store, {
      query: 'authent retry ChatViewGenerate',
      scope: 'memory-plugin',
      limit: '1',
    });

    expect(recalled.map((m) => m.title)).toEqual(['Authentication retry backoff']);
  });

  it('returns fallback candidates instead of hard-emptying when records exist', () => {
    let store = emptyMemoryStore();
    store = recordMemory(store, {
      title: 'Newest candidate',
      content: 'A candidate can guide the agent when lexical recall is weak.',
      scope: 'memory-plugin',
      tags: 'fallback',
    }, '2026-07-02T01:00:00.000Z').store;
    store = recordMemory(store, {
      title: 'Older candidate',
      content: 'Another record.',
      scope: 'memory-plugin',
      tags: 'fallback',
    }, '2026-07-01T01:00:00.000Z').store;

    const recalled = recallMemories(store, {
      query: 'zzzzqqqq',
      scope: 'memory-plugin',
      limit: '1',
    });

    expect(recalled.map((m) => m.title)).toEqual(['Newest candidate']);
  });

  it('passes a multilingual no-false-empty recall eval set', () => {
    let store = emptyMemoryStore();
    const add = (title: string, content: string, tags: string, updatedAt: string) => {
      store = recordMemory(store, {
        title,
        content,
        scope: 'eval',
        tags,
      }, updatedAt).store;
    };

    add(
      'Newest unrelated visual preference',
      'Canvas color preferences and panel density are not memory retrieval failures.',
      'visual',
      '2026-07-10T00:00:00.000Z',
    );
    add(
      '中文提示修复失败',
      '修复提示没有出现时需要重新物化 webview turn。',
      '修复, 提示',
      '2026-07-01T00:00:00.000Z',
    );
    add(
      '日本語検索テスト',
      'テスト検索が失敗した時は bigram と trigram を使う。',
      '検索',
      '2026-07-02T00:00:00.000Z',
    );
    add(
      '한국검색 누락',
      '한국검색 결과가 누락되면 trigram 토큰으로 찾는다.',
      '검색',
      '2026-07-03T00:00:00.000Z',
    );
    add(
      'ChatViewGenerating repair turn',
      'driveBoardAgain materializes repair turns when ChatView is stuck generating.',
      'identifier, repair',
      '2026-07-04T00:00:00.000Z',
    );
    add(
      'Authentication retry backoff',
      'Authentication retries should use exponential backoff.',
      'auth, retry',
      '2026-07-05T00:00:00.000Z',
    );

    const cases = [
      ['提示没出现', '中文提示修复失败'],
      ['検索失敗', '日本語検索テスト'],
      ['한국검', '한국검색 누락'],
      ['ChatViewGenerate driveBoardAgin', 'ChatViewGenerating repair turn'],
      ['authent rety', 'Authentication retry backoff'],
    ];

    for (const [query, expectedTitle] of cases) {
      expect(recallMemories(store, { query, scope: 'eval', limit: '1' }).map((m) => m.title), query)
        .toEqual([expectedTitle]);
    }

    expect(recallMemories(store, { query: 'zzzzqqqq', scope: 'eval', limit: '2' }).map((m) => m.title))
      .toEqual(['Newest unrelated visual preference', 'Authentication retry backoff']);
  });

  it('tokenizes normalized Latin, identifiers, and CJK n-grams', () => {
    const tokens = tokenizeMemoryText('Ａｕｔｈ ChatViewGenerating driveBoardAgain snake_case kebab-case 修复提示没有出现 テスト検索 한국검색');

    expect(tokens).toContain('auth');
    expect(tokens).toEqual(expect.arrayContaining(['chat', 'view', 'generating', 'drive', 'board', 'again', 'snake', 'case', 'kebab']));
    expect(tokens).toEqual(expect.arrayContaining(['修', '修复', '修复提', '提示', '提示没']));
    expect(tokens).toEqual(expect.arrayContaining(['テ', 'テス', 'テスト']));
    expect(tokens).toEqual(expect.arrayContaining(['한', '한국', '한국검']));
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

  it('rejects class-invalid lesson, snapshot, transcript, and locator births with structured reasons', () => {
    expect(birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Missing evidence',
      content: 'Lessons need evidence locators.',
      recallCue: 'When a lesson lacks evidence.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z')).toMatchObject({
      ok: false,
      errors: [{ code: 'lesson.evidenceLocators.required' }],
    });

    expect(birthMemoryEnvelope({
      verb: 'snapshot',
      title: 'Missing source',
      content: 'Snapshot body.',
      capturedAt: '2026-07-07T00:00:00.000Z',
      recallCue: 'When a snapshot lacks source.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z')).toMatchObject({
      ok: false,
      errors: [{ code: 'snapshot.source.required' }],
    });

    expect(birthMemoryEnvelope({
      verb: 'snapshot',
      title: 'Missing captured at',
      content: 'Snapshot body.',
      source: 'src/example.ts',
      recallCue: 'When a snapshot lacks capture time.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z')).toMatchObject({
      ok: false,
      errors: [{ code: 'snapshot.capturedAt.required' }],
    });

    expect(birthMemoryEnvelope({
      verb: 'transcript',
      title: 'Missing quote',
      quoteSource: 'user',
      recallCue: 'When a transcript lacks quote.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z')).toMatchObject({
      ok: false,
      errors: [{ code: 'transcript.quote.required' }],
    });

    expect(birthMemoryEnvelope({
      verb: 'locator',
      title: 'Locator with conclusion',
      locator: 'docs/example.md',
      conclusion: 'This should not exist on a locator.',
      recallCue: 'When a locator carries a conclusion.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z')).toMatchObject({
      ok: false,
      errors: [{ code: 'locator.conclusion.forbidden' }],
    });
  });

  it('accepts empty locator content fields but rejects a non-empty locator conclusion', () => {
    const base = {
      verb: 'locator' as const,
      title: 'Pointer only',
      locator: 'docs/example.md',
      recallCue: 'When checking locator-only births.',
      provenance: 'model.test',
    };

    expect(birthMemoryEnvelope({ ...base, content: undefined })).toMatchObject({ ok: true });
    expect(birthMemoryEnvelope({ ...base, content: '' })).toMatchObject({ ok: true });
    expect(birthMemoryEnvelope({ ...base, content: 'A conclusion is not a locator.' })).toMatchObject({
      ok: false,
      errors: [{ code: 'locator.conclusion.forbidden' }],
    });
  });

  it('derives class from verb and rejects free class or type fields', () => {
    const valid = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Class derives from verb',
      content: 'The caller cannot pick its own class.',
      evidenceLocators: ['test:red-green'],
      recallCue: 'When class must be mechanical.',
      provenance: 'test',
      class: '2',
      type: 'caller-picked',
    }, '2026-07-07T00:00:00.000Z');

    expect(valid).toMatchObject({
      ok: false,
      errors: [
        { code: 'class.forbidden' },
        { code: 'type.forbidden' },
      ],
    });

    const derived = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Class derives from verb',
      content: 'The caller cannot pick its own class.',
      evidenceLocators: ['test:red-green'],
      recallCue: 'When class must be mechanical.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z');

    expect(derived).toMatchObject({
      ok: true,
      record: {
        verb: 'lesson',
        corpusClass: 4,
        provisional: true,
      },
    });
  });

  it('defaults new memory births to current while invalid labels still normalize down', () => {
    expect(normalizeMemoryStatus(undefined)).toBe('stale');
    expect(normalizeMemoryStatus('trusted')).toBe('stale');
    expect(normalizeMemoryFreshness(undefined)).toBe('unverified');
    expect(normalizeMemoryFreshness('fresh')).toBe('unverified');

    const record = birthMemoryEnvelope({
      verb: 'locator',
      title: 'Defaults down',
      locator: 'docs/example.md',
      recallCue: 'When labels are missing.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z');

    expect(record).toMatchObject({
      ok: true,
      record: {
        status: 'current',
        freshness: 'unverified',
        lastVerified: undefined,
      },
    });

    const invalid = birthMemoryEnvelope({
      verb: 'locator',
      title: 'Invalid routing defaults down',
      locator: 'docs/example.md',
      recallCue: 'When an invalid birth status is supplied.',
      provenance: 'test',
      status: 'not-a-status',
    }, '2026-07-07T00:00:00.000Z');
    expect(invalid).toMatchObject({ ok: true, record: { status: 'stale' } });
  });

  it('preserves omitted routing status on envelope updates', () => {
    const first = birthMemoryEnvelope({
      verb: 'locator', title: 'Preserved routing', locator: 'docs/example.md',
      recallCue: 'When an envelope update omits status.', provenance: 'test', status: 'disputed',
    }, '2026-07-07T00:00:00.000Z');
    const update = birthMemoryEnvelope({
      verb: 'locator', title: 'Preserved routing', locator: 'docs/example.md',
      recallCue: 'When an envelope update omits status.', provenance: 'test',
    }, '2026-07-08T00:00:00.000Z');
    if (!first.ok || !update.ok) throw new Error('unexpected birth failure');

    const stored = recordMemoryEnvelope(emptyMemoryStore(), first.record).store;
    const result = recordMemoryEnvelope(stored, update.record);
    expect(result.record.status).toBe('disputed');
  });

  it('applies direct supersession purely for self, missing, and successful prior records', () => {
    const prior = birthMemoryEnvelope({
      verb: 'locator', title: 'Prior record', locator: 'docs/prior.md',
      recallCue: 'When testing direct supersession.', provenance: 'model.test',
    }, '2026-07-07T00:00:00.000Z');
    if (!prior.ok) throw new Error('unexpected birth failure');
    const store = recordMemoryEnvelope(emptyMemoryStore(), prior.record).store;
    const successor = { ...prior.record, id: 'mem-successor', title: 'Successor record', supersedes: `memory:${prior.record.id}` };

    expect(applyDirectSupersession(store, { ...successor, supersedes: 'memory:mem-successor' }))
      .toMatchObject({ ok: false, error: 'supersedes.self' });
    expect(applyDirectSupersession(store, { ...successor, supersedes: 'memory:missing-prior' }))
      .toMatchObject({ ok: false, error: 'supersedes.not_found' });

    const applied = applyDirectSupersession(store, successor);
    expect(applied).toMatchObject({ ok: true });
    if (!applied.ok) throw new Error('unexpected supersession failure');
    expect(applied.store.records.find((record) => record.id === prior.record.id)?.status).toBe('superseded');
    expect(store.records.find((record) => record.id === prior.record.id)?.status).toBe('current');
  });

  it('carries stable identity and optional supersedes reference for artifact versions', () => {
    const first = birthMemoryEnvelope({
      verb: 'locator',
      title: 'Artifact compatible identity',
      locator: 'docs/example.md',
      recallCue: 'When memory needs an artifact id.',
      provenance: 'test',
      status: 'current',
      freshness: 'verified',
      lastVerifiedLocator: 'docs/example.md',
      supersedes: 'previous-memory-id',
    }, '2026-07-07T00:00:00.000Z');

    const second = birthMemoryEnvelope({
      verb: 'locator',
      title: 'Artifact compatible identity',
      locator: 'docs/example.md',
      recallCue: 'When memory needs an artifact id.',
      provenance: 'test',
      status: 'current',
      freshness: 'verified',
      lastVerifiedLocator: 'docs/example.md',
      supersedes: 'previous-memory-id',
    }, '2026-07-08T00:00:00.000Z');

    expect(first).toMatchObject({
      ok: true,
      record: {
        id: expect.stringMatching(/^mem-/),
        supersedes: 'previous-memory-id',
        lastVerified: {
          at: '2026-07-07T00:00:00.000Z',
          locator: 'docs/example.md',
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      record: {
        id: (first as any).record.id,
      },
    });
  });

  it('preserves existing scope and tags when updating a class-bound memory without replacements', () => {
    let store = emptyMemoryStore();
    const first = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Scoped lesson',
      content: 'First body.',
      evidenceLocators: ['test:first'],
      recallCue: 'When preserving metadata.',
      provenance: 'test',
    }, '2026-07-07T00:00:00.000Z');
    const second = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Scoped lesson',
      content: 'Second body.',
      evidenceLocators: ['test:second'],
      recallCue: 'When preserving metadata.',
      provenance: 'test',
    }, '2026-07-08T00:00:00.000Z');
    if (!first.ok || !second.ok) throw new Error('unexpected birth failure');

    store = recordMemoryEnvelope(store, first.record, {
      scope: 'memory-plugin',
      tags: 'routing, important',
    }, '2026-07-07T00:00:00.000Z').store;
    store = recordMemoryEnvelope(store, second.record, {}, '2026-07-08T00:00:00.000Z').store;

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      content: 'Second body.',
      scope: 'memory-plugin',
      tags: ['routing', 'important'],
    });
  });

  it('recalls CJK query text against migrated memory records', () => {
    let store = emptyMemoryStore();
    store = recordMemory(store, {
      title: '中文查询召回全 0 分',
      content: 'memory_recall 对中文 query 返回空。',
      scope: 'memory',
      tags: ['召回', '检索'],
      evidence: 'test:cjk',
    }, '2026-07-01T00:00:00.000Z').store;

    expect(recallMemories(store, { query: '召回为空', limit: '3' }).map((record) => record.title))
      .toEqual(['中文查询召回全 0 分']);
  });

  it('formats a complete compact catalog without usage-based ordering', () => {
    let store = emptyMemoryStore();
    for (let i = 0; i < 45; i += 1) {
      const born = birthMemoryEnvelope({
        verb: 'lesson',
        title: `Lesson ${String(i).padStart(2, '0')}`,
        content: `Body ${i}`,
        evidenceLocators: ['test:evidence'],
        recallCue: `When checking catalog line ${i}`,
        provenance: `test:${i}`,
        status: 'current',
      }, `2026-07-${String((i % 9) + 1).padStart(2, '0')}T00:00:00.000Z`);
      if (!born.ok) throw new Error('unexpected birth failure');
      store = recordMemoryEnvelope(store, born.record).store;
    }
    const first = store.records[0];
    const newest = store.records[44];
    store = recordMemoryEnvelope(store, {
      ...newest,
      evidenceLocators: [first.id],
      updatedAt: '2026-07-30T00:00:00.000Z',
    }).store;
    store = recordMemoryReads(store, [first.id], '2026-07-31T00:00:00.000Z');

    const catalog = formatMemoryCatalog(store);
    expect((catalog.match(/Lesson \d\d/g) ?? [])).toHaveLength(45);
    expect(catalog).toContain('←1');
    expect(catalog).not.toContain('readCount');
    expect(catalog).not.toContain('.braid/memory');
    expect(catalog).toContain('memory:');
    expect(catalog.indexOf('Lesson 44')).toBeLessThan(catalog.indexOf('Lesson 00'));
  });

  it('derives evidence citation counts without changing record authority', () => {
    let store = emptyMemoryStore();
    const a = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Base lesson',
      content: 'A base lesson.',
      evidenceLocators: ['test:a'],
      recallCue: 'When checking citation counts.',
      provenance: 'test:a',
      status: 'current',
    }, '2026-07-01T00:00:00.000Z');
    const b = birthMemoryEnvelope({
      verb: 'lesson',
      title: 'Derived lesson',
      content: 'A derived lesson.',
      evidenceLocators: [(a as any).record.id],
      recallCue: 'When checking citation counts.',
      provenance: 'test:b',
      status: 'current',
    }, '2026-07-02T00:00:00.000Z');
    if (!a.ok || !b.ok) throw new Error('unexpected birth failure');
    store = recordMemoryEnvelope(store, a.record).store;
    store = recordMemoryEnvelope(store, b.record).store;

    expect(deriveEvidenceCitationCounts(store)[a.record.id]).toBe(1);
    expect(store.records.find((record) => record.id === a.record.id)?.status).toBe('current');
  });

  it('falls back to newest store-wide candidates when the scope filter matches nothing', () => {
    let store = emptyMemoryStore();
    store = recordMemory(store, {
      title: 'Older engine note',
      content: 'Older engine content.',
      scope: 'engine',
      tags: 'engine',
    }, '2026-07-01T00:00:00.000Z').store;
    store = recordMemory(store, {
      title: 'Newest engine note',
      content: 'Newest engine content.',
      scope: 'engine',
      tags: 'engine',
    }, '2026-07-02T00:00:00.000Z').store;

    // A scope that exists nowhere must NOT dead-end while memories exist (ADR-10): it returns the newest
    // candidates across the whole store, not an empty result.
    const recalled = recallMemories(store, { query: 'anything relevant', scope: 'does-not-exist', limit: '1' });
    expect(recalled.map((m) => m.title)).toEqual(['Newest engine note']);
  });

  it('counts citations by exact id or memory:<id> only, not arbitrary substrings', () => {
    const store = normalizeMemoryStore({
      version: 1,
      records: [
        { id: 'mem-alpha', title: 'Alpha', content: 'a', scope: 's', tags: [], evidence: '', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
        { id: 'mem-alpha-two', title: 'Beta', content: 'b', scope: 's', tags: [], evidence: '', evidenceLocators: ['mem-alpha-two-ref'], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
        { id: 'mem-gamma', title: 'Gamma', content: 'c', scope: 's', tags: [], evidence: '', evidenceLocators: ['memory:mem-alpha'], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
      ],
    });

    const counts = deriveEvidenceCitationCounts(store);
    // Only mem-gamma's `memory:mem-alpha` reference counts. The `mem-alpha-two-ref` locator merely CONTAINS
    // "mem-alpha" as a substring and must not inflate the count (that was O(records²) + a false positive).
    expect(counts['mem-alpha']).toBe(1);
    expect(counts['mem-alpha-two']).toBeUndefined();
  });
});
