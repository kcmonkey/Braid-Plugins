import type { BoardLike, ToolStepLike } from '../shared/board';
import {
  ORCHESTRATION_PLUGIN_ID,
  asOrchestrationState,
  roleLabel,
  stageLabel,
  type OrchestrationRole,
  type OrchestrationStage,
  type OrchestrationState,
} from './model';

export type CardExecutionStatus = 'queued' | 'running' | 'delivered' | 'passed' | 'rejected' | 'blocked';
export type BubbleKind = 'order' | 'report' | 'verdict' | 'peer';
export type BubbleRelation = 'down' | 'up' | 'peer';
export type ScopedIntelTier = 'run-wide' | 'role-scoped' | 'private';
export type TimelineKind = 'prompt' | 'answer' | 'tool' | 'message';

export interface RunBoardInput {
  boardId: string;
  board: BoardLike;
}

export interface RoleRecordPayload {
  parentBoardId?: string;
  boardId?: string;
  runId?: string;
  role?: OrchestrationRole;
  stage?: OrchestrationStage;
  planId?: string;
  packageId?: string;
  packageTitle?: string;
}

export interface ContextBlockLike {
  blockId: string;
  scope?: string;
  title?: string;
  content: string;
  payload?: unknown;
  updatedAt?: string;
}

export interface BoardMessageLike {
  id?: string;
  seq?: number;
  sourceBoardId?: string;
  targetBoardId: string;
  correlationId: string;
  kind?: string;
  text?: string;
  payload?: unknown;
  createdAt?: string;
  status?: string;
}

export interface ProjectionEdgeLike {
  edgeId?: string;
  pluginId: string;
  overlayKind: string;
  sourceBoardId: string;
  targetBoardId: string;
  payload?: unknown;
}

export interface RunViewModelInput {
  runId: string;
  focusedBoardId?: string;
  boards: RunBoardInput[];
  contextBlocks?: ContextBlockLike[];
  messages?: BoardMessageLike[];
  projectionEdges?: ProjectionEdgeLike[];
}

export interface CardTimelineItem {
  id: string;
  kind: TimelineKind;
  text: string;
  status?: string;
  sourceBoardId?: string;
  targetBoardId?: string;
  seq: number;
}

export interface CardArtifact {
  blockId: string;
  title: string;
  scope?: string;
  content: string;
}

export interface CardExecutionReport {
  status: CardExecutionStatus;
  statusLabel: string;
  receivedOrder?: string;
  artifacts: CardArtifact[];
  timeline: CardTimelineItem[];
}

export interface RunCardNode {
  boardId: string;
  parentBoardId?: string;
  runId: string;
  role: OrchestrationRole;
  roleLabel: string;
  stage: OrchestrationStage;
  stageLabel: string;
  title: string;
  packageTitle?: string;
  status: CardExecutionStatus;
  statusLabel: string;
  report: CardExecutionReport;
}

export interface BubbleEvent {
  id: string;
  kind: BubbleKind;
  relation: BubbleRelation;
  text: string;
  sourceBoardId?: string;
  targetBoardId: string;
  seq: number;
}

export interface ScopedIntelEntry {
  blockId: string;
  title: string;
  scope?: string;
  tier: ScopedIntelTier;
  producerBoardId?: string;
  producerRole?: OrchestrationRole;
  content: string;
}

export interface RunViewModel {
  runId: string;
  focusedBoardId?: string;
  cards: RunCardNode[];
  bubbles: BubbleEvent[];
  scopedIntel: ScopedIntelEntry[];
}

interface CardSeed {
  boardId: string;
  board?: BoardLike;
  state?: OrchestrationState;
  payload?: RoleRecordPayload;
  parentBoardId?: string;
}

const STATUS_LABELS: Record<CardExecutionStatus, string> = {
  queued: '待命',
  running: '执行中',
  delivered: '已交付',
  passed: '已通过',
  rejected: '打回',
  blocked: '已否决',
};

export function buildRunViewModel(input: RunViewModelInput): RunViewModel {
  const messages = (input.messages ?? []).slice().sort(compareMessages);
  const contextBlocks = input.contextBlocks ?? [];
  const seeds = collectCardSeeds(input);
  const parentByBoard = parentMap(seeds, input.projectionEdges ?? [], messages);
  const cards = [...seeds.values()]
    .map((seed) => toCard(seed, input.runId, parentByBoard, contextBlocks, messages))
    .filter((card): card is RunCardNode => !!card)
    .sort(compareCards(parentByBoard));
  const cardByBoard = new Map(cards.map((card) => [card.boardId, card]));
  return {
    runId: input.runId,
    ...(input.focusedBoardId ? { focusedBoardId: input.focusedBoardId } : {}),
    cards,
    bubbles: messages
      .filter((message) => cardByBoard.has(message.targetBoardId) || (message.sourceBoardId ? cardByBoard.has(message.sourceBoardId) : false))
      .map((message, index) => toBubble(message, index, parentByBoard)),
    scopedIntel: contextBlocks.map((block) => toScopedIntel(block, cardByBoard)),
  };
}

export function statusLabel(status: CardExecutionStatus): string {
  return STATUS_LABELS[status];
}

function collectCardSeeds(input: RunViewModelInput): Map<string, CardSeed> {
  const seeds = new Map<string, CardSeed>();
  const ensure = (boardId: string): CardSeed => {
    const seed = seeds.get(boardId) ?? { boardId };
    seeds.set(boardId, seed);
    return seed;
  };

  for (const { boardId, board } of input.boards) {
    const state = asOrchestrationState(board.elements?.[ORCHESTRATION_PLUGIN_ID]);
    if (state?.runId !== input.runId) continue;
    const seed = ensure(boardId);
    seed.board = board;
    seed.state = state;
    seed.parentBoardId = state.sourceBoardId ?? seed.parentBoardId;
  }

  for (const block of input.contextBlocks ?? []) {
    const payload = asRolePayload(block.payload, input.runId);
    if (!payload?.boardId) continue;
    const seed = ensure(payload.boardId);
    seed.payload = { ...(seed.payload ?? {}), ...payload };
    seed.parentBoardId = payload.parentBoardId ?? seed.parentBoardId;
  }

  for (const message of input.messages ?? []) {
    const payload = asRolePayload(message.payload, input.runId);
    if (!payload?.boardId) continue;
    const seed = ensure(payload.boardId);
    seed.payload = { ...(seed.payload ?? {}), ...payload };
    seed.parentBoardId = payload.parentBoardId ?? message.sourceBoardId ?? seed.parentBoardId;
  }

  for (const edge of input.projectionEdges ?? []) {
    if (edge.pluginId !== ORCHESTRATION_PLUGIN_ID || edge.overlayKind !== 'role-materialized') continue;
    const payload = asRolePayload(edge.payload, input.runId);
    const boardId = payload?.boardId ?? edge.targetBoardId;
    if (!boardId) continue;
    const seed = ensure(boardId);
    seed.payload = { ...(seed.payload ?? {}), ...(payload ?? { boardId, runId: input.runId }) };
    seed.parentBoardId = payload?.parentBoardId ?? edge.sourceBoardId ?? seed.parentBoardId;
  }

  return seeds;
}

function parentMap(seeds: Map<string, CardSeed>, edges: ProjectionEdgeLike[], messages: BoardMessageLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const seed of seeds.values()) {
    if (seed.parentBoardId) out.set(seed.boardId, seed.parentBoardId);
  }
  for (const edge of edges) {
    if (edge.pluginId === ORCHESTRATION_PLUGIN_ID && edge.overlayKind === 'role-materialized') {
      out.set(edge.targetBoardId, edge.sourceBoardId);
    }
  }
  for (const message of messages) {
    if (message.kind === 'role-materialized' && message.sourceBoardId) {
      out.set(message.targetBoardId, message.sourceBoardId);
    }
  }
  return out;
}

function toCard(
  seed: CardSeed,
  runId: string,
  parentByBoard: Map<string, string>,
  contextBlocks: ContextBlockLike[],
  messages: BoardMessageLike[],
): RunCardNode | undefined {
  const state = seed.state;
  const role = state?.role ?? seed.payload?.role;
  if (!role) return undefined;
  const stage = state?.stage ?? seed.payload?.stage ?? 'execution';
  const status = executionStatus(seed.board, stage, state, role);
  const artifacts = contextBlocks
    .filter((block) => producerBoardId(block) === seed.boardId && !isRoleMaterializationContext(block, seed.boardId))
    .map((block) => ({
      blockId: block.blockId,
      title: block.title?.trim() || block.blockId,
      ...(block.scope ? { scope: block.scope } : {}),
      content: block.content,
    }));
  const report: CardExecutionReport = {
    status,
    statusLabel: statusLabel(status),
    receivedOrder: receivedOrder(seed.boardId, messages),
    artifacts,
    timeline: cardTimeline(seed.boardId, seed.board, messages),
  };
  const label = roleLabel(role);
  const packageTitle = state?.packageTitle ?? seed.payload?.packageTitle;
  return {
    boardId: seed.boardId,
    parentBoardId: parentByBoard.get(seed.boardId),
    runId,
    role,
    roleLabel: label,
    stage,
    stageLabel: stageLabel(stage),
    title: packageTitle ? `${label}: ${packageTitle}` : label,
    ...(packageTitle ? { packageTitle } : {}),
    status,
    statusLabel: statusLabel(status),
    report,
  };
}

function executionStatus(board: BoardLike | undefined, stage: OrchestrationStage, state: OrchestrationState | undefined, role: OrchestrationRole): CardExecutionStatus {
  if (board?.status === 'error') return 'blocked';
  if (board?.status === 'streaming' || board?.status === 'waiting') return 'running';
  if (stage === 'blocked') return 'blocked';
  if (state?.completed || stage === 'complete') return 'passed';
  if (stage === 'repair' && role === 'testEngineer') return 'rejected';
  if (board?.status === 'done') return 'delivered';
  return 'queued';
}

function receivedOrder(boardId: string, messages: BoardMessageLike[]): string | undefined {
  const message = messages.find((m) => m.targetBoardId === boardId && m.kind === 'role-materialized');
  return compact(message?.text);
}

function cardTimeline(boardId: string, board: BoardLike | undefined, messages: BoardMessageLike[]): CardTimelineItem[] {
  const out: CardTimelineItem[] = [];
  let seq = 1;
  const turns = board?.turns?.length ? board.turns : board ? [{ prompt: board.prompt, answer: board.answer, steps: board.steps }] : [];
  turns.forEach((turn, turnIndex) => {
    if (turn.prompt?.trim()) out.push({ id: `${boardId}:turn:${turnIndex}:prompt`, kind: 'prompt', text: turn.prompt.trim(), seq: seq++ });
    for (const step of turn.steps ?? []) out.push(toolTimelineItem(boardId, turnIndex, step, seq++));
    if (turn.answer?.trim()) out.push({ id: `${boardId}:turn:${turnIndex}:answer`, kind: 'answer', text: turn.answer.trim(), seq: seq++ });
  });
  for (const message of messages) {
    if (message.sourceBoardId !== boardId && message.targetBoardId !== boardId) continue;
    const text = compact(message.text) || message.kind || 'board message';
    out.push({
      id: message.id ?? `${boardId}:message:${message.seq ?? seq}`,
      kind: 'message',
      text,
      ...(message.status ? { status: message.status } : {}),
      ...(message.sourceBoardId ? { sourceBoardId: message.sourceBoardId } : {}),
      targetBoardId: message.targetBoardId,
      seq: seq++,
    });
  }
  return out;
}

function toolTimelineItem(boardId: string, turnIndex: number, step: ToolStepLike, seq: number): CardTimelineItem {
  const result = step.result?.trim();
  const input = step.input && Object.keys(step.input).length ? ` ${JSON.stringify(step.input)}` : '';
  return {
    id: `${boardId}:turn:${turnIndex}:tool:${step.id}`,
    kind: 'tool',
    text: result ? `${step.name}: ${result}` : `${step.name}${input}`,
    status: step.isError ? 'error' : result ? 'done' : 'running',
    seq,
  };
}

function toBubble(message: BoardMessageLike, index: number, parentByBoard: Map<string, string>): BubbleEvent {
  return {
    id: message.id ?? `message:${message.seq ?? index}`,
    kind: bubbleKind(message.kind),
    relation: bubbleRelation(message.sourceBoardId, message.targetBoardId, parentByBoard),
    text: compact(message.text) || message.kind || 'message',
    ...(message.sourceBoardId ? { sourceBoardId: message.sourceBoardId } : {}),
    targetBoardId: message.targetBoardId,
    seq: message.seq ?? index,
  };
}

function bubbleKind(kind: string | undefined): BubbleKind {
  const k = (kind ?? '').toLowerCase();
  if (k === 'role-materialized' || k.includes('order') || k.includes('command')) return 'order';
  if (k.includes('report')) return 'report';
  if (k.includes('verdict') || k.includes('decision') || k.includes('review')) return 'verdict';
  return 'peer';
}

function bubbleRelation(sourceBoardId: string | undefined, targetBoardId: string, parentByBoard: Map<string, string>): BubbleRelation {
  if (!sourceBoardId || sourceBoardId === targetBoardId) return 'peer';
  if (parentByBoard.get(targetBoardId) === sourceBoardId) return 'down';
  if (parentByBoard.get(sourceBoardId) === targetBoardId) return 'up';
  if (parentByBoard.get(sourceBoardId) && parentByBoard.get(sourceBoardId) === parentByBoard.get(targetBoardId)) return 'peer';
  return 'peer';
}

function toScopedIntel(block: ContextBlockLike, cardByBoard: Map<string, RunCardNode>): ScopedIntelEntry {
  const producer = producerBoardId(block);
  const producerCard = producer ? cardByBoard.get(producer) : undefined;
  return {
    blockId: block.blockId,
    title: block.title?.trim() || block.blockId,
    ...(block.scope ? { scope: block.scope } : {}),
    tier: scopedIntelTier(block.scope, producer),
    ...(producer ? { producerBoardId: producer } : {}),
    ...(producerCard ? { producerRole: producerCard.role } : {}),
    content: block.content,
  };
}

function scopedIntelTier(scope: string | undefined, producerBoardId: string | undefined): ScopedIntelTier {
  const normalized = (scope ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'run' || normalized === 'global' || normalized === 'run-wide') return 'run-wide';
  if (normalized === producerBoardId?.toLowerCase() || normalized.startsWith('private') || normalized.startsWith('board:')) return 'private';
  return 'role-scoped';
}

function producerBoardId(block: ContextBlockLike): string | undefined {
  const payload = payloadObject(block.payload);
  return typeof payload?.boardId === 'string' ? payload.boardId : undefined;
}

function isRoleMaterializationContext(block: ContextBlockLike, boardId: string): boolean {
  return block.blockId === `role:${boardId}`;
}

function asRolePayload(value: unknown, runId: string): RoleRecordPayload | undefined {
  const payload = payloadObject(value);
  if (!payload || payload.runId !== runId || typeof payload.boardId !== 'string') return undefined;
  const state = asOrchestrationState(payload);
  if (state) {
    return {
      ...state,
      boardId: payload.boardId,
      parentBoardId: typeof payload.parentBoardId === 'string' ? payload.parentBoardId : undefined,
      packageTitle: typeof payload.packageTitle === 'string' ? payload.packageTitle : undefined,
    };
  }
  return undefined;
}

function payloadObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function compact(value: string | undefined): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function compareMessages(a: BoardMessageLike, b: BoardMessageLike): number {
  return (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
    || (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

function compareCards(parentByBoard: Map<string, string>): (a: RunCardNode, b: RunCardNode) => number {
  return (a, b) => {
    const depthDelta = cardDepth(a.boardId, parentByBoard) - cardDepth(b.boardId, parentByBoard);
    if (depthDelta) return depthDelta;
    if (a.parentBoardId !== b.parentBoardId) return (a.parentBoardId ?? '').localeCompare(b.parentBoardId ?? '');
    return a.boardId.localeCompare(b.boardId);
  };
}

function cardDepth(boardId: string, parentByBoard: Map<string, string>): number {
  const seen = new Set<string>();
  let depth = 0;
  let cur: string | undefined = boardId;
  while (cur && parentByBoard.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = parentByBoard.get(cur);
    depth += 1;
  }
  return depth;
}
