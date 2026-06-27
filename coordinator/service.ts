import type {
  HostProviderCapabilitiesEvent,
  HostRunBoardEvent,
  HostRunLifecycleEvent,
  HostRunWarmIdleEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  PluginManifest,
  ToolMiddlewareContext,
  ToolMiddlewareResult,
} from '../../../src/plugin-api/types';
import type { AgentToolContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId, WebviewMessage } from '../../../src/protocol';
import {
  addBoardMessage,
  claimFile,
  claimResourceSet,
  cleanupCanvas,
  emptyCoordinationState,
  findClaimConflict,
  findResourceClaimConflict,
  markStaleClaims,
  matchResourceTriggers,
  normalizeResourceList,
  projectSnapshot,
  releaseBoardClaims,
  releaseBoardTransientClaims,
  setProviderCapabilities,
  setWorkspaceResources,
  snapshotForCanvas,
  updateNegotiation,
  upsertWorkIntent,
  type ClaimConflict,
  type CoordinationState,
  type FileClaim,
  type ResourceClaim,
  type ResourceClaimRequest,
} from './model';
import { createCoordinatorAgentTool, type CoordinateToolRequest } from './agentTool';
import { actorKey, coordinationPathList, sameCanvasLiveBoardKeys, workspaceStateTargetCanvases } from './helpers';
import { createCoordinatorLiveMessages, createCoordinatorProjectState, createCoordinatorTurnContext } from './hostHooks';
import manifestJson from './plugin.json';
import { loadWorkspaceResourceCatalog } from './resources';
import { createCoordinatorToolMiddleware } from './toolMiddleware';
import { createCoordinatorWebviewMessages, type CoordinatorWebviewMessage } from './webviewMessages';

const COORD_WAIT_CAP_MIN = 15;
const COORD_WAIT_CAP_MS = COORD_WAIT_CAP_MIN * 60_000;
const COORD_ESCALATE_MIN = 3;
const COORD_ESCALATE_MS = COORD_ESCALATE_MIN * 60_000;
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

type ResourceWaiter = {
  canvasId: string;
  boardId: string;
  req: ResourceClaimRequest;
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
  private readonly coordinationConflictKeys = new Set<string>();
  private resourceCatalogFile: string | undefined;
  private resourceCatalogSignature: string | null | undefined;

  constructor(private readonly ctx: HostServiceContext) {}

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
    return [createCoordinatorTurnContext((ctx) => this.coordinationContextForBoard(ctx.canvasId, ctx.boardId))];
  }

  liveMessages() {
    return [createCoordinatorLiveMessages()];
  }

  webviewMessages() {
    return [createCoordinatorWebviewMessages((ctx) => this.handleWebviewMessage(ctx.canvasId, ctx.message))];
  }

  onCanvasReady(canvasId: string): void {
    this.syncWorkspaceResources();
    this.publishCoordination(canvasId);
  }

  onCanvasClose(canvasId: string): void {
    const prefix = canvasId + '::';
    const filePrefix = 'file::' + prefix;
    for (const key of [...this.coordinationNoticeKeys]) if (key.startsWith(prefix) || key.startsWith(filePrefix)) this.coordinationNoticeKeys.delete(key);
    for (const key of [...this.coordinationConflictKeys]) if (key.startsWith(prefix) || key.startsWith(filePrefix)) this.coordinationConflictKeys.delete(key);
    for (const key of [...this.coordinationEscalationKeys]) if (key.startsWith(prefix)) this.coordinationEscalationKeys.delete(key);
    this.cancelWaitersForCanvas(canvasId, 'Wait canceled because the canvas was closed.');
    this.coordination = cleanupCanvas(this.coordination, canvasId);
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

  onRunWarmIdle(event: HostRunWarmIdleEvent): void {
    if (!event.idle) return;
    for (const boardId of event.boardIds) this.releaseBoard(event.canvasId, boardId);
  }

  onBoardAsyncIdle(event: HostRunBoardEvent): void {
    this.releaseBoard(event.canvasId, event.boardId, undefined, true);
  }

  onRunError(event: HostRunBoardEvent): void {
    this.releaseBoard(event.canvasId, event.boardId, 'Released after board error.');
  }

  onBoardAbort(event: HostRunBoardEvent): void {
    this.releaseBoard(event.canvasId, event.boardId, 'Released after board abort.');
  }

  onRunSettled(event: HostRunLifecycleEvent): void {
    for (const boardId of event.boardIds) this.releaseBoard(event.canvasId, boardId);
    this.publishCoordination(event.canvasId);
  }

  private aKey(canvasId: string, boardId: string) {
    return actorKey(canvasId, boardId);
  }

  private topLevelActor(boardId: string, provider?: EngineId) {
    return { boardId, provider, kind: 'topLevel' as const };
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

  private coordinationClaimRequests(canvasId: string, claim: WebviewMessage & { type: 'coordinationResourceClaim' }): ResourceClaimRequest[] {
    const actor = claim.claim.actor ?? this.topLevelActor(claim.claim.boardId);
    const items = claim.claim.claims?.length ? claim.claim.claims : [claim.claim];
    return items.map((item) => ({
      ...item,
      canvasId,
      boardId: claim.claim.boardId,
      actor,
      ttlMs: item.ttlMs ?? claim.claim.ttlMs,
      priority: item.priority ?? claim.claim.priority,
      summary: item.summary ?? claim.claim.summary,
    }));
  }

  private claimResources(reqs: ResourceClaimRequest[]): ReturnType<typeof claimResourceSet> {
    return claimResourceSet(this.coordination, reqs, this.ctx.liveOwnerKeys());
  }

  private publishCoordination(originCanvasId?: string) {
    const now = Date.now();
    const liveOwners = this.ctx.liveOwnerKeys();
    this.coordination = markStaleClaims(this.coordination, now, liveOwners);
    this.tryResolveWaiters();
    const canvasIds = workspaceStateTargetCanvases(this.ctx, originCanvasId);
    this.ctx.publishWorkspaceState({
      pluginId: 'coordinator',
      stateKey: 'coordination',
      canvasIds,
      snapshotForCanvas: (canvasId) => projectSnapshot(this.coordination, canvasId, now, liveOwners),
    });
  }

  private tryResolveWaiters() {
    if (!this.resourceWaiters.size) return;
    for (const [key, w] of [...this.resourceWaiters]) {
      const r = this.claimResources([w.req]);
      if (!r.conflicts.length) {
        this.coordination = r.state;
        this.resolveWaiter(key, { ok: true, result: `${w.req.resource} is now free - you now HOLD ${w.req.resource} (ACTIVE). This grants ONLY ${w.req.resource}; you do NOT automatically hold any other resource (a separate editor/build window is a DIFFERENT claim). Proceed only with actions gated on ${w.req.resource}.` });
      }
    }
  }

  private resolveWaiter(key: string, result: AgentToolResult) {
    const waiter = this.resourceWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.escalateTimer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.resourceWaiters.delete(key);
    this.clearEscalationsForBoard(this.aKey(waiter.canvasId, waiter.boardId));
    waiter.resolve(result);
  }

  private cancelWaitersForCanvas(canvasId: string, msg: string) {
    for (const [key, waiter] of [...this.resourceWaiters]) {
      if (waiter.canvasId === canvasId) this.resolveWaiter(key, { ok: false, result: msg });
    }
  }

  private waitBlockerBoardKeys(req: ResourceClaimRequest): string[] {
    const conflict = findResourceClaimConflict(this.coordination, req, this.ctx.liveOwnerKeys());
    return conflict ? [...new Set(conflict.blocking.map((c) => this.aKey(c.canvasId, c.boardId)))] : [];
  }

  private resourceClaimBlockerBoardIds(claim: ResourceClaim): string[] {
    const conflict = findResourceClaimConflict(this.coordination, {
      canvasId: claim.canvasId, boardId: claim.boardId, actor: claim.actor, resource: claim.resource,
      mode: claim.mode, desiredState: claim.desiredState, priority: claim.priority,
    }, this.ctx.liveOwnerKeys());
    if (!conflict) return [];
    return [...new Set(conflict.blocking.map((c) => c.boardId).filter((id) => id !== claim.boardId))];
  }

  private detectWaitCycleFrom(startBoardKey: string): string[] | null {
    const waiterByBoard = new Map<string, ResourceClaimRequest>();
    for (const w of this.resourceWaiters.values()) waiterByBoard.set(this.aKey(w.canvasId, w.boardId), w.req);
    const stack: string[] = [];
    const visited = new Set<string>();
    const dfs = (key: string): string[] | null => {
      const at = stack.indexOf(key);
      if (at >= 0) return stack.slice(at);
      if (visited.has(key)) return null;
      visited.add(key);
      const req = waiterByBoard.get(key);
      if (!req) return null;
      stack.push(key);
      for (const blocker of this.waitBlockerBoardKeys(req)) {
        const found = dfs(blocker);
        if (found) return found;
      }
      stack.pop();
      return null;
    };
    return dfs(startBoardKey);
  }

  private emitCoordinationEscalation(canvasId: string, boardKeys: string[], resources: string[], reason: 'deadlock' | 'stall') {
    const boards = boardKeys.map((k) => k.slice(k.lastIndexOf('::') + 2));
    const key = `${canvasId}::${reason}::|${[...boardKeys].sort().join('|')}|::${[...resources].sort().join('|')}`;
    if (this.coordinationEscalationKeys.has(key)) return;
    this.coordinationEscalationKeys.add(key);
    const text = reason === 'deadlock'
      ? `Coordination DEADLOCK: boards ${boards.join(', ')} are each waiting on a resource another holds (${resources.join(', ')}). Braid will NOT force a takeover - please intervene: Stop one of these boards (or let it ride the ${COORD_WAIT_CAP_MIN}-min wait cap).`
      : `Coordination STALL: a board has waited >${COORD_ESCALATE_MIN} min for ${resources.join(', ')} held by ${boards.join(', ')} with no handoff. Please intervene: ask or Stop the holder, or let the waiter ride the ${COORD_WAIT_CAP_MIN}-min cap.`;
    this.coordination = addBoardMessage(this.coordination, { canvasId, fromBoardId: boards[0] ?? 'coordination', kind: 'note', text, relatedResources: resources }).state;
    this.publishCoordination(canvasId);
  }

  private clearEscalationsForBoard(boardKey: string) {
    for (const k of [...this.coordinationEscalationKeys]) if (k.includes(`|${boardKey}|`)) this.coordinationEscalationKeys.delete(k);
  }

  private releaseBoard(canvasId: string, boardId: string, summary?: string, transientOnly = false) {
    const beforeSnap = snapshotForCanvas(this.coordination, canvasId, Date.now(), this.ctx.liveOwnerKeys());
    const beforeFiles = beforeSnap.claims.filter((c) => c.boardId === boardId && c.status !== 'released');
    const beforeResources = beforeSnap.resourceClaims.filter((c) =>
      c.boardId === boardId &&
      c.status !== 'released' &&
      (!transientOnly || (c.status === 'active' && c.mode === 'exclusive' && !c.desiredState)));
    const beforeCount = beforeFiles.length + beforeResources.length;
    this.coordination = transientOnly
      ? releaseBoardTransientClaims(this.coordination, canvasId, boardId)
      : releaseBoardClaims(this.coordination, canvasId, boardId);
    let text = summary;
    if (summary || beforeCount) {
      const added = addBoardMessage(this.coordination, {
        canvasId,
        fromBoardId: boardId,
        kind: 'release',
        text: summary ?? `Released ${beforeCount} coordination claim${beforeCount === 1 ? '' : 's'}.`,
        relatedPaths: beforeFiles.map((c) => c.path),
        relatedResources: beforeResources.map((c) => c.resource),
      });
      this.coordination = added.state;
      text = summary ?? added.message.text;
    }
    if (text) this.ctx.publishWorkspaceEvent({ pluginId: 'coordinator', eventKey: 'toast', canvasId, data: { text } });
    const tk = this.aKey(canvasId, boardId);
    for (const k of [...this.coordinationNoticeKeys]) if (k.startsWith(`${tk}::res::`)) this.coordinationNoticeKeys.delete(k);
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
    return `Board ${claim.boardId}: ${claim.path} (${claim.access}, ${claim.status})${summary}`;
  }

  private resourceClaimContextLine(claim: ResourceClaim): string {
    const summary = claim.summary ? ` - ${claim.summary}` : '';
    const idle = claim.status === 'stale' ? ' [board idle - advisory, not blocking]' : '';
    return `Board ${claim.boardId}: ${this.describeResourceClaim(claim)}${summary}${idle}`;
  }

  private recordFileConflicts(
    canvasId: string,
    boardId: string,
    actor: ClaimConflict['requestedBy'],
    conflicts: ClaimConflict[],
  ) {
    if (!conflicts.length) return;
    const paths = [...new Set(conflicts.map((conflict) => conflict.path))];
    const blockingClaims = conflicts.flatMap((conflict) => conflict.blocking);
    const blockers = [...new Set(blockingClaims.map((claim) => claim.boardId))];
    const blockerKeys = [...new Set(blockingClaims.map((claim) => this.aKey(claim.canvasId, claim.boardId)))];
    const pathText = paths.join(', ');
    const orderText = 'Another board needs to edit a file your board claims. A holding board should checkpoint/save and call coordinate release at its next safe tool step if it is done with the file, or reply with an ETA if it needs to keep editing.';
    const negId = `neg-file-${canvasId}-${paths.slice().sort().join('|')}`;
    const conflictKey = `file::${canvasId}::${boardId}::${paths.slice().sort().join('|')}::${blockers.slice().sort().join('|')}`;
    if (this.coordinationConflictKeys.has(conflictKey)) {
      this.queueLiveFileConflictNotices(canvasId, boardId, blockerKeys, paths, orderText);
      return;
    }
    this.coordinationConflictKeys.add(conflictKey);
    const added = addBoardMessage(this.coordination, {
      canvasId,
      fromBoardId: boardId,
      kind: 'note',
      text: `Potential coordination conflict: ${boardId} attempted to edit ${pathText}, currently claimed by ${blockers.join(', ')}.`,
      relatedPaths: paths,
    });
    this.coordination = added.state;
    this.coordination = updateNegotiation(this.coordination, {
      canvasId,
      id: negId,
      topic: `File conflict: ${pathText}`,
      boardIds: [boardId, ...blockers],
      actor,
      action: 'propose',
      text: `${boardId} attempted to edit ${pathText}. Blocking boards: ${blockers.join(', ')}. ${orderText}`,
      relatedPaths: paths,
    }).state;
    this.queueLiveFileConflictNotices(canvasId, boardId, blockerKeys, paths, orderText);
  }

  private recordResourceConflicts(
    canvasId: string,
    boardId: string,
    actor: ResourceClaimRequest['actor'],
    claims: ResourceClaim[],
    conflicts: ReturnType<typeof claimResourceSet>['conflicts'],
    summary?: string,
  ) {
    if (!conflicts.length) return;
    const blockingClaims = conflicts.flatMap((conflict) => conflict.blocking);
    const blockers = [...new Set(blockingClaims.map((c) => c.boardId))];
    const blockerKeys = [...new Set(blockingClaims.map((c) => this.aKey(c.canvasId, c.boardId)))];
    const relatedResources = [...new Set([...claims.map((c) => c.resource), ...conflicts.map((c) => c.resource)])];
    const claimText = claims.map((claim) => this.describeResourceClaim(claim)).join(', ');
    const highPriority = claims.some((claim) => claim.priority === 'high');
    const requestText = `${boardId} requested ${claimText}`;
    const orderText = highPriority
      ? 'This is a high-priority pending resource request. A blocking board should SAVE, then call coordinate release at its NEXT safe tool step (it need not finish its whole turn) - or report an ETA if it truly cannot release yet. If you will still NEED this resource after the high-priority work, call coordinate wait on it right after releasing to AUTO-RESUME when it frees, then reopen/reload (e.g. relaunch the editor) and continue.'
      : 'The request is pending. A blocking board should SAVE then release the resource at its next safe tool step; if you still need it afterwards, call coordinate wait on it right after releasing to auto-resume when it frees, then reopen/reload and continue.';
    const negId = `neg-res-${canvasId}-${relatedResources.slice().sort().join('|')}`;
    const conflictKey = `${canvasId}::${relatedResources.slice().sort().join('|')}::${blockers.slice().sort().join('|')}`;
    if (this.coordinationConflictKeys.has(conflictKey)) {
      this.queueLiveResourceConflictNotices(canvasId, boardId, blockerKeys, claims, relatedResources, highPriority, orderText);
      return;
    }
    this.coordinationConflictKeys.add(conflictKey);
    const added = addBoardMessage(this.coordination, {
      canvasId,
      fromBoardId: boardId,
      kind: 'note',
      text: `Potential resource conflict: ${requestText}, currently claimed by ${blockers.join(', ')}.`,
      relatedResources,
    });
    this.coordination = added.state;
    this.coordination = updateNegotiation(this.coordination, {
      canvasId,
      id: negId,
      topic: `Resource conflict: ${relatedResources.join(', ')}`,
      boardIds: [boardId, ...blockers],
      actor,
      action: 'propose',
      text: `${summary ?? requestText}. Blocking boards: ${blockers.join(', ')}. ${orderText}`,
      relatedResources,
    }).state;
    this.queueLiveResourceConflictNotices(canvasId, boardId, blockerKeys, claims, relatedResources, highPriority, orderText);
  }

  private queueLiveResourceConflictNotices(
    canvasId: string,
    requestingBoardId: string,
    targetKeys: string[],
    claims: ResourceClaim[],
    relatedResources: string[],
    highPriority: boolean,
    orderText: string,
  ) {
    if (!targetKeys.length) return;
    const requestingKey = this.aKey(canvasId, requestingBoardId);
    const claimText = claims.map((claim) => this.describeResourceClaim(claim)).join(', ');
    const resourcesText = relatedResources.join(', ');
    const guidance = highPriority
      ? 'This is a high-priority resource request. Checkpoint the conflicting work, release the resource when safe, let the high-priority work run, then resume.'
      : orderText;
    for (const targetKey of targetKeys) {
      if (targetKey === requestingKey || !this.ctx.hasLiveBoardKey(targetKey)) continue;
      const noticeKeys = relatedResources.map((r) => `${targetKey}::res::${r}::${highPriority ? 'hi' : 'lo'}`);
      if (noticeKeys.length && noticeKeys.every((k) => this.coordinationNoticeKeys.has(k))) continue;
      const delivered = this.ctx.deliverLiveBoardMessage({
        canvasId,
        targetKey,
        fromBoardId: requestingBoardId,
        kind: 'coordination.notice',
        injected: true,
        text: [
          '[Braid coordination notice]',
          `Board ${requestingBoardId} requested ${claimText}.`,
          `Related resources: ${resourcesText}.`,
          guidance,
        ].join('\n'),
      });
      for (const k of noticeKeys) this.coordinationNoticeKeys.add(k);
      void delivered;
    }
  }

  private queueLiveFileConflictNotices(
    canvasId: string,
    requestingBoardId: string,
    targetKeys: string[],
    paths: string[],
    guidance: string,
  ) {
    if (!targetKeys.length) return;
    const requestingKey = this.aKey(canvasId, requestingBoardId);
    const pathText = paths.join(', ');
    const pathKey = paths.slice().sort().join('|');
    for (const targetKey of targetKeys) {
      if (targetKey === requestingKey || !this.ctx.hasLiveBoardKey(targetKey)) continue;
      const noticeKey = `file::${targetKey}::${requestingKey}::${pathKey}`;
      if (this.coordinationNoticeKeys.has(noticeKey)) continue;
      const delivered = this.ctx.deliverLiveBoardMessage({
        canvasId,
        targetKey,
        fromBoardId: requestingBoardId,
        kind: 'coordination.notice',
        injected: true,
        text: [
          '[Braid coordination notice]',
          `Board ${requestingBoardId} attempted to edit ${pathText}, which your board currently claims.`,
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

  private coordinationContextForBoard(canvasId: string, boardId: string): string {
    this.syncWorkspaceResources();
    const snapshot = projectSnapshot(this.coordination, canvasId, Date.now(), this.ctx.liveOwnerKeys());
    const isOwn = (c: { canvasId: string; boardId: string }) => c.canvasId === canvasId && c.boardId === boardId;
    const activeFiles = snapshot.claims.filter((claim) => claim.status !== 'released');
    const ownFiles = activeFiles.filter(isOwn);
    const otherFiles = activeFiles
      .filter((claim) => !isOwn(claim))
      .sort((a, b) => a.boardId.localeCompare(b.boardId) || a.path.localeCompare(b.path))
      .slice(0, 4);
    const activeResources = snapshot.resourceClaims.filter((claim) => claim.status !== 'released');
    const ownResources = activeResources.filter(isOwn);
    const ownPending = ownResources.filter((claim) => claim.status === 'pending');
    const otherResources = activeResources
      .filter((claim) => !isOwn(claim))
      .sort((a, b) => {
        const score = (claim: ResourceClaim) => (claim.priority === 'high' ? 0 : 10) + (claim.status === 'pending' ? 0 : 1);
        return score(a) - score(b) || a.boardId.localeCompare(b.boardId) || a.resource.localeCompare(b.resource);
      })
      .slice(0, 4);
    const resourcesInView = new Set([...ownResources, ...otherResources].map((claim) => claim.resource));
    const heldActive = new Set(activeResources
      .filter((claim) => claim.status === 'active')
      .map((claim) => `${claim.canvasId}::${claim.boardId}::${claim.resource}`));
    const releaseSuperseded = (m: { kind: string; canvasId: string; fromBoardId: string; relatedResources: string[] }) =>
      m.kind === 'release' && m.relatedResources.some((r) => heldActive.has(`${m.canvasId}::${m.fromBoardId}::${r}`));
    const messages = snapshot.messages
      .filter((message) =>
        !(message.canvasId === canvasId && message.fromBoardId === boardId) &&
        !releaseSuperseded(message) &&
        (!message.toBoardId || message.toBoardId === boardId || message.relatedResources.some((resource) => resourcesInView.has(resource))))
      .slice(-2);
    const negotiations = snapshot.negotiations
      .filter((thread) =>
        thread.status !== 'resolved' &&
        thread.status !== 'rejected' &&
        (thread.boardIds.includes(boardId) ||
          thread.relatedResources.some((resource) => resourcesInView.has(resource)) ||
          thread.relatedPaths.some((path) => ownFiles.some((claim) => claim.path === path) || otherFiles.some((claim) => claim.path === path))))
      .slice(-2);
    if (!ownFiles.length && !otherFiles.length && !ownPending.length && !otherResources.length && !messages.length && !negotiations.length) return '';
    const lines: string[] = ['[Braid coordination]'];
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
          const blockers = this.resourceClaimBlockerBoardIds(claim);
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
      for (const message of messages) lines.push(`- From ${message.fromBoardId}: ${message.text}`);
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

  private recordKnownWriteClaim(canvasId: string, boardId: string, provider: EngineId | undefined, toolName: string, input: any, publish = true): FileClaimAttempt {
    const rawPaths = this.writePathsFromToolInput(toolName, input);
    if (!rawPaths.length) return { matched: false, paths: [], conflicts: [] };
    const paths = this.coordinationPathList(rawPaths);
    if (!paths.length) return { matched: false, paths: [], conflicts: [] };
    const actor = this.topLevelActor(boardId, provider);
    const now = Date.now();
    const requests = paths.map((path) => ({
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
      this.ctx.captureFileSnapshot(canvasId, boardId, path);
      const result = claimFile(this.coordination, {
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

  private recordKnownResourceClaims(canvasId: string, boardId: string, provider: EngineId | undefined, toolName: string, input: any, publish = true): ResourceClaimAttempt {
    this.syncWorkspaceResources();
    if (!this.coordination.resources.some((r) => r.claimOn?.length)) return { matched: false, claims: [], conflicts: [] };
    const command = this.commandFromToolInput(toolName, input);
    let inputText = '';
    try { inputText = JSON.stringify(input ?? {}).slice(0, 2000); } catch { inputText = ''; }
    const triggered = matchResourceTriggers(this.coordination.resources, { toolName, command, inputText });
    if (!triggered.length) return { matched: false, claims: [], conflicts: [] };
    const actor = this.topLevelActor(boardId, provider);
    const result = this.claimResources(triggered.map((t) => ({ ...t, canvasId, boardId, actor })));
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
      conflict.blocking.map((claim) => claim.canvasId ? `${claim.boardId} on ${claim.canvasId}` : claim.boardId)))];
    const claimText = attempt.claims.map((claim) => this.describeResourceClaim(claim)).join(', ') || resources.join(', ');
    const resourceText = resources.join(', ') || 'the requested resource';
    const blockerText = blockers.join(', ') || 'another board';
    return [
      `[Braid coordination] Blocked this tool because it would claim ${claimText}, currently blocked by ${blockerText}.`,
      `Call braid.coordinate with action:"wait" for ${resourceText}, or ask the blocking board to release/checkpoint, then retry the tool after the claim is active.`,
    ].join('\n');
  }

  private fileConflictToolReason(attempt: FileClaimAttempt, canvasId: string): string {
    const paths = [...new Set([
      ...attempt.paths,
      ...attempt.conflicts.map((conflict) => conflict.path),
    ])];
    const blockers = [...new Set(attempt.conflicts.flatMap((conflict) =>
      conflict.blocking.map((claim) => claim.canvasId !== canvasId ? `${claim.boardId} on ${claim.canvasId}` : claim.boardId)))];
    const pathText = paths.join(', ') || 'the requested file';
    const blockerText = blockers.join(', ') || 'another board';
    return [
      `[Braid coordination] Blocked this write because ${pathText} is currently claimed by ${blockerText}.`,
      'Ask the blocking board to checkpoint/release, or wait until the file claim is released, then retry the write.',
    ].join('\n');
  }

  private async gateToolMiddleware(ctx: ToolMiddlewareContext): Promise<ToolMiddlewareResult> {
    const fileAttempt = this.recordKnownWriteClaim(ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.conflicts.length) {
      this.publishCoordination(ctx.canvasId);
      return { deny: true, reason: this.fileConflictToolReason(fileAttempt, ctx.canvasId) };
    }
    const resourceAttempt = this.recordKnownResourceClaims(ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.matched || resourceAttempt.matched) this.publishCoordination(ctx.canvasId);
    if (resourceAttempt.conflicts.length) return { deny: true, reason: this.resourceConflictToolReason(resourceAttempt) };
    return { proceed: true };
  }

  private observeToolMiddleware(ctx: ToolMiddlewareContext): void {
    const fileAttempt = ctx.toolName === 'FileChange'
      ? this.recordKnownWriteClaim(ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false)
      : { matched: false, paths: [], conflicts: [] };
    const resourceAttempt = this.recordKnownResourceClaims(ctx.canvasId, ctx.boardId, ctx.provider, ctx.toolName, ctx.input, false);
    if (fileAttempt.matched || resourceAttempt.matched) this.publishCoordination(ctx.canvasId);
  }

  private async handleCoordinateTool(ctx: AgentToolContext, req: CoordinateToolRequest): Promise<AgentToolResult> {
    const canvasId = ctx.canvasId;
    const rb = ctx.boardId;
    const provider = ctx.provider;
    const signal = ctx.signal;
    this.syncWorkspaceResources();
    if (req.action === 'status') {
      const ids = this.coordination.resources.map((r) => r.id);
      const header = ids.length
        ? `Shared workspace resources: ${ids.join(', ')}.`
        : 'This project declares no shared resources (.braid/resources.json), so there is nothing to coordinate.';
      const context = this.coordinationContextForBoard(canvasId, rb);
      return { ok: true, result: context ? `${header}\n${context}` : `${header} No active claims, messages, or negotiations right now.` };
    }
    if (req.action === 'release') {
      const held = this.coordination.resourceClaims.filter((c) => c.canvasId === canvasId && c.boardId === rb && c.status !== 'released').length
        + this.coordination.claims.filter((c) => c.canvasId === canvasId && c.boardId === rb && c.status !== 'released').length;
      if (!held) return { ok: true, result: 'Nothing to release - your board holds no coordination claims.' };
      this.releaseBoard(canvasId, rb, req.summary ?? 'Released by the agent.', false);
      return { ok: true, result: `Released your board's ${held} coordination claim${held === 1 ? '' : 's'}.` };
    }
    if (req.action === 'request') {
      const text = (req.text ?? '').trim();
      if (!text) return { ok: false, result: 'request needs `text` - what you want to ask the other board.' };
      const actor = this.topLevelActor(rb, provider);
      const relatedResources = req.resource ? [req.resource] : [];
      this.coordination = addBoardMessage(this.coordination, { canvasId, fromBoardId: rb, toBoardId: req.toBoardId, kind: 'question', text, relatedResources }).state;
      this.coordination = updateNegotiation(this.coordination, {
        canvasId,
        id: `neg-req-${canvasId}-${rb}${req.toBoardId ? '-' + req.toBoardId : ''}${req.resource ? '-' + req.resource : ''}`,
        topic: req.resource ? `Request: ${req.resource}` : `Request from ${rb}`,
        boardIds: [rb, ...(req.toBoardId ? [req.toBoardId] : [])],
        actor, action: 'propose', text, relatedResources,
      }).state;
      let delivered = false;
      if (req.toBoardId) {
        for (const key of sameCanvasLiveBoardKeys(this.ctx, canvasId, req.toBoardId)) {
          delivered = this.ctx.deliverLiveBoardMessage({
            canvasId,
            targetKey: key,
            fromBoardId: rb,
            kind: 'coordination.request',
            injected: true,
            text: `[Braid coordination request]\nBoard ${rb} asks: ${text}${req.resource ? ` (re: ${req.resource})` : ''}\nIf you can, SAVE then call coordinate release at your NEXT safe tool step (you need not finish your turn). If you still need it afterwards, call coordinate wait on it right after releasing to auto-resume when it frees, then reopen/reload and continue. Otherwise reply with your own coordinate request (e.g. an ETA).`,
          }) || delivered;
        }
      }
      this.publishCoordination(canvasId);
      return { ok: true, result: req.toBoardId
        ? `Sent your request to board ${req.toBoardId}. ${delivered ? 'It is live and was notified now.' : 'It will see it on its next turn.'}`
        : 'Posted your request; other boards will see it on their next turn.' };
    }
    const resource = (req.resource ?? '').trim();
    if (!resource) return { ok: false, result: 'claim/wait needs a `resource` id - call action:"status" first to see the declared resources.' };
    const actor = this.topLevelActor(rb, provider);
    const claimReq: ResourceClaimRequest = { canvasId, boardId: rb, actor, resource, mode: req.mode, desiredState: req.desiredState, priority: req.priority, summary: req.summary ?? 'Agent-requested claim.' };
    const result = this.claimResources([claimReq]);
    this.coordination = result.state;
    this.recordResourceConflicts(canvasId, rb, actor, result.claims, result.conflicts, req.summary);
    this.publishCoordination(canvasId);
    const claimed = result.claims.map((c) => this.describeResourceClaim(c)).join(', ') || resource;
    if (!result.conflicts.length) {
      return { ok: true, result: `Claimed ${claimed} - you now HOLD it (ACTIVE). Held for this board until you release it (action:"release") or the board finishes. This grants ONLY what is listed here; do not assume you hold any other resource.` };
    }
    const blockers = [...new Set(result.conflicts.flatMap((c) => c.blocking.map((b) => b.boardId)))].join(', ');
    if (req.action === 'claim') {
      return { ok: true, result: `Claimed ${claimed} - but it is BLOCKED by board(s) ${blockers}, so your claim is PENDING (NOT granted). You do NOT hold this resource: do NOT run any action gated on it (build, closing the editor) and do NOT report it as yielded/granted. They were notified. Use action:"wait" to block until it actually becomes ACTIVE, action:"request" to ask them, or coordinate before forcing a conflicting action.` };
    }
    const waiterKey = `${canvasId}::${rb}::${resource}`;
    const thisBoardKey = this.aKey(canvasId, rb);
    return await new Promise<AgentToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveWaiter(waiterKey, { ok: true, result: `Still blocked after ${COORD_WAIT_CAP_MIN} min - ${resource} is held by ${blockers}. Your claim stays pending; call wait again, request a handoff, or proceed at your own risk.` });
      }, COORD_WAIT_CAP_MS);
      const escalateTimer = setTimeout(() => {
        const blk = this.waitBlockerBoardKeys(claimReq);
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
      const cycle = this.detectWaitCycleFrom(thisBoardKey);
      if (cycle && cycle.length >= 2) {
        const cycleResources = [...new Set(cycle.map((bk) => {
          for (const w of this.resourceWaiters.values()) if (this.aKey(w.canvasId, w.boardId) === bk) return w.req.resource;
          return undefined;
        }).filter((r): r is string => !!r))];
        this.emitCoordinationEscalation(canvasId, cycle, cycleResources.length ? cycleResources : [resource], 'deadlock');
      }
    });
  }

  private handleWebviewMessage(canvasId: string, msg: CoordinatorWebviewMessage): { handled: true } {
    switch (msg.type) {
      case 'coordinationIntent':
        this.coordination = upsertWorkIntent(this.coordination, {
          ...msg.intent,
          canvasId,
          plannedPaths: this.coordinationPathList(msg.intent.plannedPaths),
          plannedResources: normalizeResourceList(msg.intent.plannedResources),
        }).state;
        this.publishCoordination(canvasId);
        break;
      case 'coordinationMessage':
        this.coordination = addBoardMessage(this.coordination, {
          ...msg.message,
          canvasId,
          relatedPaths: this.coordinationPathList(msg.message.relatedPaths),
          relatedResources: normalizeResourceList(msg.message.relatedResources),
        }).state;
        this.publishCoordination(canvasId);
        break;
      case 'coordinationResourceClaim': {
        this.syncWorkspaceResources();
        const actor = msg.claim.actor ?? this.topLevelActor(msg.claim.boardId);
        const result = this.claimResources(this.coordinationClaimRequests(canvasId, msg));
        this.coordination = result.state;
        this.recordResourceConflicts(canvasId, msg.claim.boardId, actor, result.claims, result.conflicts, msg.claim.summary);
        this.publishCoordination(canvasId);
        break;
      }
      case 'coordinationNegotiate': {
        const existing = !!msg.negotiation.id &&
          this.coordination.negotiations.some((thread) => thread.canvasId === canvasId && thread.id === msg.negotiation.id);
        if (msg.negotiation.action !== 'propose' && !existing) {
          this.coordination = addBoardMessage(this.coordination, {
            canvasId,
            fromBoardId: msg.negotiation.actor?.boardId ?? msg.negotiation.boardIds[0] ?? 'unknown',
            kind: 'note',
            text: `Ignored ${msg.negotiation.action} for unknown negotiation ${msg.negotiation.id ?? '(missing id)'}.`,
          }).state;
          this.publishCoordination(canvasId);
          break;
        }
        this.coordination = updateNegotiation(this.coordination, {
          ...msg.negotiation,
          canvasId,
          relatedPaths: this.coordinationPathList(msg.negotiation.relatedPaths),
          relatedResources: normalizeResourceList(msg.negotiation.relatedResources),
        }).state;
        this.publishCoordination(canvasId);
        break;
      }
      case 'coordinationRelease':
        this.releaseBoard(canvasId, msg.release.boardId, msg.release.summary);
        break;
      case 'coordinationWait':
        this.coordination = addBoardMessage(this.coordination, {
          canvasId,
          fromBoardId: msg.wait.boardId,
          toBoardId: msg.wait.targetBoardId,
          kind: 'status',
          text: msg.wait.reason ?? 'Waiting for coordination.',
        }).state;
        this.publishCoordination(canvasId);
        break;
      case 'coordinationOverride':
        this.coordination = addBoardMessage(this.coordination, {
          canvasId,
          fromBoardId: msg.override.boardId,
          kind: 'note',
          text: msg.override.reason ?? 'Override requested. User confirmation is required before any lock is bypassed.',
        }).state;
        this.publishCoordination(canvasId);
        break;
    }
    return { handled: true };
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
