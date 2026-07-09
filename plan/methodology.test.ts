import { describe, expect, it } from 'vitest';
import { RUN_BEGIN_SENTINEL, RUN_DONE_SENTINEL } from '../../../src/run/lifecycle';
import { planContextText } from './methodology';

describe('plan methodology run scope', () => {
  it('tells the agent to proactively consider plans for systematic engineering without over-planning small work', () => {
    const text = planContextText('');
    expect(text).toContain('systematic engineering');
    expect(text).toContain('multi-phase or multi-file');
    expect(text).toContain('architecture/provider/host/plugin seams');
    expect(text).toContain('do not wait for the user to use the word "plan"');
    expect(text).toContain('Do NOT force a plan for small tactical fixes');
  });

  it('tells the agent to encode final-target checks in contract.md Goal', () => {
    const text = planContextText('');
    expect(text).toContain('structured final-target checks');
    expect(text).toContain('Final Target:');
    expect(text).toContain('Done means:');
    expect(text).toContain('Not done until:');
    expect(text).toContain('Not enough:');
    expect(text).toContain('lock the final target before phase gates');
    expect(text).toContain('every acceptance criterion must trace');
    expect(text).toContain('negative grep/runtime proof');
  });

  it('tells the agent how to structure migration/replacement/cutover plans without false-completion via a facade', () => {
    const text = planContextText('');
    expect(text).toContain('migration/replacement/cutover');
    expect(text).toContain('old owner/path/transport');
    expect(text).toContain('new owner/path/transport');
    expect(text).toContain('fallback/rollback policy');
    expect(text).toContain('split it into a separate plan or ADR');
    expect(text).toContain('false completion');
    // The Final Target's delete/facade OR must resolve to one terminal state; the cheap facade branch must not win by default.
    expect(text).toContain('resolve to ONE terminal state');
    expect(text).toContain('unresolved "delete OR keep a facade/shim"');
    expect(text).toContain('defaults to FULL removal');
    expect(text).toContain('PROCESS scaffold');
    // Removal must be proved project-wide and reconciled against the full consumer census, not scoped to edited files.
    expect(text).toContain('positive proof the new path is active');
    expect(text).toContain('PROJECT-WIDE (unscoped) negative grep');
    expect(text).toContain('reconciled against the full consumer census');
    expect(text).toContain('re-homed to a NAMED owning phase');
    expect(text).toContain('may not be marked done on a narrowed scope');
  });

  it('requires adversarial plan review before presenting or scaffolding a plan', () => {
    const text = planContextText('');
    expect(text).toContain('adversarial plan review');
    expect(text).toContain('try to invalidate');
    expect(text).toContain('actual code owner');
    expect(text).toContain('data granularity');
    expect(text).toContain('lifecycle owner');
    expect(text).toContain('revise the plan before presenting or scaffolding');
  });

  it('treats agent-authored facts as navigation aids, not authority', () => {
    const text = planContextText('');
    expect(text).toContain('Agent-authored information is a navigation aid, not authority');
    expect(text).toContain('plan Ground Truth');
    expect(text).toContain('evidence summaries');
    expect(text).toContain('memory notes');
    expect(text).toContain('current authoritative evidence');
    expect(text).toContain('cannot be reverified');
  });

  it('tells a bound board to repair contract-level goal drift before current-phase gates', () => {
    const text = planContextText('p1');
    expect(text).toContain('If the user says the goal is wrong');
    expect(text).toContain('update .braid/plans/p1/contract.md first');
    expect(text).toContain('then rewrite current-phase.md acceptance gates');
    expect(text).toContain('prove that corrected target');
  });

  it('tells the agent that full-plan execution continues across roadmap phases', () => {
    const text = planContextText('p1');
    expect(text).toContain(`START your reply with a line containing exactly ${RUN_BEGIN_SENTINEL}`);
    expect(text).toContain('full/entire/whole');
    expect(text).toContain('all phases');
    expect(text).toContain('完整执行');
    expect(text).toContain('promote the next roadmap item into current-phase.md');
    expect(text).toContain(`Emit a line containing exactly ${RUN_DONE_SENTINEL} only when`);
    expect(text).toContain('every roadmap phase is complete');
    expect(text).toContain('Before that final marker, include a concise execution summary');
    expect(text).toContain('## Execution Summary');
    expect(text).toContain('Completed:');
    expect(text).toContain('Verification:');
    expect(text).toContain('Remaining:');
    expect(text).toContain('final line');
  });

  it('routes bound-board plan context without forcing every tactical task through the plan', () => {
    const text = planContextText('p1');
    expect(text).toContain('Treat this binding as a routing hint');
    expect(text).toContain('If the user asks to run, continue, update, review, discuss, or modify this plan');
    expect(text).toContain('first read .braid/plans/p1/current-phase.md, contract.md, and decisions.md');
    expect(text).toContain('unrelated tactical change');
    expect(text).toContain('do not read plan files just because this board is bound');
    expect(text).toContain('do not turn that task into plan execution');
    expect(text).toContain('Do NOT emit either marker for ordinary questions or "continue testing" / "继续测试"');
    expect(text).not.toContain('current-phase.md, contract.md, and decisions.md before acting');
  });

  it('tells runtime plan continuations to reuse unchanged plan context', () => {
    const text = planContextText('p1');
    expect(text).toContain('runtime/auto-continuation');
    expect(text).toContain('do not re-read unchanged plan files');
    expect(text).toContain('reuse previously read plan context');
    expect(text).toContain('after you changed it');
    expect(text).toContain('before final completion verification');
  });

  it('requires plan-system changes to be recorded in a Braid plan first', () => {
    const text = planContextText('p1');
    expect(text).toContain('Any change to the Braid plan system itself');
    expect(text).toContain('plan prompting, context routing, authoring docs, plan file format, or run policy');
    expect(text).toContain('must first be recorded in a Braid plan before code work starts');
  });
});
