import type {
  HostProviderCapabilitiesEvent,
  HostAgentExecutionReleasedEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  PluginManifest,
  ResourceCoordinatorPort,
  ResourceLeaseRequest,
  ToolMiddlewareContext,
  ToolMiddlewareResult,
} from '../../../src/plugin-api/types';
import type { AgentToolContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId } from '../../../src/protocol';
import {
  addBoardMessage,
  claimFile,
  claimResourceSet,
  claimTaskResourceSet,
  emptyCoordinationState,
  findClaimConflict,
  findResourceClaimConflict,
  markStaleClaims,
  matchResourceTriggers,
  projectSnapshot,
  pruneRetiredCoordination,
  releaseAgentClaims,
  releaseTaskResourceClaims,
  retireAgentCoordination,
  setProviderCapabilities,
  setWorkspaceResources,
  updateNegotiation,
  type ClaimConflict,
  type ClaimRequest,
  type CoordinationState,
  type FileClaim,
  type ResourceClaim,
  type ResourceClaimRequest,
  type TaskResourceClaimRequest,
} from './model';
import { createCoordinatorAgentTool, type CoordinateToolRequest } from './agentTool';
import { coordinationPathList } from './helpers';
import { createCoordinatorLiveMessages, createCoordinatorProjectState, createCoordinatorTurnContext } from './hostHooks';
import manifestJson from './plugin.json';
import { loadWorkspaceResourceCatalog } from './resources';
import { createCoordinatorToolMiddleware } from './toolMiddleware';

const COORD_WAIT_CAP_MIN = 15;
const COORD_WAIT_CAP_MS = COORD_WAIT_CAP_MIN * 60_000;
const COORD_ESCALATE_MIN = 3;
const COORD_ESCALATE_MS = COORD_ESCALATE_MIN * 60_000;
const FILE_WAIT_RECHECK_MS = 1_000;
const manifest = manifestJson as PluginManifest;

type ResourceClaimAttempt = {
  matched: boolean;
  claims: ResourceClaim[];
  conflicts: ReturnType<typeof claimResourceSet>['conflicts'];
};

type FileClaimAttempt = {
  matched: boolean;
  paths: string[];
  conflicts: ClaimConflict[];
};

type AgentTarget = {
  agentId: string;
  canvasId?: string;
  boardId?: string;
};

type ResourceWaiter = {
  canvasId?: string;
  boardId?: string;
  req: ResourceClaimRequest;
  timer: ReturnType<typeof setTimeout>;
  escalateTimer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(result: AgentToolResult): void;
};

type FileWaiter = {
  canvasId?: string;
  boardId?: string;
  req: ClaimRequest;
  timer: ReturnType<typeof setTimeout>;
  escalateTimer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(result: AgentToolResult): void;
};

class CoordinatorHostService implements HostService {
  id = 'coordinator.hostService';
  label = 'Coordinator Host Service';
  manifest = manifest;

  private coordination: CoordinationState = emptyCoordinationState();
  private readonly coordinationNoticeKeys = new Set<string>();
  private readonly coordinationEscalationKeys = new Set<string>();
  private readonly resourceWaiters = new Map<string, ResourceWaiter>();
  private readonly fileWaiters = new Map<string, FileWaiter>();
  private fileWaitRecheckTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly coordinationConflictKeys = new Set<string>();
  private resourceCatalogFile: string | undefined;
  private resourceCatalogSignature: string | null | undefined;
  private taskAdmissionClosed = false;
  private readonly taskWaiters = new Map<string, {
    requests: TaskResourceClaimRequest[];
    resolve(): void;
    reject(error: unknown): void;
  }>();
  private readonly taskDrainWaiters = new Set<() => void>();
  private taskExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: HostServiceContext) {}

  resourceCoordinator(): ResourceCoordinatorPort {
    return { withLease: (request, work) => this.withTaskLease(request, work) };
  }

  hasActiveWork(): boolean {
    return this.coordination.taskResourceClaims.length > 0;
  }

  async drain(): Promise<void> {
    this.taskAdmissionClosed = true;
    if (this.hasActiveWork()) await new Promise<void>((resolve) => this.taskDrainWaiters.add(resolve));
  }

  private async withTaskLease<T>(request: ResourceLeaseRequest, work: () => Promise<T>): Promise<T> {
    if (this.disposed || this.taskAdmissionClosed) throw new Error('Resource Coordinator is closing.');
    if (!request.taskId?.trim() || !request.label?.trim() || !Array.isArray(request.resources) || !request.resources.length
      || request.resources.some((entry) => !entry || typeof entry.resource !== 'string' || !entry.resource.trim())) {
      throw new Error('A resource task requires taskId, label, and declared resources.');
    }
    if (this.coordination.taskResourceClaims.some((claim) => claim.taskId === request.taskId)) {
      throw new Error(`Resource task already exists: ${request.taskId}`);
    }
    this.syncWorkspaceResources();
    const now = Date.now();
    const requests = request.resources.map((resource) => ({
      ...resource, taskId: request.taskId, label: request.label, summary: request.label, now,
    }));
    try {
      const claimed = claimTaskResourceSet(this.coordination, requests);
      this.coordination = claimed.state;
      if (claimed.blocking.length || claimed.taskBlocking.length) {
        const ready = new Promise<void>((resolve, reject) => {
          this.taskWaiters.set(request.taskId, { requests, resolve, reject });
        });
        this.publishCoordination();
        for (const target of this.agentTargets(claimed.blocking)) {
          void this.ctx.deliverLiveAgentMessage({
            ...target, kind: 'coordination-conflict',
            text: `[Braid coordination] Background task ${request.label} (${request.taskId}) is waiting for ${claimed.claims.map((claim) => claim.resource).join(', ')}. Release your conflicting resource claims when the work is safe to hand off. The task will acquire them before executing.`,
          }).catch(() => {});
        }
        await ready;
      } else {
        this.publishCoordination();
      }
      return await work();
    } finally {
      this.taskWaiters.delete(request.taskId);
      this.coordination = releaseTaskResourceClaims(this.coordination, request.taskId);
      try {
        this.publishCoordination();
      } finally {
        if (!this.hasActiveWork()) {
          for (const resolve of this.taskDrainWaiters) resolve();
          this.taskDrainWaiters.clear();
        }
      }
    }
  }

  private tryResolveTaskWaiters(): void {
    for (const [taskId, waiter] of this.taskWaiters) {
      try {
        const now = Date.now();
        const claimed = claimTaskResourceSet(this.coordination, waiter.requests.map((request) => ({ ...request, now })));
        this.coordination = claimed.state;
        if (!claimed.blocking.length && !claimed.taskBlocking.length) {
          this.taskWaiters.delete(taskId);
          waiter.resolve();
        }
      } catch (error) {
        this.taskWaiters.delete(taskId);
        waiter.reject(error);
      }
    }
    if (this.taskExpiryTimer) clearTimeout(this.taskExpiryTimer);
    this.taskExpiryTimer = undefined;
    // A declaration's existing TTL is a precise expiry event, not a polling/retry loop.
    if (this.taskWaiters.size) {
      const deadlines = this.coordination.resourceClaims
        .filter((claim) => (claim.status === 'active' || claim.status === 'pending') && claim.expiresAt != null)
        .map((claim) => claim.expiresAt!);
      if (deadlines.length) this.taskExpiryTimer = setTimeout(() => this.publishCoordination(), Math.max(1, Math.min(...deadlines) - Date.now()));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.hasActiveWork()) throw new Error('Resource Coordinator cannot dispose while background tasks hold or await leases.');
    this.disposed = true;
    if (this.taskExpiryTimer) clearTimeout(this.taskExpiryTimer);
    this.taskExpiryTimer = undefined;
    if (this.fileWaitRecheckTimer) {
      clearTimeout(this.fileWaitRecheckTimer);
      this.fileWaitRecheckTimer = undefined;
    }
    const result: AgentToolResult = { ok: false, result: 'Wait canceled because the coordinator service was disposed.' };
    for (const key of [...this.resourceWaiters.keys()]) this.resolveWaiter(key, result);
    for (const key of [...this.fileWaiters.keys()]) this.resolveFileWaiter(key, result);
  }

  agentTools() {
    return [createCoordinatorAgentTool((ctx, req) => this.handleCoordinateTool(ctx, req))];
  }

  toolMiddleware() {
    return [createCoordinatorToolMiddleware({
      gate: (ctx) => this.gateToolMiddleware(ctx),
      observe: (ctx) => this.observeToolMiddleware(ctx),
    })];
  }

  hostProjectState() {
    return [createCoordinatorProjectState(() => this.coordination)];
  }

  turnContext() {
    return [createCoordinatorTurnContext((ctx) => ctx.agentId
      ? this.coordinationContextForAgent(ctx.agentId, ctx.canvasId) : undefined)];
  }

  liveMessages() {
    return [createCoordinatorLiveMessages()];
  }

  onCanvasClose(canvasId: string): void {
    // Closing a projection never cancels an Agent's resource ownership or waits.
    this.publishCoordination(canvasId);
  }

  onProviderCapabilities(event: HostProviderCapabilitiesEvent): void {
    for (const provider of Object.keys(event.capabilities) as EngineId[]) {
      this.coordination = setProviderCapabilities(this.coordination, provider, {
        knownWriteGate: 'unknown',
        agentCallableMessages: false,
        contextInjection: true,
        providerThreadMetadata: false,
        actorAttribution: false,
      });
    }
    this.publishCoordination(event.canvasId);
  }

  onAgentExecutionReleased(event: HostAgentExecutionReleasedEvent): void {
    this.releaseAgent(event.agentId, `Released after Agent execution ${event.reason}.`);
  }

  private executionActor(agentId: string, boardId: string | undefined, provider?: EngineId) {
    return { agentId, boardId, provider, kind: 'agent' as const };
  }

  private coordinationPathList(paths: string[] | undefined): string[] {
    return coordinationPathList(this.ctx.cwd(), paths);
  }

  private syncWorkspaceResources(): boolean {
    const catalog = loadWorkspaceResourceCatalog(this.ctx.cwd());
    if (this.resourceCatalogFile === catalog.file && this.resourceCatalogSignature === catalog.signature) return false;
    this.resourceCatalogFile = catalog.file;
    this.resourceCatalogSignature = catalog.signature;
    this.coordination = setWorkspaceResources(this.coordination, catalog.resources);
    return true;
  }

  private claimResources(reqs: ResourceClaimRequest[]): ReturnType<typeof claimResourceSet> {
    return claimResourceSet(this.coordination, reqs);
  }

  private coordinationCanvasIds(originCanvasId?: string): string[] {
    const canvasIds = new Set<string | undefined>(this.ctx.openCanvasIds());
    if (originCanvasId) canvasIds.add(originCanvasId);
    for (const claim of this.coordination.claims) canvasIds.add(claim.canvasId);
    for (const claim of this.coordination.resourceClaims) canvasIds.add(claim.canvasId);
    for (const intent of this.coordination.intents) canvasIds.add(intent.canvasId);
    for (const message of this.coordination.messages) canvasIds.add(message.canvasId);
    for (const negotiation of this.coordination.negotiations) canvasIds.add(negotiation.canvasId);
    for (const waiter of this.resourceWaiters.values()) canvasIds.add(waiter.canvasId);
    for (const waiter of this.fileWaiters.values()) canvasIds.add(waiter.canvasId);
    return [...canvasIds].filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  private agentTargets(entries: readonly AgentTarget[]): AgentTarget[] {
    const targets = new Map<string, AgentTarget>();
    for (const entry of entries) {
      targets.set(entry.agentId, { agentId: entry.agentId, canvasId: entry.canvasId, boardId: entry.boardId });
    }
    return [...targets.values()];
  }

  private publishCoordination(originCanvasId?: string) {
    const now = Date.now();
    this.coordination = markStaleClaims(this.coordination, now);
    this.coordination = pruneRetiredCoordination(this.coordination, now); // drop long-dead tombstones (memory-footprint P4)
    this.tryResolveWaiters();
    const canvasIds = this.coordinationCanvasIds(originCanvasId);
    this.ctx.publishWorkspaceState({
      pluginId: 'coordinator',
      stateKey: 'coordination',
      canvasIds,
      snapshotForCanvas: (canvasId) => projectSnapshot(this.coordination, canvasId, now),
    });
  }

  private tryResolveWaiters() {
    this.tryResolveTaskWaiters();
    for (const [key, w] of [...this.resourceWaiters]) {
      const r = this.claimResources([w.req]);
      if (!r.conflicts.length) {
        this.coordination = r.state;
        this.resolveWaiter(key, { ok: true, result: `${w.req.resource} is now free - you now HOLD ${w.req.resource} (ACTIVE). This grants ONLY ${w.req.resource}; you do NOT automatically hold any other resource (a separate editor/build window is a DIFFERENT claim). Proceed only with actions gated on ${w.req.resource}.` });
      }
    }
    this.tryResolveFileWaiters();
  }

  private tryResolveFileWaiters(): boolean {
    let changed = false;
    for (const [key, w] of [...this.fileWaiters]) {
      if (w.signal?.aborted) {
        this.resolveFileWaiter(key, { ok: false, result: 'File wait canceled because the waiting Agent was stopped.' });
        changed = true;
        continue;
      }
      const r = claimFile(this.coordination, w.req);
      if (!r.conflict) {
        this.coordination = r.state;
        this.resolveFileWaiter(key, { ok: true, result: `${w.req.path} is now free - you now HOLD its file claim (ACTIVE). Retry only the write gated on this path; this grants no other file or declared resource.` });
        changed = true;
      }
    }
    return changed;
  }

  private scheduleFileWaitRecheck() {
    if (this.disposed || this.fileWaitRecheckTimer || !this.fileWaiters.size) return;
    this.fileWaitRecheckTimer = setTimeout(() => {
      this.fileWaitRecheckTimer = undefined;
      if (this.tryResolveFileWaiters()) this.publishCoordination();
      this.scheduleFileWaitRecheck();
    }, FILE_WAIT_RECHECK_MS);
  }

  private resolveWaiter(key: string, result: AgentToolResult) {
    const waiter = this.resourceWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.escalateTimer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.resourceWaiters.delete(key);
    this.clearEscalationsForAgent(waiter.req.agentId);
    waiter.resolve(result);
  }

  private resolveFileWaiter(key: string, result: AgentToolResult) {
    const waiter = this.fileWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.escalateTimer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.fileWaiters.delete(key);
    if (!this.fileWaiters.size && this.fileWaitRecheckTimer) {
      clearTimeout(this.fileWaitRecheckTimer);
      this.fileWaitRecheckTimer = undefined;
    }
    this.clearEscalationsForAgent(waiter.req.agentId);
    waiter.resolve(result);
  }

  private cancelWaitersForAgent(agentId: string, msg: string) {
    for (const [key, waiter] of [...this.resourceWaiters]) {
      if (waiter.req.agentId === agentId) this.resolveWaiter(key, { ok: false, result: msg });
    }
    for (const [key, waiter] of [...this.fileWaiters]) {
      if (waiter.req.agentId === agentId) this.resolveFileWaiter(key, { ok: false, result: msg });
    }
  }

  private waitBlockerAgentIds(req: ResourceClaimRequest): string[] {
    const conflict = findResourceClaimConflict(this.coordination, req);
    return conflict ? [...new Set(conflict.blocking.map((c) => c.agentId))] : [];
  }

  private fileWaitBlockerAgentIds(req: ClaimRequest): string[] {
    const conflict = findClaimConflict(this.coordination, req);
    return conflict ? [...new Set(conflict.blocking.map((c) => c.agentId))] : [];
  }

  private resourceClaimBlockerAgentIds(claim: ResourceClaim): string[] {
    const conflict = findResourceClaimConflict(this.coordination, {
      agentId: claim.agentId, canvasId: claim.canvasId, boardId: claim.boardId, actor: claim.actor, resource: claim.resource,
      mode: claim.mode, desiredState: claim.desiredState, priority: claim.priority,
    });
    if (!conflict) return [];
    return [...new Set(conflict.blocking.map((c) => c.agentId).filter((id) => id !== claim.agentId))];
  }

  private detectWaitCycleFrom(startAgentId: string): string[] | null {
    const waiterByAgent = new Map<string, ResourceClaimRequest>();
    for (const w of this.resourceWaiters.values()) waiterByAgent.set(w.req.agentId, w.req);
    const stack: string[] = [];
    const visited = new Set<string>();
    const dfs = (key: string): string[] | null => {
      const at = stack.indexOf(key);
      if (at >= 0) return stack.slice(at);
      if (visited.has(key)) return null;
      visited.add(key);
      const req = waiterByAgent.get(key);
      if (!req) return null;
      stack.push(key);
      for (const blocker of this.waitBlockerAgentIds(req)) {
        const found = dfs(blocker);
        if (found) return found;
      }
      stack.pop();
      return null;
    };
    return dfs(startAgentId);
  }

  private emitCoordinationEscalation(canvasId: string | undefined, boardKeys: string[], resources: string[], reason: 'deadlock' | 'stall') {
    const boards = boardKeys;
    const key = `${canvasId}::${reason}::|${[...boardKeys].sort().join('|')}|::${[...resources].sort().join('|')}`;
    if (this.coordinationEscalationKeys.has(key)) return;
    this.coordinationEscalationKeys.add(key);
    const text = reason === 'deadlock'
      ? `Coordination DEADLOCK: boards ${boards.join(', ')} are each waiting on a resource another holds (${resources.join(', ')}). Braid will NOT force a takeover - please intervene: Stop one of these boards (or let it ride the ${COORD_WAIT_CAP_MIN}-min wait cap).`
      : `Coordination STALL: a board has waited >${COORD_ESCALATE_MIN} min for ${resources.join(', ')} held by ${boards.join(', ')} with no handoff. Please intervene: ask or Stop the holder, or let the waiter ride the ${COORD_WAIT_CAP_MIN}-min cap.`;
    this.coordination = addBoardMessage(this.coordination, { canvasId, kind: 'note', text, relatedResources: resources }).state;
    this.publishCoordination(canvasId);
  }

  private emitFileWaitEscalation(canvasId: string | undefined, boardKeys: string[], paths: string[]) {
    const boards = boardKeys;
    const key = `${canvasId}::file-stall::|${[...boardKeys].sort().join('|')}|::${[...paths].sort().join('|')}`;
    if (this.coordinationEscalationKeys.has(key)) return;
    this.coordinationEscalationKeys.add(key);
    const text = `Coordination STALL: a board has waited >${COORD_ESCALATE_MIN} min for ${paths.join(', ')} held by ${boards.join(', ')} with no handoff. Please intervene: ask or Stop the holder, or let the waiter ride the ${COORD_WAIT_CAP_MIN}-min cap.`;
    this.coordination = addBoardMessage(this.coordination, {
      canvasId,
      kind: 'note',
      text,
      relatedPaths: paths,
    }).state;
    this.publishCoordination(canvasId);
  }

  private clearEscalationsForAgent(agentId: string) {
    for (const k of [...this.coordinationEscalationKeys]) if (k.includes(`|${agentId}|`)) this.coordinationEscalationKeys.delete(k);
  }

  private releaseAgent(agentId: string, summary?: string) {
    this.cancelWaitersForAgent(agentId, 'Wait canceled because this Agent finished or stopped.');
    const beforeFiles = this.coordination.claims.filter((c) => c.agentId === agentId && c.status !== 'released');
    const beforeResources = this.coordination.resourceClaims.filter((c) => c.agentId === agentId && c.status !== 'released');
    const beforeCount = beforeFiles.length + beforeResources.length;
    this.coordination = releaseAgentClaims(this.coordination, agentId);
    this.coordination = retireAgentCoordination(this.coordination, agentId);
    const origin = beforeFiles[0] ?? beforeResources[0];
    const canvasId = origin?.canvasId;
    const boardId = origin?.boardId;
    let text: string | undefined;
    if (beforeCount) {
      const added = addBoardMessage(this.coordination, {
        canvasId,
        fromBoardId: boardId,
        actor: this.executionActor(agentId, boardId),
        kind: 'release',
        text: summary ?? `Released ${beforeCount} coordination claim${beforeCount === 1 ? '' : 's'}.`,
        relatedPaths: beforeFiles.map((c) => c.path),
        relatedResources: beforeResources.map((c) => c.resource),
      });
      this.coordination = added.state;
      text = summary ?? added.message.text;
    }
    if (text && canvasId) this.ctx.publishWorkspaceEvent({ pluginId: 'coordinator', eventKey: 'toast', canvasId, data: { text } });
    for (const k of [...this.coordinationNoticeKeys]) if (k.includes(agentId)) this.coordinationNoticeKeys.delete(k);
    this.publishCoordination(canvasId);
  }

  private describeResourceClaim(claim: ResourceClaim): string {
    const stateText = claim.desiredState ? `=${claim.desiredState}` : '';
    const requiredBy = claim.requiredBy ? ` required-by ${claim.requiredBy}` : '';
    const priority = claim.priority !== 'normal' ? ` ${claim.priority}-priority` : '';
    return `${claim.resource} (${claim.mode}${stateText}, ${claim.status}${priority}${requiredBy})`;
  }

  private fileClaimContextLine(claim: FileClaim): string {
    const summary = claim.summary ? ` - ${claim.summary}` : '';
    return `Agent ${claim.agentId}${claim.boardId ? ` (Board ${claim.boardId})` : ''}: ${claim.path} (${claim.access}, ${claim.status})${summary}`;
  }

  private resourceClaimContextLine(claim: ResourceClaim): string {
    const summary = claim.summary ? ` - ${claim.summary}` : '';
    const idle = claim.status === 'stale' ? ' [explicit lease expired - not blocking]' : '';
    return `Agent ${claim.agentId}${claim.boardId ? ` (Board ${claim.boardId})` : ''}: ${this.describeResourceClaim(claim)}${summary}${idle}`;
  }

  private recordFileConflicts(
    canvasId: string | undefined,
    boardId: string | undefined,
    actor: ClaimConflict['requestedBy'],
    conflicts: ClaimConflict[],
  ) {
    if (!conflicts.length) return;
    const paths = [...new Set(conflicts.map((conflict) => conflict.path))];
    const blockingClaims = conflicts.flatMap((conflict) => conflict.blocking);
    const blockers = [...new Set(blockingClaims.map((claim) => claim.agentId))];
    const blockerTargets = this.agentTargets(blockingClaims);
    const pathText = paths.join(', ');
    const orderText = 'Another board needs to edit a file your board claims. A holding board should checkpoint/save and call coordinate release at its next safe tool step if it is done with the file, or reply with an ETA if it needs to keep editing.';
    const negId = `neg-file-${canvasId}-${paths.slice().sort().join('|')}`;
    const conflictKey = `file::${actor.agentId}::${paths.slice().sort().join('|')}::${blockers.slice().sort().join('|')}`;
    if (this.coordinationConflictKeys.has(conflictKey)) {
      this.queueLiveFileConflictNotices(actor, blockerTargets, paths, orderText);
      return;
    }
    this.coordinationConflictKeys.add(conflictKey);
    const added = addBoardMessage(this.coordination, {
      canvasId,
      fromBoardId: boardId,
      actor,
      kind: 'note',
      text: `Potential coordination conflict: ${boardId} attempted to edit ${pathText}, currently claimed by ${blockers.join(', ')}.`,
      relatedPaths: paths,
    });
    this.coordination = added.state;
    this.coordination = updateNegotiation(this.coordination, {
      canvasId,
      id: negId,
      topic: `File conflict: ${pathText}`,
      boardIds: [boardId, ...blockingClaims.map(claim => claim.boardId)].filter((id): id is string => !!id),
      actor,
      action: 'propose',
      text: `${boardId} attempted to edit ${pathText}. Blocking boards: ${blockers.join(', ')}. ${orderText}`,
      relatedPaths: paths,
    }).state;
    this.queueLiveFileConflictNotices(actor, blockerTargets, paths, orderText);
  }

  private recordResourceConflicts(
    canvasId: string | undefined,
    boardId: string | undefined,
    actor: ResourceClaimRequest['actor'],
    claims: ResourceClaim[],
    conflicts: ReturnType<typeof claimResourceSet>['conflicts'],
    summary?: string,
  ) {
    if (!conflicts.length) return;
    const blockingClaims = conflicts.flatMap((conflict) => conflict.blocking);
    const blockers = [...new Set(blockingClaims.map((c) => c.agentId))];
    const blockerLabels = [...new Set([
      ...blockers,
      ...conflicts.flatMap((conflict) => (conflict.taskBlocking ?? []).map((claim) => `task ${claim.label} (${claim.taskId})`)),
    ])];
    const blockerTargets = this.agentTargets(blockingClaims);
    const relatedResources = [...new Set([...claims.map((c) => c.resource), ...conflicts.map((c) => c.resource)])];
    const claimText = claims.map((claim) => this.describeResourceClaim(claim)).join(', ');
    const highPriority = claims.some((claim) => claim.priority === 'high');
    const requestText = `Agent ${actor?.agentId} requested ${claimText}`;
    const orderText = highPriority
      ? 'This is a high-priority pending resource request. A blocking board should SAVE, then call coordinate release at its NEXT safe tool step (it need not finish its whole turn) - or report an ETA if it truly cannot release yet. If you will still NEED this resource after the high-priority work, call coordinate wait on it right after releasing to AUTO-RESUME when it frees, then reopen/reload (e.g. relaunch the editor) and continue.'
      : 'The request is pending. A blocking board should SAVE then release the resource at its next safe tool step; if you still need it afterwards, call coordinate wait on it right after releasing to auto-resume when it frees, then reopen/reload and continue.';
    const negId = `neg-res-${canvasId}-${relatedResources.slice().sort().join('|')}`;
    const conflictKey = `${canvasId}::${relatedResources.slice().sort().join('|')}::${blockerLabels.slice().sort().join('|')}`;
    if (this.coordinationConflictKeys.has(conflictKey)) {
      this.queueLiveResourceConflictNotices(actor, blockerTargets, claims, relatedResources, highPriority, orderText);
      return;
    }
    this.coordinationConflictKeys.add(conflictKey);
    const added = addBoardMessage(this.coordination, {
      canvasId,
      fromBoardId: boardId,
      actor,
      kind: 'note',
      text: `Potential resource conflict: ${requestText}, currently claimed by ${blockerLabels.join(', ')}.`,
      relatedResources,
    });
    this.coordination = added.state;
    this.coordination = updateNegotiation(this.coordination, {
      canvasId,
      id: negId,
      topic: `Resource conflict: ${relatedResources.join(', ')}`,
      boardIds: [boardId, ...blockingClaims.map(claim => claim.boardId)].filter((id): id is string => !!id),
      actor,
      action: 'propose',
      text: `${summary ?? requestText}. Blocked by: ${blockerLabels.join(', ')}. ${orderText}`,
      relatedResources,
    }).state;
    this.queueLiveResourceConflictNotices(actor, blockerTargets, claims, relatedResources, highPriority, orderText);
  }

  private queueLiveResourceConflictNotices(
    actor: ResourceClaimRequest['actor'],
    targets: readonly AgentTarget[],
    claims: ResourceClaim[],
    relatedResources: string[],
    highPriority: boolean,
    orderText: string,
  ) {
    if (!targets.length) return;
    const claimText = claims.map((claim) => this.describeResourceClaim(claim)).join(', ');
    const resourcesText = relatedResources.join(', ');
    const guidance = highPriority
      ? 'This is a high-priority resource request. Checkpoint the conflicting work, release the resource when safe, let the high-priority work run, then resume.'
      : orderText;
    for (const target of targets) {
      if (target.agentId === actor?.agentId) continue;
      const agentId = target.agentId;
      const noticeKeys = relatedResources.map((r) => (
        `${target.agentId}::res::${r}::${highPriority ? 'hi' : 'lo'}`
      ));
      if (noticeKeys.length && noticeKeys.every((k) => this.coordinationNoticeKeys.has(k))) continue;
      const delivered = this.ctx.deliverLiveAgentMessage({
        agentId,
        canvasId: target.canvasId,
        boardId: target.boardId,
        fromBoardId: actor?.boardId,
        kind: 'coordination.notice',
        injected: true,
        text: [
          '[Braid coordination notice]',
          `Agent ${actor?.agentId} requested ${claimText}.`,
          `Related resources: ${resourcesText}.`,
          guidance,
        ].join('\n'),
      });
      for (const k of noticeKeys) this.coordinationNoticeKeys.add(k);
      void delivered;
    }
  }

  private queueLiveFileConflictNotices(
    actor: ClaimRequest['actor'],
    targets: readonly AgentTarget[],
    paths: string[],
    guidance: string,
  ) {
    if (!targets.length) return;
    const pathText = paths.join(', ');
    const pathKey = paths.slice().sort().join('|');
    for (const target of targets) {
      if (target.agentId === actor?.agentId) continue;
      const agentId = target.agentId;
      const noticeKey = `file::${target.agentId}::${actor?.agentId}::${pathKey}`;
      if (this.coordinationNoticeKeys.has(noticeKey)) continue;
      const delivered = this.ctx.deliverLiveAgentMessage({
        agentId,
        canvasId: target.canvasId,
        boardId: target.boardId,
        fromBoardId: actor?.boardId,
        kind: 'coordination.notice',
        injected: true,
        text: [
          '[Braid coordination notice]',
          `Agent ${actor?.agentId} attempted to edit ${pathText}, which you currently claim.`,
          guidance,
        ].join('\n'),
      });
      this.coordinationNoticeKeys.add(noticeKey);
      void delivered;
    }
  }

  private hasHighPriorityResourceWindow(claims: ResourceClaim[]): boolean {
    return claims.some((claim) => claim.priority === 'high' && (claim.status === 'active' || claim.status === 'pending'));
  }

  private coordinationContextForAgent(agentId: string, canvasId?: string): string {
    this.syncWorkspaceResources();
    const snapshot = projectSnapshot(this.coordination, canvasId, Date.now());
    const isOwn = (c: { agentId: string }) => c.agentId === agentId;
    const activeFiles = snapshot.claims.filter((claim) => claim.status !== 'released');
    const ownFiles = activeFiles.filter(isOwn);
    const otherFiles = activeFiles
      .filter((claim) => !isOwn(claim))
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.path.localeCompare(b.path))
      .slice(0, 4);
    // Expired resource claims become `stale` through `markStaleClaims`; within-TTL records remain visible as
    // coordination facts without consulting a Board execution-presence hint.
    const activeResources = snapshot.resourceClaims.filter((claim) => claim.status !== 'released');
    const ownResources = activeResources.filter(isOwn);
    const otherResources = activeResources
      .filter((claim) => !isOwn(claim))
      .sort((a, b) => {
        const score = (claim: ResourceClaim) => (claim.priority === 'high' ? 0 : 10) + (claim.status === 'pending' ? 0 : 1);
        return score(a) - score(b) || a.agentId.localeCompare(b.agentId) || a.resource.localeCompare(b.resource);
      })
      .slice(0, 4);
    const resourcesInView = new Set([...ownResources, ...otherResources].map((claim) => claim.resource));
    const heldActive = new Set(activeResources
      .filter((claim) => claim.status === 'active')
      .map((claim) => `${claim.agentId}::${claim.resource}`));
    const releaseSuperseded = (m: CoordinationState['messages'][number]) =>
      m.kind === 'release' && m.relatedResources.some((r) => heldActive.has(`${m.actor?.agentId}::${r}`));
    const messages = snapshot.messages
      .filter((message) =>
        message.actor?.agentId !== agentId &&
        !releaseSuperseded(message) &&
        (!message.toAgentId || message.toAgentId === agentId || message.relatedResources.some((resource) => resourcesInView.has(resource))))
      .slice(-2);
    const negotiations = snapshot.negotiations
      .filter((thread) =>
        thread.status !== 'resolved' &&
        thread.status !== 'rejected' &&
        (thread.turns.some(turn => turn.actor?.agentId === agentId) ||
          thread.relatedResources.some((resource) => resourcesInView.has(resource)) ||
          thread.relatedPaths.some((path) => ownFiles.some((claim) => claim.path === path) || otherFiles.some((claim) => claim.path === path))))
      .slice(-2);
    if (!ownFiles.length && !otherFiles.length && !ownResources.length && !otherResources.length && !snapshot.taskResourceClaims.length && !messages.length && !negotiations.length) return '';
    const lines: string[] = ['[Braid coordination]'];
    if (snapshot.taskResourceClaims.length) {
      lines.push('Background task resource claims (owned until the operation finishes):');
      for (const claim of snapshot.taskResourceClaims.slice(0, 12)) lines.push(`- Task ${claim.label} (${claim.taskId}): ${claim.resource} (${claim.mode}, ${claim.status})`);
    }
    if (ownFiles.length) {
      lines.push('Your file claims:');
      for (const claim of ownFiles.slice(0, 3)) lines.push(`- ${this.fileClaimContextLine(claim)}`);
    }
    if (otherFiles.length) {
      lines.push('Other board file claims:');
      for (const claim of otherFiles) lines.push(`- ${this.fileClaimContextLine(claim)}`);
    }
    if (ownResources.length) {
      lines.push('Your resource claims:');
      for (const claim of ownResources.slice(0, 3)) {
        let line = `- ${this.resourceClaimContextLine(claim)}`;
        if (claim.status === 'pending') {
          const blockers = this.resourceClaimBlockerAgentIds(claim);
          line += `  NOT GRANTED${blockers.length ? ` - blocked by ${blockers.join(', ')}` : ''}: you do NOT hold ${claim.resource}; do NOT run any action gated on it and do NOT report it as yielded/granted until your claim is ACTIVE.`;
        }
        lines.push(line);
      }
    }
    if (otherResources.length) {
      lines.push('Other board resource claims:');
      for (const claim of otherResources) lines.push(`- ${this.resourceClaimContextLine(claim)}`);
    }
    if (negotiations.length) {
      lines.push('Open negotiations:');
      for (const thread of negotiations) {
        const last = thread.turns.at(-1);
        lines.push(`- ${thread.topic}: ${last?.text ?? thread.status}`);
      }
    }
    if (messages.length) {
      lines.push('Recent board messages:');
      for (const message of messages) lines.push(`- From ${message.actor?.agentId ?? message.fromBoardId ?? 'Coordinator'}: ${message.text}`);
    }
    if (this.hasHighPriorityResourceWindow(activeResources)) {
      lines.push('Policy: Treat high-priority resource claims as bounded coordination windows. Conflicting boards should checkpoint, release the resource when safe, wait for the high-priority claim to release, then resume.');
    }
    return lines.join('\n');
  }

  private writePathsFromToolInput(toolName: string, input: any): string[] {
    if (!['Edit', 'Write', 'NotebookEdit', 'FileChange'].includes(toolName)) return [];
    const paths: string[] = [];
    const add = (v: unknown) => { if (typeof v === 'string' && v.trim()) paths.push(v); };
    add(input?.file_path);
    add(input?.path);
    if (Array.isArray(input?.changes)) {
      for (const change of input.changes) add(change?.path);
    }
    return paths;
  }

  private recordKnownWriteClaim(agentId: string, canvasId: string | undefined, boardId: string | undefined, provider: EngineId | undefined, toolName: string, input: any, publish = true): FileClaimAttempt {
    const rawPaths = this.writePathsFromToolInput(toolName, input);
    if (!rawPaths.length) return { matched: false, paths: [], conflicts: [] };
    const paths = this.coordinationPathList(rawPaths);
    if (!paths.length) return { matched: false, paths: [], conflicts: [] };
    // Drain queued file waiters before a newcomer can claim the newly free path.
    this.tryResolveFileWaiters();
    const actor = this.executionActor(agentId, boardId, provider);
    const now = Date.now();
    const requests = paths.map((path) => ({
      agentId,
      canvasId,
      boardId,
      actor,
      path,
      access: 'edit' as const,
      summary: `${toolName} write`,
      now,
    }));
    const conflicts = requests
      .map((req) => findClaimConflict(this.coordination, req))
      .filter((conflict): conflict is ClaimConflict => !!conflict);
    if (conflicts.length) {
      this.recordFileConflicts(canvasId, boardId, actor, conflicts);
      if (publish) this.publishCoordination(canvasId);
      return { matched: true, paths, conflicts };
    }
    for (const path of paths) {
      const result = claimFile(this.coordination, {
        agentId,
        canvasId,
        boardId,
        actor,
        path,
        access: 'edit',
        summary: `${toolName} write`,
        now,
      });
      this.coordination = result.state;
      if (result.conflict) {
        this.recordFileConflicts(canvasId, boardId, actor, [result.conflict]);
        if (publish) this.publishCoordination(canvasId);
        return { matched: true, paths, conflicts: [result.conflict] };
      }
    }
    if (publish) this.publishCoordination(canvasId);
    return { matched: true, paths, conflicts: [] };
  }

  private commandFromToolInput(toolName: string, input: any): string {
    if (typeof input?.command === 'string') return input.command;
    if (Array.isArray(input?.command)) return input.command.filter((c: unknown) => typeof c === 'string').join(' ');
    return '';
  }

  private recordKnownResourceClaims(agentId: string, canvasId: string | undefined, boardId: string | undefined, provider: EngineId | undefined, toolName: string, input: any, publish = true): ResourceClaimAttempt {
    this.syncWorkspaceResources();
    if (!this.coordination.resources.some((r) => r.claimOn?.length)) return { matched: false, claims: [], conflicts: [] };
    const command = this.commandFromToolInput(toolName, input);
    let inputText = '';
    try { inputText = JSON.stringify(input ?? {}).slice(0, 2000); } catch { inputText = ''; }
    const triggered = matchResourceTriggers(this.coordination.resources, { toolName, command, inputText });
    if (!triggered.length) return { matched: false, claims: [], conflicts: [] };
    const actor = this.executionActor(agentId, boardId, provider);
    const result = this.claimResources(triggered.map((t) => ({ ...t, agentId, canvasId, boardId, actor })));
    this.coordination = result.state;
    this.recordResourceConflicts(canvasId, boardId, actor, result.claims, result.conflicts,
      result.claims.map((c) => c.summary).filter(Boolean).join(' '));
    if (publish) this.publishCoordination(canvasId);
    return { matched: true, claims: result.claims, conflicts: result.conflicts };
  }

  private resourceConflictToolReason(attempt: ResourceClaimAttempt): string {
    const resources = [...new Set([
      ...attempt.claims.map((claim) => claim.resource),
      ...attempt.conflicts.map((conflict) => conflict.resource),
    ])];
    const blockers = [...new Set(attempt.conflicts.flatMap((conflict) =>
      [
        ...conflict.blocking.map((claim) => `Agent ${claim.agentId}${claim.boardId ? ` (Board ${claim.boardId})` : ''}`),
        ...(conflict.taskBlocking ?? []).map((claim) => `task ${claim.label} (${claim.taskId})`),
      ]))];
    const claimText = attempt.claims.map((claim) => this.describeResourceClaim(claim)).join(', ') || resources.join(', ');
    const resourceText = resources.join(', ') || 'the requested resource';
    const blockerText = blockers.join(', ') || 'another board';
    return [
      `[Braid coordination] Blocked this tool because it would claim ${claimText}, currently blocked by ${blockerText}.`,
      `Call braid.coordinate with action:"wait" for ${resourceText}, or ask the blocking board to release/checkpoint, then retry the tool after the claim is active.`,
    ].join('\n');
  }

  private fileConflictToolReason(attempt: FileClaimAttempt, canvasId: string | undefined): string {
    const paths = [...new Set([
      ...attempt.paths,
      ...attempt.conflicts.map((conflict) => conflict.path),
    ])];
    const blockers = [...new Set(attempt.conflicts.flatMap((conflict) =>
      conflict.blocking.map((claim) => `Agent ${claim.agentId}${claim.boardId ? ` (Board ${claim.boardId})` : ''}`)))];
    const pathText = paths.join(', ') || 'the requested file';
    const waitPath = attempt.conflicts[0]?.path ?? paths[0];
    const blockerText = blockers.join(', ') || 'another board';
    return [
      `[Braid coordination] Blocked this write because ${pathText} is currently claimed by ${blockerText}.`,
      waitPath
        ? `Call braid.coordinate ONCE with action:"wait-file" and path:"${waitPath}"; it blocks until that file claim is ACTIVE. Stop only this gated write while waiting - do not poll or end the turn merely because the file is busy.`
        : 'Ask the blocking board to checkpoint/release, then retry the write only after the file claim is ACTIVE.',
    ].join('\n');
  }

  private async gateToolMiddleware(ctx: ToolMiddlewareContext): Promise<ToolMiddlewareResult> {
    if (!ctx.agentId) return { deny: true, reason: 'Coordinator requires the exact executing Agent identity.' };
    const fileAttempt = this.recordKnownWriteClaim(ctx.agentId, ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.conflicts.length) {
      this.publishCoordination(ctx.canvasId);
      return { deny: true, reason: this.fileConflictToolReason(fileAttempt, ctx.canvasId) };
    }
    const resourceAttempt = this.recordKnownResourceClaims(ctx.agentId, ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.matched || resourceAttempt.matched) this.publishCoordination(ctx.canvasId);
    if (resourceAttempt.conflicts.length) return { deny: true, reason: this.resourceConflictToolReason(resourceAttempt) };
    return { proceed: true };
  }

  private observeToolMiddleware(ctx: ToolMiddlewareContext): void {
    if (!ctx.agentId) return;
    const fileAttempt = ctx.toolName === 'FileChange'
      ? this.recordKnownWriteClaim(ctx.agentId, ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false)
      : { matched: false, paths: [], conflicts: [] };
    const resourceAttempt = this.recordKnownResourceClaims(ctx.agentId, ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.matched || resourceAttempt.matched) this.publishCoordination(ctx.canvasId);
  }

  private async handleCoordinateTool(ctx: AgentToolContext, req: CoordinateToolRequest): Promise<AgentToolResult> {
    const agentId = ctx.agentId;
    if (!agentId) return { ok: false, result: 'Coordinator requires the exact executing Agent identity.' };
    const canvasId = ctx.canvasId;
    const rb = ctx.boardId;
    const provider = ctx.provider;
    const signal = ctx.signal;
    this.syncWorkspaceResources();
    if (req.action === 'status') {
      const ids = this.coordination.resources.map((r) => r.id);
      const header = ids.length
        ? `Shared workspace resources: ${ids.join(', ')}.`
        : 'No named shared resources are declared (.braid/resources.json); file claims remain available.';
      const context = this.coordinationContextForAgent(agentId, canvasId);
      return { ok: true, result: context ? `${header}\n${context}` : `${header} No active claims, messages, or negotiations right now.` };
    }
    if (req.action === 'release') {
      const held = this.coordination.resourceClaims.filter((c) => c.agentId === agentId && c.status !== 'released').length
        + this.coordination.claims.filter((c) => c.agentId === agentId && c.status !== 'released').length;
      this.releaseAgent(agentId, req.summary ?? 'Released by the Agent.');
      return { ok: true, result: held ? `Released this Agent's ${held} coordination claim${held === 1 ? '' : 's'}.` : 'Nothing to release - this Agent holds no coordination claims.' };
    }
    if (req.action === 'request') {
      const text = (req.text ?? '').trim();
      if (!text) return { ok: false, result: 'request needs `text` - what you want to ask the other Agent.' };
      if (req.toAgentId && req.toBoardId) return { ok: false, result: 'Use toAgentId or toBoardId, not both.' };
      if (req.toBoardId && !canvasId) return { ok: false, result: 'toBoardId requires its displayed Canvas; use the exact toAgentId from status.' };
      const targetAgentId = req.toAgentId ?? (req.toBoardId && canvasId ? this.ctx.agentIdForBoard(canvasId, req.toBoardId) : undefined);
      if ((req.toAgentId || req.toBoardId) && !targetAgentId) return { ok: false, result: 'The selected projection has no exact Agent binding.' };
      const actor = this.executionActor(agentId, rb, provider);
      const relatedResources = req.resource ? [req.resource] : [];
      this.coordination = addBoardMessage(this.coordination, { canvasId, fromBoardId: rb, toBoardId: req.toBoardId, toAgentId: targetAgentId, actor, kind: 'question', text, relatedResources }).state;
      this.coordination = updateNegotiation(this.coordination, {
        canvasId,
        id: `neg-req-${agentId}${targetAgentId ? '-' + targetAgentId : ''}${req.resource ? '-' + req.resource : ''}`,
        topic: req.resource ? `Request: ${req.resource}` : `Request from Agent ${agentId}`,
        boardIds: [rb, req.toBoardId].filter((id): id is string => !!id),
        actor, action: 'propose', text, relatedResources,
      }).state;
      let delivered = false;
      if (targetAgentId) {
          delivered = await this.ctx.deliverLiveAgentMessage({
            agentId: targetAgentId,
            canvasId,
            boardId: req.toBoardId,
            fromBoardId: rb,
            kind: 'coordination.request',
            injected: true,
            text: `[Braid coordination request]\nAgent ${agentId} asks: ${text}${req.resource ? ` (re: ${req.resource})` : ''}\nRelease the resource at your next safe tool step if finished, or reply to this exact Agent with your coordination plan. A claim belongs only to its executing Agent.`,
          });
      }
      this.publishCoordination(canvasId);
      return { ok: true, result: targetAgentId
        ? `Recorded your request to Agent ${targetAgentId}. ${delivered ? 'The Agent notification was delivered.' : 'Live delivery was not accepted; the request remains in coordination context.'}`
        : 'Posted your request in project coordination context.' };
    }
    if (req.action === 'wait-file') {
      const paths = this.coordinationPathList(req.path ? [req.path] : undefined);
      if (paths.length !== 1) {
        return { ok: false, result: 'wait-file needs one workspace-relative `path` (for example "src/shared.ts").' };
      }
      const path = paths[0];
      const waiterKey = `file::${agentId}::${path}`;
      if (this.fileWaiters.has(waiterKey)) {
        return { ok: false, result: `Your board is already waiting for ${path}; keep the original wait-file call pending instead of starting another.` };
      }
      const actor = this.executionActor(agentId, rb, provider);
      const claimReq: ClaimRequest = {
        agentId,
        canvasId,
        boardId: rb,
        actor,
        path,
        access: 'edit',
        summary: req.summary ?? 'Agent-requested file wait.',
      };
      // Preserve waiter FIFO: queued waiters get first chance before this newcomer attempts the same path.
      this.tryResolveFileWaiters();
      const initial = claimFile(this.coordination, claimReq);
      if (!initial.conflict) {
        this.coordination = initial.state;
        this.publishCoordination(canvasId);
        return { ok: true, result: `Claimed ${path} - you now HOLD its file claim (ACTIVE). Retry only the write gated on this path; this grants no other file or declared resource.` };
      }
      this.recordFileConflicts(canvasId, rb, actor, [initial.conflict]);
      const blockers = [...new Set(initial.conflict.blocking.map((claim) => claim.agentId))].join(', ');
      return await new Promise<AgentToolResult>((resolve) => {
        const timer = setTimeout(() => {
          const changed = this.tryResolveFileWaiters();
          if (changed) this.publishCoordination();
          if (!this.fileWaiters.has(waiterKey)) return;
          this.resolveFileWaiter(waiterKey, {
            ok: false,
            result: `Still blocked after ${COORD_WAIT_CAP_MIN} min - ${path} is held by ${blockers}. You do NOT hold this file claim; call wait-file again or request a handoff.`,
          });
        }, COORD_WAIT_CAP_MS);
        const escalateTimer = setTimeout(() => {
          const changed = this.tryResolveFileWaiters();
          if (changed) this.publishCoordination();
          if (!this.fileWaiters.has(waiterKey)) return;
          const blockerKeys = this.fileWaitBlockerAgentIds(claimReq);
          if (blockerKeys.length) this.emitFileWaitEscalation(canvasId, blockerKeys, [path]);
        }, COORD_ESCALATE_MS);
        const onAbort = () => this.resolveFileWaiter(waiterKey, { ok: false, result: 'File wait canceled (the board was stopped).' });
        if (signal?.aborted) {
          clearTimeout(timer);
          clearTimeout(escalateTimer);
          resolve({ ok: false, result: 'File wait canceled (the board was stopped).' });
          return;
        }
        this.fileWaiters.set(waiterKey, {
          canvasId,
          boardId: rb,
          req: claimReq,
          timer,
          escalateTimer,
          signal,
          onAbort,
          resolve,
        });
        this.scheduleFileWaitRecheck();
        signal?.addEventListener('abort', onAbort, { once: true });
        this.publishCoordination(canvasId);
      });
    }
    const resource = (req.resource ?? '').trim();
    if (!resource) return { ok: false, result: 'claim/wait needs a `resource` id - call action:"status" first to see the declared resources.' };
    const actor = this.executionActor(agentId, rb, provider);
    const claimReq: ResourceClaimRequest = { agentId, canvasId, boardId: rb, actor, resource, mode: req.mode, desiredState: req.desiredState, priority: req.priority, summary: req.summary ?? 'Agent-requested claim.' };
    const result = this.claimResources([claimReq]);
    this.coordination = result.state;
    this.recordResourceConflicts(canvasId, rb, actor, result.claims, result.conflicts, req.summary);
    this.publishCoordination(canvasId);
    const claimed = result.claims.map((c) => this.describeResourceClaim(c)).join(', ') || resource;
    if (!result.conflicts.length) {
      return { ok: true, result: `Claimed ${claimed} - Agent ${agentId} now HOLDS it (ACTIVE). Held until this Agent releases it or its execution ends. The claim cannot be transferred by a message and grants no other Agent or resource.` };
    }
    const blockers = [...new Set(result.conflicts.flatMap((conflict) => [
      ...conflict.blocking.map((claim) => claim.agentId),
      ...(conflict.taskBlocking ?? []).map((claim) => `task ${claim.label} (${claim.taskId})`),
    ]))].join(', ');
    if (req.action === 'claim') {
      return { ok: true, result: `Claimed ${claimed} - but it is BLOCKED by ${blockers}, so your claim is PENDING (NOT granted). You do NOT hold this resource: do NOT run any action gated on it (build, closing the editor) and do NOT report it as yielded/granted. Blocking boards were notified; background tasks release when their operations finish. Use action:"wait" to block until it becomes ACTIVE.` };
    }
    const waiterKey = `${agentId}::${resource}`;
    if (this.resourceWaiters.has(waiterKey)) return { ok: false, result: 'This Agent already has a pending wait for this resource.' };
    return await new Promise<AgentToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveWaiter(waiterKey, { ok: false, result: `Still blocked after ${COORD_WAIT_CAP_MIN} min - ${resource} is held by ${blockers}. Your claim stays pending and grants no permission to execute. Call wait again or request a handoff.` });
      }, COORD_WAIT_CAP_MS);
      const escalateTimer = setTimeout(() => {
        const blk = this.waitBlockerAgentIds(claimReq);
        if (blk.length) this.emitCoordinationEscalation(canvasId, blk, [resource], 'stall');
      }, COORD_ESCALATE_MS);
      const onAbort = () => this.resolveWaiter(waiterKey, { ok: false, result: 'Wait canceled (the board was stopped).' });
      if (signal?.aborted) {
        clearTimeout(timer);
        clearTimeout(escalateTimer);
        resolve({ ok: false, result: 'Wait canceled (the board was stopped).' });
        return;
      }
      this.resourceWaiters.set(waiterKey, {
        canvasId, boardId: rb, req: claimReq,
        timer,
        escalateTimer,
        signal,
        onAbort,
        resolve,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const cycle = this.detectWaitCycleFrom(agentId);
      if (cycle && cycle.length >= 2) {
        const cycleResources = [...new Set(cycle.map((bk) => {
          for (const w of this.resourceWaiters.values()) if (w.req.agentId === bk) return w.req.resource;
          return undefined;
        }).filter((r): r is string => !!r))];
        this.emitCoordinationEscalation(canvasId, cycle, cycleResources.length ? cycleResources : [resource], 'deadlock');
      }
    });
  }
}

export const coordinatorHostServicePlugin: HostServicePlugin = {
  id: 'coordinator.hostService',
  label: 'Coordinator Host Service',
  manifest,
  create(ctx) {
    return new CoordinatorHostService(ctx);
  },
};
