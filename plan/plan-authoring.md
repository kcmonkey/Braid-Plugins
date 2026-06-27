# Braid Plan Authoring — Templates, Rules & Reasoning

> The Braid Plan plugin ships and owns this file. It is the single authority for how to author a plan under
> `.braid/plans/<PlanName>/`, and it travels with the plugin to any project. Read it before creating or editing
> a plan.

## 1. Core Boundary

A plan is a **current execution contract**. It is not a session journal, a knowledge base, a full decision
history, or a dump of verification artifacts.

- The plan exposes a narrow, current contract to implementers.
- The implementer owns the HOW at execution time.
- Old designs and progress notes are preserved as history, but never mixed into the execution entry point.

If a future agent needs to read more than `contract.md` and `current-phase.md` before starting ordinary
execution, the plan is probably too wide.

## 2. Standard Plan Directory

```text
.braid/plans/<PlanName>/
  contract.md
  current-phase.md
  decisions.md
  history.md
  evidence/
```

### File Roles

| File | Role | Default read? |
|---|---|---|
| `contract.md` | Current stable contract: goal, effective decisions, interfaces, invariants, global gates | Yes |
| `current-phase.md` | The one active task card the next implementer should execute | Yes |
| `decisions.md` | Current ADRs and rationale; only effective decisions, no replaced ones | Only on ambiguity or contract citation |
| `history.md` | Superseded designs, old progress logs, archaeology | No |
| `evidence/` | Compact census/verification summaries and pointers to raw artifacts | As needed |

Raw logs, large generated dumps, and scratch outputs go in a scratch/temp area, not in the plan directory.
`evidence/` holds summaries or links, not raw bulk output.

## 3. Default Read Path

For plan execution or review:

1. Read the plan index only to locate the plan.
2. Read `contract.md`.
3. Read `current-phase.md`.
4. Read `decisions.md` only when the contract cites a decision or ambiguity exists.
5. Read `history.md` only after detecting drift, conflict, regression, or a need for archaeology.

`history.md` is non-authoritative by default. It exists to preserve context without poisoning the active
contract.

## 4. WHAT-vs-HOW Boundary

`current-phase.md` states **WHAT** changes. The implementer decides **HOW** using codebase context and
engineering judgment.

| | Belongs in `current-phase.md` | Belongs to the implementer |
|---|---|---|
| Granularity | Scoped deliverables | Tool calls, edit order, low-level wiring |
| Example | "Add `GetHealthPercent()` to `IDamageable` + a default impl" | Which file to edit first, which tool to use |
| Form | Plain-language end state | Pseudocode, code blocks, SQL, command recipes |
| Authority | Plan locks the deliverable | Implementer chooses mechanism during execution |

If a bullet tells the implementer how to produce the change rather than what must be true after the phase,
rewrite it as an end deliverable.

## 5. Pre-Plan Exploration Checklist

Architecture decisions made on an unexplored codebase are guesses. Before authoring a contract, verify every
point below that applies, using the project's own code-search / code-intelligence tools.

Record only the facts the contract or active phase needs. Demand file paths and line numbers where applicable.
Mark anything unconfirmed as `[UNVERIFIED]`; do not rely on it until verified.

1. Existing patterns: the 1–3 similar systems and conventions to match.
2. Class/module hierarchy and dependencies: types, interfaces, components, module boundaries.
3. Integration points: which existing systems the change touches; events, configs, data sources, registries.
4. Constraints and risks: concurrency, hot paths, hard references, platform/runtime constraints.
5. Change-impact analysis: for each modified/replaced API, schema, data structure, or asset contract, trace
   its consumers and classify each impact (signature change / data migration / behavioral change). Flag any
   consumer count over ~10 as high blast-radius — it likely needs its own phase.
6. Asset/resource references: confirm the real, full identifiers/paths the plan depends on (do not guess them).
7. Verifiable state and failure modes: key properties/defaults, public surface, guards, logs, invariants.

No "discovery phase" should exist just to do this later. Ground truth is planner work unless runtime-only
validation is genuinely impossible during authoring.

## 6. `contract.md` Template

Keep `contract.md` short enough to read every time. It contains only the current effective contract.

```markdown
# [Plan Name] Contract

## Goal
[1–3 paragraphs: what problem this solves and what the final state means.]

## Current Decisions
- ADR-1: [Effective decision and why it still applies.]
- ADR-2: [Effective decision and why it still applies.]

## Interfaces / Contracts
- `[TypeOrFunction]` — [signature or behavioral contract implementers must preserve.]
- `[resource/asset id]` — [confirmed role, if relevant.]

## Invariants
- [Named behavior or dependency that must remain true across all phases.]

## Phase Roadmap
- Phase 1: [short description]
- Phase 2: [short description]

## Global Verification
- [The project's build/test command(s) that run after EVERY phase.]

## Current Phase
See `current-phase.md`.

## Deferred / Out Of Scope
- [Only items intentionally excluded from the current contract.]
```

Rules:
- Superseded decisions are forbidden here. Move them to `history.md`.
- Long progress logs are forbidden.
- Do not duplicate `current-phase.md`.
- Promote one phase at a time from the roadmap into `current-phase.md`; do not write every phase file up front.

## 7. `current-phase.md` Template

This is the active task card. It should be replaceable when the phase changes.

```markdown
# Current Phase: [Name]

## Goal
[1–2 lines: what is true after this phase.]

## Prerequisites
[One line. Omit the section if none.]

## What To Deliver
- [Concrete deliverable, WHAT not HOW.]
- [Concrete deliverable.]

## Files / Assets
- `path/to/file` — [role in this phase]

## Ground Truth
[Include only when this phase modifies existing code/assets. Every fact includes its verification method.]
- [Fact] (verified via: [tool/command])

## Constraints
[Include only when there is a real contract to protect.]
- [Specific downstream consumer or behavior that must not change.]

## Acceptance Criteria
- [ ] [Machine-verifiable outcome — checkable by a command/test/grep/observation.]
- [ ] [Machine-verifiable outcome.]

## Test
- **command**: [the project's build/test command]
- **scope**: [what this verifies]
```

Rules:
- `Prerequisites`, `Ground Truth`, and `Constraints` are conditional. Omit empty sections entirely.
- Acceptance criteria are ALWAYS `- [ ]` checkboxes and must be checkable by command output or a tool — never
  prose ("Stages & gates", `### Stage N`, paragraphs). Tick `- [x]` as each gate passes so progress stays
  accurate.
- A phase is normally one implementation slice, not a whole roadmap.

## 8. `decisions.md` Template

`decisions.md` is for current ADRs only. It is not a graveyard of replaced ideas.

```markdown
# [Plan Name] Decisions

## ADR-1 — [Decision Title]
- **Status**: current
- **Decision**: [What is locked.]
- **Why**: [Short rationale.]
- **Implications**: [What implementers must do or avoid.]
- **Replaces**: [Optional pointer to a `history.md` section.]
```

When a decision is replaced: move the old ADR text to `history.md`, keep only the replacement here, and update
`contract.md` if the effective contract changed. Use a consistent heading style within a file (`## ADR-<n>` or
`## D<n>`); do not mix two styles.

## 9. `history.md` Template

`history.md` preserves context without being part of the default execution path.

```markdown
# [Plan Name] History

## Superseded Designs
- [Date] [Old approach] — replaced by [current decision/link].

## Progress Log
- [Date] [Short factual note about completed work or verification.]

## Archaeology Notes
- [Context that may help diagnose drift later, clearly non-authoritative.]
```

## 10. `evidence/` Guidance

Use `evidence/` for compact, reusable summaries (`census-YYYY-MM-DD.md`, `build-YYYY-MM-DD.md`,
`review-YYYY-MM-DD.md`). Each states: what was checked, the exact command/tool, the result, and links to raw
artifacts when needed. Do not paste giant command output or full logs.

## 11. Banned Active-Contract Content

Forbidden in `contract.md` and `current-phase.md` because they cause drift or steal execution judgment:

| Content | Why banned | Where it goes |
|---|---|---|
| Superseded designs | Misleads agents into following stale context | `history.md` |
| Rolling progress logs | Bloats the default read path | `history.md` / `evidence/` summary |
| Step-by-step implementation recipes | Converts implementer into transcriber; rots quickly | Nowhere; implementer decides |
| Tool signatures / schema dumps per phase | Duplicates mechanism detail | One minimal signature in `contract.md` |
| Large code blocks / SQL / generated dumps | Context waste and drift | Source files or scratch area |
| Rationale essays per phase | Duplicates ADRs and buries deliverables | `decisions.md` |
| Manual status tables mirrored across files | Guaranteed sync drift | `current-phase.md` only |

## 12. Forbidden Phase Types

Do not create execution phases whose only goal is "Discovery", "Audit current state", "Ground truth
verification", or "Decision lock-in". Those are plan-authoring responsibilities. If a fact cannot be verified
until runtime, make it the first acceptance criterion of the phase that consumes it and explain why it is
runtime-only. Lock every architecture decision with the user (ask before writing the files) — a plan with TBD
decisions is a draft, not a plan.

## 13. Static-vs-Runtime Verification Heuristic

| Fact source | Route |
|---|---|
| Static-verifiable: grep/read/config/source inspection | Verify during authoring; put fact + method in `Ground Truth` |
| Runtime-only: live process / binary asset / runtime state | Make it the first acceptance criterion, or ask the user to run it before approval |
| Future state: build passes after our change | Acceptance criterion of the producing phase |

Before writing a verification phase, ask: "What prevents me from verifying this now?" If the answer is
"nothing", verify now and delete the would-be phase.

## 14. Preflight Before Presenting A Plan

If any check fails, revise or report the blocker before presenting:

1. Referenced files/directories exist.
2. APIs, patterns, and interfaces the plan depends on exist as described.
3. Resource/asset identifiers are confirmed, not guessed.
4. Acceptance criteria are runnable with concrete commands/tools.
5. The baseline build/test status is known. If the baseline is broken, say so — do not hide it in the plan.

## 15. Proactive Plan Use

The agent should not wait for the user to say "plan" when the requested work is clearly systematic engineering.
Before starting implementation, proactively consider using the plan system when the task has any of these traits:

- Multiple phases, milestones, or a sequence where later work depends on earlier verification.
- Cross-module, cross-provider, host/runtime, protocol, persistence, plugin seam, schema, or API-contract changes.
- Risky refactors, migrations, behavior-preserving extractions, or work with rollback/cutover concerns.
- Ambiguous architecture choices that need user decision before implementation.
- Several independently verifiable acceptance gates that should be tracked over time.

Do not force a plan for small tactical work:

- Single-file/local bug fixes with a clear implementation path.
- Direct questions, explanations, code reviews, or small UI/content edits.
- Mechanical test or documentation updates with low blast radius.

If a plan is warranted, say so briefly, do the proportional pre-plan exploration, present 2-3 approaches, and ask
the user to choose before scaffolding. If the user explicitly says not to plan, continue directly unless the work
would be unsafe or ambiguous without locked decisions; in that case explain the blocker plainly.

## 16. How To Create A Plan From Natural Language

When the user asks (in natural language) to create / draft a plan, with no special command:

1. Briefly explore the relevant code (Section 5) — proportional to the change's blast-radius.
2. Propose 2–3 approaches and ask the user which they want; lock the decisions.
3. Scaffold a SINGLE `.braid/plans/<kebab-name>/` with `contract.md` + `current-phase.md` + `decisions.md` in
   the templates above, then tell the user the plan name.
4. When updating or advancing a plan, edit those files in place, keeping this structure.

## 17. Migrating A Legacy `_summary.md` Plan

Older plans may use `_summary.md` + `phase-XX.md`. When you touch one: create `contract.md` (current effective
decisions + invariants) and `current-phase.md` (the next executable slice); move superseded design / old
progress into `history.md`; convert useful verification notes into compact `evidence/` summaries; leave
`_summary.md` only as legacy source. Do not treat a mixed `_summary.md` as authoritative when it contains
superseded sections.
