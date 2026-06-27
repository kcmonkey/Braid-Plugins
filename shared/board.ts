import type { EngineId } from '../../../src/protocol';

export type BoardStatus = 'idle' | 'streaming' | 'waiting' | 'done' | 'error';

export interface ToolStepLike {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface TurnLike {
  prompt?: string;
  answer?: string;
  engine?: EngineId;
  steps?: ToolStepLike[];
  done?: boolean;
}

export interface BoardLike {
  prompt?: string;
  answer?: string;
  status?: BoardStatus | string;
  steps?: ToolStepLike[];
  turns?: TurnLike[];
  elements?: Record<string, unknown>;
  formState?: unknown;
  boardForm?: string;
  archived?: boolean;
  compact?: boolean;
  collapsedGraph?: unknown;
}

export function boardTurns(board: BoardLike): TurnLike[] {
  return board.turns && board.turns.length
    ? board.turns
    : [{ prompt: board.prompt, answer: board.answer, steps: board.steps }];
}

export function latestAnswer(board: BoardLike): string {
  const turns = boardTurns(board);
  return turns[turns.length - 1]?.answer ?? board.answer ?? '';
}

export function hasPendingAsk(board: BoardLike): boolean {
  return boardTurns(board).some((turn) =>
    (turn.steps ?? []).some((step) => step.name === 'AskUserQuestion' && step.result == null),
  );
}
