import { describe, expect, it } from 'vitest';
import {
  createMemoryRecallIndex,
  formatMemoryOverview,
  formatMemoryCatalog,
  recallMemories,
  recallMemoriesFromIndex,
  type MemoryRecord,
  type MemoryStore,
} from './model';
import { MemoryIndexCache } from './indexCache';

interface NeedleCase {
  id: string;
  title: string;
  content: string;
  scope: string;
  tags: string[];
  recallCue: string;
  query: string;
}

const STORE_SIZE = 12_000;
const RECALL_LIMIT = 5;

const NEEDLES: NeedleCase[] = [
  {
    id: 'needle-artifact-live-nudge',
    title: 'artifact_expect missing expectation live nudge repair prompt',
    content: 'When artifact_expect is missing, live-nudge before repair turns so ChatView does not stay Generating.',
    scope: 'artifacts',
    tags: ['artifact_expect', 'repair', 'obligation'],
    recallCue: 'artifact_expect missing expectation nothing:false ChatView Generating repair prompt',
    query: 'artifact_expect missing expectation live nudge obligation repair prompt nothing:false ChatView Generating',
  },
  {
    id: 'needle-cjk-recall-empty',
    title: '中文查询召回全 0 分',
    content: '中文和日文查询不能依赖英文空格分词, 需要 bigram trigram 才能召回。',
    scope: 'memory',
    tags: ['召回', '中文', '检索'],
    recallCue: '中文 query 召回为空 memory_recall 返回空',
    query: '中文召回为空 检索失败',
  },
  {
    id: 'needle-japanese-search',
    title: '日本語検索のメモリ再現',
    content: '検索できない時は CJK ngram tokenizer を使い memory_recall の候補を返す。',
    scope: 'memory',
    tags: ['検索', '日本語'],
    recallCue: '日本語検索できない メモリ recall',
    query: '日本語検索できない メモリ候補',
  },
  {
    id: 'needle-korean-search',
    title: '한국어 검색 누락 방지',
    content: '한국어 메모리 검색은 bigram trigram 토큰으로 후보를 찾아야 한다.',
    scope: 'memory',
    tags: ['검색', '한국어'],
    recallCue: '한국어 검색 누락 memory_recall 후보',
    query: '한국어 검색 누락 후보',
  },
  {
    id: 'needle-chatview-generating',
    title: 'ChatViewGenerating repair materialization',
    content: 'driveBoardAgain materializes repair turns when ChatViewGenerating is stuck after an obligation repair.',
    scope: 'webview',
    tags: ['ChatViewGenerating', 'driveBoardAgain', 'repair'],
    recallCue: 'ChatView Generating repair turn driveBoardAgain materialize',
    query: 'ChatViewGenerate driveBoardAgin repair materialize',
  },
  {
    id: 'needle-auth-retry',
    title: 'Authentication retry backoff policy',
    content: 'Authentication retries should use exponential backoff and preserve provider-neutral errors.',
    scope: 'engine',
    tags: ['authentication', 'retry', 'provider-neutral'],
    recallCue: 'authent retry provider neutral backoff',
    query: 'authent rety provider-neutral backoff',
  },
];

function makeRecord(id: string, i: number): MemoryRecord {
  const scope = ['webview', 'engine', 'memory', 'artifacts', 'coordination', 'provider'][i % 6];
  const tagA = ['canvas', 'adapter', 'recall', 'artifact', 'claim', 'model'][i % 6];
  const tagB = ['lifecycle', 'status', 'catalog', 'render', 'session', 'tool'][Math.floor(i / 6) % 6];
  const day = String((i % 28) + 1).padStart(2, '0');
  return {
    id,
    title: `Synthetic memory ${i} ${scope} ${tagA}`,
    content: `Synthetic body ${i} for ${scope}. This distractor mentions board agent tool status and generic project behavior.`,
    scope,
    tags: [tagA, tagB],
    evidence: `synthetic:evidence:${i}`,
    createdAt: `2026-07-${day}T00:00:00.000Z`,
    updatedAt: `2026-07-${day}T12:00:00.000Z`,
    verb: 'lesson',
    corpusClass: 4,
    provisional: true,
    status: 'current',
    freshness: 'unverified',
    recallCue: `Synthetic recall cue ${i} ${scope} ${tagA} ${tagB}`,
    provenance: `synthetic:${i}`,
    evidenceLocators: [`synthetic:evidence:${i}`],
    recordedAt: `2026-07-${day}T00:00:00.000Z`,
  };
}

function makeNeedleRecord(needle: NeedleCase, index: number): MemoryRecord {
  return {
    id: needle.id,
    title: needle.title,
    content: needle.content,
    scope: needle.scope,
    tags: needle.tags,
    evidence: `synthetic:needle:${needle.id}`,
    createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
    verb: 'lesson',
    corpusClass: 4,
    provisional: true,
    status: 'current',
    freshness: 'unverified',
    recallCue: needle.recallCue,
    provenance: `synthetic:${needle.id}`,
    evidenceLocators: [`synthetic:needle:${needle.id}`],
    recordedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function makeLargeStore(size = STORE_SIZE): MemoryStore {
  const records = Array.from({ length: size - NEEDLES.length }, (_, i) => makeRecord(`synthetic-${i}`, i));
  for (let i = 0; i < NEEDLES.length; i += 1) {
    const at = Math.floor((i + 1) * records.length / (NEEDLES.length + 1));
    records.splice(at, 0, makeNeedleRecord(NEEDLES[i], i));
  }
  return { version: 1, records };
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

describe('memory large-scale recall eval', () => {
  it('keeps known multilingual/code needles reachable within top-k on a large store', () => {
    const store = makeLargeStore();
    const metrics: Array<{ id: string; rank: number; ms: number }> = [];

    for (const needle of NEEDLES) {
      const start = process.hrtime.bigint();
      const results = recallMemories(store, { query: needle.query, scope: needle.scope, limit: String(RECALL_LIMIT) });
      const ms = elapsedMs(start);
      const rank = results.findIndex((record) => record.id === needle.id) + 1;
      metrics.push({ id: needle.id, rank, ms: Math.round(ms) });
      expect(rank, `${needle.id} should be within top ${RECALL_LIMIT}; got ${results.map((record) => record.id).join(', ')}`)
        .toBeGreaterThan(0);
      expect(rank).toBeLessThanOrEqual(RECALL_LIMIT);
    }

    console.log(JSON.stringify({
      probe: 'memory-supply-recall-baseline',
      records: store.records.length,
      limit: RECALL_LIMIT,
      metrics,
    }));
  }, 120_000);

  it('records complete-catalog context-size baseline for the current supply path', () => {
    const store = makeLargeStore();
    const start = process.hrtime.bigint();
    const catalog = formatMemoryCatalog(store);
    const formatMs = elapsedMs(start);
    const bytes = Buffer.byteLength(catalog, 'utf8');
    console.log(JSON.stringify({
      probe: 'memory-supply-catalog-baseline',
      records: store.records.length,
      catalogBytes: bytes,
      formatMs: Math.round(formatMs),
    }));
    expect(catalog).toContain('needle-artifact-live-nudge');
    expect(bytes).toBeGreaterThan(1_000_000);
  }, 120_000);

  it('reuses a cached large-store index while keeping needles reachable', async () => {
    const store = makeLargeStore();
    let loads = 0;
    const cache = new MemoryIndexCache(() => 'large-eval-token');
    const load = async () => {
      loads += 1;
      return store;
    };

    const first = await cache.get(process.cwd(), load);
    const second = await cache.get(process.cwd(), load);
    expect(second).toBe(first);
    expect(loads).toBe(1);

    const metrics: Array<{ id: string; rank: number; ms: number }> = [];
    for (const needle of NEEDLES) {
      const start = process.hrtime.bigint();
      const results = recallMemoriesFromIndex(second.index, {
        query: needle.query,
        scope: needle.scope,
        limit: String(RECALL_LIMIT),
      });
      const ms = elapsedMs(start);
      const rank = results.findIndex((record) => record.id === needle.id) + 1;
      metrics.push({ id: needle.id, rank, ms: Math.round(ms) });
      expect(rank, `${needle.id} should stay within top ${RECALL_LIMIT} through cached recall`)
        .toBeGreaterThan(0);
      expect(rank).toBeLessThanOrEqual(RECALL_LIMIT);
    }

    console.log(JSON.stringify({
      probe: 'memory-supply-cached-recall',
      records: store.records.length,
      loads,
      metrics,
    }));
  }, 120_000);

  it('keeps large-store needles reachable with overview-only context', () => {
    const store = makeLargeStore();
    const index = createMemoryRecallIndex(store);
    const overview = formatMemoryOverview(index.facets, { threshold: 300 });
    const overviewBytes = Buffer.byteLength(overview, 'utf8');

    expect(overviewBytes).toBeLessThan(20_000);
    expect(overview).toContain('memory_recall');
    expect(overview).toContain('memory_get');
    expect(overview).toContain('memory_catalog');
    expect(overview).toContain('memory');
    expect(overview).toContain('webview');
    expect(overview).not.toContain('needle-artifact-live-nudge');
    expect(overview).not.toContain('ChatViewGenerating repair materialization');

    for (const needle of NEEDLES) {
      expect(overview).toContain(needle.scope);
      expect(overview).toContain(needle.tags[0].toLowerCase());
      const recalled = recallMemoriesFromIndex(index, {
        query: needle.query,
        scope: needle.scope,
        limit: String(RECALL_LIMIT),
      });
      const hit = recalled.find((record) => record.id === needle.id);
      expect(hit?.content).toBe(needle.content);
    }

    console.log(JSON.stringify({
      probe: 'memory-supply-overview-reachability',
      records: store.records.length,
      overviewBytes,
    }));
  }, 120_000);
});
