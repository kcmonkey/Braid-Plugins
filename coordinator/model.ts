import type { EngineId } from '../../../src/protocol';

export type CoordinationAccess = 'read' | 'edit';
export type ClaimStatus = 'active' | 'pending' | 'stale' | 'released';
export type ResourceClaimMode = 'shared' | 'exclusive' | 'state';
export type ResourcePriority = 'low' | 'normal' | 'high';
export type NegotiationStatus = 'proposed' | 'accepted' | 'countered' | 'rejected' | 'resolved' | 'needs-user-decision';
export type NegotiationAction = 'propose' | 'accept' | 'counter' | 'reject' | 'resolve' | 'needs-user-decision';

export type CoordinationActorKind =
  | 'topLevel'
  | 'providerSubagent'
  | 'providerThread'
  | 'sdkWorker'
  | 'toolRun';

export interface CoordinationActor {
  boardId: string;
  provider?: EngineId;
  kind: CoordinationActorKind;
  actorId?: string;
  parentActorId?: string;
  providerThreadId?: string;
  toolUseId?: string;
  label?: string;
}

export interface CoordinationCapabilityState {
  knownWriteGate: 'full' | 'approval-only' | 'none' | 'unknown';
  agentCallableMessages: boolean;
  contextInjection: boolean;
  providerThreadMetadata: boolean;
  actorAttribution: boolean;
}

export interface FileClaim {
  id: string;
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  path: string;
  access: CoordinationAccess;
  status: ClaimStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  summary?: string;
}

export interface ClaimConflict {
  path: string;
  requestedBy: CoordinationActor;
  requestedAccess: CoordinationAccess;
  blocking: FileClaim[];
}

export interface ResourceClaim {
  id: string;
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  resource: string;
  mode: ResourceClaimMode;
  desiredState?: string;
  priority: ResourcePriority;
  requiredBy?: string;
  status: ClaimStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  summary?: string;
}

export interface ResourceClaimConflict {
  resource: string;
  requestedBy: CoordinationActor;
  requestedMode: ResourceClaimMode;
  requestedState?: string;
  requestedPriority: ResourcePriority;
  blocking: ResourceClaim[];
}

export interface WorkspaceResourceRequirement {
  resource: string;
  mode?: ResourceClaimMode;
  desiredState?: string;
  priority?: ResourcePriority;
  summary?: string;
}

/** A project-declared trigger that turns an OBSERVED tool use into a resource claim. Lives entirely in the
 * project's `.braid/resources.json` (per resource, under `claimOn`) — the core matcher is generic and hardcodes
 * NO tool/command knowledge. A trigger fires when its positive conditions all match and `notMatches` (if any)
 * does not. All regexes are tested case-insensitively against the tool name / command / serialized input. */
export interface ResourceTrigger {
  tool?: string;            // exact tool name to match (e.g. "Bash")
  toolMatches?: string;     // regex tested against the tool name (e.g. "^mcp__")
  commandMatches?: string;  // regex tested against `<toolName> <command> <serialized input>`
  notMatches?: string;      // negative regex on the same haystack — skip the trigger if it matches
  desiredState?: string;    // for `state` resources: the state this trigger claims (e.g. "open"/"closed")
  priority?: ResourcePriority; // overrides the resource's priority for claims from this trigger
  summary?: string;
}

export interface WorkspaceResource {
  id: string;
  label?: string;
  kind: ResourceClaimMode;
  states?: string[];
  priority?: ResourcePriority;
  requires?: WorkspaceResourceRequirement[];
  description?: string;
  claimOn?: ResourceTrigger[]; // project-declared observed-tool-use triggers (no built-in defaults)
}

export interface WorkIntent {
  id: string;
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  title: string;
  summary?: string;
  topics: string[];
  plannedPaths: string[];
  plannedResources: string[];
  plannedBehavior?: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'done' | 'abandoned';
}

export interface BoardMessage {
  id: string;
  canvasId: string;
  fromBoardId: string;
  toBoardId?: string;
  actor?: CoordinationActor;
  kind: 'status' | 'release' | 'handoff' | 'question' | 'answer' | 'note';
  text: string;
  relatedPaths: string[];
  relatedResources: string[];
  relatedIntentIds: string[];
  createdAt: number;
  readByBoardIds: string[];
}

export interface NegotiationTurn {
  id: string;
  boardId: string;
  actor?: CoordinationActor;
  action: NegotiationAction;
  text: string;
  createdAt: number;
}

export interface NegotiationThread {
  id: string;
  canvasId: string;
  topic: string;
  status: NegotiationStatus;
  boardIds: string[];
  relatedPaths: string[];
  relatedResources: string[];
  relatedIntentIds: string[];
  proposedOwnerBoardId?: string;
  turns: NegotiationTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface CoordinationSnapshot {
  canvasId: string;
  claims: FileClaim[];
  resourceClaims: ResourceClaim[];
  resources: WorkspaceResource[];
  intents: WorkIntent[];
  messages: BoardMessage[];
  negotiations: NegotiationThread[];
  capabilities: Partial<Record<EngineId, CoordinationCapabilityState>>;
  now: number;
}

export interface CoordinationState {
  claims: FileClaim[];
  resourceClaims: ResourceClaim[];
  resources: WorkspaceResource[];
  intents: WorkIntent[];
  messages: BoardMessage[];
  negotiations: NegotiationThread[];
  capabilities: Partial<Record<EngineId, CoordinationCapabilityState>>;
  seq: number;
}

export interface ClaimRequest {
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  path: string;
  access: CoordinationAccess;
  now?: number;
  ttlMs?: number;
  summary?: string;
}

export interface ResourceClaimRequest {
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  resource: string;
  mode?: ResourceClaimMode;
  desiredState?: string;
  priority?: ResourcePriority;
  requiredBy?: string;
  now?: number;
  ttlMs?: number;
  summary?: string;
}

export interface WorkIntentInput {
  id?: string;
  canvasId: string;
  boardId: string;
  actor?: CoordinationActor;
  title: string;
  summary?: string;
  topics?: string[];
  plannedPaths?: string[];
  plannedResources?: string[];
  plannedBehavior?: string;
  now?: number;
  status?: WorkIntent['status'];
}

export interface BoardMessageInput {
  canvasId: string;
  fromBoardId: string;
  toBoardId?: string;
  actor?: CoordinationActor;
  kind: BoardMessage['kind'];
  text: string;
  relatedPaths?: string[];
  relatedResources?: string[];
  relatedIntentIds?: string[];
  now?: number;
}

export interface NegotiationInput {
  id?: string;
  canvasId: string;
  topic: string;
  boardIds: string[];
  actor?: CoordinationActor;
  action: NegotiationAction;
  text: string;
  relatedPaths?: string[];
  relatedResources?: string[];
  relatedIntentIds?: string[];
  proposedOwnerBoardId?: string;
  now?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export const emptyCoordinationState = (): CoordinationState => ({
  claims: [],
  resourceClaims: [],
  resources: [],
  intents: [],
  messages: [],
  negotiations: [],
  capabilities: {},
  seq: 0,
});

export function normalizeWorkspacePath(path: string): string {
  let p = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  p = p.replace(/\/$/, '');
  if (/^[a-z]:\//i.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p;
}

export function normalizePathList(paths: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths ?? []) {
    const p = normalizeWorkspacePath(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function normalizeResourceKey(resource: string): string {
  return resource.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizeResourceState(state: string | undefined): string | undefined {
  const s = state?.trim().toLowerCase();
  return s || undefined;
}

const RESOURCE_PRIORITIES: ResourcePriority[] = ['low', 'normal', 'high'];
const RESOURCE_MODES: ResourceClaimMode[] = ['shared', 'exclusive', 'state'];

export function normalizeResourcePriority(priority: ResourcePriority | undefined): ResourcePriority | undefined {
  return priority && RESOURCE_PRIORITIES.includes(priority) ? priority : undefined;
}

const resourcePriorityValue = (priority: ResourcePriority | undefined): number => {
  switch (priority) {
    case 'high': return 2;
    case 'low': return 0;
    case 'normal':
    default: return 1;
  }
};

const normalizeResourceMode = (mode: ResourceClaimMode | undefined): ResourceClaimMode | undefined =>
  mode && RESOURCE_MODES.includes(mode) ? mode : undefined;

export function normalizeResourceList(resources: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of resources ?? []) {
    const r = normalizeResourceKey(raw);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function normalizeResourceRequirements(requires: WorkspaceResourceRequirement[] | undefined): WorkspaceResourceRequirement[] {
  const out: WorkspaceResourceRequirement[] = [];
  const seen = new Set<string>();
  for (const raw of requires ?? []) {
    const resource = normalizeResourceKey(raw.resource);
    if (!resource) continue;
    const mode = normalizeResourceMode(raw.mode);
    const desiredState = normalizeResourceState(raw.desiredState);
    const key = `${resource}:${mode ?? ''}:${desiredState ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      resource,
      mode,
      desiredState,
      priority: normalizeResourcePriority(raw.priority),
      summary: raw.summary?.trim() || undefined,
    });
  }
  return out;
}

function normalizeResourceTriggers(claimOn: ResourceTrigger[] | undefined): ResourceTrigger[] | undefined {
  if (!Array.isArray(claimOn)) return undefined;
  const out: ResourceTrigger[] = [];
  for (const raw of claimOn) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = typeof raw.tool === 'string' && raw.tool.trim() ? raw.tool.trim() : undefined;
    const toolMatches = typeof raw.toolMatches === 'string' && raw.toolMatches.trim() ? raw.toolMatches : undefined;
    const commandMatches = typeof raw.commandMatches === 'string' && raw.commandMatches.trim() ? raw.commandMatches : undefined;
    if (!tool && !toolMatches && !commandMatches) continue; // drop empty / match-all triggers (must be positive)
    out.push({
      tool,
      toolMatches,
      commandMatches,
      notMatches: typeof raw.notMatches === 'string' && raw.notMatches.trim() ? raw.notMatches : undefined,
      desiredState: normalizeResourceState(raw.desiredState),
      priority: normalizeResourcePriority(raw.priority),
      summary: raw.summary?.trim() || undefined,
    });
  }
  return out.length ? out : undefined;
}

export function normalizeWorkspaceResources(resources: WorkspaceResource[] | undefined): WorkspaceResource[] {
  const out: WorkspaceResource[] = [];
  const seen = new Set<string>();
  for (const raw of resources ?? []) {
    const id = normalizeResourceKey(raw.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: raw.label?.trim() || undefined,
      kind: normalizeResourceMode(raw.kind) ?? 'shared',
      states: normalizeResourceList(raw.states),
      priority: normalizeResourcePriority(raw.priority),
      requires: normalizeResourceRequirements(raw.requires),
      description: raw.description?.trim() || undefined,
      claimOn: normalizeResourceTriggers(raw.claimOn),
    });
  }
  return out;
}

/** One observed tool invocation, fed to the trigger matcher. `command` is the shell command string when the
 * tool is a command runner (else ''); `inputText` is the serialized tool input (truncated by the caller). */
export interface ObservedToolUse {
  toolName: string;
  command: string;
  inputText: string;
}

/** The resource-claim shape a trigger produces (the host wraps it with canvas/board/actor). */
export interface TriggeredResourceClaim {
  resource: string;
  mode: ResourceClaimMode;
  desiredState?: string;
  priority?: ResourcePriority;
  summary?: string;
}

function compileTriggerRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; } // invalid pattern → fail safe (no match)
}

function triggerMatches(trigger: ResourceTrigger, obs: ObservedToolUse): boolean {
  if (!trigger.tool && !trigger.toolMatches && !trigger.commandMatches) return false; // never match-all
  if (trigger.tool && obs.toolName !== trigger.tool) return false;
  if (trigger.toolMatches) {
    const re = compileTriggerRegex(trigger.toolMatches);
    if (!re || !re.test(obs.toolName)) return false;
  }
  const haystack = `${obs.toolName} ${obs.command} ${obs.inputText}`;
  if (trigger.commandMatches) {
    const re = compileTriggerRegex(trigger.commandMatches);
    if (!re || !re.test(haystack)) return false;
  }
  if (trigger.notMatches) {
    const re = compileTriggerRegex(trigger.notMatches);
    if (re && re.test(haystack)) return false;
  }
  return true;
}

/** Match an observed tool use against every workspace resource's project-declared `claimOn` triggers. Pure +
 * provider-neutral: the core never hardcodes a tool/command — all knowledge lives in `.braid/resources.json`.
 * First matching trigger per resource wins. A resource without `claimOn`, or a project with none, infers nothing. */
export function matchResourceTriggers(resources: WorkspaceResource[], obs: ObservedToolUse): TriggeredResourceClaim[] {
  const out: TriggeredResourceClaim[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    for (const trigger of resource.claimOn ?? []) {
      if (!triggerMatches(trigger, obs)) continue;
      const desiredState = resource.kind === 'state' ? normalizeResourceState(trigger.desiredState) : undefined;
      const key = `${resource.id}:${desiredState ?? ''}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        resource: resource.id,
        mode: resource.kind,
        desiredState,
        priority: normalizeResourcePriority(trigger.priority) ?? resource.priority,
        summary: trigger.summary?.trim() || undefined,
      });
      break; // one claim per resource (first matching trigger)
    }
  }
  return out;
}

const activeAt = (claim: { status: ClaimStatus; expiresAt?: number }, now: number): boolean =>
  claim.status === 'active' && (claim.expiresAt == null || claim.expiresAt > now);

const liveAt = (claim: { status: ClaimStatus; expiresAt?: number }, now: number): boolean =>
  (claim.status === 'active' || claim.status === 'pending') && (claim.expiresAt == null || claim.expiresAt > now);

// Liveness chokepoint (SSOT). `ownerKey` builds the host's `${canvasId}::${boardId}` owner key; `isLiveOwner` tests
// membership in the host-supplied live-owner set. EVERY read path that gates on owner-liveness — file/resource
// enforcement, the `markStaleClaims` TTL backstop, and the agent-context filters in service.ts — MUST go through
// these, so a new claim type / read path can't silently omit the gate or re-derive the key with the wrong field
// shape (e.g. `fromBoardId`, negotiation originator) — the failure mode behind every recurring zombie-lock bug
// (D12/D14/D15/D21). `liveOwners` is optional: when the caller doesn't track liveness (legacy / direct unit callers)
// `isLiveOwner` is false, so each path falls back to its old TTL-only behavior unchanged.
export function ownerKey(entry: { canvasId: string; boardId: string }): string {
  return `${entry.canvasId}::${entry.boardId}`;
}
export function isLiveOwner(entry: { canvasId: string; boardId: string }, liveOwners?: ReadonlySet<string>): boolean {
  return !!liveOwners && liveOwners.has(ownerKey(entry));
}

const touchesSamePath = (a: string, b: string): boolean => normalizeWorkspacePath(a) === normalizeWorkspacePath(b);

export function compatibleClaims(existing: FileClaim, req: ClaimRequest, now: number, liveOwners?: ReadonlySet<string>): boolean {
  if (!activeAt(existing, now)) return true;
  // D21 (file-claim liveness parity): a file edit-lock is only honored while its OWNING board is a live owner (the
  // host supplies `liveOwners`). A settled board's leftover lock must NOT block a live board — it is released on
  // run-end (D15); this is the self-healing backstop for a missed/late release, mirroring resource liveness (D14).
  // When `liveOwners` is omitted (legacy / direct unit callers) the old TTL-only behavior is kept.
  if (liveOwners && !isLiveOwner(existing, liveOwners)) return true;
  if (!touchesSamePath(existing.path, req.path)) return true;
  // Cross-canvas: a board only "re-enters" its OWN claim. Board ids are per-canvas (the webview mints `b${n}`
  // from a per-canvas counter, so ids collide across canvases) → the owner is the (canvasId, boardId) pair. (cross-canvas)
  if (existing.canvasId === req.canvasId && existing.boardId === req.boardId) return true;
  return existing.access === 'read' && req.access === 'read';
}

export function findClaimConflict(state: CoordinationState, req: ClaimRequest, liveOwners?: ReadonlySet<string>): ClaimConflict | null {
  const now = req.now ?? Date.now();
  const path = normalizeWorkspacePath(req.path);
  // Cross-canvas: file conflicts span every canvas in the project (shared filesystem). `compatibleClaims`
  // scopes "own board" by the (canvasId, boardId) pair, so a different board in another canvas still conflicts.
  const blocking = state.claims.filter((claim) => !compatibleClaims(claim, { ...req, path }, now, liveOwners));
  if (!blocking.length) return null;
  return {
    path,
    requestedBy: req.actor ?? { boardId: req.boardId, kind: 'topLevel' },
    requestedAccess: req.access,
    blocking,
  };
}

export function claimFile(state: CoordinationState, req: ClaimRequest, liveOwners?: ReadonlySet<string>): { state: CoordinationState; claim?: FileClaim; conflict?: ClaimConflict } {
  const now = req.now ?? Date.now();
  const path = normalizeWorkspacePath(req.path);
  const conflict = findClaimConflict(state, { ...req, path, now }, liveOwners);
  if (conflict) return { state, conflict };

  const existing = state.claims.find((claim) =>
    claim.canvasId === req.canvasId &&
    claim.boardId === req.boardId &&
    claim.path === path &&
    claim.status !== 'released');
  const expiresAt = now + (req.ttlMs ?? DEFAULT_TTL_MS);
  if (existing) {
    const updated: FileClaim = {
      ...existing,
      actor: req.actor ?? existing.actor,
      access: existing.access === 'edit' || req.access === 'edit' ? 'edit' : 'read',
      status: 'active',
      updatedAt: now,
      expiresAt,
      summary: req.summary ?? existing.summary,
    };
    return {
      state: { ...state, claims: state.claims.map((claim) => (claim.id === existing.id ? updated : claim)) },
      claim: updated,
    };
  }

  const claim: FileClaim = {
    id: `claim-${state.seq + 1}`,
    canvasId: req.canvasId,
    boardId: req.boardId,
    actor: req.actor,
    path,
    access: req.access,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    summary: req.summary,
  };
  return { state: { ...state, seq: state.seq + 1, claims: [...state.claims, claim] }, claim };
}

const resourceStateConflict = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a !== b;

const workspaceResourceFor = (state: CoordinationState, resource: string): WorkspaceResource | undefined =>
  state.resources.find((r) => r.id === normalizeResourceKey(resource));

function resourceModeFor(
  state: CoordinationState,
  resource: string,
  desiredState: string | undefined,
  mode: ResourceClaimMode | undefined,
): ResourceClaimMode {
  return normalizeResourceMode(mode) ?? workspaceResourceFor(state, resource)?.kind ?? (desiredState ? 'state' : 'shared');
}

function resourcePriorityFor(
  state: CoordinationState,
  resource: string,
  priority: ResourcePriority | undefined,
  inheritedPriority?: ResourcePriority,
): ResourcePriority {
  return normalizeResourcePriority(priority) ??
    inheritedPriority ??
    workspaceResourceFor(state, resource)?.priority ??
    'normal';
}

function normalizeResourceClaimRequest(
  state: CoordinationState,
  req: ResourceClaimRequest,
  now = req.now ?? Date.now(),
  inheritedPriority?: ResourcePriority,
): ResourceClaimRequest & { mode: ResourceClaimMode; priority: ResourcePriority; now: number } {
  const resource = normalizeResourceKey(req.resource);
  const desiredState = normalizeResourceState(req.desiredState);
  const priority = resourcePriorityFor(state, resource, req.priority, inheritedPriority);
  return {
    ...req,
    resource,
    desiredState,
    mode: resourceModeFor(state, resource, desiredState, req.mode),
    priority,
    requiredBy: req.requiredBy ? normalizeResourceKey(req.requiredBy) : undefined,
    now,
  };
}

function resourceClaimBlocks(existing: ResourceClaim, reqPriority: ResourcePriority, now: number, liveOwners?: ReadonlySet<string>): boolean {
  // D14 (liveness-true claims): a claim whose OWNING board's run is LIVE (streaming / async-waiting — the host
  // supplies the set) never expires via the 10-min TTL while live; a claim whose owner is NOT live falls back to
  // the TTL (orphan backstop for host-restart / crash leftovers). Without a liveOwners set this is the old
  // TTL-only behavior (callers that don't track liveness, e.g. tests).
  const ownerLive = isLiveOwner(existing, liveOwners);
  const stillActive = existing.status === 'active' && (ownerLive || existing.expiresAt == null || existing.expiresAt > now);
  if (stillActive) return true;
  const stillPending = existing.status === 'pending' && (ownerLive || existing.expiresAt == null || existing.expiresAt > now);
  if (!stillPending) return false;
  return resourcePriorityValue(existing.priority) > resourcePriorityValue('normal') &&
    resourcePriorityValue(existing.priority) >= resourcePriorityValue(reqPriority);
}

export function compatibleResourceClaims(existing: ResourceClaim, req: ResourceClaimRequest, now: number, liveOwners?: ReadonlySet<string>): boolean {
  const reqPriority = req.priority ?? 'normal';
  if (!resourceClaimBlocks(existing, reqPriority, now, liveOwners)) return true;
  if (existing.resource !== normalizeResourceKey(req.resource)) return true;
  if (existing.canvasId === req.canvasId && existing.boardId === req.boardId) return true; // own (canvasId,boardId) re-entry — board ids collide across canvases
  const mode = req.mode ?? 'shared';
  if (existing.mode === 'exclusive' || mode === 'exclusive') return false;
  return !resourceStateConflict(existing.desiredState, normalizeResourceState(req.desiredState));
}

export function findResourceClaimConflict(state: CoordinationState, req: ResourceClaimRequest, liveOwners?: ReadonlySet<string>): ResourceClaimConflict | null {
  const now = req.now ?? Date.now();
  const normalizedReq = normalizeResourceClaimRequest(state, req, now);
  const { resource, mode } = normalizedReq;
  // Cross-canvas: resource conflicts span every canvas in the project (shared editor/build/etc.).
  const blocking = state.resourceClaims.filter((claim) => !compatibleResourceClaims(claim, normalizedReq, now, liveOwners));
  if (!blocking.length) return null;
  return {
    resource,
    requestedBy: req.actor ?? { boardId: req.boardId, kind: 'topLevel' },
    requestedMode: mode,
    requestedState: normalizedReq.desiredState,
    requestedPriority: normalizedReq.priority,
    blocking,
  };
}

function expandResourceClaimRequests(state: CoordinationState, reqs: ResourceClaimRequest[]): ResourceClaimRequest[] {
  const out: ResourceClaimRequest[] = [];
  const seen = new Set<string>();
  const visit = (req: ResourceClaimRequest, inheritedPriority?: ResourcePriority, requiredBy?: string, expandRequirements = true) => {
    const now = req.now ?? Date.now();
    const normalized = normalizeResourceClaimRequest(
      state,
      { ...req, requiredBy: requiredBy ?? req.requiredBy },
      now,
      inheritedPriority,
    );
    if (!normalized.resource) return;
    const key = `${normalized.canvasId}:${normalized.boardId}:${normalized.resource}:${normalized.mode}:${normalized.desiredState ?? ''}:${normalized.requiredBy ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
    const descriptor = expandRequirements ? workspaceResourceFor(state, normalized.resource) : undefined;
    for (const requirement of descriptor?.requires ?? []) {
      visit({
        canvasId: normalized.canvasId,
        boardId: normalized.boardId,
        actor: normalized.actor,
        resource: requirement.resource,
        mode: requirement.mode,
        desiredState: requirement.desiredState,
        priority: requirement.priority,
        ttlMs: normalized.ttlMs,
        now,
        summary: requirement.summary ?? `Required by ${normalized.resource}`,
      }, normalized.priority, normalized.resource, false);
    }
  };
  for (const req of reqs) visit(req);
  return out;
}

function upsertResourceClaim(
  state: CoordinationState,
  req: ResourceClaimRequest,
  status: 'active' | 'pending',
): { state: CoordinationState; claim?: ResourceClaim } {
  const now = req.now ?? Date.now();
  const normalized = normalizeResourceClaimRequest(state, req, now);
  const { resource, desiredState, mode, priority } = normalized;
  if (!resource) return { state };

  const existing = state.resourceClaims.find((claim) =>
    claim.canvasId === req.canvasId &&
    claim.boardId === req.boardId &&
    claim.resource === resource &&
    claim.status !== 'released');
  const expiresAt = now + (req.ttlMs ?? DEFAULT_TTL_MS);
  if (existing) {
    const updated: ResourceClaim = {
      ...existing,
      actor: req.actor ?? existing.actor,
      mode: existing.mode === 'exclusive' || mode === 'exclusive' ? 'exclusive' : mode,
      desiredState: desiredState ?? existing.desiredState,
      priority,
      requiredBy: normalized.requiredBy ?? existing.requiredBy,
      status,
      updatedAt: now,
      expiresAt,
      summary: req.summary ?? existing.summary,
    };
    return {
      state: { ...state, resourceClaims: state.resourceClaims.map((claim) => (claim.id === existing.id ? updated : claim)) },
      claim: updated,
    };
  }

  const claim: ResourceClaim = {
    id: `res-${state.seq + 1}`,
    canvasId: req.canvasId,
    boardId: req.boardId,
    actor: req.actor,
    resource,
    mode,
    desiredState,
    priority,
    requiredBy: normalized.requiredBy,
    status,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    summary: req.summary,
  };
  return { state: { ...state, seq: state.seq + 1, resourceClaims: [...state.resourceClaims, claim] }, claim };
}

export function claimResourceSet(
  state: CoordinationState,
  reqs: ResourceClaimRequest[],
  liveOwners?: ReadonlySet<string>,
): { state: CoordinationState; claims: ResourceClaim[]; conflicts: ResourceClaimConflict[] } {
  const expanded = expandResourceClaimRequests(state, reqs);
  if (!expanded.length) return { state, claims: [], conflicts: [] };
  const conflicts = expanded
    .map((req) => findResourceClaimConflict(state, req, liveOwners))
    .filter((conflict): conflict is ResourceClaimConflict => !!conflict);
  const status: 'active' | 'pending' = conflicts.length ? 'pending' : 'active';
  let next = state;
  const claims: ResourceClaim[] = [];
  for (const req of expanded) {
    const result = upsertResourceClaim(next, req, status);
    next = result.state;
    if (result.claim) claims.push(result.claim);
  }
  return { state: next, claims, conflicts };
}

export function claimResource(
  state: CoordinationState,
  req: ResourceClaimRequest,
  liveOwners?: ReadonlySet<string>,
): { state: CoordinationState; claim?: ResourceClaim; conflict?: ResourceClaimConflict } {
  const result = claimResourceSet(state, [req], liveOwners);
  return { state: result.state, claim: result.claims[0], conflict: result.conflicts[0] };
}

export function releaseBoardClaims(state: CoordinationState, canvasId: string, boardId: string, now = Date.now()): CoordinationState {
  return {
    ...state,
    claims: state.claims.map((claim) =>
      claim.canvasId === canvasId && claim.boardId === boardId && claim.status !== 'released'
        ? { ...claim, status: 'released', updatedAt: now, expiresAt: undefined }
        : claim),
    resourceClaims: state.resourceClaims.map((claim) =>
      claim.canvasId === canvasId && claim.boardId === boardId && claim.status !== 'released'
        ? { ...claim, status: 'released', updatedAt: now, expiresAt: undefined }
        : claim),
  };
}

export function releaseBoardTransientClaims(state: CoordinationState, canvasId: string, boardId: string, now = Date.now()): CoordinationState {
  return {
    ...state,
    claims: state.claims.map((claim) =>
      claim.canvasId === canvasId && claim.boardId === boardId && claim.status !== 'released'
        ? { ...claim, status: 'released', updatedAt: now, expiresAt: undefined }
        : claim),
    resourceClaims: state.resourceClaims.map((claim) =>
      claim.canvasId === canvasId &&
      claim.boardId === boardId &&
      claim.status === 'active' &&
      claim.mode === 'exclusive' &&
      !claim.desiredState
        ? { ...claim, status: 'released', updatedAt: now, expiresAt: undefined }
        : claim),
  };
}

export function cleanupCanvas(state: CoordinationState, canvasId: string): CoordinationState {
  return {
    ...state,
    claims: state.claims.filter((claim) => claim.canvasId !== canvasId),
    resourceClaims: state.resourceClaims.filter((claim) => claim.canvasId !== canvasId),
    intents: state.intents.filter((intent) => intent.canvasId !== canvasId),
    messages: state.messages.filter((message) => message.canvasId !== canvasId),
    negotiations: state.negotiations.filter((thread) => thread.canvasId !== canvasId),
  };
}

export function markStaleClaims(state: CoordinationState, now = Date.now(), liveOwners?: ReadonlySet<string>): CoordinationState {
  // D14/D21: a LIVE owner's claim must NOT be staled by the 10-min TTL while the board is running — otherwise it
  // leaves `active`/`pending` and the liveness override (which only applies to active/pending) can never fire,
  // silently defeating liveness-true blocking. The TTL stays an ORPHAN backstop: a non-live owner's expired claim
  // still goes stale. D21 brings FILE claims to the same parity (was TTL-only): a live owner keeps its edit-lock
  // past the TTL, and a non-live owner's expired lock goes stale.
  // memory-footprint Phase 4: this runs on EVERY publishCoordination (per coordination change / matched tool),
  // so SHORT-CIRCUIT when nothing actually transitions — `.some()` allocates nothing, and returning the same
  // `state` ref avoids cloning both full arrays + every claim object on the hot path. Behavior-preserving.
  const fileStale = (claim: FileClaim) =>
    claim.status === 'active' && claim.expiresAt != null && claim.expiresAt <= now && !isLiveOwner(claim, liveOwners);
  const resStale = (claim: ResourceClaim) =>
    (claim.status === 'active' || claim.status === 'pending') && claim.expiresAt != null && claim.expiresAt <= now && !isLiveOwner(claim, liveOwners);
  const anyFile = state.claims.some(fileStale);
  const anyRes = state.resourceClaims.some(resStale);
  if (!anyFile && !anyRes) return state; // nothing expired → no allocation
  return {
    ...state,
    claims: anyFile ? state.claims.map((claim) => (fileStale(claim) ? { ...claim, status: 'stale', updatedAt: now } : claim)) : state.claims,
    resourceClaims: anyRes ? state.resourceClaims.map((claim) => (resStale(claim) ? { ...claim, status: 'stale', updatedAt: now } : claim)) : state.resourceClaims,
  };
}

/** Age (ms) after which a fully-retired coordination tombstone — a `released` claim, a `resolved`/`rejected`
 *  negotiation — is pruned from the in-memory ledger. Generous (well past the ~10-min claim TTL) so a just-
 *  released claim still survives a quick re-claim and the panel keeps recent history; only long-dead tombstones
 *  are dropped, bounding the arrays over a marathon session. (memory-footprint Phase 4) */
export const RETIRED_PRUNE_AGE_MS = 30 * 60_000;

/**
 * Drop long-dead coordination tombstones so `claims` / `resourceClaims` / `negotiations` don't grow unbounded
 * over a long session: `released` claims and `resolved`/`rejected` negotiations older than `maxAgeMs`. Pure +
 * behavior-preserving — returns the SAME `state` when nothing is old enough (zero allocation on the hot publish
 * path). Released claims are NEVER shown (`snapshotForCanvas` filters them) and conflict detection ignores them,
 * and the "Released N" count is taken at release time, so dropping aged ones is invisible. `cleanupCanvas` still
 * wholesale-clears on canvas close. (memory-footprint Phase 4) */
export function pruneRetiredCoordination(state: CoordinationState, now = Date.now(), maxAgeMs = RETIRED_PRUNE_AGE_MS): CoordinationState {
  const cutoff = now - maxAgeMs;
  const deadClaim = (c: { status: string; updatedAt: number }) => c.status === 'released' && c.updatedAt <= cutoff;
  const deadNeg = (t: { status: string; updatedAt: number }) => (t.status === 'resolved' || t.status === 'rejected') && t.updatedAt <= cutoff;
  const anyClaim = state.claims.some(deadClaim);
  const anyRes = state.resourceClaims.some(deadClaim);
  const anyNeg = state.negotiations.some(deadNeg);
  if (!anyClaim && !anyRes && !anyNeg) return state;
  return {
    ...state,
    claims: anyClaim ? state.claims.filter((c) => !deadClaim(c)) : state.claims,
    resourceClaims: anyRes ? state.resourceClaims.filter((c) => !deadClaim(c)) : state.resourceClaims,
    negotiations: anyNeg ? state.negotiations.filter((t) => !deadNeg(t)) : state.negotiations,
  };
}

/** The board that ORIGINATED a negotiation (the requester / the board whose attempt opened the thread): the first
 * turn's board, falling back to the first listed board id for hand-built threads with no turns. Used to decide whose
 * lifecycle owns the thread (retire-on-end) and whether it is still backed by a live board (context liveness gate). */
export function negotiationOriginatorBoardId(thread: NegotiationThread): string {
  return thread.turns[0]?.boardId ?? thread.boardIds[0];
}

/** Retire the coordination footprint a FINISHED board leaves behind, so other boards stop seeing its request as an
 * active contender after its session is gone. Resolves the negotiations this board ORIGINATED and drops its
 * conflict(`note`)/request(`question`) messages; resource/file CLAIMS are released separately (releaseBoardClaims),
 * and release/status/answer/handoff messages are kept. Call ONLY on a FULL board end (settle / error / abort /
 * delete / explicit release) — NOT async-idle, where the board stays a live contender that may still resume. */
export function retireBoardCoordination(
  state: CoordinationState,
  canvasId: string,
  boardId: string,
  now = Date.now(),
): CoordinationState {
  return {
    ...state,
    negotiations: state.negotiations.map((thread) =>
      thread.canvasId === canvasId &&
      negotiationOriginatorBoardId(thread) === boardId &&
      thread.status !== 'resolved' &&
      thread.status !== 'rejected'
        ? { ...thread, status: 'resolved', updatedAt: now }
        : thread),
    messages: state.messages.filter((message) =>
      !(message.canvasId === canvasId &&
        message.fromBoardId === boardId &&
        (message.kind === 'note' || message.kind === 'question'))),
  };
}

export function upsertWorkIntent(state: CoordinationState, input: WorkIntentInput): { state: CoordinationState; intent: WorkIntent } {
  const now = input.now ?? Date.now();
  const existing = input.id ? state.intents.find((intent) => intent.id === input.id && intent.canvasId === input.canvasId) : undefined;
  const next: WorkIntent = {
    id: existing?.id ?? input.id ?? `intent-${state.seq + 1}`,
    canvasId: input.canvasId,
    boardId: input.boardId,
    actor: input.actor ?? existing?.actor,
    title: input.title.trim(),
    summary: input.summary,
    topics: [...new Set((input.topics ?? []).map((t) => t.trim()).filter(Boolean))],
    plannedPaths: normalizePathList(input.plannedPaths),
    plannedResources: normalizeResourceList(input.plannedResources),
    plannedBehavior: input.plannedBehavior,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status: input.status ?? existing?.status ?? 'active',
  };
  return existing
    ? { state: { ...state, intents: state.intents.map((intent) => (intent.id === existing.id ? next : intent)) }, intent: next }
    : { state: { ...state, seq: state.seq + 1, intents: [...state.intents, next] }, intent: next };
}

export function addBoardMessage(state: CoordinationState, input: BoardMessageInput): { state: CoordinationState; message: BoardMessage } {
  const now = input.now ?? Date.now();
  const message: BoardMessage = {
    id: `msg-${state.seq + 1}`,
    canvasId: input.canvasId,
    fromBoardId: input.fromBoardId,
    toBoardId: input.toBoardId,
    actor: input.actor,
    kind: input.kind,
    text: input.text,
    relatedPaths: normalizePathList(input.relatedPaths),
    relatedResources: normalizeResourceList(input.relatedResources),
    relatedIntentIds: [...new Set(input.relatedIntentIds ?? [])],
    createdAt: now,
    readByBoardIds: [input.fromBoardId],
  };
  return { state: { ...state, seq: state.seq + 1, messages: [...state.messages, message] }, message };
}

const statusForAction = (action: NegotiationAction): NegotiationStatus => {
  switch (action) {
    case 'accept': return 'accepted';
    case 'counter': return 'countered';
    case 'reject': return 'rejected';
    case 'resolve': return 'resolved';
    case 'needs-user-decision': return 'needs-user-decision';
    case 'propose':
    default: return 'proposed';
  }
};

export function updateNegotiation(state: CoordinationState, input: NegotiationInput): { state: CoordinationState; thread: NegotiationThread } {
  const now = input.now ?? Date.now();
  const existing = input.id ? state.negotiations.find((thread) => thread.id === input.id && thread.canvasId === input.canvasId) : undefined;
  const turn: NegotiationTurn = {
    id: `turn-${state.seq + 1}`,
    boardId: input.actor?.boardId ?? input.boardIds[0],
    actor: input.actor,
    action: input.action,
    text: input.text,
    createdAt: now,
  };
  const thread: NegotiationThread = {
    id: existing?.id ?? input.id ?? `neg-${state.seq + 1}`,
    canvasId: input.canvasId,
    topic: input.topic.trim(),
    status: statusForAction(input.action),
    boardIds: [...new Set([...(existing?.boardIds ?? []), ...input.boardIds])],
    relatedPaths: normalizePathList([...(existing?.relatedPaths ?? []), ...(input.relatedPaths ?? [])]),
    relatedResources: normalizeResourceList([...(existing?.relatedResources ?? []), ...(input.relatedResources ?? [])]),
    relatedIntentIds: [...new Set([...(existing?.relatedIntentIds ?? []), ...(input.relatedIntentIds ?? [])])],
    proposedOwnerBoardId: input.proposedOwnerBoardId ?? existing?.proposedOwnerBoardId,
    turns: [...(existing?.turns ?? []), turn],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return existing
    ? { state: { ...state, seq: state.seq + 1, negotiations: state.negotiations.map((n) => (n.id === existing.id ? thread : n)) }, thread }
    : { state: { ...state, seq: state.seq + 1, negotiations: [...state.negotiations, thread] }, thread };
}

export function setProviderCapabilities(
  state: CoordinationState,
  provider: EngineId,
  capabilities: CoordinationCapabilityState,
): CoordinationState {
  return { ...state, capabilities: { ...state.capabilities, [provider]: capabilities } };
}

export function setWorkspaceResources(state: CoordinationState, resources: WorkspaceResource[]): CoordinationState {
  return { ...state, resources: normalizeWorkspaceResources(resources) };
}

export function snapshotForCanvas(
  state: CoordinationState,
  canvasId: string,
  now = Date.now(),
  liveOwners?: ReadonlySet<string>,
): CoordinationSnapshot {
  const marked = markStaleClaims(state, now, liveOwners);
  return {
    canvasId,
    claims: marked.claims.filter((claim) => claim.canvasId === canvasId && claim.status !== 'released'),
    resourceClaims: marked.resourceClaims.filter((claim) => claim.canvasId === canvasId && claim.status !== 'released'),
    resources: marked.resources,
    intents: marked.intents.filter((intent) => intent.canvasId === canvasId),
    messages: marked.messages.filter((message) => message.canvasId === canvasId),
    negotiations: marked.negotiations.filter((thread) => thread.canvasId === canvasId),
    capabilities: marked.capabilities,
    now,
  };
}

/** A PROJECT-WIDE coordination snapshot: every canvas's live claims/messages/negotiations in one host (which
 * shares one workspace cwd). Used for the webview panel + agent context injection so boards coordinate ACROSS
 * canvases. `canvasId` is the recipient (display) canvas; each row carries its own `canvasId` for attribution. */
export function projectSnapshot(
  state: CoordinationState,
  canvasId: string,
  now = Date.now(),
  liveOwners?: ReadonlySet<string>,
): CoordinationSnapshot {
  const marked = markStaleClaims(state, now, liveOwners);
  return {
    canvasId,
    claims: marked.claims.filter((claim) => claim.status !== 'released'),
    resourceClaims: marked.resourceClaims.filter((claim) => claim.status !== 'released'),
    resources: marked.resources,
    intents: marked.intents,
    messages: marked.messages,
    negotiations: marked.negotiations,
    capabilities: marked.capabilities,
    now,
  };
}
