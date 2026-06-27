import { describe, it, expect } from 'vitest';
import { runStep, runArm, sig, MAX_CONTINUES, RUN_DONE_SENTINEL, RUN_BEGIN_SENTINEL, type RunState } from './runStep';

const running = (over: Partial<RunState> = {}): RunState => ({ status: 'running', continues: 0, ...over });

describe('runStep — Plan run controller safety state machine (P3c / Gap E)', () => {
  it('does nothing when there is no run, or the run is paused', () => {
    expect(runStep(undefined, 'done', 'x', false).action).toBe('wait');
    expect(runStep({ status: 'paused', continues: 2 }, 'done', 'x', false).action).toBe('wait');
  });

  it('waits while a turn is in flight (streaming / idle)', () => {
    expect(runStep(running(), 'streaming', '', false).action).toBe('wait');
    expect(runStep(running(), 'idle', '', false).action).toBe('wait');
  });

  it('WAITS (does not pause) on `waiting` — a background task / scheduled wakeup auto-resumes', () => {
    expect(runStep(running(), 'waiting', 'bg task running', false).action).toBe('wait');
  });

  it('PAUSES when the agent needs the user (pending question / permission), even though the board reads streaming', () => {
    const d = runStep(running(), 'streaming', '', true);
    expect(d.action).toBe('pause');
    expect(d.action === 'pause' && d.next.status).toBe('paused');
    expect(d.action === 'pause' && d.next.note).toContain('answer');
  });

  it('PAUSES on an errored turn', () => {
    const e = runStep(running(), 'error', 'boom', false);
    expect(e.action).toBe('pause');
    expect(e.action === 'pause' && e.next.status).toBe('paused');
  });

  it('CONTINUES on a fresh settled turn under the cap (advances the counter + records the turn sig)', () => {
    const d = runStep(running({ continues: 1 }), 'done', 'made progress', false);
    expect(d.action).toBe('continue');
    if (d.action === 'continue') {
      expect(d.next.continues).toBe(2);
      expect(d.next.lastSig).toBe(sig('made progress'));
      expect(d.next.status).toBe('running');
    }
  });

  it('does NOT re-drive the same settled turn twice (lastSig guard against double-fire / remount)', () => {
    const answer = 'same turn';
    const first = runStep(running({ continues: 0 }), 'done', answer, false);
    expect(first.action).toBe('continue');
    const afterSig = first.action === 'continue' ? first.next.lastSig : undefined;
    expect(runStep(running({ continues: 1, lastSig: afterSig }), 'done', answer, false).action).toBe('wait');
  });

  it('PAUSES when the agent signals completion (the sentinel)', () => {
    const d = runStep(running({ continues: 1 }), 'done', `all gates pass.\n${RUN_DONE_SENTINEL}`, false);
    expect(d.action).toBe('pause');
    expect(d.action === 'pause' && d.next.note).toContain('completed');
  });

  it('PAUSES at the hard cap — a runaway is structurally impossible', () => {
    const d = runStep(running({ continues: MAX_CONTINUES }), 'done', 'still going', false);
    expect(d.action).toBe('pause');
    expect(d.action === 'pause' && /cap/.test(d.next.note ?? '')).toBe(true);
  });

  it('a full run drives at most MAX_CONTINUES times then pauses (simulated loop)', () => {
    let run: RunState = running();
    let drives = 0;
    for (let turn = 0; turn < MAX_CONTINUES + 5; turn++) {
      const d = runStep(run, 'done', `turn ${turn}`, false);
      if (d.action === 'continue') { drives++; run = d.next; }
      else if (d.action === 'pause') { run = d.next; break; }
    }
    expect(drives).toBe(MAX_CONTINUES);
    expect(run.status).toBe('paused');
  });
});

describe('runArm — natural-language run arming (the agent BEGIN marker replaces the ▶ button)', () => {
  it('arms a fresh run when the BEGIN marker is on its own line', () => {
    expect(runArm(undefined, `${RUN_BEGIN_SENTINEL}\nstarting work`, 1)).toEqual({ status: 'running', continues: 0, seenTurns: 1 });
  });

  it('does NOT arm without the marker (a plain discussion turn never starts a run)', () => {
    expect(runArm(undefined, 'here is how the plan works, no marker', 1)).toBeNull();
  });

  it('does NOT arm when the marker is only MENTIONED mid-line (quoting, not executing)', () => {
    // Line-anchoring stops a false bypass-permissions run when the agent merely talks about the marker.
    expect(runArm(undefined, `I will emit ${RUN_BEGIN_SENTINEL} once you ask me to execute.`, 1)).toBeNull();
  });

  it('does NOT re-arm while already running (the loop is in charge)', () => {
    expect(runArm({ status: 'running', continues: 3, seenTurns: 1 }, `${RUN_BEGIN_SENTINEL}\nx`, 2)).toBeNull();
  });

  it('does NOT re-arm the SAME stopped/completed turn from its lingering BEGIN marker (edge-trigger on turnCount)', () => {
    // The Stop-re-arm bug: a run stopped during its arming turn is paused with seenTurns = that turn; the same
    // turn's still-present BEGIN marker must NOT restart it.
    expect(runArm({ status: 'paused', continues: 0, seenTurns: 1 }, `${RUN_BEGIN_SENTINEL}\nwork`, 1)).toBeNull();
  });

  it('re-arms on a genuinely NEW turn (turnCount advanced past seenTurns)', () => {
    expect(runArm({ status: 'paused', continues: 2, seenTurns: 1 }, `${RUN_BEGIN_SENTINEL}\ngo again`, 2))
      .toEqual({ status: 'running', continues: 0, seenTurns: 2 });
  });
});
