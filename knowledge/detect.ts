// Pure "the agent narrated recording a durable lesson but did NOT write it to the vault" detector (ADR-13). Used
// to (1) surface a human-visible nudge in the focused ChatView panel and (2) inject ONE bounded next-turn provider
// reminder, WITHOUT auto-writing anything (capture stays agent-driven, ADR-3) and WITHOUT a forced turn. Pure ⇒
// unit-tested.
//
// Closing the claim↔action loop: the failure mode is an answer that SAYS it recorded / 记下 a lesson while no vault
// write happened (the lesson is then silently lost and the human is told it was saved). We detect (a) a lesson-
// recording CLAIM in the latest settled answer and (b) the absence of any `.braid/knowledge/` write in that same
// turn. Conservative by design (precision over recall): a false nudge nags, a missed lesson is recoverable, so we
// fire only on unambiguous recording-claim phrasing and never on the legacy `.braid/knowledge-vault/` directory.

import { boardTurns, latestAnswer, type BoardLike as BoardData, type ToolStepLike as ToolStep } from '../shared/board';

// Matches `.braid/knowledge/` anywhere in a (forward-slash-normalized) path. Deliberately excludes the legacy
// `.braid/knowledge-vault/` directory: "knowledge-vault/" does not contain "knowledge/".
const VAULT_WRITE_PATH = /\.braid\/knowledge\//;

// High-precision phrases that assert capturing a durable lesson / finding. Kept tight on purpose so a benign
// conversational "let me note that…" does not fire — the English verbs are anchored to a knowledge noun.
const LESSON_CLAIM_PATTERNS: RegExp[] = [
  /记下/,
  /记入|写进?\s*知识库|存(入|进)\s*知识库|沉淀(到|进)?\s*知识/,
  /经验教训|几条教训|这些?教训|教训(如下|有|是)/,
  /lessons?\s+learned/i,
  /\b(record|recorded|recording|note|noting|noted|capture|captured|capturing|log|logged|document|documented)\b[^.\n。]{0,40}\b(lesson|lessons|takeaway|takeaways|gotcha|gotchas|finding|findings|knowledge|vault)\b/i,
  /\b(record|capture|log|save|write)\b[^.\n。]{0,30}\b(vault|knowledge\s*base|knowledge\s*vault)\b/i,
];

export function mentionsLessonRecording(text: string): boolean {
  const t = text ?? '';
  return LESSON_CLAIM_PATTERNS.some((re) => re.test(t));
}

function structuredWritePaths(step: ToolStep): string[] {
  const input = step.input ?? {};
  const out: string[] = [];
  const name = step.name;
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

// A shell tool that both uses a write-ish verb/redirect AND names a vault path. Conservative: requires both so a
// `cat .braid/knowledge/x.md` read does not count as a write.
function shellWritesToVault(step: ToolStep): boolean {
  const name = step.name;
  if (name !== 'Bash' && name !== 'PowerShell' && name !== 'Command') return false;
  const raw = (step.input ?? {} as Record<string, unknown>).command;
  const command = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter((c) => typeof c === 'string').join(' ') : '';
  if (!command) return false;
  const norm = command.replace(/\\/g, '/');
  const writeish = /\b(Set-Content|Add-Content|Out-File|New-Item|tee|cp|copy|mv|move)\b|>>?/.test(command);
  return writeish && VAULT_WRITE_PATH.test(norm);
}

function stepWritesToVault(step: ToolStep): boolean {
  if (structuredWritePaths(step).some((p) => VAULT_WRITE_PATH.test(p.replace(/\\/g, '/')))) return true;
  return shellWritesToVault(step);
}

function latestTurnSteps(board: BoardData): ToolStep[] {
  const turns = boardTurns(board);
  return (turns[turns.length - 1]?.steps ?? []) as ToolStep[];
}

// True when the latest turn wrote to (or updated) anything under `.braid/knowledge/`.
export function recordedToVaultThisTurn(board: BoardData): boolean {
  return latestTurnSteps(board).some(stepWritesToVault);
}

// True when the board has SETTLED (`done`), its latest answer claims a durable lesson, and no `.braid/knowledge/`
// write happened in that latest turn. Streaming/waiting/error/idle boards never fire (only nudge after a clean
// settle). Self-clearing: once the agent writes a note, or the next answer carries no lesson claim, this is false.
export function lessonRecordingGap(board: BoardData): boolean {
  if (board.status !== 'done') return false;
  if (!mentionsLessonRecording(latestAnswer(board))) return false;
  return !recordedToVaultThisTurn(board);
}
