import type { BoardPluginApi } from '../../../src/plugin-api/types';
import type { BoardLike } from '../shared/board';
import {
  ORCHESTRATION_PLUGIN_ID,
  asOrchestrationDecision,
  asOrchestrationState,
  boardAnswer,
  boardStatus,
  parseOrchestrationDecision,
  parseWorkPackages,
  type OrchestrationDecision,
  type OrchestrationState,
  type WorkPackage,
  type WorkerReport,
} from './model';

type AggregateApi = Pick<
  BoardPluginApi,
  | 'appendPluginEvent'
  | 'readPluginAggregate'
  | 'readAggregateRun'
  | 'readAggregateContext'
>;

type BoardReadApi = Pick<BoardPluginApi, 'listBoards' | 'getBoard'>;

const EVENT_VERSION = 1;
const DECISION_EVENT = 'orchestration-decision';
const WORK_PACKAGES_EVENT = 'orchestration-work-packages';
const WORKER_REPORT_EVENT = 'orchestration-worker-report';

interface DecisionPayload {
  version: number;
  type: 'decision';
  sourceBoardId: string;
  decision: OrchestrationDecision;
}

interface WorkPackagesPayload {
  version: number;
  type: 'work-packages';
  sourceBoardId: string;
  packages: WorkPackage[];
}

interface WorkerReportPayload {
  version: number;
  type: 'worker-report';
  sourceBoardId: string;
  report: WorkerReport;
}

function payloadObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function isWorkPackage(value: unknown): value is WorkPackage {
  const v = payloadObject(value);
  return !!v && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.scope === 'string';
}

function asDecisionPayload(value: unknown): DecisionPayload | undefined {
  const v = payloadObject(value);
  if (!v || v.version !== EVENT_VERSION || v.type !== 'decision' || typeof v.sourceBoardId !== 'string') return undefined;
  const decision = asOrchestrationDecision(v.decision);
  return decision ? { version: EVENT_VERSION, type: 'decision', sourceBoardId: v.sourceBoardId, decision } : undefined;
}

function asWorkPackagesPayload(value: unknown): WorkPackagesPayload | undefined {
  const v = payloadObject(value);
  if (!v || v.version !== EVENT_VERSION || v.type !== 'work-packages' || typeof v.sourceBoardId !== 'string' || !Array.isArray(v.packages)) return undefined;
  const packages = v.packages.filter(isWorkPackage);
  return { version: EVENT_VERSION, type: 'work-packages', sourceBoardId: v.sourceBoardId, packages };
}

function asWorkerReportPayload(value: unknown): WorkerReportPayload | undefined {
  const v = payloadObject(value);
  const rawReport = payloadObject(v?.report);
  if (!v || v.version !== EVENT_VERSION || v.type !== 'worker-report' || typeof v.sourceBoardId !== 'string' || !rawReport) return undefined;
  if (typeof rawReport.boardId !== 'string' || typeof rawReport.answer !== 'string') return undefined;
  const status = rawReport.status === 'pending'
    || rawReport.status === 'running'
    || rawReport.status === 'done'
    || rawReport.status === 'error'
    || rawReport.status === 'unknown'
    ? rawReport.status
    : 'unknown';
  return {
    version: EVENT_VERSION,
    type: 'worker-report',
    sourceBoardId: v.sourceBoardId,
    report: {
      boardId: rawReport.boardId,
      status,
      answer: rawReport.answer,
      ...(typeof rawReport.packageId === 'string' ? { packageId: rawReport.packageId } : {}),
      ...(typeof rawReport.packageTitle === 'string' ? { packageTitle: rawReport.packageTitle } : {}),
    },
  };
}

function sameWorkPackages(a: WorkPackage[] | undefined, b: WorkPackage[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((pkg, i) => (
    pkg.id === b[i]?.id
    && pkg.title === b[i]?.title
    && pkg.scope === b[i]?.scope
  ));
}

function sameDecision(a: OrchestrationDecision | undefined, b: OrchestrationDecision): boolean {
  return !!a
    && a.route === b.route
    && a.rationale === b.rationale
    && a.planId === b.planId
    && a.nextRole === b.nextRole
    && sameWorkPackages(a.workPackages, b.workPackages);
}

async function readEvents(api: AggregateApi, runId: string): Promise<any[]> {
  const aggregate = await api.readPluginAggregate(ORCHESTRATION_PLUGIN_ID, runId);
  if (aggregate.error) throw new Error(`Orchestration aggregate read failed: ${aggregate.error}`);
  return aggregate.events ?? [];
}

async function appendAggregateEvent(api: AggregateApi, runId: string, kind: string, payload: unknown): Promise<void> {
  const result = await api.appendPluginEvent(ORCHESTRATION_PLUGIN_ID, runId, { kind, payload });
  if (result.error) throw new Error(`Orchestration aggregate append failed: ${result.error}`);
}

export async function readRecordedDecision(api: AggregateApi, runId: string, boardId: string): Promise<OrchestrationDecision | undefined> {
  const events = await readEvents(api, runId);
  for (const event of events.slice().reverse()) {
    if (event.kind !== DECISION_EVENT) continue;
    const payload = asDecisionPayload(event.payload);
    if (payload?.sourceBoardId === boardId) return payload.decision;
  }
  return undefined;
}

export async function captureDecisionFromBoard(
  api: AggregateApi,
  boardId: string,
  board: BoardLike,
  state: OrchestrationState,
): Promise<OrchestrationDecision | undefined> {
  const parsed = parseOrchestrationDecision(boardAnswer(board));
  const existing = await readRecordedDecision(api, state.runId, boardId);
  if (!parsed) return existing;
  if (sameDecision(existing, parsed)) return existing;
  await appendAggregateEvent(api, state.runId, DECISION_EVENT, {
    version: EVENT_VERSION,
    type: 'decision',
    sourceBoardId: boardId,
    decision: parsed,
  } satisfies DecisionPayload);
  const recorded = await readRecordedDecision(api, state.runId, boardId);
  if (!recorded) throw new Error('Orchestration decision was captured but could not be replayed from aggregate state.');
  return recorded;
}

async function readRecordedWorkPackages(api: AggregateApi, runId: string, boardId: string): Promise<WorkPackage[] | undefined> {
  const events = await readEvents(api, runId);
  for (const event of events.slice().reverse()) {
    if (event.kind !== WORK_PACKAGES_EVENT) continue;
    const payload = asWorkPackagesPayload(event.payload);
    if (payload?.sourceBoardId === boardId) return payload.packages;
  }
  return undefined;
}

export async function captureWorkPackagesFromBoard(
  api: AggregateApi,
  boardId: string,
  board: BoardLike,
  state: OrchestrationState,
): Promise<WorkPackage[]> {
  const packages = parseWorkPackages(boardAnswer(board));
  const existing = await readRecordedWorkPackages(api, state.runId, boardId);
  if (sameWorkPackages(existing, packages)) return existing!;
  await appendAggregateEvent(api, state.runId, WORK_PACKAGES_EVENT, {
    version: EVENT_VERSION,
    type: 'work-packages',
    sourceBoardId: boardId,
    packages,
  } satisfies WorkPackagesPayload);
  const recorded = await readRecordedWorkPackages(api, state.runId, boardId);
  if (!recorded?.length) throw new Error('Orchestration work packages were captured but could not be replayed from aggregate state.');
  return recorded;
}

function contextPayload(block: unknown): Record<string, unknown> | undefined {
  const v = payloadObject(block);
  return payloadObject(v?.payload);
}

async function workerRefsFromAggregate(api: AggregateApi, state: OrchestrationState): Promise<{ boardId: string; packageId?: string; packageTitle?: string }[]> {
  const [run, context] = await Promise.all([
    api.readAggregateRun(ORCHESTRATION_PLUGIN_ID, state.runId),
    api.readAggregateContext(ORCHESTRATION_PLUGIN_ID, state.runId, 'workerEngineer'),
  ]);
  if (run.error) throw new Error(`Orchestration run read failed: ${run.error}`);
  if (context.error) throw new Error(`Orchestration context read failed: ${context.error}`);

  const registered = new Set(run.snapshot?.boardIds ?? []);
  const refs = new Map<string, { boardId: string; packageId?: string; packageTitle?: string }>();
  for (const block of context.blocks ?? []) {
    const payload = contextPayload(block);
    if (payload?.role !== 'workerEngineer' || typeof payload.boardId !== 'string') continue;
    if (registered.size && !registered.has(payload.boardId)) continue;
    refs.set(payload.boardId, {
      boardId: payload.boardId,
      ...(typeof payload.packageId === 'string' ? { packageId: payload.packageId } : {}),
      ...(typeof payload.packageTitle === 'string' ? { packageTitle: payload.packageTitle } : {}),
    });
  }
  for (const boardId of state.workerBoardIds ?? []) {
    if (registered.size && !registered.has(boardId)) continue;
    if (!refs.has(boardId)) refs.set(boardId, { boardId });
  }
  const packageById = new Map((state.workPackages ?? []).map((pkg) => [pkg.id, pkg]));
  return [...refs.values()].map((ref) => ({
    ...ref,
    ...(ref.packageId && !ref.packageTitle && packageById.get(ref.packageId) ? { packageTitle: packageById.get(ref.packageId)!.title } : {}),
  }));
}

function latestWorkerReports(events: any[], refs: { boardId: string }[]): WorkerReport[] {
  const byBoard = new Map<string, WorkerReport>();
  for (const event of events) {
    if (event.kind !== WORKER_REPORT_EVENT) continue;
    const payload = asWorkerReportPayload(event.payload);
    if (payload) byBoard.set(payload.report.boardId, payload.report);
  }
  return refs.map((ref) => byBoard.get(ref.boardId) ?? {
    boardId: ref.boardId,
    status: 'unknown',
    answer: '',
  });
}

export async function captureWorkerReportsFromBoards(
  api: AggregateApi & BoardReadApi,
  state: OrchestrationState,
): Promise<WorkerReport[]> {
  const refs = await workerRefsFromAggregate(api, state);
  if (!refs.length) return [];
  const listed = new Map((api.listBoards?.() ?? []).map((entry) => [entry.boardId, entry.board]));
  for (const ref of refs) {
    const board = api.getBoard?.(ref.boardId) ?? listed.get(ref.boardId);
    const boardState = asOrchestrationState(board?.elements?.[ORCHESTRATION_PLUGIN_ID]);
    const report: WorkerReport = {
      boardId: ref.boardId,
      packageId: boardState?.packageId ?? ref.packageId,
      packageTitle: boardState?.packageTitle ?? ref.packageTitle,
      status: boardStatus(board),
      answer: boardAnswer(board),
    };
    await appendAggregateEvent(api, state.runId, WORKER_REPORT_EVENT, {
      version: EVENT_VERSION,
      type: 'worker-report',
      sourceBoardId: ref.boardId,
      report,
    } satisfies WorkerReportPayload);
  }
  return latestWorkerReports(await readEvents(api, state.runId), refs);
}
