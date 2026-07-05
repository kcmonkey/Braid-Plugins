// Pure parsers that turn a plan's markdown files into a glanceable snapshot (phase / gate progress / decisions /
// gaps) for the board chip + the ChatView plan panel. Kept pure + total so they are unit-testable independent of
// React/DOM/host I/O — the hooks in index.tsx do the async readBraidFile and feed the text in here.
// (plans/Plan-Plugin — ChatView/board plan visualization)

export interface PlanGate { text: string; done: boolean }
export interface PlanDecision { id: string; title: string }
export interface PlanTargetGroup { key: string; label: string; items: string[] }
export interface PlanSnapshot {
  phase?: string;
  goal?: string;       // the plan's overall objective (contract.md "## Goal") — the "why"
  phaseGoal?: string;  // what the CURRENT phase is trying to achieve (current-phase.md "## Goal") — the "what now"
  finalTarget: PlanTargetGroup[]; // structured final-state / anti-drift checks from contract.md "## Goal"
  gates: PlanGate[];
  done: number;
  total: number;
  decisions: PlanDecision[];
  deferred: string[]; // "gaps" — Deferred / Out-of-Scope / Blockers bullets, if the plan declares any
  phases: string[];   // contract.md "## Phase Roadmap" — the ordered phase list (PLAN-level progress axis)
  phaseIndex: number; // 1-based position of the current phase within `phases`, or 0 when it can't be matched
}

// First markdown heading, with the plan-format "Current Phase:" prefix stripped (so a current-phase.md whose
// heading is "# Current Phase: Smoke" shows just "Smoke").
export function firstHeading(md: string): string | undefined {
  const m = md.match(/^#{1,6}\s+(.+?)\s*$/m);
  // Strip the "Current Phase" label whatever separator the plan uses (": " / " — " / " - ").
  return m ? m[1].replace(/^Current Phase\s*[:—–-]\s*/i, '').trim() : undefined;
}

// Acceptance gates = GitHub-style task checkboxes. `- [ ]` pending, `- [x]` done. This is the progress metric.
export function parseGates(md: string): PlanGate[] {
  const out: PlanGate[] = [];
  // `[ \t]+` (not `\s+`) so an empty checkbox can't let the gate text spill onto the next line / swallow the
  // following list item — only same-line text counts; a bare `- [ ]` is correctly skipped (not a gate).
  for (const m of md.matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.*\S)[ \t]*$/gm)) {
    out.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() });
  }
  return out;
}

// Locked decisions = `## Dn` OR `## ADR-n` / `## ADR-001` headings (both conventions appear in real plans), each
// optionally carrying a parenthetical status/date `(RESOLVED 2026-…)` before a `—`/`:`/`-` separator. Title = the
// heading remainder, else the id alone. (grounded against real ContractorsShowdown plans — ADR-style was missed)
export function parseDecisions(md: string): PlanDecision[] {
  const out: PlanDecision[] = [];
  for (const m of md.matchAll(/^#{2,4}\s+(ADR-?\d+|D\d+)\b[ \t]*(?:\([^)]*\))?[ \t]*[-–—:.]*[ \t]*(.*?)[ \t]*$/gm)) {
    const title = (m[2] ?? '').trim();
    out.push({ id: m[1], title: title || m[1] });
  }
  return out;
}

const GAP_HEADING = /^#{1,6}\s+(?:deferred|out[\s-]*of[\s-]*scope|gaps?|blockers?|carry[\s-]*forward|not\s+doing)\b/i;
// "Gaps" = bullets under a Deferred / Out-of-Scope / Gaps / Blockers / Carry-Forward heading (the plan-format
// sections for "what's explicitly NOT done / open"). Collected until the next heading.
export function parseDeferred(md: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) { inSection = GAP_HEADING.test(line); continue; }
    if (!inSection) continue;
    const m = line.match(/^[ \t]*[-*]\s+(.*\S)[ \t]*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// The prose under a heading (everything until the next heading), trimmed. Used to pull the "## Goal" body out of
// the contract / current-phase docs so the panel can show WHY the plan exists + WHAT the current phase delivers.
export function parseSection(md: string, headingRe: RegExp): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) { inSection = headingRe.test(line); continue; }
    if (inSection) out.push(line);
  }
  return out.join('\n').trim();
}

const GOAL_HEADING = /^#{1,6}\s+goal\b/i;
// A phase's intent: prefer its "## Goal", else "## What To Deliver" (plan-format current-phase.md section names).
const PHASE_GOAL_HEADING = /^#{1,6}\s+(?:goal|what\s+to\s+deliver)\b/i;

const TARGET_LABELS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'finalTarget', label: 'Final target', re: /^(?:final\s+target|target|end\s+state(?:\s*\([^)]*\))?|最终目标)\s*[:：]\s*(.*)$/i },
  { key: 'doneMeans', label: 'Done means', re: /^(?:done\s+means|completion\s+means|done\s*=|完成(?:意味着|标准)?|完成后)\s*[:：]\s*(.*)$/i },
  { key: 'notDoneUntil', label: 'Not done until', re: /^(?:not\s+done\s+until|must\s+include|completion\s+requires|未完成直到|必须包括)\s*[:：]\s*(.*)$/i },
  { key: 'notEnough', label: 'Not enough', re: /^(?:not\s+enough|insufficient|does\s+not\s+count|不达标|不算完成)\s*[:：]\s*(.*)$/i },
];
function stripListMarker(line: string): string {
  return line.replace(/^[ \t]*(?:[-*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '').trim();
}
function targetLabel(line: string): { key: string; label: string; inline: string } | undefined {
  const t = line.trim();
  for (const l of TARGET_LABELS) {
    const m = t.match(l.re);
    if (m) return { key: l.key, label: l.label, inline: (m[1] ?? '').trim() };
  }
  return undefined;
}
// "Final target" checks live inside contract.md "## Goal" so the contract keeps the canonical section order while
// still giving the UI something stronger than free prose. These bullets are what prevent "all gates checked" from
// hiding that the user's actual final state was missed.
export function parseFinalTarget(goalBody: string): PlanTargetGroup[] {
  const byKey = new Map<string, PlanTargetGroup>();
  let current: PlanTargetGroup | undefined;
  const ensure = (key: string, label: string): PlanTargetGroup => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const next = { key, label, items: [] };
    byKey.set(key, next);
    return next;
  };
  for (const raw of goalBody.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lbl = targetLabel(line);
    if (lbl) {
      current = ensure(lbl.key, lbl.label);
      if (lbl.inline) current.items.push(stripListMarker(lbl.inline));
      continue;
    }
    if (!current) continue;
    const item = stripListMarker(line);
    if (item) current.items.push(item);
  }
  return TARGET_LABELS
    .map((l) => byKey.get(l.key))
    .filter((g): g is PlanTargetGroup => !!g && g.items.length > 0);
}

const PHASE_ROADMAP_HEADING = /^#{1,6}\s+phase\s+roadmap\b/i;
// The ordered phase list from contract.md "## Phase Roadmap". Each list item is one phase; a wrapped continuation
// line (roadmap items often span two lines) folds back into the item it belongs to. This is the PLAN-level
// progress axis (how many phases), distinct from the gate fraction (the CURRENT phase's acceptance criteria).
export function parsePhases(contractMd: string): string[] {
  const body = parseSection(contractMd, PHASE_ROADMAP_HEADING);
  if (!body) return [];
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(/^[ \t]*(?:[-*]|\d+[.)])[ \t]+(.*\S)[ \t]*$/);
    if (m) out.push(m[1].trim());
    else if (out.length && raw.trim()) out[out.length - 1] += ' ' + raw.trim();
  }
  return out;
}

const PHASE_STOP = new Set(['phase', 'the', 'and', 'for', 'with', 'into', 'via', 'add', 'use', 'its', 'per', 'new', 'that']);
function sigWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !PHASE_STOP.has(w)));
}
// Best-effort: which roadmap phase is the current one? Match the current-phase name against each roadmap item by
// significant-word overlap, strongest wins (need >=2 shared words so a lone coincidence can't win). 0 = "couldn't
// tell" -> the panel shows the roadmap without a current marker rather than highlighting the wrong phase.
export function matchPhaseIndex(phases: string[], phaseName?: string): number {
  if (!phases.length) return 0;
  const name = phaseName ?? '';
  const target = sigWords(name);
  const scorePhase = (p: string): number => {
    const w = sigWords(p);
    let score = 0;
    for (const t of target) if (w.has(t)) score++;
    return score;
  };
  let best = 0;
  let bestScore = 1;
  if (target.size) {
    phases.forEach((p, i) => {
      const score = scorePhase(p);
      if (score > bestScore) { bestScore = score; best = i + 1; }
    });
  }
  // Strong signal: the current-phase name often carries its ordinal ("Phase 2 — …", "P2:"). Trust it directly
  // unless the current phase text/goal has a clearly stronger content match elsewhere; this catches stale copied
  // headings like "Phase 5 - ..." after the agent already promoted the phase body to Phase 7.
  const ord = name.match(/^\s*(?:phase|p)\s*0*(\d{1,3})\b/i);
  if (ord) {
    const n = parseInt(ord[1], 10);
    if (n >= 1 && n <= phases.length) {
      const ordinalScore = target.size ? scorePhase(phases[n - 1]) : 0;
      if (best && best !== n && bestScore >= 3 && bestScore >= ordinalScore + 2) return best;
      return n;
    }
  }
  if (!target.size) return 0;
  return best;
}

export function parsePlanSnapshot(docs: { phaseMd: string; decisionsMd: string; contractMd: string }): PlanSnapshot {
  const gates = parseGates(docs.phaseMd);
  const phase = firstHeading(docs.phaseMd);
  const phaseGoal = parseSection(docs.phaseMd, PHASE_GOAL_HEADING) || undefined;
  const phases = parsePhases(docs.contractMd);
  const goal = parseSection(docs.contractMd, GOAL_HEADING);
  return {
    phase,
    goal: goal || undefined,
    phaseGoal,
    finalTarget: parseFinalTarget(goal),
    gates,
    done: gates.filter((g) => g.done).length,
    total: gates.length,
    decisions: parseDecisions(docs.decisionsMd),
    // Gaps can be declared in either the contract (Deferred / Out Of Scope) or the current phase (Blockers /
    // Carry-Forward); merge both, contract first.
    deferred: [...parseDeferred(docs.contractMd), ...parseDeferred(docs.phaseMd)],
    phases,
    // Prefer the phase HEADING match; the goal body shares generic architecture words with many phases (e.g.
    // "plugin aggregate state" collides with an early phase's roadmap text), so only fall back to name+goal when
    // the heading alone can't place the phase. Without this, a plan whose heading uniquely names the LAST phase
    // (e.g. "Cleanup Retention Compatibility" → Phase 8) shows an early index because the goal tied with Phase 1.
    phaseIndex: matchPhaseIndex(phases, phase) || matchPhaseIndex(phases, [phase, phaseGoal].filter(Boolean).join('\n')),
  };
}
