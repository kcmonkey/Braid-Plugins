import { describe, expect, it } from 'vitest';
import { createMemoryRecallIndex, focusedMemoryQueryTokens, hybridEligibleRecords, hybridRecallCandidates, recallCandidatesFromIndex, type MemoryRecord } from './model';

const record = (id: string, title: string, status: MemoryRecord['status'] = 'current', scope = 'memory'): MemoryRecord => ({
  id, title, content: 'durable evidence', scope, status, tags: [], evidence: '', createdAt: '2026-09-01', updatedAt: '2026-09-01',
});

describe('frozen conservative hybrid', () => {
  it('keeps a genuine original lexical first while admitting dense candidates beyond a full lexical list', () => {
    const records = [record('anchor', 'nativeSessionRecovery'), ...Array.from({ length: 12 }, (_, n) => record(`lex-${n}`, 'native session')), record('dense', 'Independent durable execution')];
    const input = { query: 'nativeSessionRecovery native session', limit: '5' };
    const index = createMemoryRecallIndex({ version: 1, records });
    const baseline = recallCandidatesFromIndex(index, input);
    const result = hybridRecallCandidates(index, input, [{ id: 'dense', score: 1 }], 'verified-model');
    expect(result[0].record.id).toBe(baseline[0].record.id);
    expect(result[0].source.kind).toBe('lexical');
    expect(result.map((row) => row.record.id)).toContain('dense');
    expect(new Set(result.map((row) => row.record.id)).size).toBe(5);
  });

  it('does not anchor recency and never admits out-of-scope/non-current/unknown dense candidates', () => {
    const index = createMemoryRecallIndex({ version: 1, records: [
      record('eligible', 'First'), record('old', 'Old', 'superseded'), record('foreign', 'Foreign', 'current', 'other'),
    ] });
    const records = hybridEligibleRecords(index, { scope: 'MEMORY' });
    expect(records.map((r) => r.id)).toEqual(['eligible']);
    const result = hybridRecallCandidates(index, { query: 'zzzzzz', scope: 'memory', limit: '5' }, [
      { id: 'foreign', score: 100 }, { id: 'old', score: 100 }, { id: 'missing', score: 100 }, { id: 'eligible', score: 0.5 },
    ], 'model');
    expect(result.map((r) => r.record.id)).toEqual(['eligible']);
    expect(result[0].source.kind).toBe('hybrid');
    expect(hybridEligibleRecords(index, { scope: 'missing' })).toEqual([]);
  });

  it('applies the frozen generic stop/single-CJK filter and retains original tokens if all are removed', () => {
    expect(focusedMemoryQueryTokens('how can agent recover')).toEqual(['agent', 'recover']);
    expect(focusedMemoryQueryTokens('how can')).toEqual(['how', 'can']);
    expect(focusedMemoryQueryTokens('的 agent')).toEqual(['agent']);
  });
});
