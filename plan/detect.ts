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
  return out;
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
