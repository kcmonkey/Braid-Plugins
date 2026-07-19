import { describe, expect, it } from 'vitest';
import {
  createMemoryRecallIndex,
  normalizeMemoryStore,
  recallCandidatesFromIndex,
  recallMemories,
  recallMemoriesFromIndex,
  type MemoryRecord,
  type MemoryStore,
} from './model';
import {
  DeterministicSessionSemanticCandidateSource,
  querySemanticCandidates,
  resolveSemanticRecallExecution,
  semanticOptionsForOutcome,
  type SemanticCandidateSource,
} from './semantic';

const records: MemoryRecord[] = [
  { id: 'lexical', title: 'Memory semantic ranking', content: 'lexical matching is the original recall path', scope: 'memory', tags: ['ranking'], evidence: '', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z' },
  { id: 'semantic-a', title: 'Related candidate A', content: 'nearest session signal', scope: 'memory', tags: [], evidence: '', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' },
  { id: 'semantic-b', title: 'Related candidate B', content: 'another session signal', scope: 'memory', tags: [], evidence: '', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
  { id: 'recent', title: 'Newest fallback', content: 'unrelated fallback', scope: 'memory', tags: [], evidence: '', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z' },
];

function store(): MemoryStore {
  return normalizeMemoryStore({ version: 1, records });
}

describe('memory semantic recall seam', () => {
  it('admits the deterministic session source only for configured local-experimental session mode', () => {
    const localSession = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'fixture-fp' } as const;

    expect(resolveSemanticRecallExecution({ semantic: 'configured' }, localSession)).toMatchObject({
      status: 'enabled',
      config: localSession,
    });
    expect(resolveSemanticRecallExecution({ semantic: 'off' }, localSession)).toEqual({
      status: 'off', reason: 'caller-off',
    });
    expect(resolveSemanticRecallExecution({ semantic: 'configured' }, { ...localSession, cache: 'project' })).toEqual({
      status: 'unavailable', reason: 'project-cache-unavailable',
    });
    expect(resolveSemanticRecallExecution({ semantic: 'configured' }, { mode: 'off', cache: 'session' })).toEqual({
      status: 'off', reason: 'config-off',
    });
    expect(resolveSemanticRecallExecution({ semantic: 'unexpected' } as any, localSession)).toEqual({
      status: 'off', reason: 'invalid-request',
    });
  });

  it('preserves lexical-first candidates for non-admitted semantic paths without constructing a source', () => {
    const input = { query: 'memory ranking', scope: 'memory', limit: '3' };
    const lexical = recallMemories(store(), input).map((record) => record.id);
    const configs = [
      { request: { semantic: 'off' as const }, config: { mode: 'local-experimental' as const, cache: 'session' as const } },
      { request: { semantic: 'configured' as const }, config: { mode: 'off' as const, cache: 'session' as const } },
      { request: { semantic: 'configured' as const }, config: { mode: 'local-experimental' as const, cache: 'project' as const } },
      { request: { semantic: 'invalid' } as any, config: { mode: 'local-experimental' as const, cache: 'session' as const } },
    ];

    let constructions = 0;
    for (const { request, config } of configs) {
      const execution = resolveSemanticRecallExecution({ ...input, ...request }, config);
      if (execution.status === 'enabled') {
        constructions += 1;
        new DeterministicSessionSemanticCandidateSource();
      }
      expect(recallCandidatesFromIndex(createMemoryRecallIndex(store()), input)
        .map((candidate) => candidate.record.id)).toEqual(lexical);
    }
    expect(constructions).toBe(0);
  });

  it('leaves legacy wrappers on exact lexical and recency ids/order when semantic options are omitted', () => {
    const index = createMemoryRecallIndex(store());
    for (const input of [
      { query: 'memory ranking', scope: 'memory', limit: '3' },
      { query: 'no lexical signal', scope: 'memory', limit: '2' },
    ]) {
      const expected = recallMemories(store(), input).map((record) => record.id);
      expect(recallMemoriesFromIndex(index, input).map((record) => record.id)).toEqual(expected);
      expect(recallCandidatesFromIndex(index, input).map((candidate) => candidate.record.id)).toEqual(expected);
    }
  });

  it('maps backend failure to undefined semantic options and exact lexical parity', async () => {
    const failing: SemanticCandidateSource = {
      describe: () => ({ kind: 'deterministic-session', cache: 'session', modelFingerprint: 'never', candidateNotTruth: true }),
      prepare: async () => { throw new Error('backend unavailable'); },
      query: async () => [],
      dispose: () => undefined,
    };
    const input = { query: 'memory ranking', scope: 'memory', limit: '3' };
    const outcome = await querySemanticCandidates(failing, { query: input.query, records });
    expect(outcome.status).toBe('backend-failure');
    expect(semanticOptionsForOutcome(outcome)).toBeUndefined();
    expect(recallCandidatesFromIndex(createMemoryRecallIndex(store()), input, semanticOptionsForOutcome(outcome))
      .map((candidate) => candidate.record.id))
      .toEqual(recallMemories(store(), input).map((record) => record.id));
  });

  it('keeps lexical rank immutable, then score/id semantic-only, then recency fill', () => {
    const candidates = recallCandidatesFromIndex(createMemoryRecallIndex(store()),
      { query: 'original recall', scope: 'memory', limit: '4' }, {
        semanticModelFingerprint: 'fp-1',
        semantic: [
          { id: 'semantic-b', score: 0.5 },
          { id: 'semantic-a', score: 0.5 },
          { id: 'lexical', score: 0.1 },
        ],
      });
    expect(candidates.map((candidate) => candidate.record.id)).toEqual(['lexical', 'semantic-a', 'semantic-b', 'recent']);
    expect(candidates[0].source.kind).toBe('lexical');
    expect(candidates[0].scores.map((score) => score.source.kind)).toEqual(['lexical', 'semantic']);
    expect(candidates[3].source).toMatchObject({ kind: 'recency', provenance: 'updatedAt' });
  });

  it('ignores unknown matches, deduplicates scores deterministically, and honors the limit', () => {
    const candidates = recallCandidatesFromIndex(createMemoryRecallIndex(store()),
      { query: '', scope: 'memory', limit: '2' }, {
        semantic: [
          { id: 'missing', score: 99 },
          { id: 'semantic-b', score: 0.2 },
          { id: 'semantic-a', score: 0.2 },
          { id: 'semantic-b', score: 0.9 },
          { id: 'semantic-a', score: Number.NaN },
        ],
      });
    expect(candidates.map((candidate) => candidate.record.id)).toEqual(['semantic-b', 'semantic-a']);
    expect(candidates.map((candidate) => candidate.scores[0].value)).toEqual([0.9, 0.2]);
  });

  it('exposes candidate-not-truth fingerprint provenance', async () => {
    const source = new DeterministicSessionSemanticCandidateSource({ modelFingerprint: 'fixture-fp', expansions: { vehicle: ['car'] } });
    const outcome = await querySemanticCandidates(source, { query: 'vehicle', records: [records[1], { ...records[2], id: 'car', content: 'car' }] });
    expect(outcome).toMatchObject({ status: 'ready', description: { candidateNotTruth: true, modelFingerprint: 'fixture-fp' } });
    const options = semanticOptionsForOutcome(outcome);
    const candidates = recallCandidatesFromIndex(createMemoryRecallIndex(normalizeMemoryStore({ version: 1, records: [records[1], { ...records[2], id: 'car', content: 'car' }] })),
      { query: 'none', scope: 'memory', limit: '1' }, options);
    expect(candidates[0].source).toMatchObject({ kind: 'semantic', provenance: 'session-local', modelFingerprint: 'fixture-fp' });
  });

  it('expands configured tokens deterministically without external state', async () => {
    const source = new DeterministicSessionSemanticCandidateSource({ expansions: { vehicle: ['car'] } });
    await source.prepare();
    const input = { query: 'vehicle', records: [{ ...records[1], id: 'car', content: 'car' }] };
    const first = await source.query(input);
    const second = await source.query(input);
    expect(first).toEqual([{ id: 'car', score: 0.5, modelFingerprint: 'deterministic-session-v1' }]);
    expect(second).toEqual(first);
  });

  it('rethrows caller cancellation instead of treating it as lexical fallback', async () => {
    const source = new DeterministicSessionSemanticCandidateSource();
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(querySemanticCandidates(source, { query: 'memory', records, signal: controller.signal }))
      .rejects.toThrow('caller cancelled');
  });

  it('keeps disposed and preparation failures local to the semantic backend', async () => {
    const disposed = new DeterministicSessionSemanticCandidateSource();
    disposed.dispose();
    const disposedOutcome = await querySemanticCandidates(disposed, { query: 'memory', records });
    expect(disposedOutcome.status).toBe('backend-failure');

    const unprepared = new DeterministicSessionSemanticCandidateSource();
    await expect(unprepared.query({ query: 'memory', records })).rejects.toThrow('must be prepared');
  });
});
