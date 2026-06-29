import { describe, it, expect } from 'vitest';
import type { BoardLike as BoardData, ToolStepLike as ToolStep } from '../shared/board';
import { detectCreatedPlan, latestCreatedPlan, planWriteSignal } from './detect';

function board(steps: ToolStep[]): BoardData {
  return { prompt: '', answer: '', status: 'done', steps } as unknown as BoardData;
}
function step(name: string, input: Record<string, unknown>): ToolStep {
  return { id: Math.random().toString(36).slice(2), name, input };
}

describe('detectCreatedPlan', () => {
  it('binds when a Write touches exactly one .braid/plans/<id>/ file', () => {
    const b = board([
      step('Read', { file_path: 'src/foo.ts' }),
      step('Write', { file_path: '/proj/.braid/plans/vr-decouple/contract.md', content: '# c' }),
    ]);
    expect(detectCreatedPlan(b)).toBe('vr-decouple');
  });

  it('handles Windows backslash paths', () => {
    const b = board([step('Write', { file_path: 'D:\\proj\\.braid\\plans\\warfare-br\\current-phase.md' })]);
    expect(detectCreatedPlan(b)).toBe('warfare-br');
  });

  it('reads Codex fileChange change paths', () => {
    const b = board([step('fileChange', { changes: [{ path: '.braid/plans/p1/decisions.md', kind: { type: 'add' } }] })]);
    expect(detectCreatedPlan(b)).toBe('p1');
  });

  it('binds when a shell command writes a plan file', () => {
    const b = board([step('Bash', {
      command: "@'x'@ | Set-Content -LiteralPath 'D:\\proj\\.braid\\plans\\quest-ios-store\\contract.md'",
      action: 'run',
    })]);
    expect(detectCreatedPlan(b)).toBe('quest-ios-store');
  });

  it('binds when shell redirection writes a plan file', () => {
    const b = board([step('Bash', { command: "printf x > '.braid/plans/quest-ios-store/current-phase.md'" })]);
    expect(detectCreatedPlan(b)).toBe('quest-ios-store');
  });

  it('ignores reads/searches of a plan (opening is not creating)', () => {
    const b = board([
      step('Read', { file_path: '.braid/plans/p1/contract.md' }),
      step('Grep', { pattern: 'x', path: '.braid/plans/p1' }),
    ]);
    expect(detectCreatedPlan(b)).toBeUndefined();
  });

  it('ignores read/list/search shell commands that mention plan paths', () => {
    const b = board([
      step('Bash', { command: 'Get-Content .braid/plans/p1/contract.md', action: 'read' }),
      step('Bash', { command: 'rg -n "Goal" .braid/plans/p1', action: 'search' }),
      step('Bash', { command: 'Get-ChildItem .braid/plans', action: 'list' }),
    ]);
    expect(detectCreatedPlan(b)).toBeUndefined();
  });

  it('is ambiguous (undefined) when writes touch two different plans', () => {
    const b = board([
      step('Write', { file_path: '.braid/plans/a/contract.md' }),
      step('Write', { file_path: '.braid/plans/b/contract.md' }),
    ]);
    expect(detectCreatedPlan(b)).toBeUndefined();
  });

  it('is ambiguous when one shell command writes two different plans', () => {
    const b = board([step('Bash', {
      command: "Set-Content .braid/plans/a/contract.md x; Set-Content .braid/plans/b/current-phase.md y",
    })]);
    expect(detectCreatedPlan(b)).toBeUndefined();
  });

  it('skips underscore/dot plan ids (_archive, _index)', () => {
    const b = board([step('Write', { file_path: '.braid/plans/_archive/old.md' })]);
    expect(detectCreatedPlan(b)).toBeUndefined();
  });

  it('returns undefined for a board with no steps', () => {
    expect(detectCreatedPlan(board([]))).toBeUndefined();
  });

  it('multiple writes to the SAME plan still bind it', () => {
    const b = board([
      step('Write', { file_path: '.braid/plans/p1/contract.md' }),
      step('Write', { file_path: '.braid/plans/p1/current-phase.md' }),
      step('Edit', { file_path: '.braid/plans/p1/decisions.md' }),
    ]);
    expect(detectCreatedPlan(b)).toBe('p1');
  });

  it('binds when the plan is created in a LATER turn of a multi-turn (existing) board', () => {
    // An existing board keeps each round's tool steps in turns[].steps, not top-level board.steps. The plan-
    // creating Write lands in the latest turn — detection must scan turns[] too, else existing boards never bind.
    const b = {
      prompt: '', answer: '', status: 'done',
      steps: [step('Read', { file_path: 'src/foo.ts' })], // round 0: discussion + reads, no plan write
      turns: [
        { prompt: 'q0', answer: 'a0', steps: [step('Read', { file_path: '.braid/plans/other/contract.md' })] },
        { prompt: 'create a plan', answer: 'done', steps: [
          step('Write', { file_path: '.braid/plans/vr-interaction-decouple/contract.md' }),
          step('Write', { file_path: '.braid/plans/vr-interaction-decouple/current-phase.md' }),
        ] },
      ],
    } as unknown as BoardData;
    expect(detectCreatedPlan(b)).toBe('vr-interaction-decouple');
  });

  it('still detects a plan written when top-level board.steps is absent (multi-turn only)', () => {
    const b = {
      prompt: '', answer: '', status: 'done',
      turns: [{ prompt: 'go', answer: 'ok', steps: [step('Write', { file_path: '.braid/plans/p9/contract.md' })] }],
    } as unknown as BoardData;
    expect(detectCreatedPlan(b)).toBe('p9');
  });

  it('planWriteSignal changes for writes to the target plan in later turns only', () => {
    const read = step('Read', { file_path: '.braid/plans/p1/current-phase.md' });
    const otherWrite = step('Write', { file_path: '.braid/plans/p2/current-phase.md' });
    const targetWrite = step('Edit', { file_path: '.braid/plans/p1/current-phase.md' });
    const b = {
      prompt: '',
      answer: '',
      status: 'streaming',
      turns: [
        { prompt: 'old', answer: 'old', steps: [read, otherWrite] },
        { prompt: 'next', answer: '', steps: [targetWrite] },
      ],
    } as unknown as BoardData;

    expect(planWriteSignal(b, 'p1')).toContain('.braid/plans/p1/current-phase.md:pending');
    expect(planWriteSignal(b, 'p1')).not.toContain('.braid/plans/p2/current-phase.md');

    targetWrite.result = 'edited';
    expect(planWriteSignal(b, 'p1')).toContain(':done:6:0');
  });

  it('latestCreatedPlan returns the most recently generated plan (last contract.md write wins)', () => {
    // A board bound to plan A later generates plan B — the binding should follow B. Scans turns in order.
    const b = {
      prompt: '', answer: '', status: 'done',
      turns: [
        { prompt: 'make plan A', answer: 'ok', steps: [step('Write', { file_path: '.braid/plans/a/contract.md' })] },
        { prompt: 'now make plan B', answer: 'ok', steps: [
          step('Write', { file_path: '.braid/plans/b/contract.md' }),
          step('Write', { file_path: '.braid/plans/b/current-phase.md' }),
        ] },
      ],
    } as unknown as BoardData;
    expect(latestCreatedPlan(b)).toBe('b');
  });

  it('latestCreatedPlan ignores non-contract writes (editing/referencing another plan is not creation)', () => {
    // Bound to A (wrote A/contract.md), then only edits B's current-phase.md + adds B evidence — NOT a new plan.
    const b = board([
      step('Write', { file_path: '.braid/plans/a/contract.md' }),
      step('Edit', { file_path: '.braid/plans/b/current-phase.md' }),
      step('Write', { file_path: '.braid/plans/b/evidence/note.md' }),
    ]);
    expect(latestCreatedPlan(b)).toBe('a');
  });

  it('latestCreatedPlan is undefined when no contract.md was written', () => {
    const b = board([
      step('Write', { file_path: '.braid/plans/a/current-phase.md' }),
      step('Edit', { file_path: '.braid/plans/a/evidence/x.md' }),
    ]);
    expect(latestCreatedPlan(b)).toBeUndefined();
  });

  it('latestCreatedPlan handles Codex fileChange + Windows paths', () => {
    const b = board([
      step('fileChange', { changes: [{ path: '.braid/plans/old/contract.md' }] }),
      step('Write', { file_path: 'D:\\proj\\.braid\\plans\\fresh-one\\contract.md' }),
    ]);
    expect(latestCreatedPlan(b)).toBe('fresh-one');
  });

  it('planWriteSignal includes shell writes to the target plan', () => {
    const shell = step('Bash', { command: "Set-Content .braid/plans/p1/current-phase.md '# Current Phase'", action: 'run' });
    const b = board([shell]);
    expect(planWriteSignal(b, 'p1')).toContain('.braid/plans/p1/:pending');

    shell.result = 'ok';
    expect(planWriteSignal(b, 'p1')).toContain(':done:2:0');
  });
});
