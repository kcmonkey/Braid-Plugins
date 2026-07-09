import { describe, it, expect } from 'vitest';
import { firstHeading, parseGates, parseDecisions, parseDeferred, parseSection, parsePlanSnapshot, parsePhases, matchPhaseIndex, parseFinalTarget, parseSettlePredicates } from './parse';

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

  it('parseSettlePredicates extracts deterministic Settle Gate lines', () => {
    const md = [
      '# Current Phase: Verify',
      '## Settle Gate',
      '- run: npm test',
      '- grep0: oldArtifactName',
      '- grep1: SettlePredicate',
      '- artifact: mockup',
      '- artifact(turn): report',
      '- note: ignored',
      '',
      '## Acceptance Criteria',
      '- [ ] done',
    ].join('\n');
    expect(parseSettlePredicates(md)).toEqual([
      { kind: 'run', command: 'npm test' },
      { kind: 'grep0', pattern: 'oldArtifactName' },
      { kind: 'grep1', pattern: 'SettlePredicate' },
      { kind: 'artifact', dataType: 'mockup' },
      { kind: 'artifact', dataType: 'report', scope: 'turn' },
    ]);
  });

  it('parseSettlePredicates returns empty when the Settle Gate block is absent', () => {
    expect(parseSettlePredicates('## Goal\nNo machine gate yet.\n- run: not under the gate\n')).toEqual([]);
  });

  it('parseFinalTarget extracts structured goal-fidelity checks from the contract goal body', () => {
    const groups = parseFinalTarget([
      'Decouple VR interaction ownership.',
      '',
      'Final Target:',
      '- UVRComponent owns the VR rig and legacy VR interaction seams.',
      'Done means:',
      '- AZomboyVRCharacter only forwards compatibility calls.',
      'Not done until:',
      '- Source grep proves legacy Tick/SetupPlayerInputComponent seams moved.',
      'Not enough:',
      '- A generic gameplay consumer decouple without rig ownership migration.',
    ].join('\n'));
    expect(groups).toEqual([
      { key: 'finalTarget', label: 'Final target', items: ['UVRComponent owns the VR rig and legacy VR interaction seams.'] },
      { key: 'doneMeans', label: 'Done means', items: ['AZomboyVRCharacter only forwards compatibility calls.'] },
      { key: 'notDoneUntil', label: 'Not done until', items: ['Source grep proves legacy Tick/SetupPlayerInputComponent seams moved.'] },
      { key: 'notEnough', label: 'Not enough', items: ['A generic gameplay consumer decouple without rig ownership migration.'] },
    ]);
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

  it('parsePlanSnapshot surfaces final target checks for Plan details', () => {
    const snap = parsePlanSnapshot({
      phaseMd: '# Current Phase: Smoke\n## Acceptance Criteria\n- [x] a\n',
      decisionsMd: '',
      contractMd: '## Goal\nEnd state: real owner migration.\nNot enough:\n- Pure consumer rename.\n## Phase Roadmap\n- Phase 1: smoke\n',
    });
    expect(snap.finalTarget).toEqual([
      { key: 'finalTarget', label: 'Final target', items: ['real owner migration.'] },
      { key: 'notEnough', label: 'Not enough', items: ['Pure consumer rename.'] },
    ]);
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

  it('does not let a stale leading ordinal override a strong current-phase content match', () => {
    const phases = [
      'Establish the current BP impact boundary, then expand ShadowCompare from rig binding to behavior snapshots for the VR seams that will move: pose/tick',
      'Move VR pose sampling + tick orchestration ownership into UVRComponent; AZomboyVRCharacter forwards and remains Legacy-authoritative until compare is green.',
      'Move motion-controller offsets, hand pose, and gunstock ergonomics into UVRComponent; preserve existing control-setting replication and local tuning behavior.',
    ];
    expect(matchPhaseIndex(phases, [
      'Phase 1 - Controller, Hand Pose, and Gunstock Ownership',
      'Move motion-controller offsets, hand-pose calculation, and gunstock/control-setting ergonomics into UVRComponent.',
    ].join('\n'))).toBe(3);
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

  it('parsePlanSnapshot prefers the phase heading over goal-body collisions with an earlier phase', () => {
    // Real braid-core-architecture bug: heading "Cleanup Retention Compatibility" uniquely names Phase 8, but the
    // goal body ("plugin aggregate state ...") collides 3 ways with Phase 1's roadmap text. A name+goal blob tied
    // at 3 and the first-match tie-break wrongly reported Phase 1/8. The heading match must win → Phase 8/8.
    const roadmap = [
      'Phase 1: Plugin aggregate and event-state primitive (host-owned; append/order/replay).',
      'Phase 2: Board-to-board message envelope and correlation lifecycle.',
      'Phase 3: Atomic visible board materialization transaction.',
      'Phase 4: Aggregate-level run controller and lifecycle fan-in.',
      'Phase 5: Scoped context substrate for aggregate-owned intel and status.',
      'Phase 6: Plugin semantic graph projection for non-lineage edges.',
      'Phase 7: Orchestration cutover + negative proof old ownership is gone.',
      'Phase 8: Cleanup, retention, and compatibility hardening.',
    ];
    const snap = parsePlanSnapshot({
      phaseMd: '# Current Phase: Cleanup Retention Compatibility\n## Goal\nCore exposes bounded cleanup and retention controls for plugin aggregate state while preserving compatibility for existing plugin behavior.\n## Acceptance Criteria\n- [x] a\n',
      decisionsMd: '',
      contractMd: `## Phase Roadmap\n${roadmap.map((p) => `- ${p}`).join('\n')}\n## Global Verification\n- npm test\n`,
    });
    expect(snap.phases).toHaveLength(8);
    expect(snap.phaseIndex).toBe(8);
  });
});
