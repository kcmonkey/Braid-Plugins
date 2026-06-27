// The Braid Plan plugin OWNS the plan methodology (plans/Plan-Plugin D11 / 方向O). The agent no longer learns
// "how to write a plan" from per-provider prompts (`.claude`/`.codex`) — the plugin is the single,
// project-neutral source, so it runs at full strength in ANY project. Two layers:
//   1. DEFAULT_METHODOLOGY (below) — a COMPACT, fixed format + a POINTER, injected (DORMANT) on EVERY board so
//      "create a plan" works from natural language anywhere. Small enough to ride every turn.
//   2. The FULL authoring doc (`plan-authoring.md`, shipped in this plugin) — seeded once to the project's
//      `.braid/plans/_authoring.md` (see index.tsx `seedArtifacts`); the compact block points the agent to it,
//      and the agent Reads it ON DEMAND (lazy — not injected every turn). (方向O — portable, lazy depth)
// The agent scaffolds a SINGLE `.braid/plans/<name>/`; the run policy AUTO-BINDS the board to it
// (detectCreatedPlan). This replaces the `/new-plan` command for the common case.

import { RUN_BEGIN_SENTINEL, RUN_DONE_SENTINEL } from './runStep';

// Compact, project-neutral contract format — one canonical structure for every plan, small enough to ride every
// turn. The FULL rules live in the seeded `.braid/plans/_authoring.md` (pointed to below).
export const DEFAULT_METHODOLOGY =
  "Braid plans use the project's contract format — EVERY plan has the SAME structure (do not invent your own). " +
  'A plan is a folder `.braid/plans/<PlanName>/` containing `contract.md`, `current-phase.md`, `decisions.md`, ' +
  '`history.md`, and an `evidence/` dir. ONE active phase at a time: `current-phase.md` is the single task card ' +
  'the next implementer runs; the full phase list lives in contract.md → Phase Roadmap and is promoted into ' +
  'current-phase.md as work advances (do NOT write every phase file up front).\n' +
  '`contract.md` — `##` sections IN ORDER: `## Goal` (why it exists + what "done" means), `## Current Decisions` ' +
  '(effective locked decisions, `D1: … + why`; superseded go to history.md), `## Key Interfaces / Contracts` ' +
  '(signatures + confirmed asset/resource identifiers every phase must preserve), `## Invariants`, ' +
  '`## Phase Roadmap` (ordered phase list), `## Global Verification` (gates run after EVERY phase — the ' +
  "project's build/test command(s)), `## Prohibited Actions`, `## Deferred / Out Of Scope`. Keep contract.md short.\n" +
  '`current-phase.md` — `# Current Phase: <Name>`, then `## Goal` (END STATE in 1-2 lines), `## What to do` ' +
  '(discrete deliverables — WHAT not HOW, one scoped change per bullet), `## Files`, `## Acceptance Criteria` ' +
  '(each a `- [ ]` checkbox, machine-verifiable by a command/test/tool — tick `- [x]` as each passes), ' +
  '`## Test` (command + scope). CONDITIONAL sections, include only when they apply: `## Prerequisites` (phases ' +
  'that must finish first), `## Ground Truth 🔴` (verified facts about EXISTING code the phase relies on, each ' +
  'with its verification method — only when modifying existing code/assets), `## Constraints` (a named ' +
  'downstream contract that must not break).\n' +
  '`decisions.md` — current ADRs only, each a `## ADR-<n> — <Title>` block with Status / Decision / Why / ' +
  'Implications; when a decision is replaced, move the old ADR to history.md.\n' +
  'FORBIDDEN in current-phase.md: "Technical Approach" / "Implementation Steps" / pseudocode / code blocks / ' +
  'node GUIDs / numbered "first do X then Y" procedures / schema dumps / per-phase Why essays / ' +
  'Layer·Type·Severity metadata. FORBIDDEN phase types: a read-only "Phase 0 / Discovery / Audit" phase, and a ' +
  '"decision lock-in" phase (lock decisions with the user via AskUserQuestion BEFORE writing the plan).\n' +
  'For the FULL authoring rules (exploration checklist, complete templates, banned content, preflight, legacy ' +
  'migration), read `.braid/plans/_authoring.md` before creating or editing a plan.\n' +
  'Proactively consider the plan system when the user asks for systematic engineering: multi-phase or multi-file ' +
  'work, architecture/provider/host/plugin seams, migrations, risky refactors, cross-module behavior changes, or ' +
  'work that needs sequenced verification. Do NOT force a plan for small tactical fixes, local questions, simple ' +
  'reviews, or single-file edits. If a plan is warranted, say so briefly and follow the plan-creation flow below; ' +
  'do not wait for the user to use the word "plan".\n' +
  'When the user asks you (natural language) to CREATE / 生成 a plan: briefly explore the code, propose 2-3 ' +
  'approaches and ask which they want (AskUserQuestion), then scaffold a SINGLE `.braid/plans/<PlanName>/` in ' +
  'EXACTLY this format and tell the user the plan name. When updating or advancing a plan, edit those files in ' +
  'place, keeping this structure. If the user is NOT talking about a Braid plan, ignore this entirely.';

// The bound-board addendum: route plan-related turns to the live plan, keep unrelated tactical work out of plan
// execution, preserve the BEGIN/DONE run protocol, and record decisions.
function boundBlock(planId: string): string {
  return (
    `This board is bound to the Braid plan "${planId}". Treat this binding as a routing hint, not as an ` +
    `execution order. If the user asks to run, continue, update, review, discuss, or modify this plan, first ` +
    `read .braid/plans/${planId}/current-phase.md, contract.md, and decisions.md; respect locked decisions and ` +
    `do not advance past the current phase before its \`- [ ]\` acceptance gates pass. If the user asks for an ` +
    `unrelated tactical change, local question, simple review, or single-file edit, do not read plan files just ` +
    `because this board is bound, and do not turn that task into plan execution.\n` +
    `Any change to the Braid plan system itself (plan prompting, context routing, authoring docs, plan file ` +
    `format, or run policy) must first be recorded in a Braid plan before code work starts.\n` +
    `If the user asks you to EXECUTE / RUN / 完成 / 跑完 this plan (do the work, not merely discuss it), START ` +
    `your reply with a line containing exactly ${RUN_BEGIN_SENTINEL}. Interpret the requested scope literally: ` +
    `if they ask for the current phase, finish the current-phase.md gates; if they ask for the full/entire/whole ` +
    `plan, all phases, 完整执行, 一口气跑完, or 跑完整个 plan, keep executing Phase Roadmap items in order. After a ` +
    `phase passes, update evidence/history as needed, promote the next roadmap item into current-phase.md, and ` +
    `continue without stopping for confirmation. Emit a line containing exactly ${RUN_DONE_SENTINEL} only when ` +
    `the requested scope is complete: for current-phase scope, every current-phase gate passes; for full-plan ` +
    `scope, every roadmap phase is complete and global verification passes. If you are only discussing or ` +
    `answering a question, do NOT emit either marker.\n` +
    `When a decision is locked in, append it to .braid/plans/${planId}/decisions.md as a new ` +
    `\`## ADR-<n> — <Title>\` block (Status / Decision / Why / Implications) using the next number.`
  );
}

// The full context block for a board: the fixed plan format (always, so NL plan-creation works on any board)
// plus the bound addendum when this board is bound to a plan.
export function planContextText(planId: string): string {
  return planId ? `${DEFAULT_METHODOLOGY}\n\n${boundBlock(planId)}` : DEFAULT_METHODOLOGY;
}
