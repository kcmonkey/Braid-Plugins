import { describe, expect, it } from 'vitest';
import { RUN_BEGIN_SENTINEL, RUN_DONE_SENTINEL } from './runStep';
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

  it('tells the agent that full-plan execution continues across roadmap phases', () => {
    const text = planContextText('p1');
    expect(text).toContain(`START your reply with a line containing exactly ${RUN_BEGIN_SENTINEL}`);
    expect(text).toContain('full/entire/whole');
    expect(text).toContain('all phases');
    expect(text).toContain('完整执行');
    expect(text).toContain('promote the next roadmap item into current-phase.md');
    expect(text).toContain(`Emit a line containing exactly ${RUN_DONE_SENTINEL} only when`);
    expect(text).toContain('every roadmap phase is complete');
  });

  it('routes bound-board plan context without forcing every tactical task through the plan', () => {
    const text = planContextText('p1');
    expect(text).toContain('Treat this binding as a routing hint');
    expect(text).toContain('If the user asks to run, continue, update, review, discuss, or modify this plan');
    expect(text).toContain('first read .braid/plans/p1/current-phase.md, contract.md, and decisions.md');
    expect(text).toContain('unrelated tactical change');
    expect(text).toContain('do not read plan files just because this board is bound');
    expect(text).toContain('do not turn that task into plan execution');
    expect(text).not.toContain('current-phase.md, contract.md, and decisions.md before acting');
  });

  it('requires plan-system changes to be recorded in a Braid plan first', () => {
    const text = planContextText('p1');
    expect(text).toContain('Any change to the Braid plan system itself');
    expect(text).toContain('plan prompting, context routing, authoring docs, plan file format, or run policy');
    expect(text).toContain('must first be recorded in a Braid plan before code work starts');
  });
});
