import type { AgentToolContext, HostService, HostServicePlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { createArtifactAgentTools, type ArtifactDeclareToolRequest } from './agentTool';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;
const DEFAULT_MIME = 'text/markdown';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

class ArtifactsHostService implements HostService {
  id = 'artifacts.hostService';
  label = 'Artifacts Host Service';
  manifest = manifest;

  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}

  agentTools() {
    return createArtifactAgentTools({
      declare: (ctx, req) => this.handleDeclare(ctx, req),
    });
  }

  private async handleDeclare(ctx: AgentToolContext, req: ArtifactDeclareToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Artifact declaration canceled.' };
    const dataType = nonEmpty(req.dataType);
    const label = nonEmpty(req.label);
    const text = req.text;
    if (!dataType) return { ok: false, result: 'artifact_declare needs a non-empty dataType.' };
    if (!label) return { ok: false, result: 'artifact_declare needs a non-empty label.' };
    if (typeof text !== 'string' || !text.length) return { ok: false, result: 'artifact_declare needs non-empty text.' };

    try {
      const result = await this.host.produceArtifact(ctx.canvasId, ctx.boardId, {
        source: 'declared',
        dataType,
        mime: nonEmpty(req.mime) ?? DEFAULT_MIME,
        label,
        text,
        pluginId: manifest.id,
        ...(req.attachToTurn ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
      });
      if (result.error || !result.ref) return { ok: false, result: result.error ?? 'artifact_declare failed.' };
      return {
        ok: true,
        result: JSON.stringify({ ref: result.ref, path: result.path }, null, 2),
      };
    } catch (error: any) {
      return { ok: false, result: error?.message ?? 'artifact_declare failed.' };
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
