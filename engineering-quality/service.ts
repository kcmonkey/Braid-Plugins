import * as nodePath from 'path';
import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServicePlugin,
  ToolMiddlewareContext,
  ToolMiddlewarePlugin,
  ToolResultMiddlewareContext,
} from '../../../src/plugin-api/types';
import type {
  ExpectStanceProcessEvidence,
  ObligationLedgerEvent,
  ObligationTarget,
} from '../../../src/obligations';
import {
  createEngineeringAgentTools,
  manifest,
  type EngineeringChangeKind,
  type EngineeringExpectRequest,
  type EngineeringReviewKind,
  type EngineeringRisk,
} from './agentTool';

const TOOL_ID = 'braid.engineering_expect';
const PROCESS_SOURCE = 'engineering-closeout';
const PLUGIN_ID = 'engineering-quality';

const CHANGE_KINDS = new Set<EngineeringChangeKind>(['bugfix', 'feature', 'refactor', 'config', 'test', 'other']);
const RISKS = new Set<EngineeringRisk>(['low', 'medium', 'high']);
const REVIEW_KINDS = new Set<EngineeringReviewKind>(['self', 'independent', 'not-needed']);
const RISK_RANK: Record<EngineeringRisk, number> = { low: 0, medium: 1, high: 2 };

const MUTATION_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'filechange', 'patch', 'apply_patch']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search']);
const NON_ENGINEERING_EXTENSIONS = new Set([
  '.md', '.mdx', '.rst', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.tsv',
  '.mp3', '.wav', '.flac', '.mp4', '.mov', '.webm',
  '.glb', '.gltf', '.obj', '.fbx',
]);
const HIGH_RISK_PATH = /(^|\/)(?:src\/)?(?:engine|auth|accounts?|sessions?|persistence|migrations?|schema|protocol|obligations?|coordination|runtime)(?:\/|\.|$)/i;
const VERIFICATION_COMMAND = /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|build|lint|typecheck|check)\b|(?:npx\s+)?(?:vitest|jest|tsc|eslint)\b|pytest\b|python\s+-m\s+pytest\b|go\s+test\b|cargo\s+(?:test|check|clippy)\b|dotnet\s+test\b|mvnw?\s+test\b|gradlew?\s+test\b|make\s+(?:test|check)\b)/i;
const SEARCH_COMMAND = /(?:^|[;&|]\s*)(?:rg|grep|git\s+grep|findstr|fd|find|select-string)\b/i;

type PendingToolKind = 'mutation' | 'search' | 'verification' | 'reviewer-spawn' | 'agent-reports';

interface PendingTool {
  kind: PendingToolKind;
  mutationSerial: number;
  command?: string;
  paths?: string[];
}

interface EngineeringTurnState {
  target: ObligationTarget;
  obligationId?: string;
  attachError?: string;
  obligationOrdinal: number;
  mutationSerial: number;
  changedPaths: Set<string>;
  pendingTools: Map<string, PendingTool>;
  successfulSearchMutationSerial?: number;
  verificationPasses: Set<string>;
  verificationMutationSerial?: number;
  reviewerSpawnMutationSerial?: number;
  reviewerHandles: Set<string>;
  independentReviewMutationSerial?: number;
  readyMutationSerial?: number;
  lastStanceTurnIndex?: number;
  recordedProcessEvidence: Map<string, string>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizedToolName(toolName: string): string {
  const raw = toolName.trim().toLowerCase();
  const doubleUnderscore = raw.split('__').filter(Boolean);
  const tail = doubleUnderscore.length > 1 ? doubleUnderscore[doubleUnderscore.length - 1] : raw;
  return tail.split(/[./:]/).filter(Boolean).at(-1) ?? tail;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function commandText(input: unknown): string | undefined {
  const value = inputRecord(input).command ?? inputRecord(input).cmd ?? inputRecord(input).script;
  if (typeof value === 'string') return nonEmpty(value);
  if (Array.isArray(value)) return nonEmpty(value.map((part) => String(part)).join(' '));
  return undefined;
}

function patchPaths(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gmi)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => Boolean(path));
}

function mutationPaths(input: unknown): string[] {
  const record = inputRecord(input);
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().replace(/\\/g, '/');
    if (normalized) out.add(normalized);
  };
  add(record.file_path);
  add(record.path);
  add(record.notebook_path);
  if (Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (!change || typeof change !== 'object') continue;
      add((change as Record<string, unknown>).path);
      add((change as Record<string, unknown>).file_path);
    }
  }
  for (const path of patchPaths(record.patch)) add(path);
  return [...out];
}

function engineeringRelevantPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return false;
  const ext = nodePath.extname(normalized).toLowerCase();
  return !NON_ENGINEERING_EXTENSIONS.has(ext);
}

function verificationCommand(input: unknown): string | undefined {
  const command = commandText(input);
  return command && VERIFICATION_COMMAND.test(command) ? command : undefined;
}

function isSearchUse(toolName: string, input: unknown): boolean {
  if (SEARCH_TOOLS.has(normalizedToolName(toolName))) return true;
  const record = inputRecord(input);
  if (record.action === 'search' || record.action === 'list') return true;
  const command = commandText(input);
  return Boolean(command && SEARCH_COMMAND.test(command));
}

function isReviewerSpawn(toolName: string, input: unknown): boolean {
  if (normalizedToolName(toolName) !== 'spawn_agent') return false;
  return String(inputRecord(input).profile ?? '').trim().toLowerCase() === 'reviewer';
}

function reviewerHandle(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { handle?: unknown };
    return typeof parsed.handle === 'string' ? nonEmpty(parsed.handle) : undefined;
  } catch {
    return undefined;
  }
}

function reviewerReportPresent(content: string, handles: ReadonlySet<string>): boolean {
  try {
    const parsed = JSON.parse(content) as { children?: unknown[] };
    return Array.isArray(parsed.children) && parsed.children.some((value) => {
      if (!value || typeof value !== 'object') return false;
      const child = value as Record<string, unknown>;
      const profile = child.profile && typeof child.profile === 'object'
        ? String((child.profile as Record<string, unknown>).name ?? '')
        : String(child.profile ?? '');
      const handle = String(child.handle ?? '');
      const status = String(child.status ?? '').toLowerCase();
      return handles.has(handle)
        && profile.toLowerCase() === 'reviewer'
        && (status === 'reported' || status === 'satisfied')
        && Boolean(child.reportRef);
    });
  } catch {
    return false;
  }
}

function minimumRisk(state: EngineeringTurnState): EngineeringRisk {
  if (state.changedPaths.size >= 5 || [...state.changedPaths].some((path) => HIGH_RISK_PATH.test(path))) return 'high';
  if (state.changedPaths.size >= 2) return 'medium';
  return 'low';
}

function evidenceItems(changeKind: EngineeringChangeKind, risk: EngineeringRisk, reviewKind: EngineeringReviewKind): ExpectStanceProcessEvidence[] {
  const items: ExpectStanceProcessEvidence[] = [
    { type: 'source-change', count: 1 },
    { type: 'verification-pass', count: 1 },
  ];
  if (changeKind === 'bugfix') items.push({ type: 'related-surface-search', count: 1 });
  if (risk === 'high' || reviewKind === 'independent') items.push({ type: 'independent-review', count: 1 });
  return items;
}

function evidenceSignature(items: ExpectStanceProcessEvidence[]): string {
  return items.map((item) => `${item.type}:${item.count ?? 1}`).sort().join('|');
}

function stateKey(canvasId: string, boardId: string): string {
  return `${canvasId}\0${boardId}`;
}

function toolKey(turnIndex: number, toolUseId: string): string {
  return `${turnIndex}\0${toolUseId}`;
}

class EngineeringQualityHostService implements HostService {
  id = 'engineering-quality.hostService';
  label = 'Engineering Quality Host Service';
  manifest = manifest;
  private readonly states = new Map<string, EngineeringTurnState>();

  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}

  agentTools() {
    return createEngineeringAgentTools({ expect: (ctx, req) => this.handleExpect(ctx, req) });
  }

  toolMiddleware(): ToolMiddlewarePlugin[] {
    return [{
      id: 'engineering-quality.observer',
      label: 'Engineering Quality Observer',
      manifest,
      observeToolUse: (ctx) => this.observeToolUse(ctx),
      observeToolResult: (ctx) => this.observeToolResult(ctx),
    }];
  }

  onRunError(event: HostRunBoardEvent): void {
    this.interruptState(event);
  }

  onBoardAbort(event: HostRunBoardEvent): void {
    this.interruptState(event);
  }

  onCanvasClose(canvasId: string): void {
    for (const key of this.states.keys()) {
      if (key.startsWith(`${canvasId}\0`)) this.states.delete(key);
    }
  }

  private interruptState(event: Pick<HostRunBoardEvent, 'canvasId' | 'boardId'>): void {
    const key = stateKey(event.canvasId, event.boardId);
    const state = this.states.get(key);
    if (!state) return;
    state.pendingTools.clear();
    if (!state.changedPaths.size) this.states.delete(key);
  }

  private newState(ctx: Pick<ToolMiddlewareContext, 'canvasId' | 'boardId' | 'turnIndex'>): EngineeringTurnState {
    return {
      target: { canvasId: ctx.canvasId, boardId: ctx.boardId, turnIndex: ctx.turnIndex! },
      obligationOrdinal: 1,
      mutationSerial: 0,
      changedPaths: new Set(),
      pendingTools: new Map(),
      verificationPasses: new Set(),
      reviewerHandles: new Set(),
      recordedProcessEvidence: new Map(),
    };
  }

  private stateForObservation(ctx: Pick<ToolMiddlewareContext, 'canvasId' | 'boardId' | 'turnIndex'>): EngineeringTurnState {
    const key = stateKey(ctx.canvasId, ctx.boardId);
    const existing = this.states.get(key);
    if (!existing || (existing.lastStanceTurnIndex !== undefined && ctx.turnIndex! > existing.lastStanceTurnIndex)) {
      const fresh = this.newState(ctx);
      this.states.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  private stateForToolCall(
    ctx: Pick<AgentToolContext, 'canvasId' | 'boardId' | 'turnIndex'>,
    status: string | undefined,
  ): EngineeringTurnState | undefined {
    const key = stateKey(ctx.canvasId, ctx.boardId);
    const state = this.states.get(key);
    if (state?.lastStanceTurnIndex !== undefined && ctx.turnIndex > state.lastStanceTurnIndex) {
      if (status === 'not-ready' && state.readyMutationSerial !== undefined) return state;
      this.states.delete(key);
      return undefined;
    }
    return state;
  }

  private obligationBaseId(state: EngineeringTurnState): string {
    return `engineering.closeout.${state.target.boardId}.${state.target.turnIndex}`;
  }

  private ensureBinding(state: EngineeringTurnState): void {
    if (state.obligationId || state.attachError) return;
    if (!this.host.attachBinding) {
      state.attachError = 'Engineering Quality requires the host obligation binding API.';
      return;
    }
    const base = this.obligationBaseId(state);
    const id = state.obligationOrdinal === 1 ? base : `${base}.recheck-${state.obligationOrdinal}`;
    const attached = this.host.attachBinding({
      bindingId: id,
      recipeId: 'engineering-closeout',
      source: {
        pluginId: PLUGIN_ID,
        kind: 'engineering-quality',
        label: 'Engineering Quality',
        id: TOOL_ID,
        ref: state.target.boardId,
      },
      target: state.target,
      params: {
        id,
        stanceToolId: TOOL_ID,
        processSource: PROCESS_SOURCE,
        maxRepairs: 2,
        permissionMode: 'bypassPermissions',
      },
    });
    if (attached.error) state.attachError = attached.error;
    else state.obligationId = attached.obligationId;
  }

  private openRecheck(state: EngineeringTurnState): void {
    state.obligationOrdinal += 1;
    state.obligationId = undefined;
    state.attachError = undefined;
    state.readyMutationSerial = undefined;
    this.ensureBinding(state);
  }

  private rearmAfterReady(state: EngineeringTurnState): void {
    if (state.readyMutationSerial === undefined) return;
    this.openRecheck(state);
  }

  private observeToolUse(ctx: ToolMiddlewareContext): void {
    if (ctx.source !== 'observed' || typeof ctx.turnIndex !== 'number') return;
    const name = normalizedToolName(ctx.toolName);
    const paths = MUTATION_TOOLS.has(name) ? mutationPaths(ctx.input).filter(engineeringRelevantPath) : [];
    const command = verificationCommand(ctx.input);
    const search = isSearchUse(ctx.toolName, ctx.input);
    const reviewerSpawn = isReviewerSpawn(ctx.toolName, ctx.input);
    const reports = name === 'agent_reports';
    if (!paths.length && !command && !search && !reviewerSpawn && !reports) return;

    const state = this.stateForObservation(ctx);
    let pending: PendingTool | undefined;
    if (paths.length) {
      pending = { kind: 'mutation', mutationSerial: state.mutationSerial, paths };
    } else if (command) {
      pending = { kind: 'verification', mutationSerial: state.mutationSerial, command };
    } else if (reviewerSpawn) {
      pending = { kind: 'reviewer-spawn', mutationSerial: state.mutationSerial };
    } else if (reports) {
      pending = { kind: 'agent-reports', mutationSerial: state.mutationSerial };
    } else if (search) {
      pending = { kind: 'search', mutationSerial: state.mutationSerial };
    }
    if (pending && ctx.toolUseId) state.pendingTools.set(toolKey(ctx.turnIndex, ctx.toolUseId), pending);
  }

  private observeToolResult(ctx: ToolResultMiddlewareContext): void {
    if (ctx.append) return;
    const state = this.states.get(stateKey(ctx.canvasId, ctx.boardId));
    if (!state) return;
    const pending = state.pendingTools.get(toolKey(ctx.turnIndex, ctx.toolUseId));
    if (!pending) return;
    state.pendingTools.delete(toolKey(ctx.turnIndex, ctx.toolUseId));
    if (ctx.isError) return;
    switch (pending.kind) {
      case 'mutation':
        this.rearmAfterReady(state);
        state.mutationSerial += 1;
        for (const path of pending.paths ?? []) state.changedPaths.add(path);
        state.successfulSearchMutationSerial = undefined;
        state.verificationPasses.clear();
        state.verificationMutationSerial = undefined;
        state.reviewerSpawnMutationSerial = undefined;
        state.reviewerHandles.clear();
        state.independentReviewMutationSerial = undefined;
        this.ensureBinding(state);
        return;
      case 'search':
        if (pending.mutationSerial === state.mutationSerial) {
          state.successfulSearchMutationSerial = pending.mutationSerial;
        }
        return;
      case 'verification':
        if (pending.mutationSerial === state.mutationSerial) {
          state.verificationPasses.add(pending.command ?? 'verification');
          state.verificationMutationSerial = pending.mutationSerial;
        }
        return;
      case 'reviewer-spawn':
        if (pending.mutationSerial === state.mutationSerial) {
          const handle = reviewerHandle(ctx.content);
          if (handle) {
            state.reviewerSpawnMutationSerial = pending.mutationSerial;
            state.reviewerHandles.add(handle);
          }
        }
        return;
      case 'agent-reports':
        if (pending.mutationSerial === state.mutationSerial
          && state.reviewerSpawnMutationSerial === pending.mutationSerial
          && reviewerReportPresent(ctx.content, state.reviewerHandles)) {
          state.independentReviewMutationSerial = pending.mutationSerial;
        }
        return;
    }
  }

  private record(event: ObligationLedgerEvent): void {
    this.host.recordObligationEvent?.(event);
  }

  private validationError(state: EngineeringTurnState, req: EngineeringExpectRequest): {
    error?: string;
    changeKind?: EngineeringChangeKind;
    risk?: EngineeringRisk;
    reviewKind?: EngineeringReviewKind;
  } {
    const changeKindRaw = nonEmpty(req.changeKind)?.toLowerCase() as EngineeringChangeKind | undefined;
    const riskRaw = nonEmpty(req.risk)?.toLowerCase() as EngineeringRisk | undefined;
    const reviewKindRaw = nonEmpty(req.reviewKind)?.toLowerCase() as EngineeringReviewKind | undefined;
    if (!changeKindRaw || !CHANGE_KINDS.has(changeKindRaw)) return { error: 'engineering_expect status:"ready" requires a valid changeKind.' };
    if (!riskRaw || !RISKS.has(riskRaw)) return { error: 'engineering_expect status:"ready" requires risk:"low", "medium", or "high".' };
    if (!reviewKindRaw || !REVIEW_KINDS.has(reviewKindRaw)) return { error: 'engineering_expect status:"ready" requires reviewKind:"self" or "independent".' };
    for (const [field, value] of [['impact', req.impact], ['regression', req.regression], ['review', req.review], ['verification', req.verification]] as const) {
      if (!nonEmpty(value)) return { error: `engineering_expect status:"ready" requires a non-empty ${field} assessment.` };
    }
    const floor = minimumRisk(state);
    if (RISK_RANK[riskRaw] < RISK_RANK[floor]) {
      return { error: `Observed paths require at least risk:"${floor}"; reassess blast radius before declaring ready.` };
    }
    if (reviewKindRaw === 'not-needed') {
      return { error: 'Source-changing ready stances require self or independent code review; reviewKind:"not-needed" is not valid.' };
    }
    if (state.verificationMutationSerial !== state.mutationSerial || !state.verificationPasses.size) {
      return { error: 'engineering_expect status:"ready" requires a successful verification command result after the latest source change.' };
    }
    if (changeKindRaw === 'bugfix' && state.successfulSearchMutationSerial !== state.mutationSerial) {
      return { error: 'Bugfix readiness requires a successful related-surface search for sibling implementations, callers, or the same invariant.' };
    }
    if (riskRaw === 'high' || reviewKindRaw === 'independent') {
      if (reviewKindRaw !== 'independent' || state.independentReviewMutationSerial !== state.mutationSerial) {
        return { error: 'High-risk readiness requires an independent Reviewer report gathered after the latest source change.' };
      }
    }
    return { changeKind: changeKindRaw, risk: riskRaw, reviewKind: reviewKindRaw };
  }

  private async handleExpect(ctx: AgentToolContext, req: EngineeringExpectRequest) {
    if (ctx.signal.aborted) return { ok: false, result: 'Engineering readiness expectation canceled.' };
    const status = nonEmpty(req.status)?.toLowerCase();
    const state = this.stateForToolCall(ctx, status);

    if (status === 'not-applicable') {
      const reason = nonEmpty(req.reason);
      if (!reason) return { ok: false, result: 'engineering_expect status:"not-applicable" requires a non-empty reason.' };
      if (state?.changedPaths.size) {
        return { ok: false, result: 'engineering_expect cannot be not-applicable after source or executable configuration changes were observed.' };
      }
      return { ok: true, result: JSON.stringify({ status, reason }) };
    }

    if (status !== 'ready' && status !== 'not-ready') {
      return { ok: false, result: 'engineering_expect requires status:"ready", status:"not-ready", or status:"not-applicable".' };
    }
    if (!state || !state.changedPaths.size) {
      return { ok: false, result: 'engineering_expect has no observed source-changing turn to assess.' };
    }
    this.ensureBinding(state);
    if (state.attachError || !state.obligationId) {
      return { ok: false, result: state.attachError ?? 'Engineering closeout obligation could not be attached.' };
    }

    if (status === 'not-ready') {
      const reason = nonEmpty(req.reason);
      if (!reason) return { ok: false, result: 'engineering_expect status:"not-ready" requires concrete remaining work in reason.' };
      const revisingReadyStance = state.readyMutationSerial !== undefined;
      this.record({
        type: 'expect-stance-decided',
        obligationId: state.obligationId,
        target: state.target,
        toolId: TOOL_ID,
        decision: { kind: 'not-yet', option: 'not-ready', reason },
      });
      state.readyMutationSerial = undefined;
      if (revisingReadyStance) {
        this.openRecheck(state);
        state.lastStanceTurnIndex = undefined;
        if (state.attachError || !state.obligationId) {
          return { ok: false, result: `The not-ready stance was recorded, but a fresh engineering recheck could not be attached: ${state.attachError ?? 'unknown attachment failure'}` };
        }
      } else {
        state.lastStanceTurnIndex = ctx.turnIndex;
      }
      return {
        ok: true,
        result: JSON.stringify({
          status,
          reason,
          changedPaths: [...state.changedPaths].sort(),
          ...(revisingReadyStance ? { recheckObligationId: state.obligationId } : {}),
        }),
      };
    }

    const validation = this.validationError(state, req);
    if (validation.error || !validation.changeKind || !validation.risk || !validation.reviewKind) {
      return { ok: false, result: validation.error ?? 'Engineering readiness could not be validated.' };
    }
    const items = evidenceItems(validation.changeKind, validation.risk, validation.reviewKind);
    const signature = evidenceSignature(items);
    const recorded = state.recordedProcessEvidence.get(state.obligationId);
    if (recorded && recorded !== signature) {
      return { ok: false, result: 'engineering_expect evidence requirements changed after ready; make the needed source change or use status:"not-ready" before reassessing.' };
    }
    if (!recorded) {
      this.record({
        type: 'expect-stance-process-evidence-observed',
        obligationId: state.obligationId,
        target: state.target,
        source: PROCESS_SOURCE,
        items,
      });
      state.recordedProcessEvidence.set(state.obligationId, signature);
    }
    const summary = [
      `changeKind=${validation.changeKind}`,
      `risk=${validation.risk}`,
      `impact=${nonEmpty(req.impact)}`,
      `regression=${nonEmpty(req.regression)}`,
      `review=${nonEmpty(req.review)}`,
      `verification=${nonEmpty(req.verification)}`,
    ].join('; ');
    this.record({
      type: 'expect-stance-decided',
      obligationId: state.obligationId,
      target: state.target,
      toolId: TOOL_ID,
      decision: { kind: 'positive', option: 'ready', expected: items, reason: summary.slice(0, 2400) },
    });
    state.readyMutationSerial = state.mutationSerial;
    state.lastStanceTurnIndex = ctx.turnIndex;
    return {
      ok: true,
      result: JSON.stringify({
        status,
        changeKind: validation.changeKind,
        risk: validation.risk,
        reviewKind: validation.reviewKind,
        changedPaths: [...state.changedPaths].sort(),
        verificationCommands: [...state.verificationPasses],
        evidence: items,
      }, null, 2),
    };
  }
}

export const engineeringQualityHostServicePlugin: HostServicePlugin = {
  id: 'engineering-quality.hostService',
  label: 'Engineering Quality Host Service',
  manifest,
  create(ctx) {
    return new EngineeringQualityHostService(ctx);
  },
};
