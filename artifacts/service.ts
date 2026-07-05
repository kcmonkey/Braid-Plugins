import * as path from 'path';
import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServicePlugin,
  HostTurnSettledEvent,
  PluginManifest,
  ToolMiddlewareContext,
  ToolMiddlewarePlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import {
  artifactTypeDescriptors,
  META_ARTIFACT_DATA_TYPE,
  resolveArtifactTypeDescriptor,
} from '../../../src/plugin-runtime/registry';
import { createArtifactAgentTools, type ArtifactDeclareToolRequest, type ArtifactTypesToolRequest } from './agentTool';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;
const DEFAULT_MIME = 'text/markdown';
type FileStorageMode = 'external-ref' | 'born';
type DeliverableCandidate = {
  path: string;
  toolName: string;
};

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

function isDeliverableCandidatePath(candidate: string): boolean {
  return candidate.startsWith('mockups/') && !candidate.endsWith('/');
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

function collectDeliverableCandidatePaths(cwd: string, input: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown, key?: string, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (!looksLikePathKey(key)) return;
      const normalized = normalizeWorkspacePath(cwd, value);
      if (normalized && isDeliverableCandidatePath(normalized)) out.add(normalized);
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

  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}

  agentTools() {
    return createArtifactAgentTools({
      declare: (ctx, req) => this.handleDeclare(ctx, req),
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
    const candidates = this.candidates.get(key);
    if (!candidates?.size) {
      this.cleanupTurn(key);
      return;
    }
    const covered = this.coveredPaths.get(key) ?? new Set<string>();
    const unclaimed = [...candidates.values()].filter((candidate) => !covered.has(candidate.path));
    if (!unclaimed.length) {
      this.cleanupTurn(key);
      return;
    }
    const targetKey = `${event.canvasId}::${event.boardId}`;
    if (!this.host.hasLiveBoardKey(targetKey)) {
      this.cleanupTurn(key);
      return;
    }
    const paths = unclaimed.map((candidate) => `- ${candidate.path}`).join('\n');
    this.host.deliverLiveBoardMessage({
      canvasId: event.canvasId,
      targetKey,
      fromBoardId: event.boardId,
      kind: 'artifact-deliverable-self-check',
      injected: true,
      text: [
        'Artifact self-check:',
        'You created project files that look like durable deliverables but did not declare them as artifacts:',
        paths,
        '',
        'If any are intended deliverables, call braid.artifact_declare with attachToTurn:true. If they are scratch or intermediate files, ignore this message.',
      ].join('\n'),
    });
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
    const types = artifactTypeDescriptors()
      .map((type) => `${type.dataType} (${type.label})`)
      .join('; ');
    return `Defined artifact dataTypes: ${types}. Use braid.artifact_types for detailed guidance/schema.`;
  }

  private async handleDeclare(ctx: AgentToolContext, req: ArtifactDeclareToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact declaration canceled.' };
    const dataType = nonEmpty(req.dataType) ?? META_ARTIFACT_DATA_TYPE;
    const label = nonEmpty(req.label);
    const hasText = typeof req.text === 'string' && req.text.length > 0;
    const sourcePath = nonEmpty(req.path);
    const storageMode = normalizeFileStorageMode(req.storageMode);
    if (!label) return { ok: false, result: 'artifact_declare needs a non-empty label.' };
    if (hasText && sourcePath) return { ok: false, result: 'artifact_declare accepts either text or path, not both.' };
    if (!hasText && !sourcePath) return { ok: false, result: 'artifact_declare needs either non-empty text or a workspace path.' };
    if (sourcePath && !storageMode) return { ok: false, result: 'artifact_declare path declarations need storageMode "external-ref" or "born".' };
    if (!sourcePath && nonEmpty(req.storageMode)) return { ok: false, result: 'artifact_declare storageMode only applies to path declarations.' };

    try {
      const result = sourcePath
        ? await this.host.produceArtifact(ctx.canvasId, ctx.boardId, {
          source: storageMode!,
          dataType,
          ...(nonEmpty(req.mime) ? { mime: nonEmpty(req.mime) } : {}),
          label,
          path: sourcePath,
          pluginId: manifest.id,
          ...(req.attachToTurn ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
        })
        : await this.host.produceArtifact(ctx.canvasId, ctx.boardId, {
          source: 'declared',
          dataType,
          mime: nonEmpty(req.mime) ?? DEFAULT_MIME,
          label,
          text: req.text!,
          pluginId: manifest.id,
          ...(req.attachToTurn ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
        });
      if (result.error || !result.ref) return { ok: false, result: result.error ?? 'artifact_declare failed.' };
      if (sourcePath && req.attachToTurn) {
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

  private async handleTypes(ctx: AgentToolContext, req: ArtifactTypesToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact type discovery canceled.' };
    const requestedDataType = nonEmpty(req.dataType);
    if (requestedDataType) {
      const resolved = resolveArtifactTypeDescriptor(requestedDataType, { includeSchema: true });
      return {
        ok: true,
        result: JSON.stringify({
          defaultDataType: META_ARTIFACT_DATA_TYPE,
          requestedDataType: resolved.requestedDataType,
          resolved: resolved.exact ? 'exact' : 'meta',
          type: resolved.descriptor,
        }, null, 2),
      };
    }
    return {
      ok: true,
      result: JSON.stringify({
        defaultDataType: META_ARTIFACT_DATA_TYPE,
        types: artifactTypeDescriptors({ includeSchema: false }),
      }, null, 2),
    };
  }

  private observeToolUse(ctx: ToolMiddlewareContext): void {
    if (ctx.source !== 'observed' || typeof ctx.turnIndex !== 'number') return;
    const paths = collectDeliverableCandidatePaths(this.host.cwd(), ctx.input);
    if (!paths.length) return;
    const key = turnCandidateKey(ctx.canvasId, ctx.boardId, ctx.turnIndex);
    const covered = this.coveredPaths.get(key) ?? new Set<string>();
    let bucket = this.candidates.get(key);
    if (!bucket) {
      bucket = new Map<string, DeliverableCandidate>();
      this.candidates.set(key, bucket);
    }
    for (const candidatePath of paths) {
      if (covered.has(candidatePath)) continue;
      bucket.set(candidatePath, { path: candidatePath, toolName: ctx.toolName });
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

export const artifactsHostServicePlugin: HostServicePlugin = {
  id: 'artifacts.hostService',
  label: 'Artifacts Host Service',
  manifest,
  create(ctx) {
    return new ArtifactsHostService(ctx);
  },
};
