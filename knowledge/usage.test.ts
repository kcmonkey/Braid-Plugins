import { describe, expect, it } from 'vitest';
import { applyToolObservation, applyTurnSettled, emptyUsage, knowledgeUsageTotal } from './usage';

describe('knowledge usage accumulator', () => {
  it('counts a vault read as a recall', () => {
    const { tally, wroteVault } = applyToolObservation(emptyUsage(), 'Read', { file_path: '.braid/knowledge/x.md' });
    expect(tally).toEqual({ recalls: 1, records: 0, gaps: 0 });
    expect(wroteVault).toBe(false);
  });

  it('counts a vault write as a record and reports wroteVault', () => {
    const { tally, wroteVault } = applyToolObservation(emptyUsage(), 'Write', { file_path: '.braid/knowledge/x.md' });
    expect(tally).toEqual({ recalls: 0, records: 1, gaps: 0 });
    expect(wroteVault).toBe(true);
  });

  it('leaves the tally reference unchanged for a non-vault tool', () => {
    const cur = emptyUsage();
    const { tally, wroteVault } = applyToolObservation(cur, 'Write', { file_path: 'src/foo.ts' });
    expect(tally).toBe(cur);
    expect(wroteVault).toBe(false);
  });

  it('counts a GAP when a settled answer claims a lesson with no vault write', () => {
    expect(applyTurnSettled(emptyUsage(), '我记下了三条教训', false)).toEqual({ recalls: 0, records: 0, gaps: 1 });
  });

  it('no GAP when the lesson was written this turn', () => {
    const cur = emptyUsage();
    expect(applyTurnSettled(cur, '我记下了三条教训', true)).toBe(cur);
  });

  it('no GAP when the answer has no lesson claim', () => {
    const cur = emptyUsage();
    expect(applyTurnSettled(cur, 'The build passed.', false)).toBe(cur);
  });

  it('totals all three signals', () => {
    expect(knowledgeUsageTotal({ recalls: 2, records: 1, gaps: 3 })).toBe(6);
  });
});
