import { describe, it, expect } from 'vitest';
import { firstHeading, parseGates, parseDecisions, parseDeferred, parseSection, parsePlanSnapshot, parsePhases, matchPhaseIndex } from './parse';

describe('plan parse', () => {
  it('firstHeading strips the "Current Phase:" prefix', () => {
    expect(firstHeading('# Current Phase: Smoke\n\nbody')).toBe('Smoke');
    expect(firstHeading('## Goal\n\nx')).toBe('Goal');
    expect(firstHeading('no heading here')).toBeUndefined();
  });

  it('parseGates counts checked vs unchecked task boxes', () => {
    const md = '## Acceptance Criteria\n- [ ] build is green\n- [x] tests pass\n* [X] tsc clean\n- not a box\n';
    const gates = parseGates(md);
    expect(gates).toHaveLength(3);
    expect(gates.filter((g) => g.done).map((g) => g.text)).toEqual(['tests pass', 'tsc clean']);
    expect(gates[0]).toEqual({ done: false, text: 'build is green' });
  });

  it('parseGates skips an empty checkbox instead of swallowing the next line', () => {
    // A bare `- [ ]` must not let its text spill onto / consume the following list item.
    const md = '- [ ]\n- [x] real gate\n';
    const gates = parseGates(md);
    expect(gates).toEqual([{ done: true, text: 'real gate' }]);
  });

  it('parseDecisions reads ## Dn headings with or without a title', () => {
    const md = '# Decisions\n\n## D1 - Use attachment edges\nbody\n\n## D2\njust a body line\n\n### D10: pure functions\n';
    expect(parseDecisions(md)).toEqual([
      { id: 'D1', title: 'Use attachment edges' },
      { id: 'D2', title: 'D2' },
      { id: 'D10', title: 'pure functions' },
    ]);
  });

  it('parseDecisions also reads the ADR-n / ADR-001 conventions real plans use (with status parentheticals)', () => {
    const md = [
      '# Decisions (ADRs)',
      '## ADR-1 — Native-base routing (primary) + guarded fallback',
      '## ADR-001: Use a Component for Character-Side ALS',
      '## ADR-6 (RESOLVED 2026-06-17) — Snapshot format = FSQLiteDatabase',
      '## D7 - mixed style still works',
    ].join('\n');
    expect(parseDecisions(md)).toEqual([
      { id: 'ADR-1', title: 'Native-base routing (primary) + guarded fallback' },
      { id: 'ADR-001', title: 'Use a Component for Character-Side ALS' },
      { id: 'ADR-6', title: 'Snapshot format = FSQLiteDatabase' },
      { id: 'D7', title: 'mixed style still works' },
    ]);
  });

  it('parseDeferred collects bullets only under a gaps/deferred/out-of-scope heading', () => {
    const md = '## Goal\n- not a gap\n\n## Deferred / Out Of Scope\n- run-to-target phase\n- real gate eval\n\n## Notes\n- unrelated\n';
    expect(parseDeferred(md)).toEqual(['run-to-target phase', 'real gate eval']);
  });

  it('parseSection extracts the prose under a heading (until the next heading)', () => {
    const md = '# Title\n## Goal\nDo the thing.\nMore detail.\n## Next\n- x\n';
    expect(parseSection(md, /^#{1,6}\s+goal\b/i)).toBe('Do the thing.\nMore detail.');
    expect(parseSection(md, /^#{1,6}\s+missing\b/i)).toBe('');
  });

  it('parsePlanSnapshot pulls the overall goal + the current-phase intent', () => {
    const snap = parsePlanSnapshot({
      phaseMd: '# Current Phase: Smoke\n## Goal\nFinish the smoke run.\n## Acceptance Criteria\n- [ ] a\n',
      decisionsMd: '',
      contractMd: '## Goal\nThe overall objective.\n## Deferred / Out Of Scope\n- later\n',
    });
    expect(snap.phaseGoal).toBe('Finish the smoke run.');
    expect(snap.goal).toBe('The overall objective.');
  });

  it('parsePlanSnapshot composes phase + progress + decisions + gaps', () => {
    const snap = parsePlanSnapshot({
      phaseMd: '# Current Phase: Smoke\n## Acceptance Criteria\n- [x] a\n- [ ] b\n',
      decisionsMd: '## D1 - x\n',
      contractMd: '## Deferred / Out Of Scope\n- later thing\n',
    });
    expect(snap.phase).toBe('Smoke');
    expect(snap.done).toBe(1);
    expect(snap.total).toBe(2);
    expect(snap.decisions).toEqual([{ id: 'D1', title: 'x' }]);
    expect(snap.deferred).toEqual(['later thing']);
  });

  it('parsePhases reads the contract Phase Roadmap and folds wrapped continuation lines', () => {
    const contract = [
      '## Phase Roadmap',
      '- Phase 1: Plugin skeleton + context provider + seeded',
      '  usage doc + registration, enabled.',
      '- Phase 2: Read-only vault visualization board element.',
      '',
      '## Global Verification',
      '- npm test',
    ].join('\n');
    const phases = parsePhases(contract);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toContain('Plugin skeleton');
    expect(phases[0]).toContain('registration, enabled.');
    expect(phases[1]).toContain('Read-only vault visualization');
  });

  it('matchPhaseIndex trusts an explicit "Phase N" ordinal in the phase name (over ambiguous word overlap)', () => {
    const phases = ['Additive C++ core', 'AI parallel slice', 'Player parallel slice', 'Equivalence gate', 'Cutover', 'Old removal'];
    expect(matchPhaseIndex(phases, 'Phase 2 - AI Parallel Slice Closeout')).toBe(2); // NOT 3, though "parallel slice" is in both
    expect(matchPhaseIndex(phases, 'P5: cutover')).toBe(5);
    expect(matchPhaseIndex(phases, 'Phase 9 — out of range')).toBe(0); // ordinal out of range → fall back; no overlap → 0
  });

  it('matchPhaseIndex locates the current phase by word overlap, 0 when unsure', () => {
    const phases = [
      'Phase 1: Plugin skeleton + context provider + seeded usage doc + registration, enabled',
      'Phase 2: Read-only vault visualization board element + searchText findability',
    ];
    expect(matchPhaseIndex(phases, 'Context provider + seeded usage doc')).toBe(1);
    expect(matchPhaseIndex(phases, 'Vault visualization board element')).toBe(2);
    expect(matchPhaseIndex(phases, 'Totally unrelated wording')).toBe(0);
    expect(matchPhaseIndex([], 'x')).toBe(0);
  });

  it('parsePlanSnapshot surfaces the phase roadmap + current phase index', () => {
    const snap = parsePlanSnapshot({
      phaseMd: '# Current Phase: Context provider + seeded usage doc\n## Acceptance Criteria\n- [x] a\n',
      decisionsMd: '',
      contractMd: '## Phase Roadmap\n- Phase 1: context provider seeded usage doc registration\n- Phase 2: vault visualization element\n',
    });
    expect(snap.phases).toHaveLength(2);
    expect(snap.phaseIndex).toBe(1);
  });
});
