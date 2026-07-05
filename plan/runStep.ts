// Pure decision for the Plan run controller's auto-continue loop (plans/Plan-Plugin P3c, direction A).
// Extracted from the React effect so the RUNAWAY-PRONE state machine is deterministically unit-testable,
// independent of React/DOM. The hard cap (MAX_CONTINUES) is the structural backstop: even if every other
// branch were wrong, the loop can re-drive a board at most MAX_CONTINUES times before it pauses.
import type { SettlePredicate, SettleVerdict } from '../../../src/protocol';

export const MAX_CONTINUES = 6;
export const RUN_DONE_SENTINEL = 'BRAID_RUN_DONE';
const RUN_DONE_SENTINEL_ALIASES = ['BRAID RUN DONE'];
// The agent emits this (told via the plan context provider) when the USER asks it to EXECUTE/RUN the plan — as
// opposed to merely discussing it. That is what ARMS the auto-continue loop, so a run starts from natural
// language ("run the plan" / "一口气跑完") rather than a button. The agent classifies intent (it understands the
// request perfectly); the policy just reacts to the marker. (plans/Plan-Plugin — NL-driven run, no buttons)
export const RUN_BEGIN_SENTINEL = 'BRAID_RUN_BEGIN';

// `seenTurns` = the board's turn count at the last action this run took (arm / continue / pause / stop). Arming
// is EDGE-triggered on it: a run arms only on a turn NEWER than `seenTurns`, so a stale BEGIN marker left in the
// just-stopped (or just-completed) turn's answer can't re-arm the run — only a genuinely new request can.
export interface RunState { status: 'running' | 'paused'; continues: number; lastSig?: string; seenTurns?: number; note?: string; summaryRepairSent?: boolean; userPrompt?: string }

// True only when `sentinel` appears on its OWN line (ignoring surrounding whitespace). The markers are
// alphanumeric+underscore, so no regex escaping is needed. Line-anchoring stops a false trigger when the agent
// merely MENTIONS/quotes the marker mid-sentence (e.g. "I'll emit BRAID_RUN_DONE when finished").
function sentinelOnLine(text: string, sentinel: string): boolean {
  return new RegExp(`^\\s*${sentinel}\\s*$`, 'm').test(text);
}

function firstRunDoneSentinelMatch(text: string): RegExpExecArray | null {
  let first: RegExpExecArray | null = null;
  for (const sentinel of [RUN_DONE_SENTINEL, ...RUN_DONE_SENTINEL_ALIASES]) {
    const m = new RegExp(`^\\s*${sentinel}\\s*$`, 'm').exec(text);
    if (m && (!first || m.index < first.index)) first = m;
  }
  return first;
}

export function runDoneVisible(text: string): boolean {
  return firstRunDoneSentinelMatch(text) != null;
}

export function runCompletionSummaryVisible(text: string): boolean {
  const done = firstRunDoneSentinelMatch(text);
  const heading = /^\s*#{2,3}\s*Execution Summary\s*$/im.exec(text);
  if (!heading) return false;
  if (done && heading.index > done.index) return false;
  const body = text.slice(heading.index + heading[0].length, done?.index ?? text.length).trim();
  const hasLine = (label: string) => new RegExp(`^\\s*[-*]?\\s*(?:\\*\\*)?${label}(?:\\*\\*)?:(?:\\*\\*)?\\s*\\S`, 'im').test(body);
  return hasLine('Completed') && hasLine('Verification') && hasLine('Remaining');
}

export type RunDecision =
  | { action: 'continue'; next: RunState; reason?: 'completionSummaryMissing' | 'settleVerificationFailed'; verdict?: SettleVerdict } // persist `next`, then re-drive the board
  | { action: 'verify'; next: RunState; predicates: SettlePredicate[] } // persist `next`, then ask the source-neutral driver to run host predicates
  | { action: 'pause'; next: RunState; stop?: boolean; verified?: boolean } // persist `next`; optionally stop the live turn
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
export interface RunStepOptions {
  settlePredicates?: SettlePredicate[];
  settleVerdict?: SettleVerdict;
}

export function runStep(run: RunState | undefined, status: string, answer: string, needsUser: boolean, options: RunStepOptions = {}): RunDecision {
  if (!run || run.status !== 'running') return { action: 'wait' };
  if (needsUser) return { action: 'pause', next: { ...run, status: 'paused', note: 'paused — needs your answer' } };
  const s = sig(answer);
  const settlePredicates = options.settlePredicates ?? [];
  if (runDoneVisible(answer)) {
    if (runCompletionSummaryVisible(answer)) {
      if (settlePredicates.length) {
        const verdict = options.settleVerdict;
        if (!verdict) {
          return {
            action: 'verify',
            predicates: settlePredicates,
            next: { ...run, lastSig: s, note: 'verifying Settle Gate' },
          };
        }
        if (verdict.pass) {
          const next = { ...run, status: 'paused' as const, lastSig: s, note: 'completed ✓ host-verified' };
          return { action: 'pause', next, verified: true, ...(status === 'streaming' || status === 'waiting' ? { stop: true } : {}) };
        }
        if (run.continues >= MAX_CONTINUES) {
          return {
            action: 'pause',
            next: { ...run, status: 'paused', lastSig: s, note: `paused — Settle Gate failed and hit the ${MAX_CONTINUES}-continue cap` },
          };
        }
        return {
          action: 'continue',
          reason: 'settleVerificationFailed',
          verdict,
          next: { ...run, continues: run.continues + 1, lastSig: s, note: 'repairing Settle Gate' },
        };
      }
      const next = { ...run, status: 'paused' as const, lastSig: s, note: 'completed ✓' };
      return { action: 'pause', next, ...(status === 'streaming' || status === 'waiting' ? { stop: true } : {}) };
    }
    if (status === 'streaming' || status === 'idle' || status === 'waiting') return { action: 'wait' };
    if (run.summaryRepairSent) {
      return { action: 'pause', next: { ...run, status: 'paused', lastSig: s, note: 'paused — completion marker missing Execution Summary' } };
    }
    return {
      action: 'continue',
      reason: 'completionSummaryMissing',
      next: { ...run, lastSig: s, note: 'repairing completion summary', summaryRepairSent: true },
    };
  }
  // `waiting` = the board launched a background task / scheduled wakeup and is holding its session to AUTO-RESUME;
  // it is NOT a blocker — wait it out (it settles to `done` later) rather than pausing. (was a wrong pause before)
  if (status === 'streaming' || status === 'idle' || status === 'waiting') return { action: 'wait' };
  if (status === 'error') return { action: 'pause', next: { ...run, status: 'paused', note: 'paused — error' } };
  // status === 'done'
  if (run.lastSig === s) return { action: 'wait' };
  if (run.continues >= MAX_CONTINUES) return { action: 'pause', next: { ...run, status: 'paused', lastSig: s, note: `paused — hit the ${MAX_CONTINUES}-continue cap` } };
  return { action: 'continue', next: { ...run, continues: run.continues + 1, lastSig: s, note: undefined } };
}
