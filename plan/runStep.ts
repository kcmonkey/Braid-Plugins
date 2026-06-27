// Pure decision for the Plan run controller's auto-continue loop (plans/Plan-Plugin P3c, direction A).
// Extracted from the React effect so the RUNAWAY-PRONE state machine is deterministically unit-testable,
// independent of React/DOM. The hard cap (MAX_CONTINUES) is the structural backstop: even if every other
// branch were wrong, the loop can re-drive a board at most MAX_CONTINUES times before it pauses.

export const MAX_CONTINUES = 6;
export const RUN_DONE_SENTINEL = 'BRAID_RUN_DONE';
// The agent emits this (told via the plan context provider) when the USER asks it to EXECUTE/RUN the plan — as
// opposed to merely discussing it. That is what ARMS the auto-continue loop, so a run starts from natural
// language ("run the plan" / "一口气跑完") rather than a button. The agent classifies intent (it understands the
// request perfectly); the policy just reacts to the marker. (plans/Plan-Plugin — NL-driven run, no buttons)
export const RUN_BEGIN_SENTINEL = 'BRAID_RUN_BEGIN';

// `seenTurns` = the board's turn count at the last action this run took (arm / continue / pause / stop). Arming
// is EDGE-triggered on it: a run arms only on a turn NEWER than `seenTurns`, so a stale BEGIN marker left in the
// just-stopped (or just-completed) turn's answer can't re-arm the run — only a genuinely new request can.
export interface RunState { status: 'running' | 'paused'; continues: number; lastSig?: string; seenTurns?: number; note?: string }

// True only when `sentinel` appears on its OWN line (ignoring surrounding whitespace). The markers are
// alphanumeric+underscore, so no regex escaping is needed. Line-anchoring stops a false trigger when the agent
// merely MENTIONS/quotes the marker mid-sentence (e.g. "I'll emit BRAID_RUN_DONE when finished").
function sentinelOnLine(text: string, sentinel: string): boolean {
  return new RegExp(`^\\s*${sentinel}\\s*$`, 'm').test(text);
}

export type RunDecision =
  | { action: 'continue'; next: RunState } // persist `next`, then re-drive the board
  | { action: 'pause'; next: RunState }    // persist `next` (paused), do NOT re-drive
  | { action: 'wait' };                    // do nothing this render

// FNV-1a hash of a settled turn's answer. `lastSig` makes each settled turn drive AT MOST ONCE — the guard
// against double-fire (effect re-runs) and against re-driving the same turn after a card remount/reload.
export function sig(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Arming decision: should a fresh run START? The agent emits RUN_BEGIN (on its own line) when the user asks it to
 * execute the plan. Returns a fresh `running` RunState to ADOPT, or null. Pure + total. Guards:
 *  - never re-arm while already running (the loop is in charge);
 *  - EDGE-trigger on `turnCount`: arm only on a turn NEWER than `run.seenTurns`. This is what makes a manual Stop
 *    (or a completion) STICK — the just-stopped turn's lingering BEGIN marker is on a turn we've already seen, so
 *    it can't restart the run; only a genuinely new request (a later turn) re-arms.
 * `answer` is the LATEST turn's answer (not the flattened board answer) so an old turn's marker can't re-arm.
 */
export function runArm(run: RunState | undefined, answer: string, turnCount: number): RunState | null {
  if (run?.status === 'running') return null;
  if (!sentinelOnLine(answer, RUN_BEGIN_SENTINEL)) return null;
  if (turnCount <= (run?.seenTurns ?? 0)) return null;
  return { status: 'running', continues: 0, seenTurns: turnCount };
}

/**
 * Decide what the run loop should do for a board's CURRENT (status, answer, needsUser). Pure + total.
 * Order: not-running → wait; needsUser (a pending AskUserQuestion — a real human decision) → pause; turn in
 * flight OR `waiting` → wait; error → pause; else the turn is `done`: already-acted → wait; completion sentinel →
 * pause; cap reached → pause; else continue.
 *   `needsUser` is supplied by the policy (`hasPendingAsk`) because a pending ask BLOCKS the turn, so the board
 *   reads as `streaming` — status alone cannot see it. (A pending PERMISSION prompt is intentionally NOT a pause:
 *   the run bypasses approvals on continues, and turn 1 just waits for the user's approval.)
 */
export function runStep(run: RunState | undefined, status: string, answer: string, needsUser: boolean): RunDecision {
  if (!run || run.status !== 'running') return { action: 'wait' };
  if (needsUser) return { action: 'pause', next: { ...run, status: 'paused', note: 'paused — needs your answer' } };
  // `waiting` = the board launched a background task / scheduled wakeup and is holding its session to AUTO-RESUME;
  // it is NOT a blocker — wait it out (it settles to `done` later) rather than pausing. (was a wrong pause before)
  if (status === 'streaming' || status === 'idle' || status === 'waiting') return { action: 'wait' };
  if (status === 'error') return { action: 'pause', next: { ...run, status: 'paused', note: 'paused — error' } };
  // status === 'done'
  const s = sig(answer);
  if (run.lastSig === s) return { action: 'wait' };
  if (sentinelOnLine(answer, RUN_DONE_SENTINEL)) return { action: 'pause', next: { ...run, status: 'paused', lastSig: s, note: 'completed ✓' } };
  if (run.continues >= MAX_CONTINUES) return { action: 'pause', next: { ...run, status: 'paused', lastSig: s, note: `paused — hit the ${MAX_CONTINUES}-continue cap` } };
  return { action: 'continue', next: { ...run, continues: run.continues + 1, lastSig: s, note: undefined } };
}
