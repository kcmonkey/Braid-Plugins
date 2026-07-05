import { describe, expect, it, vi } from 'vitest';

vi.mock('./plan-authoring.md', () => ({ default: '' }));

describe('planRunPolicy live completion cleanup', () => {
  it('does not arm auto-run when the model emits BEGIN for an ordinary "continue testing" prompt', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: '继续测试',
          answer: 'BRAID_RUN_BEGIN\n我会继续检查一下。',
          turns: [{ prompt: '继续测试', answer: 'BRAID_RUN_BEGIN\n我会继续检查一下。' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1' },
        interrupted: false,
      });

      expect(r).toBeNull();
    });
  });

  it('arms auto-run when the latest user prompt explicitly asks to run the current phase', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer: 'BRAID_RUN_BEGIN\nStarting the current phase.',
          turns: [{ prompt: 'Run the current phase', answer: 'BRAID_RUN_BEGIN\nStarting the current phase.' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1' },
        interrupted: false,
      });

      expect(r).toEqual({
        state: {
          planId: 'p1',
          run: { status: 'running', continues: 0, seenTurns: 1, userPrompt: 'Run the current phase' },
        },
      });
    });
  });

  it('asks for a visible completion summary before the final sentinel on auto-continue', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer: 'phase work progressed',
          turns: [{ prompt: 'Run the current phase', answer: 'phase work progressed' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 0, userPrompt: 'Run the current phase' } },
        interrupted: false,
      });

      expect(r).toMatchObject({ permissionMode: 'bypassPermissions' });
      expect((r as any).displayPrompt).toBe('Run the current phase');
      expect((r as any).event).toMatchObject({
        kind: 'continue',
        title: 'Plan auto-continued',
        detail: 'Continuing the current phase without adding a user-authored prompt.',
      });
      expect((r as any).drive).toContain('completion-report');
      expect((r as any).drive).toContain('final line');
      expect((r as any).drive).not.toContain('nothing else');
    });
  });

  it('returns a source-neutral verify step when a summarized completion has Settle Gate predicates', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const predicates = [{ kind: 'run' as const, command: 'npm test' }];
      const answer = '## Execution Summary\n- Completed: done\n- Verification: local checks\n- Remaining: none\nBRAID_RUN_DONE';
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer,
          turns: [{ prompt: 'Run the current phase', answer }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1, userPrompt: 'Run the current phase' }, settlePredicates: predicates },
        interrupted: false,
      });

      expect(r).toMatchObject({
        verify: predicates,
        state: { planId: 'p1', run: { status: 'running', note: 'verifying Settle Gate' }, settlePredicates: predicates },
        event: { kind: 'verify', title: 'Plan verifying Settle Gate' },
      });
    });
  });

  it('completes as host-verified when the Settle Gate verdict passes', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const predicates = [{ kind: 'grep1' as const, pattern: 'SettlePredicate' }];
      const answer = '## Execution Summary\n- Completed: done\n- Verification: local checks\n- Remaining: none\nBRAID_RUN_DONE';
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer,
          turns: [{ prompt: 'Run the current phase', answer }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1, userPrompt: 'Run the current phase' }, settlePredicates: predicates },
        interrupted: false,
        settleVerdict: { pass: true, results: [{ predicate: predicates[0], pass: true, detail: 'matched' }] },
      });

      expect(r).toMatchObject({
        state: { planId: 'p1', run: { status: 'paused', note: 'completed ✓ host-verified' }, settlePredicates: predicates },
        event: { kind: 'verified', title: 'Plan completed with host-verified Settle Gate' },
      });
    });
  });

  it('re-drives with concrete Settle Gate failure detail when the verdict fails', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const predicates = [{ kind: 'grep0' as const, pattern: 'legacyName' }];
      const answer = '## Execution Summary\n- Completed: done\n- Verification: local checks\n- Remaining: none\nBRAID_RUN_DONE';
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer,
          turns: [{ prompt: 'Run the current phase', answer }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1, userPrompt: 'Run the current phase' }, settlePredicates: predicates },
        interrupted: false,
        settleVerdict: { pass: false, results: [{ predicate: predicates[0], pass: false, detail: 'legacyName matched src/a.ts:1' }] },
      });

      expect(r).toMatchObject({
        permissionMode: 'bypassPermissions',
        state: { planId: 'p1', run: { status: 'running', continues: 2, note: 'repairing Settle Gate' }, settlePredicates: predicates },
        event: { kind: 'repair', title: 'Plan requested Settle Gate repair' },
      });
      expect((r as any).drive).toContain('The host-ran Settle Gate failed');
      expect((r as any).drive).toContain('grep0: legacyName');
      expect((r as any).drive).toContain('legacyName matched src/a.ts:1');
    });
  });

  it('keeps the original user prompt as displayPrompt when driving a completion-summary repair', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          prompt: 'Run the current phase',
          answer: 'Checkin succeeded.\nBRAID_RUN_DONE',
          turns: [{ prompt: 'Run the current phase', answer: 'Checkin succeeded.\nBRAID_RUN_DONE' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1, lastSig: 'old', userPrompt: 'Run the current phase' } },
        interrupted: false,
      });

      expect((r as any).drive).toContain('You emitted the completion marker without the required');
      expect((r as any).displayPrompt).toBe('Run the current phase');
      expect((r as any).displayPrompt).not.toContain('You emitted the completion marker');
      expect((r as any).event).toMatchObject({
        kind: 'repair',
        title: 'Plan requested execution summary',
      });
    });
  });

  it('uses a stricter execution-summary report block in the auto-continue prompt', () => {
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

      expect((r as any).drive).toContain('## Execution Summary');
      expect((r as any).drive).toContain('Completed:');
      expect((r as any).drive).toContain('Verification:');
      expect((r as any).drive).toContain('Remaining:');
    });
  });

  it('keeps auto-continue from rereading unchanged plan and skill files every tick', () => {
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

      expect((r as any).drive).toContain('Reuse plan files and skill bodies already read');
      expect((r as any).drive).toContain('do not re-read stable plan or skill files');
      expect((r as any).drive).toContain('before final completion verification');
      expect((r as any).drive).toContain('Do not read `.braid/plans/_authoring.md` during execution');
      expect((r as any).drive).not.toContain('Always read current-phase.md and contract.md first');
    });
  });

  it('stops a bound streaming board when summarized completion is visible even if run state is missing', () => {
    return import('./index').then(({ planRunPolicy }) => {
    const r = planRunPolicy.step({
      boardId: 'b1',
      board: {
        status: 'streaming',
        answer: '## Execution Summary\n- Completed: done\n- Verification: passed\n- Remaining: none\nBRAID RUN DONE',
        turns: [{ answer: '## Execution Summary\n- Completed: done\n- Verification: passed\n- Remaining: none\nBRAID RUN DONE' }],
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

  it('accepts the screenshot-style bold execution-summary labels and stops the live board', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const answer = [
        '## Execution Summary',
        '- **Completed:** Added the packed move data container and checked all gates.',
        '- **Verification:** build wrapper passed with BUILD_EXIT_CODE=0.',
        '- **Remaining:** none for the current phase.',
        '',
        'BRAID_RUN_DONE',
      ].join('\n');
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'streaming',
          answer,
          turns: [{ answer }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1 } },
        interrupted: false,
      });

      expect(r).toMatchObject({
        stop: true,
        state: { planId: 'p1', run: { status: 'paused', note: 'completed ✓' } },
      });
    });
  });

  it('does not accept a bare completion marker as done; it stops the live turn and schedules a summary repair', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'streaming',
          answer: 'Checkin succeeded.\nBRAID_RUN_DONE',
          turns: [{ answer: 'Checkin succeeded.\nBRAID_RUN_DONE' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1 } },
        interrupted: false,
      });

      expect(r).toMatchObject({
        stop: true,
        state: { planId: 'p1', run: { status: 'running', note: 'completion marker missing Execution Summary' } },
      });
    });
  });

  it('re-drives a settled bare completion marker with a dedicated completion-report repair prompt', () => {
    return import('./index').then(({ planRunPolicy }) => {
      const r = planRunPolicy.step({
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'Checkin succeeded.\nBRAID_RUN_DONE',
          turns: [{ answer: 'Checkin succeeded.\nBRAID_RUN_DONE' }],
          elements: { plan: { planId: 'p1' } },
        } as any,
        config: {},
        state: { planId: 'p1', run: { status: 'running', continues: 1, lastSig: 'old' } },
        interrupted: false,
      });

      expect(r).toMatchObject({ permissionMode: 'bypassPermissions' });
      expect((r as any).drive).toContain('You emitted the completion marker without the required');
      expect((r as any).drive).toContain('## Execution Summary');
      expect((r as any).state.run.summaryRepairSent).toBe(true);
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
