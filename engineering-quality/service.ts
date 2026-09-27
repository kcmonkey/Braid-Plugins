import * as path from 'path';
import type { AgentToolContext, HostRunBoardEvent, HostService, HostServicePlugin, ToolMiddlewareContext, ToolMiddlewarePlugin, ToolResultMiddlewareContext } from '../../../src/plugin-api/types';
import { isDefiniteSourceMutationUse, isKnownNonMutatingWorkspaceTool, normalizeToolName } from '../../../src/plugin-api/toolSemantics';
import type { ChangeEvidenceProjection } from '../../../src/changeEvidence/types';
import type { ExpectStanceProcessEvidence, ObligationLedgerEvent, ObligationTarget } from '../../../src/obligations';
import { createEngineeringAgentTools, manifest, type EngineeringApproach, type EngineeringArchitectureSignal, type EngineeringChangeKind, type EngineeringExpectRequest, type EngineeringReassessmentDisposition, type EngineeringReviewKind, type EngineeringRisk } from './agentTool';

const TOOL_ID = 'braid.engineering_expect';
const PROCESS_SOURCE = 'engineering-closeout';
const PLUGIN_ID = 'engineering-quality';
const KINDS = new Set<EngineeringChangeKind>(['bugfix', 'feature', 'refactor', 'config', 'test', 'other']);
const RISKS = new Set<EngineeringRisk>(['low', 'medium', 'high']);
const REVIEWS = new Set<EngineeringReviewKind>(['self', 'independent', 'not-needed']);
const SIGNALS = new Set<EngineeringArchitectureSignal>(['none', 'ownership', 'shared-state', 'lifecycle', 'concurrency', 'public-contract', 'permission', 'extensibility']);
const APPROACHES = new Set<EngineeringApproach>(['evidence-only', 'localized', 'narrow-refactor', 'replacement']);
const DISPOSITIONS = new Set<EngineeringReassessmentDisposition>(['retain', 'revise', 'remove']);
const NON_ENGINEERING = new Set(['.md', '.mdx', '.rst', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.tsv', '.mp3', '.wav', '.flac', '.mp4', '.mov', '.webm', '.glb', '.gltf', '.obj', '.fbx']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search']);
const SEARCH_COMMAND = /(?:^|[;&|]\s*)(?:rg|grep|findstr|fd|find|select-string)\b/i;
const VERIFY_COMMAND = /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|build|lint|typecheck|check)\b|(?:npx\s+)?(?:vitest|jest|tsc|eslint)\b|pytest\b|python\s+-m\s+pytest\b|go\s+test\b|cargo\s+(?:test|check|clippy)\b|dotnet\s+test\b|mvnw?\s+test\b|gradlew?\s+test\b|make\s+(?:test|check)\b)/i;

type Binding = { finalEvidenceId: string; currentnessToken: string };
type ObservedBinding = Binding & { observationOrder: number };
type PendingKind = 'search' | 'verification' | 'reviewer-spawn' | 'agent-reports';
type Pending = Binding & { kind: PendingKind; command?: string };
type Strategy = {
  revision: number; phase: 'current' | 'stale'; changeKind: EngineeringChangeKind; risk: EngineeringRisk;
  scopePaths: string[]; requiresMigrationProof: boolean; finalEvidenceBinding?: Binding; reassessmentObservationOrder?: number;
};
type State = {
  target: ObligationTarget; ordinal: number; obligationId?: string; attachError?: string;
  projection?: ChangeEvidenceProjection; pending: Map<string, Pending>; search?: ObservedBinding;
  verification: Map<string, ObservedBinding>; reviewerSpawn?: Binding; reviewerHandles: Set<string>;
  reviewerUnavailable?: Binding; reviewerUnavailableReason?: string; independentReview?: Binding;
  changeReview?: Binding; ready?: Binding; strategy?: Strategy; strategyRevision: number;
  evidence: Map<string, string>; observationOrder: number;
  /** F2: exact tool uses proven non-mutating at observation time (toolKey). */
  nonMutatingToolUses: Set<string>;
};

const text = (value: string | undefined) => value?.trim() || undefined;
const strings = (value: string[] | undefined) => [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const command = (value: unknown) => {
  const input = record(value); const raw = input.command ?? input.cmd ?? input.script;
  return typeof raw === 'string' ? text(raw) : Array.isArray(raw) ? text(raw.map(String).join(' ')) : undefined;
};
const surfaceIsEngineering = (surface: string) => Boolean(surface && !surface.endsWith('/') && !NON_ENGINEERING.has(path.extname(surface).toLowerCase()));
const key = (canvasId: string, boardId: string) => canvasId + '\0' + boardId;
type ExecutionScope = Pick<ToolMiddlewareContext, 'canvasId' | 'boardId' | 'turnIndex' | 'agentId'>;
const scopeKey = (ctx: ExecutionScope): string => {
  if (ctx.canvasId && ctx.boardId) return key(ctx.canvasId, ctx.boardId);
  if (ctx.agentId) return '\0agent\0' + ctx.agentId;
  throw new Error('Engineering evidence needs an exact Agent or Board-turn target.');
};
const toolKey = (turnIndex: number, toolUseId: string) => String(turnIndex) + '\0' + toolUseId;
const binding = (projection?: ChangeEvidenceProjection): Binding | undefined => projection ? { finalEvidenceId: projection.finalEvidence.finalEvidenceId, currentnessToken: projection.finalEvidence.currentnessToken } : undefined;
const same = (left?: Binding, right?: Binding) => Boolean(left && right && left.finalEvidenceId === right.finalEvidenceId && left.currentnessToken === right.currentnessToken);
const missingResult = (items: string[]) => ['engineering_expect status:"ready" blocked. Missing:', ...items.map((item, i) => String(i + 1) + '. ' + item), 'Do every missing item, then call status:"ready" once. Green verification never substitutes for final change review.'].join('\n');
function scopePath(cwd: string, value: string): string | undefined {
  const raw = value.trim(); if (!raw || path.isAbsolute(raw)) return undefined;
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, raw));
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? undefined : relative.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || undefined;
}
const covered = (candidate: string, scopes: readonly string[]) => scopes.some((scope) => candidate === scope || candidate.startsWith(scope + '/'));
function preflightPaths(value: unknown): string[] {
  const input = record(value); const paths = new Set<string>();
  const add = (entry: unknown) => { if (typeof entry === 'string' && entry.trim() && !path.isAbsolute(entry)) paths.add(entry.trim().replace(/\\/g, '/').replace(/^\.\//, '')); };
  add(input.file_path); add(input.filePath); add(input.path); add(input.notebook_path);
  if (Array.isArray(input.changes)) for (const change of input.changes) { const item = record(change); add(item.file_path); add(item.filePath); add(item.path); }
  return [...paths];
}
function isSearch(toolName: string, input: unknown): boolean { const raw = command(input); return SEARCH_TOOLS.has(normalizeToolName(toolName)) || record(input).action === 'search' || record(input).action === 'list' || Boolean(raw && SEARCH_COMMAND.test(raw)); }
function isVerification(input: unknown): string | undefined { const raw = command(input); return raw && !/(?:&&|\|\||;|\||\r?\n|[<>]|\$\(|\x60)/.test(raw) && VERIFY_COMMAND.test(raw) ? raw : undefined; }
function isReviewerSpawn(toolName: string, input: unknown): boolean { return normalizeToolName(toolName) === 'spawn_agent' && String(record(input).profile ?? '').toLowerCase() === 'reviewer'; }
function reportHandle(content: string): string | undefined { try { const result = JSON.parse(content) as { handle?: unknown }; return typeof result.handle === 'string' ? text(result.handle) : undefined; } catch { return undefined; } }
function hasReviewerReport(content: string, handles: ReadonlySet<string>): boolean {
  try { const result = JSON.parse(content) as { children?: unknown[] }; return Boolean(result.children?.some((value) => { const child = record(value); const profile = typeof child.profile === 'object' ? String(record(child.profile).name ?? '') : String(child.profile ?? ''); const status = String(child.status ?? '').toLowerCase(); return handles.has(String(child.handle ?? '')) && profile.toLowerCase() === 'reviewer' && (status === 'reported' || status === 'satisfied') && Boolean(child.reportRef); })); } catch { return false; }
}
const reviewerUnavailable = (content: string) => /blocked|unavailable|not in provider|model catalog|cannot spawn|failed to spawn|is not in provider/.test(String(content).toLowerCase());
function items(review: EngineeringReviewKind, migration: boolean): ExpectStanceProcessEvidence[] {
  const out: ExpectStanceProcessEvidence[] = [{ type: 'source-change', count: 1 }, { type: 'engineering-strategy', count: 1 }, { type: 'related-surface-search', count: 1 }, { type: 'verification-pass', count: 1 }, { type: 'final-change-review', count: 1 }];
  if (migration) out.push({ type: 'authority-migration-proof', count: 1 }); if (review === 'independent') out.push({ type: 'independent-review', count: 1 }); return out;
}

class EngineeringQualityHostService implements HostService {
  id = 'engineering-quality.hostService'; label = 'Engineering Quality Host Service'; manifest = manifest;
  private readonly states = new Map<string, State>();
  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}
  agentTools() { return createEngineeringAgentTools({ expect: (ctx, request) => this.expect(ctx, request) }); }
  toolMiddleware(): ToolMiddlewarePlugin[] { return [{ id: 'engineering-quality.observer', label: 'Engineering Quality Observer', manifest, gateToolUse: (ctx) => this.gate(ctx), observeToolUse: (ctx) => this.observeUse(ctx), observeToolResult: (ctx) => this.observeResult(ctx) }]; }
  onRunError(event: HostRunBoardEvent) { this.states.get(key(event.canvasId, event.boardId))?.pending.clear(); }
  onBoardAbort(event: HostRunBoardEvent) { this.onRunError(event); }
  onCanvasClose(canvasId: string) { for (const stateKey of this.states.keys()) if (stateKey.startsWith(canvasId + '\0')) this.states.delete(stateKey); }
  private create(ctx: ExecutionScope): State { return { target: ctx.canvasId && ctx.boardId ? { canvasId: ctx.canvasId, boardId: ctx.boardId, turnIndex: ctx.turnIndex! } : { agentId: ctx.agentId, turnIndex: ctx.turnIndex! }, ordinal: 1, pending: new Map(), verification: new Map(), reviewerHandles: new Set(), strategyRevision: 0, evidence: new Map(), observationOrder: 0, nonMutatingToolUses: new Set() }; }
  private observed(ctx: ExecutionScope): State | undefined { if (typeof ctx.turnIndex !== 'number' || (!ctx.agentId && (!ctx.canvasId || !ctx.boardId))) return undefined; const stateKey = scopeKey(ctx); const state = this.states.get(stateKey); if (state?.target.turnIndex === ctx.turnIndex) return state; const fresh = this.create(ctx); this.states.set(stateKey, fresh); return fresh; }
  private current(ctx: ExecutionScope): State | undefined { const state = this.states.get(scopeKey(ctx)); return state?.target.turnIndex === ctx.turnIndex ? state : undefined; }
  private strategyState(ctx: ExecutionScope): State { const state = this.current(ctx); if (state) return state; const fresh = this.create(ctx); this.states.set(scopeKey(ctx), fresh); return fresh; }
  /** Projection is the only fact/currentness authority; every observation begins here. */
  private sync(state: State, projection?: ChangeEvidenceProjection) {
    if (!projection) return;
    const previous = state.projection;
    const before = binding(previous);
    const after = binding(projection);
    state.projection = projection;
    if (same(before, after)) return;
    state.search = undefined;
    state.verification.clear();
    state.reviewerSpawn = undefined;
    state.reviewerHandles.clear();
    state.reviewerUnavailable = undefined;
    state.reviewerUnavailableReason = undefined;
    state.independentReview = undefined;
    state.changeReview = undefined;
    if (!state.ready) return;
    // Ready must reopen only when the new identity reflects engineering-surface
    // work. Empty-ops opaque/effect:none evidence-gathering (post-ready vitest,
    // rg, foreign markers) advances currentness but must not mint a fresh
    // unstanced closeout obligation — that created an infinite settle repair loop.
    if (!this.shouldReopenReady(previous, projection)) {
      state.ready = after;
      state.changeReview = after;
      return;
    }
    state.ready = undefined;
    this.openRecheck(state);
  }

  /** True when projection advanced with engineering-surface-affecting receipts. */
  private shouldReopenReady(previous: ChangeEvidenceProjection | undefined, next: ChangeEvidenceProjection): boolean {
    if (!previous) return true;
    const prior = new Map(previous.receipts.map((receipt) => [receipt.receiptId, receipt]));
    for (const receipt of next.receipts) {
      const old = prior.get(receipt.receiptId);
      if (!old) {
        if (receipt.effect === 'none') continue;
        if (receipt.operations.some((operation) => surfaceIsEngineering(operation.surfaceId))) return true;
        continue;
      }
      if (
        old.effect === receipt.effect
        && old.unresolved === receipt.unresolved
        && old.operations.length === receipt.operations.length
        && old.operations.every((operation, index) => (
          operation.surfaceId === receipt.operations[index]?.surfaceId
          && operation.operation === receipt.operations[index]?.operation
        ))
      ) continue;
      if (receipt.effect === 'changed' || receipt.effect === 'may-have-changed') return true;
      if (receipt.operations.some((operation) => surfaceIsEngineering(operation.surfaceId))) return true;
    }
    return false;
  }

  private final(state: State) { return binding(state.projection); }
  private observedBinding(state: State, current: Binding): ObservedBinding { return { ...current, observationOrder: ++state.observationOrder }; }
  private surfaces(state: State) { return (state.projection?.finalEvidence.surfaces ?? []).map((entry) => entry.surfaceId).filter(surfaceIsEngineering).sort(); }
  private potentialMutation(state: State) { return Boolean(state.projection?.receipts.some((receipt) => receipt.effect !== 'none')); }
  /** F2: an unresolved receipt keeps not-applicable blocked unless its exact tool
   * use was proven a known non-mutating workspace read. Receipts without a
   * judgeable tool use (provider-host opaque, foreign invalidation) stay blocking. */
  private hasUnjudgedUnresolvedReceipts(state: State): boolean {
    const unresolved = state.projection?.finalEvidence.unresolvedReceiptIds ?? [];
    if (!unresolved.length) return false;
    const receipts = new Map((state.projection?.receipts ?? []).map((receipt) => [receipt.receiptId, receipt]));
    return unresolved.some((receiptId) => {
      const toolUseId = receipts.get(receiptId)?.toolUseId;
      return !toolUseId || !state.nonMutatingToolUses.has(toolKey(state.target.turnIndex, toolUseId));
    });
  }
  private gate(ctx: ToolMiddlewareContext) {
    const state = this.observed(ctx); if (state) this.sync(state, ctx.changeEvidence);
    if (ctx.source === 'observed' || !isDefiniteSourceMutationUse(ctx.toolName, ctx.input)) return { proceed: true as const };
    const paths = preflightPaths(ctx.input).filter(surfaceIsEngineering); if (!paths.length) return { proceed: true as const };
    if (!state?.strategy || state.strategy.phase === 'stale') return { deny: true as const, reason: 'Source mutation requires an accepted mutation-scoped Engineering Strategy. Inspect current source, then call engineering_expect status:"strategy" before editing.' };
    const outside = paths.filter((entry) => !covered(entry, state.strategy!.scopePaths)); if (!outside.length) return { proceed: true as const };
    state.strategy.phase = 'stale'; return { deny: true as const, reason: 'Source mutation is outside the declared strategy scope (' + outside.join(', ') + '). Revise engineering_expect status:"strategy" before retrying.' };
  }
  private ensureBinding(state: State) {
    if (state.obligationId || state.attachError) return;
    if (!this.host.attachBinding) { state.attachError = 'Engineering Quality requires the host obligation binding API.'; return; }
    const base = 'engineering.closeout.' + state.target.boardId + '.' + String(state.target.turnIndex);
    const id = state.ordinal === 1 ? base : base + '.recheck-' + String(state.ordinal);
    const result = this.host.attachBinding({ bindingId: id, recipeId: 'engineering-closeout', source: { pluginId: PLUGIN_ID, kind: 'engineering-quality', label: 'Engineering Quality', id: TOOL_ID, ref: state.target.boardId }, target: state.target, params: { id, stanceToolId: TOOL_ID, processSource: PROCESS_SOURCE, maxRepairs: 2, permissionMode: 'bypassPermissions' } });
    if (result.error) state.attachError = result.error; else state.obligationId = result.obligationId;
  }
  private openRecheck(state: State) { state.ordinal += 1; state.obligationId = undefined; state.attachError = undefined; this.ensureBinding(state); }
  private observeUse(ctx: ToolMiddlewareContext) {
    const state = this.observed(ctx); if (!state) return; this.sync(state, ctx.changeEvidence);
    if (ctx.source !== 'observed' || !ctx.toolUseId) return;
    // F2: remember which exact tool uses were provably bounded reads so a later
    // unresolved opaque receipt for that same use cannot wedge not-applicable.
    if (isKnownNonMutatingWorkspaceTool(ctx.toolName, ctx.input)) state.nonMutatingToolUses.add(toolKey(state.target.turnIndex, ctx.toolUseId));
    const current = this.final(state); if (!current) return;
    const pending = this.pendingFor(ctx.toolName, ctx.input, current);
    if (pending) state.pending.set(toolKey(state.target.turnIndex, ctx.toolUseId), pending);
  }
  private pendingFor(toolName: string, input: unknown, current: Binding): Pending | undefined {
    const verify = isVerification(input);
    return verify ? { kind: 'verification', command: verify, ...current }
      : isReviewerSpawn(toolName, input) ? { kind: 'reviewer-spawn', ...current }
        : normalizeToolName(toolName) === 'agent_reports' ? { kind: 'agent-reports', ...current }
          : isSearch(toolName, input) ? { kind: 'search', ...current } : undefined;
  }
  private settlePending(state: State, pending: Pending, content: string, isError: boolean) {
    const current = this.final(state); if (!same(pending, current)) return;
    if (isError) { if (pending.kind === 'reviewer-spawn') { state.reviewerUnavailable = current; state.reviewerUnavailableReason = String(content ?? 'Reviewer spawn failed').slice(0, 500); state.reviewerSpawn = undefined; state.reviewerHandles.clear(); state.independentReview = undefined; } return; }
    if (pending.kind === 'search') { state.search = this.observedBinding(state, current!); return; }
    if (pending.kind === 'verification') { state.verification.set(pending.command ?? 'verification', this.observedBinding(state, current!)); return; }
    if (pending.kind === 'reviewer-spawn') { const handle = reportHandle(content); if (handle) { state.reviewerSpawn = current; state.reviewerHandles.add(handle); state.reviewerUnavailable = undefined; state.reviewerUnavailableReason = undefined; } else if (reviewerUnavailable(content)) { state.reviewerUnavailable = current; state.reviewerUnavailableReason = String(content ?? '').slice(0, 500); state.reviewerHandles.clear(); state.reviewerSpawn = undefined; state.independentReview = undefined; } return; }
    if (same(state.reviewerSpawn, current) && hasReviewerReport(content, state.reviewerHandles)) state.independentReview = current;
  }
  /** Consume composite children only when the app projection proves their exact parent/child receipt linkage. */
  private observeNestedResults(state: State, ctx: ToolResultMiddlewareContext) {
    if (ctx.nestedToolObservationsComplete !== true || !Array.isArray(ctx.nestedToolObservations)) return;
    const current = this.final(state); const receipts = state.projection?.receipts;
    if (!current || !receipts) return;
    const parents = receipts.filter((receipt) => receipt.toolUseId === ctx.toolUseId && !receipt.parentReceiptId);
    if (parents.length !== 1) return;
    const parent = parents[0];
    const lastMutationSequence = receipts.reduce((last, receipt) => receipt.effect === 'none' ? last : Math.max(last, receipt.ledgerSequence), 0);
    const seen = new Set<string>();
    const accepted: Array<{ toolUseId: string; toolName: string; input: unknown; content: string; isError: boolean }> = [];
    for (const child of ctx.nestedToolObservations) {
      const childId = child?.use?.toolUseId?.trim();
      if (!childId || childId !== child?.result?.toolUseId?.trim() || !child.use.toolName?.trim() || child.result.append === true || seen.has(childId)) return;
      seen.add(childId);
      const matches = receipts.filter((receipt) => receipt.toolUseId === childId && receipt.parentReceiptId === parent.receiptId && receipt.provenance === 'composite-child');
      if (matches.length !== 1) return;
      const receipt = matches[0];
      if (receipt.ledgerSequence <= parent.ledgerSequence) return;
      if (receipt.outcome !== 'succeeded' || child.result.isError || receipt.effect !== 'none' || receipt.ledgerSequence <= lastMutationSequence) continue;
      accepted.push({ toolUseId: childId, toolName: child.use.toolName, input: child.use.input, content: child.result.content, isError: child.result.isError });
    }
    for (const child of accepted) {
      const pending = this.pendingFor(child.toolName, child.input, current);
      if (pending) this.settlePending(state, pending, child.content, child.isError);
    }
  }
  private observeResult(ctx: ToolResultMiddlewareContext) {
    if (ctx.append) return; const state = this.observed(ctx); if (!state) return; this.sync(state, ctx.changeEvidence);
    if (ctx.nestedToolObservationsComplete === true || ctx.nestedToolObservations !== undefined) { this.observeNestedResults(state, ctx); return; }
    const pending = state.pending.get(toolKey(ctx.turnIndex, ctx.toolUseId)); if (!pending) return; state.pending.delete(toolKey(ctx.turnIndex, ctx.toolUseId));
    this.settlePending(state, pending, ctx.content, ctx.isError);
  }
  private validStrategy(state: State, req: EngineeringExpectRequest): { error?: string; strategy?: Strategy } {
    const changeKind = text(req.changeKind)?.toLowerCase() as EngineeringChangeKind | undefined; const risk = text(req.risk)?.toLowerCase() as EngineeringRisk | undefined; const approach = text(req.approach)?.toLowerCase() as EngineeringApproach | undefined; const signals = strings(req.architectureSignals).map((entry) => entry.toLowerCase() as EngineeringArchitectureSignal); const requestedScopes = strings(req.scopePaths); const scopes = requestedScopes.map((entry) => scopePath(this.host.cwd(), entry)).filter((entry): entry is string => Boolean(entry)); const absent: string[] = [];
    if (!changeKind || !KINDS.has(changeKind)) absent.push('changeKind: use bugfix|feature|refactor|config|test|other');
    if (!risk || !RISKS.has(risk)) absent.push('risk: use low|medium|high');
    if (!approach || !APPROACHES.has(approach)) absent.push('approach: use evidence-only|localized|narrow-refactor|replacement');
    if (!signals.length || signals.some((entry) => !SIGNALS.has(entry)) || (signals.includes('none') && signals.length !== 1)) absent.push('architectureSignals: use supported signals; "none" cannot be combined');
    for (const [field, value] of [['problem', req.problem], ['rootCause', req.rootCause], ['owner', req.owner], ['verificationPlan', req.verificationPlan]] as const) if (!text(value)) absent.push(field + ': non-empty strategy assessment required');
    if (!strings(req.evidence).length) absent.push('evidence: at least one current locator required');
    if (!scopes.length || scopes.length !== requestedScopes.length) absent.push('scopePaths: workspace-relative paths inside the current workspace required');
    if (!strings(req.targetInvariants).length) absent.push('targetInvariants: at least one target invariant required');
    const structural = changeKind === 'refactor' || signals.some((entry) => entry !== 'none') || approach === 'narrow-refactor' || approach === 'replacement';
    if (!structural && !text(req.containment)) absent.push('containment: localized/evidence-only containment required');
    if (structural) { for (const [field, value] of [['boundary', req.boundary], ['failureBehavior', req.failureBehavior]] as const) if (!text(value)) absent.push(field + ': required for structural change'); if (!strings(req.consumers).length) absent.push('consumers: required for structural change'); if (strings(req.alternatives).length < 2) absent.push('alternatives: at least two required for structural change'); }
    const migration = approach === 'replacement' || Boolean(text(req.oldAuthority) || text(req.newAuthority)); if (migration) for (const [field, value] of [['oldAuthority', req.oldAuthority], ['newAuthority', req.newAuthority], ['migrationPlan', req.migrationPlan], ['positiveProofPlan', req.positiveProofPlan], ['negativeProofPlan', req.negativeProofPlan], ['rollback', req.rollback]] as const) if (!text(value)) absent.push(field + ': authority migration contract required');
    return absent.length || !changeKind || !risk ? { error: ['engineering_expect strategy blocked. Missing:', ...absent].join('\n') } : { strategy: { revision: 0, phase: 'current', changeKind, risk, scopePaths: scopes, requiresMigrationProof: migration } };
  }
  private strategy(ctx: AgentToolContext, req: EngineeringExpectRequest, status: 'strategy' | 'reassess') {
    const state = this.strategyState(ctx); const absent: string[] = []; const current = this.final(state);
    if (status === 'reassess') { const disposition = text(req.disposition)?.toLowerCase() as EngineeringReassessmentDisposition | undefined; if (!this.potentialMutation(state)) absent.push('reassessment-trigger: host-observed potentially mutating receipt required'); if (!disposition || !DISPOSITIONS.has(disposition)) absent.push('disposition: use retain|revise|remove'); if (!text(req.reassessment)) absent.push('reassessment: current change-evidence rationale required'); }
    const checked = this.validStrategy(state, req); if (checked.error) absent.push(checked.error);
    if (status === 'reassess' && checked.strategy) { const outside = this.surfaces(state).filter((entry) => !covered(entry, checked.strategy!.scopePaths)); if (outside.length) absent.push('strategy scope: canonical engineering surfaces outside proposed scope (' + outside.join(', ') + ')'); }
    if (absent.length || !checked.strategy) return { ok: false, result: ['engineering_expect status:"' + status + '" blocked. Missing:', ...absent].join('\n') };
    state.strategyRevision += 1; state.strategy = { ...checked.strategy, revision: state.strategyRevision, ...(current ? { finalEvidenceBinding: current } : {}), ...(status === 'reassess' ? { reassessmentObservationOrder: state.observationOrder } : {}) };
    return { ok: true, result: JSON.stringify({ status, strategyRevision: state.strategy.revision, ...current }, null, 2) };
  }
  private record(event: ObligationLedgerEvent) { this.host.recordObligationEvent?.(event); }
  private readyError(state: State, req: EngineeringExpectRequest): { error?: string; kind?: EngineeringChangeKind; risk?: EngineeringRisk; review?: EngineeringReviewKind } {
    const kind = text(req.changeKind)?.toLowerCase() as EngineeringChangeKind | undefined; const risk = text(req.risk)?.toLowerCase() as EngineeringRisk | undefined; const review = text(req.reviewKind)?.toLowerCase() as EngineeringReviewKind | undefined; const current = this.final(state); const absent: string[] = [];
    if (!kind || !KINDS.has(kind)) absent.push('changeKind: use bugfix|feature|refactor|config|test|other'); if (!risk || !RISKS.has(risk)) absent.push('risk: use low|medium|high'); if (!review || !REVIEWS.has(review) || review === 'not-needed') absent.push('reviewKind: source-changing ready requires self or independent');
    for (const [field, value] of [['impact', req.impact], ['regression', req.regression], ['review', req.review], ['verification', req.verification], ['changeReview', req.changeReview]] as const) if (!text(value)) absent.push(field + ': non-empty assessment required');
    if (!state.strategy || state.strategy.phase !== 'current') absent.push('engineering-strategy: current accepted strategy required'); else { if (req.strategyRevision !== state.strategy.revision) absent.push('strategyRevision: expected current revision ' + String(state.strategy.revision)); if (kind && kind !== state.strategy.changeKind) absent.push('changeKind: must match strategy'); if (risk && risk !== state.strategy.risk) absent.push('risk: must match strategy'); const outside = this.surfaces(state).filter((entry) => !covered(entry, state.strategy!.scopePaths)); if (outside.length) absent.push('engineering-strategy scope: canonical surfaces outside scope (' + outside.join(', ') + ')'); if (state.strategy.requiresMigrationProof) for (const [field, value] of [['migrationProof', req.migrationProof], ['positiveProof', req.positiveProof], ['negativeProof', req.negativeProof]] as const) if (!text(value)) absent.push(field + ': final authority migration proof required'); }
    if (!text(req.changeReview)) absent.push('final-change-review: non-empty assessment over the final change required');
    if (review === 'independent' && !same(state.independentReview, current)) absent.push(same(state.reviewerUnavailable, current) ? 'independent-review: Reviewer unavailable for current identity; use self or gather report' : 'independent-review: reported Reviewer result bound to current identity required');
    return absent.length || !kind || !risk || !review ? { error: missingResult(absent) } : { kind, risk, review };
  }
  private async expect(ctx: AgentToolContext, req: EngineeringExpectRequest) {
    if (ctx.signal.aborted) return { ok: false, result: 'Engineering readiness expectation canceled.' };
    const status = text(req.status)?.toLowerCase(); if (status === 'strategy' || status === 'reassess') return this.strategy(ctx, req, status);
    const state = this.current(ctx);
    if (status === 'not-applicable') { const reason = text(req.reason); if (!reason) return { ok: false, result: 'engineering_expect status:"not-applicable" requires a non-empty reason.' }; if (state && this.hasUnjudgedUnresolvedReceipts(state)) return { ok: false, result: 'engineering_expect cannot be not-applicable while applicability is opaque or incomplete.' }; if (state && this.surfaces(state).length) return { ok: false, result: 'engineering_expect cannot be not-applicable after canonical engineering surfaces were observed.' }; return { ok: true, result: JSON.stringify({ status, reason }) }; }
    if (status !== 'ready' && status !== 'not-ready') return { ok: false, result: 'engineering_expect requires status:"strategy", status:"reassess", status:"ready", status:"not-ready", or status:"not-applicable".' };
    if (!state || !this.potentialMutation(state) || (!this.surfaces(state).length && !state.projection?.finalEvidence.unresolvedReceiptIds.length)) return { ok: false, result: 'engineering_expect has no observed engineering-relevant source-changing turn to assess.' };
    this.ensureBinding(state); if (state.attachError || !state.obligationId) return { ok: false, result: state.attachError ?? 'Engineering closeout obligation could not be attached.' };
    if (status === 'not-ready') { const reason = text(req.reason); if (!reason) return { ok: false, result: 'engineering_expect status:"not-ready" requires concrete remaining work in reason.' }; this.record({ type: 'expect-stance-decided', obligationId: state.obligationId, target: state.target, toolId: TOOL_ID, decision: { kind: 'not-yet', option: 'not-ready', reason } }); state.ready = undefined; return { ok: true, result: JSON.stringify({ status, reason, changedPaths: this.surfaces(state) }) }; }
    const checked = this.readyError(state, req); if (checked.error || !checked.kind || !checked.risk || !checked.review) return { ok: false, result: checked.error ?? 'Engineering readiness could not be validated.' };
    const current = this.final(state); if (!current) return { ok: false, result: 'Engineering readiness requires current host change-evidence projection.' }; state.changeReview = current;
    const required = items(checked.review, state.strategy?.requiresMigrationProof ?? false); const signature = required.map((entry) => entry.type + ':' + String(entry.count ?? 1)).sort().join('|'); const existing = state.evidence.get(state.obligationId); if (existing && existing !== signature) return { ok: false, result: 'engineering_expect evidence requirements changed after ready; use status:"not-ready" before reassessing.' };
    if (!existing) { this.record({ type: 'expect-stance-process-evidence-observed', obligationId: state.obligationId, target: state.target, source: PROCESS_SOURCE, items: required }); state.evidence.set(state.obligationId, signature); }
    const summary = ['changeKind=' + checked.kind, 'risk=' + checked.risk, 'strategyRevision=' + String(state.strategy?.revision), 'finalEvidenceId=' + current.finalEvidenceId, 'currentnessToken=' + current.currentnessToken, 'impact=' + text(req.impact), 'regression=' + text(req.regression), 'review=' + text(req.review), 'changeReview=' + text(req.changeReview), 'verification=' + text(req.verification)].join('; ');
    this.record({ type: 'expect-stance-decided', obligationId: state.obligationId, target: state.target, toolId: TOOL_ID, decision: { kind: 'positive', option: 'ready', expected: required, reason: summary.slice(0, 2400) } });
    state.ready = current; return { ok: true, result: JSON.stringify({ status, changeKind: checked.kind, risk: checked.risk, reviewKind: checked.review, strategyRevision: state.strategy?.revision, ...current, changedPaths: this.surfaces(state), verificationCommands: [...state.verification.entries()].filter(([, entry]) => same(entry, current)).map(([entry]) => entry), evidence: required }, null, 2) };
  }
}
export const engineeringQualityHostServicePlugin: HostServicePlugin = { id: 'engineering-quality.hostService', label: 'Engineering Quality Host Service', manifest, create(ctx) { return new EngineeringQualityHostService(ctx); } };
