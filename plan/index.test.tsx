import { describe, expect, it, vi } from 'vitest';

vi.mock('./plan-authoring.md', () => ({ default: '' }));

describe('planRunPolicy live completion cleanup', () => {
  it('asks for a visible completion summary before the final sentinel on auto-continue', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'phase work progressed',
          turns: [{ answer: 'phase work progressed' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 0 } },
        interrupted: false,
      });

      expect(r).toMatchObject({ permissionMode: 'bypassPermissions' });
      expect((r as any).drive).toContain('completion summary');
      expect((r as any).drive).toContain('last line');
      expect((r as any).drive).not.toContain('nothing else');
    });
  });

  it('stops a bound streaming board when completion is visible even if run state is missing', () => {
    return import('./index').then(({ planRunPolicy }) => {
    const r = planRunPolicy.step({
      boardId: 'b1',
      board: {
        status: 'streaming',
        answer: 'done\nBRAID RUN DONE',
        turns: [{ answer: 'done\nBRAID RUN DONE' }],
        elements: { plan: { planId: 'p1' } },
      } as any,
      config: {},
      state: { planId: 'p1' },
      interrupted: false,
    });

    expect(r).toMatchObject({
      stop: true,
      state: { planId: 'p1', run: { status: 'paused', note: 'completed ✓' } },
    });
    });
  });

  it('clears a stale stopped note once a newer turn has moved past the interrupted run', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'newer manual continuation made progress',
          turns: [
            { answer: 'stopped run' },
            { answer: 'newer manual continuation made progress' },
          ],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'paused', continues: 1, seenTurns: 1, note: 'paused — you stopped it' } },
        interrupted: false,
      });

      expect(r).toEqual({ state: { planId: 'p1' } });
    });
  });

  it('pauses a running plan when a ChatView fork/split truncated the board (fewer turns than seenTurns) instead of re-driving it', () => {
    // Bug: forking a question mid-run rewrites the source board into a shorter prefix in place. The run's lastSig
    // was computed over the full conversation, so the truncated answer mismatches → the loop re-drove the board as
    // a phantom "Generating…" turn. The board has FEWER turns than when the run last acted, so it must pause.
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'q0 arming turn',
          turns: [{ answer: 'q0 arming turn' }], // truncated to 1 turn by the fork
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 2, seenTurns: 4 } }, // last acted at 4 turns
        interrupted: false,
      });
      expect(r).toEqual({ state: { planId: 'p1', run: { status: 'paused', continues: 2, seenTurns: 4 } } });
    });
  });

  it('neutralizes a would-re-arm board on interrupt (a fork/split prefix whose dropped run left a stale BEGIN marker as its latest answer)', () => {
    // Case where the source board had NO active run (e.g. a completed run was dropped after a manual turn) and the
    // ChatView fork left an old arming turn (BRAID_RUN_BEGIN) as the prefix's latest answer. The fork marks the
    // source `interrupted`; without neutralizing, runArm would auto-restart the plan as a phantom "Generating…".
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'BRAID_RUN_BEGIN\nI will run the plan',
          turns: [{ answer: 'BRAID_RUN_BEGIN\nI will run the plan' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1' }, // no run
        interrupted: true,
      });
      expect(r).toEqual({ state: { planId: 'p1', run: { status: 'paused', continues: 0, seenTurns: 1 } } });
    });
  });

  it('does not neutralize a bound board with no stale BEGIN marker on interrupt (ordinary stop is a no-op for the plan)', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'just an ordinary settled answer',
          turns: [{ answer: 'just an ordinary settled answer' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1' },
        interrupted: true,
      });
      expect(r).toBeNull();
    });
  });

  it('does not re-pause (or re-arm) a truncated board once its run is already paused — idempotent, no loop', () => {
    // After the truncation pause, seenTurns stays above the board's turn count, so a stale BEGIN marker in the now
    // top turn cannot re-arm it and the policy returns wait (null) rather than churning the run state every tick.
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'BRAID_RUN_BEGIN\nstarting work',
          turns: [{ answer: 'BRAID_RUN_BEGIN\nstarting work' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'paused', continues: 2, seenTurns: 4 } },
        interrupted: false,
      });
      expect(r).toBeNull();
    });
  });
});
