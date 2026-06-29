# Braid Skills

This folder holds reusable agent **skills** for this project, managed by the Braid Skills plugin. A skill packages
a repeatable procedure (plus any helper scripts) so the agent can follow it the same way every time — on any
provider (Claude, Codex, DeepSeek, OpenRouter, …), not only the ones with native skill support.

## Folder format

One folder per skill:

    .braid/skills/<skill-name>/
      SKILL.md          # required: frontmatter + instructions
      scripts/...       # optional: helper scripts the agent runs with its own tools
      reference/...     # optional: extra docs the agent reads on demand

`SKILL.md` starts with YAML frontmatter, then the instructions:

    ---
    name: commit-helper
    description: Stage changed files and commit with a tidy, conventional message.
    ---

    # Commit helper

    1. Run the project's lint/test gate.
    2. Stage only intended files.
    3. Write a conventional-commit subject + body.

- `name` — the skill identifier (defaults to the folder name if omitted).
- `description` — one line: WHEN this skill applies. This is what the agent sees while deciding to use it.

## How discovery works (progressive disclosure)

- Braid scans `.braid/skills/` and lists each skill's **name + description** in the agent's context — never the
  body. This is cheap and scales: bodies are read only when needed. No hand-maintained index file is required;
  just drop a `<skill-name>/SKILL.md` folder in.
- When a task matches a skill, the agent **reads that skill's `SKILL.md` on demand**, follows it, and runs any
  bundled scripts with its own tools.
- An empty vault injects nothing (zero cost until you add a skill).

## Writing a good skill

- Keep the description specific ("when X, do Y") so the agent picks it for the right tasks.
- Put the actual steps in the body, not the description.
- Bundle a script for any deterministic step instead of describing it in prose.
- One skill = one repeatable procedure. Split unrelated procedures into separate skills.
