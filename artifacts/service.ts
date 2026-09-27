import * as path from 'path';
import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServicePlugin,
  HostTurnSettledEvent,
  ArtifactTypeDescriptor,
  PluginManifest,
  ToolMiddlewareContext,
  ToolMiddlewarePlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ObligationLedgerEvent, ObligationTarget } from '../../../src/obligations';
import { createArtifactAgentTools, type ArtifactDeclareToolRequest, type ArtifactExpectToolRequest, type ArtifactTypesToolRequest } from './agentTool';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;
const DEFAULT_MIME = 'text/markdown';
const ARTIFACT_PRODUCER_TOOLS = new Map<string, string>([
  ['image_generate', 'image'],
  ['video_generate', 'video'],
  ['speech_generate', 'audio'],
  ['sound_effect_generate', 'audio'],
  ['music_generate', 'audio'],
  ['audio_generate', 'audio'],
  ['model_generate', 'model-3d'],
]);
type FileStorageMode = 'external-ref' | 'born';
type DeliverableCandidate = {
  path: string;
  toolName: string;
};

export interface ArtifactTypeRegistryView {
  readonly metaDataType: string;
  descriptors(options?: { includeSchema?: boolean }): readonly ArtifactTypeDescriptor[];
  resolve(dataType?: string, options?: { includeSchema?: boolean }): {
    descriptor: ArtifactTypeDescriptor;
    exact: boolean;
    requestedDataType: string;
  };
}

function turnCandidateKey(canvasId: string, boardId: string, turnIndex: number): string {
  return `${canvasId}::${boardId}::${turnIndex}`;
}

function boardPrefix(canvasId: string, boardId: string): string {
  return `${canvasId}::${boardId}::`;
}

function canvasPrefix(canvasId: string): string {
  return `${canvasId}::`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFileStorageMode(value: string | undefined): FileStorageMode | undefined {
  const trimmed = value?.trim();
  return trimmed === 'external-ref' || trimmed === 'born' ? trimmed : undefined;
}

function normalizeWorkspacePath(cwd: string, value: string): string | undefined {
  let candidate = value.trim();
  if (!candidate) return undefined;
  if (path.isAbsolute(candidate)) {
    const rel = path.relative(cwd, candidate);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    candidate = rel;
  }
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  return normalized;
}

function looksLikePathKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return normalized === 'path'
    || normalized === 'filepath'
    || normalized === 'filename'
    || normalized === 'targetfile'
    || normalized === 'file';
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isObservedOutputTool(toolName: string): boolean {
  const name = normalizedToolName(toolName);
  if (!name) return true;
  if (name === 'edit' || name === 'multiedit' || name === 'notebookedit') return false;
  if (name === 'read' || name === 'grep' || name === 'glob' || name === 'ls') return false;
  if (name.includes('read') || name.includes('grep') || name.includes('glob')) return false;
  if (name.includes('bash') || name.includes('shell') || name.includes('terminal')) return false;
  return true;
}

function isFileChangeTool(toolName: string): boolean {
  return normalizedToolName(toolName) === 'filechange';
}

function artifactProducerTool(toolName: string): { toolName: string; dataType: string } | undefined {
  const raw = toolName.trim();
  const direct = ARTIFACT_PRODUCER_TOOLS.get(raw);
  if (direct) return { toolName: raw, dataType: direct };
  const parts = raw.split('__');
  if (parts.length >= 3 && parts[0] === 'agent' && parts[1] === 'braid') {
    const dataType = ARTIFACT_PRODUCER_TOOLS.get(parts[2]);
    if (dataType) return { toolName: parts[2], dataType };
  }
  return undefined;
}

function isCanceledArtifactProducerToolUse(input: unknown): boolean {
  return Boolean(input && typeof input === 'object' && (input as Record<string, unknown>).cancel === true);
}

function fileChangeIsAdd(change: unknown): boolean {
  if (!change || typeof change !== 'object') return false;
  const kind = (change as { kind?: unknown }).kind;
  if (typeof kind === 'string') return kind.toLowerCase() === 'add' || kind.toLowerCase() === 'create';
  if (kind && typeof kind === 'object') {
    const type = (kind as { type?: unknown }).type;
    return typeof type === 'string' && (type.toLowerCase() === 'add' || type.toLowerCase() === 'create');
  }
  return false;
}

function isIgnoredOutputPath(candidate: string): boolean {
  const normalized = candidate.toLowerCase().replace(/\/+$/, '');
  if (!normalized) return true;
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return true;
  if (segments.some((segment) => segment === '.braid' || segment === '.git' || segment === 'node_modules')) return true;
  const first = segments[0];
  if (first === 'dist' || first === 'build' || first === 'out' || first === 'coverage' || first === '.next') return true;
  if (first.startsWith('tmp-') || first.startsWith('probe-')) return true;
  return false;
}

function addCandidatePath(out: Set<string>, cwd: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const normalized = normalizeWorkspacePath(cwd, value);
  if (normalized && !isIgnoredOutputPath(normalized)) out.add(normalized);
}

function collectFileChangeAddPaths(cwd: string, input: unknown): string[] {
  const out = new Set<string>();
  if (!input || typeof input !== 'object') return [];
  const changes = (input as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  for (const change of changes) {
    if (!fileChangeIsAdd(change)) continue;
    if (!change || typeof change !== 'object') continue;
    const c = change as Record<string, unknown>;
    addCandidatePath(out, cwd, c.path ?? c.file_path ?? c.filePath ?? c.filename);
  }
  return [...out].sort();
}

function collectDeliverableCandidatePaths(cwd: string, toolName: string, input: unknown): string[] {
  if (!isObservedOutputTool(toolName)) return [];
  if (isFileChangeTool(toolName)) return collectFileChangeAddPaths(cwd, input);
  const out = new Set<string>();
  const visit = (value: unknown, key?: string, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (!looksLikePathKey(key)) return;
      addCandidatePath(out, cwd, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  visit(input);
  return [...out].sort();
}

class ArtifactsHostService implements HostService {
  id = 'artifacts.hostService';
  label = 'Artifacts Host Service';
  manifest = manifest;
  private readonly candidates = new Map<string, Map<string, DeliverableCandidate>>();
  private readonly coveredPaths = new Map<string, Set<string>>();

  constructor(
    private readonly host: Parameters<HostServicePlugin['create']>[0],
    private readonly artifactTypes: ArtifactTypeRegistryView,
  ) {}

  private obligationTarget(ctx: AgentToolContext | ToolMiddlewareContext): ObligationTarget | undefined {
    if (typeof ctx.turnIndex !== 'number') return undefined;
    if ('obligationTarget' in ctx && ctx.obligationTarget) return ctx.obligationTarget;
    if (ctx.canvasId && ctx.boardId) return { canvasId: ctx.canvasId, boardId: ctx.boardId, turnIndex: ctx.turnIndex };
    return ctx.agentId ? { agentId: ctx.agentId, turnIndex: ctx.turnIndex } : undefined;
  }

  private recordObligationEvent(event: ObligationLedgerEvent): void {
    this.host.recordObligationEvent?.(event);
  }

  agentTools() {
    return createArtifactAgentTools({
      declare: (ctx, req) => this.handleDeclare(ctx, req),
      expect: (ctx, req) => this.handleExpect(ctx, req),
      types: (ctx, req) => this.handleTypes(ctx, req),
    }, {
      typeSummary: this.typeSummary(),
    });
  }

  toolMiddleware(): ToolMiddlewarePlugin[] {
    return [{
      id: 'artifacts.deliverable-candidate-observer',
      label: 'Artifacts Deliverable Candidate Observer',
      manifest,
      observeToolUse: (ctx) => this.observeToolUse(ctx),
    }];
  }

  async onTurnSettled(event: HostTurnSettledEvent): Promise<void> {
    const key = turnCandidateKey(event.canvasId, event.boardId, event.turnIndex);
    this.cleanupTurn(key);
  }

  async onRunError(event: HostRunBoardEvent): Promise<void> {
    this.cleanupBoard(event.canvasId, event.boardId);
  }

  async onBoardAbort(event: HostRunBoardEvent): Promise<void> {
    this.cleanupBoard(event.canvasId, event.boardId);
  }

  // Canvas teardown aborts the canvas's live runs but does NOT dispatch onBoardAbort per board, and an engine
  // whose abort path emits no done/error would otherwise leave this turn's candidate/covered entries stranded in
  // memory until host restart. onCanvasClose is the sanctioned per-canvas retirement seam (mirrors the
  // coordinator's cleanupCanvas), so the deliverable-candidate maps never outlive their owning canvas. (LOW-1)
  async onCanvasClose(canvasId: string): Promise<void> {
    this.cleanupCanvas(canvasId);
  }

  private typeSummary(): string {
    const types = this.artifactTypes.descriptors()
      .map((type) => `${type.dataType} (${type.label})`)
      .join('; ');
    return `Defined artifact dataTypes: ${types}. Use braid.artifact_types for detailed guidance/schema.`;
  }

  private async handleDeclare(ctx: AgentToolContext, req: ArtifactDeclareToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact declaration canceled.' };
    if (req.attachToTurn && (ctx.presentation === 'headless' || !ctx.canvasId || !ctx.boardId)) {
      return { ok: false, result: 'Artifact attachment needs a current Board-turn presentation. Declare without attachToTurn and pass the exact artifact ref in your delivery.' };
    }
    const dataType = nonEmpty(req.dataType) ?? this.artifactTypes.metaDataType;
    const label = nonEmpty(req.label);
    const hasText = typeof req.text === 'string' && req.text.length > 0;
    const sourcePath = nonEmpty(req.path);
    const storageMode = normalizeFileStorageMode(req.storageMode);
    if (!label) return { ok: false, result: 'artifact_declare needs a non-empty label.' };
    if (hasText && sourcePath) return { ok: false, result: 'artifact_declare accepts either text or path, not both.' };
    if (!hasText && !sourcePath) return { ok: false, result: 'artifact_declare needs either non-empty text or a workspace path.' };
    if (sourcePath && !storageMode) return { ok: false, result: 'artifact_declare path declarations need storageMode "external-ref" or "born".' };
    if (!sourcePath && nonEmpty(req.storageMode)) return { ok: false, result: 'artifact_declare storageMode only applies to path declarations.' };
    const canvasId = ctx.canvasId;
    const boardId = ctx.boardId;

    try {
      const result = sourcePath
        ? await this.host.produceArtifact(canvasId, boardId, {
          source: storageMode!,
          dataType,
          ...(nonEmpty(req.mime) ? { mime: nonEmpty(req.mime) } : {}),
          label,
          path: sourcePath,
          pluginId: manifest.id,
          ...(ctx.agentId ? { producerAgentId: ctx.agentId } : {}),
          ...(req.attachToTurn ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
        })
        : await this.host.produceArtifact(canvasId, boardId, {
          source: 'declared',
          dataType,
          mime: nonEmpty(req.mime) ?? DEFAULT_MIME,
          label,
          text: req.text!,
          pluginId: manifest.id,
          ...(ctx.agentId ? { producerAgentId: ctx.agentId } : {}),
          ...(req.attachToTurn ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
        });
      if (result.error || !result.ref) return { ok: false, result: result.error ?? 'artifact_declare failed.' };
      const target = this.obligationTarget(ctx);
      if (!req.attachToTurn && target) {
        this.recordObligationEvent({
          type: 'artifact-produced', target, dataType: result.ref.dataType, refId: result.ref.id,
        });
      }
      if (sourcePath && req.attachToTurn && ctx.canvasId && ctx.boardId) {
        this.coverCandidate(ctx.canvasId, ctx.boardId, ctx.turnIndex, sourcePath);
      }
      return {
        ok: true,
        result: JSON.stringify({ ref: result.ref, path: result.path }, null, 2),
      };
    } catch (error: any) {
      return { ok: false, result: error?.message ?? 'artifact_declare failed.' };
    }
  }

  private async handleExpect(ctx: AgentToolContext, req: ArtifactExpectToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact expectation canceled.' };
    const dataType = nonEmpty(req.dataType);
    const expectsNothing = req.nothing === true;
    // F6 (erratum declared-design-doc-mrtaiobk-0nhbxp81@1): a redundant
    // nothing:false alongside dataType is semantically unambiguous — accept it
    // instead of scolding. A bare nothing:false lacks the needed dataType, so it
    // stays an error, but an actionable one (live retry-loop evidence).
    if (req.invalidNothingFalse && !dataType) {
      return {
        ok: false,
        result: 'artifact_expect: nothing:false implies an artifact is expected; pass dataType (for example "report" or "meta") instead, or nothing:true when no artifact should be produced.',
      };
    }
    if (dataType && expectsNothing) return { ok: false, result: 'artifact_expect accepts either dataType or nothing, not both.' };
    if (!dataType && !expectsNothing) return { ok: false, result: 'artifact_expect needs either dataType or nothing:true.' };
    const reason = nonEmpty(req.reason);
    const target = this.obligationTarget(ctx);
    if (!target) return { ok: false, result: 'Artifact expectation needs an exact current Agent or Board-turn target.' };

    if (expectsNothing) {
      this.recordObligationEvent({
        type: 'artifact-expectation-decided',
        target,
        decision: { kind: 'nothing', ...(reason ? { reason } : {}) },
      });
      return {
        ok: true,
        result: JSON.stringify({ expect: 'nothing', ...(reason ? { reason } : {}) }, null, 2),
      };
    }

    const expectedDataType = dataType!;
    this.recordObligationEvent({
      type: 'artifact-expectation-decided',
      target,
      decision: { kind: 'dataType', dataType: expectedDataType, ...(reason ? { reason } : {}) },
    });
    return {
      ok: true,
      result: JSON.stringify({
        dataType: expectedDataType,
        ...(reason ? { reason } : {}),
        ...(req.invalidNothingFalse ? { normalized: 'ignored-nothing-false' } : {}),
      }, null, 2),
    };
  }

  private async handleTypes(ctx: AgentToolContext, req: ArtifactTypesToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact type discovery canceled.' };
    const requestedDataType = nonEmpty(req.dataType);
    if (requestedDataType) {
      const resolved = this.artifactTypes.resolve(requestedDataType, { includeSchema: true });
      return {
        ok: true,
        result: JSON.stringify({
          defaultDataType: this.artifactTypes.metaDataType,
          requestedDataType: resolved.requestedDataType,
          resolved: resolved.exact ? 'exact' : 'meta',
          type: resolved.descriptor,
        }, null, 2),
      };
    }
    return {
      ok: true,
      result: JSON.stringify({
        defaultDataType: this.artifactTypes.metaDataType,
        types: this.artifactTypes.descriptors({ includeSchema: false }),
      }, null, 2),
    };
  }

  private observeToolUse(ctx: ToolMiddlewareContext): void {
    if (ctx.source !== 'observed' || typeof ctx.turnIndex !== 'number') return;
    const target = this.obligationTarget(ctx);
    if (!target) return;
    const producerTool = artifactProducerTool(ctx.toolName);
    if (producerTool && !isCanceledArtifactProducerToolUse(ctx.input)) {
      this.recordObligationEvent({
        type: 'artifact-output-intent-observed',
        target,
        toolName: producerTool.toolName,
        dataType: producerTool.dataType,
      });
    }
    const paths = collectDeliverableCandidatePaths(this.host.cwd(), ctx.toolName, ctx.input);
    if (!paths.length) return;
    if (!ctx.canvasId || !ctx.boardId) {
      // Candidate observations need no presentation-owned cache for autonomous Agent turns.
      for (const candidatePath of paths) {
        this.recordObligationEvent({ type: 'artifact-output-candidate-observed', target, path: candidatePath, toolName: ctx.toolName });
      }
      return;
    }
    const key = turnCandidateKey(ctx.canvasId, ctx.boardId, ctx.turnIndex);
    const covered = this.coveredPaths.get(key) ?? new Set<string>();
    let bucket = this.candidates.get(key);
    if (!bucket) {
      bucket = new Map<string, DeliverableCandidate>();
      this.candidates.set(key, bucket);
    }
    for (const candidatePath of paths) {
      if (covered.has(candidatePath)) continue;
      const existed = bucket.has(candidatePath);
      bucket.set(candidatePath, { path: candidatePath, toolName: ctx.toolName });
      if (!existed) {
        this.recordObligationEvent({
          type: 'artifact-output-candidate-observed',
          target,
          path: candidatePath,
          toolName: ctx.toolName,
        });
      }
    }
  }

  private coverCandidate(canvasId: string, boardId: string, turnIndex: number, rawPath: string): void {
    const candidatePath = normalizeWorkspacePath(this.host.cwd(), rawPath);
    if (!candidatePath) return;
    const key = turnCandidateKey(canvasId, boardId, turnIndex);
    const covered = this.coveredPaths.get(key) ?? new Set<string>();
    covered.add(candidatePath);
    this.coveredPaths.set(key, covered);
    this.candidates.get(key)?.delete(candidatePath);
  }

  private cleanupTurn(key: string): void {
    this.candidates.delete(key);
    this.coveredPaths.delete(key);
  }

  private cleanupBoard(canvasId: string, boardId: string): void {
    this.sweepByPrefix(boardPrefix(canvasId, boardId));
  }

  private cleanupCanvas(canvasId: string): void {
    this.sweepByPrefix(canvasPrefix(canvasId));
  }

  private sweepByPrefix(prefix: string): void {
    for (const key of [...this.candidates.keys()]) {
      if (key.startsWith(prefix)) this.candidates.delete(key);
    }
    for (const key of [...this.coveredPaths.keys()]) {
      if (key.startsWith(prefix)) this.coveredPaths.delete(key);
    }
  }
}

export function createArtifactsHostServicePlugin(artifactTypes: ArtifactTypeRegistryView): HostServicePlugin {
  return {
    id: 'artifacts.hostService',
    label: 'Artifacts Host Service',
    manifest,
    create(ctx) {
      return new ArtifactsHostService(ctx, artifactTypes);
    },
  };
}
