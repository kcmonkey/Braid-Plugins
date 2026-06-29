import type { BoardLike as BoardData, ToolStepLike as ToolStep } from '../shared/board';

// Deterministic "the agent just created/worked a plan in this board" signal, used to AUTO-BIND an unbound board
// to the plan it produced (plans/Plan-Plugin — the agent-creates-plan flow). Pure → unit-tested.
//
// Rules (conservative, to avoid false binds):
//  - Only WRITE-like tool steps count (Write/Edit/MultiEdit/create_file → input.file_path; Codex fileChange →
//    input.changes[].path). Reads/searches/listings are ignored — opening a plan is not creating one.
//  - The path must sit under `.braid/plans/<id>/…`. The `<id>` is extracted (slashes normalized both ways).
//  - Plan ids starting with `_` (e.g. `_archive`, `_index`) or `.` are skipped — they are not bindable plans.
//  - If writes touch EXACTLY ONE plan id, return it; zero or several (ambiguous) → undefined (do not bind).

const PLAN_DIR = /(?:^|\/)\.braid\/plans\/([^/]+)\//;
const PLAN_DIR_IN_TEXT = /(?:^|[^a-zA-Z0-9._-])\.braid\/plans\/([^/\\\s"'`;&|]+)\//g;
const SHELL_WRITE_SEGMENT = /\b(?:Set-Content|Add-Content|Out-File|New-Item|mkdir|md|touch|tee|install)\b[^\r\n;&|]*/gi;
const SHELL_SED_INPLACE_SEGMENT = /\bsed\b[^\r\n;&|]*\s-i\b[^\r\n;&|]*/gi;
const SHELL_REDIRECT_SEGMENT = /(?:^|[\s;&|])(?:\d?>|>>)(?!=)[ \t]*[^\r\n;&|]*/g;

export function writePathsOf(step: ToolStep): string[] {
  const input = step.input ?? {};
  const name = step.name;
  const out: string[] = [];
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'create_file' || name === 'NotebookEdit') {
    const fp = (input as { file_path?: unknown }).file_path;
    if (typeof fp === 'string') out.push(fp);
  }
  if (name === 'fileChange') {
    const changes = (input as { changes?: unknown }).changes;
    if (Array.isArray(changes)) {
      for (const c of changes) {
        const p = c && typeof c === 'object' ? (c as { path?: unknown }).path : undefined;
        if (typeof p === 'string') out.push(p);
      }
    }
  }
  out.push(...shellWritePlanPaths(step));
  return out;
}

function commandTextOf(step: ToolStep): string | undefined {
  const input = step.input ?? {};
  const command = (input as { command?: unknown }).command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.filter((c) => typeof c === 'string').join(' ');
  return undefined;
}

function planPathsInText(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.replace(/\\/g, '/').matchAll(PLAN_DIR_IN_TEXT)) {
    const id = m[1];
    if (id && !id.startsWith('_') && !id.startsWith('.')) found.add(`.braid/plans/${id}/`);
  }
  return [...found];
}

function shellWritePlanPaths(step: ToolStep): string[] {
  const name = step.name;
  if (name !== 'Bash' && name !== 'PowerShell' && name !== 'Command') return [];
  const command = commandTextOf(step);
  if (!command) return [];
  const found = new Set<string>();
  const scan = (segment: string) => {
    for (const p of planPathsInText(segment)) found.add(p);
  };
  for (const m of command.matchAll(SHELL_WRITE_SEGMENT)) scan(m[0]);
  for (const m of command.matchAll(SHELL_SED_INPLACE_SEGMENT)) scan(m[0]);
  for (const m of command.matchAll(SHELL_REDIRECT_SEGMENT)) scan(m[0]);
  return [...found];
}

function planIdFromPath(path: string): string | undefined {
  const m = PLAN_DIR.exec(path.replace(/\\/g, '/'));
  if (!m) return undefined;
  const id = m[1];
  if (!id || id.startsWith('_') || id.startsWith('.')) return undefined;
  return id;
}

function boardWriteSteps(board: BoardData): { step: ToolStep; path: string }[] {
  const steps: ToolStep[] = [
    ...(Array.isArray(board.steps) ? board.steps : []),
    ...(board.turns ?? []).flatMap((t) => t.steps ?? []),
  ];
  const out: { step: ToolStep; path: string }[] = [];
  for (const step of steps) {
    for (const path of writePathsOf(step)) out.push({ step, path });
  }
  return out;
}

export function planWriteSignal(board: BoardData, planId: string): string {
  const safeId = planId.trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) return '';
  return boardWriteSteps(board)
    .filter(({ path }) => planIdFromPath(path) === safeId)
    .map(({ step, path }) => {
      const resultState = step.result == null ? 'pending' : `done:${step.result.length}:${step.isError ? 1 : 0}`;
      return `${step.id}:${step.name}:${path.replace(/\\/g, '/')}:${resultState}`;
    })
    .join('|');
}

export function detectCreatedPlan(board: BoardData): string | undefined {
  // Tool steps live top-level on a single-turn board but in `turns[].steps` on a MULTI-turn (existing) board — so
  // scan BOTH. Without the turns[] scan, an EXISTING board that creates a plan in a later round never auto-binds
  // (only a fresh single-turn board did). Plan ids dedupe through the Set, so round 0 appearing in both is harmless.
  const writes = boardWriteSteps(board);
  if (writes.length === 0) return undefined;
  const found = new Set<string>();
  for (const { path } of writes) {
    const id = planIdFromPath(path);
    if (id) found.add(id);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// The id of the MOST RECENTLY GENERATED plan in this board — used to RE-BIND a board that is ALREADY bound to one
// plan but then generates another (the binding should follow the new plan). The reliable "a NEW plan was generated"
// signal is a write to that plan's `contract.md`: contract.md is the mandatory scaffold file of every Braid plan, so
// a write to it means the agent authored a plan there. Editing a plan's OTHER files (current-phase.md / evidence /
// decisions / history) is NOT creation and is ignored here — that's what keeps a board from false-switching when it
// merely edits or references a different plan. Scans top-level + turns[] steps IN ORDER (same source as detect/
// signal); the LAST contract.md write wins. Shell-created plans aren't covered (writePathsOf yields only the dir for
// shell, so contract.md can't be confirmed) — those still first-bind via detectCreatedPlan and re-bind manually.
export function latestCreatedPlan(board: BoardData): string | undefined {
  let latest: string | undefined;
  for (const { path } of boardWriteSteps(board)) {
    const norm = path.replace(/\\/g, '/');
    if (!/\/contract\.md$/.test(norm)) continue;
    const id = planIdFromPath(norm);
    if (id) latest = id;
  }
  return latest;
}
