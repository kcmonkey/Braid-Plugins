# Braid Knowledge Vault

This folder is a durable, project-local agent memory vault managed by the Braid Knowledge plugin. It is
for knowledge that should survive across conversations. It is not a task log, scratchpad, conversation
summary, or replacement for source code.

## Memory Types

- `semantic`: durable project facts, API/CLI/SDK behavior, gotchas, conventions, and locked decisions.
- `episodic`: lessons from a specific failure, correction, postmortem, or repeated workflow trap.
- `procedural`: durable rules that should change how the agent works in this project.

Use the narrowest type that fits. Implementation snapshots of current project code belong in
`docs/systems/`, not in the vault.

## Lifecycle

Every index entry has a status:

- `current`: eligible for normal recall.
- `stale`: may be outdated; do not use as ground truth without re-verification.
- `superseded`: preserved for history; use the replacement note instead.
- `disputed`: known conflict or unresolved evidence.

Only `current` entries participate in default routing. Non-current notes stay readable when history is
explicitly needed.

## Note Format

One file per topic: `.braid/knowledge/<topic>.md`.

Each current note should have this shape:

```markdown
# Title

## Claim
One durable fact or a small cluster of tightly related durable facts.

## Scope
Where the claim applies: provider, tool, platform, project subsystem, workflow, or environment.

## Evidence
- verified_by: command, test, source file path, URL, user decision, or observed runtime evidence
- date: YYYY-MM-DD

## Metadata
- type: semantic | episodic | procedural
- status: current | stale | superseded | disputed
- updated: YYYY-MM-DD
- keywords: comma, separated, routing, terms
- supersedes: optional old note/path
- superseded_by: optional replacement note/path
```

Keep notes short. Update an existing note instead of creating a near-duplicate.

## Rich Index

`.braid/knowledge/_index.md` is the routing index. It is read first and note bodies are read only on
demand. Use this table format:

```markdown
| Title | Path | Type | Status | Updated | Scope | Keywords |
|---|---|---|---|---|---|---|
| Auth token source | auth-tokens.md | semantic | current | 2026-06-28 | OpenAI auth | oauth, token, api key |
```

The provider may inject current routing metadata from this table, but never the note body. This keeps
context small while preserving recall quality.

## Maintenance Rules

- Add evidence for every current note.
- Mark outdated knowledge `stale` or `superseded`; do not leave contradictory current notes.
- Preserve old notes when useful for history, but keep them out of default routing by changing status.
- If a fact was learned from a user correction or failed attempt, consider `episodic`.
- If a fact changes how agents should operate, consider `procedural`.
- Keep keywords distinctive enough to route future questions to the right note.
