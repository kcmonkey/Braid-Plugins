import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export interface ArtifactDeclareToolRequest {
  dataType?: string;
  label?: string;
  text?: string;
  mime?: string;
  attachToTurn?: boolean;
}

export interface ArtifactToolHandlers {
  declare(ctx: AgentToolContext, req: ArtifactDeclareToolRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function normalizeArtifactDeclareArgs(input: Record<string, unknown>): ArtifactDeclareToolRequest {
  return {
    dataType: stringValue(input.dataType),
    label: stringValue(input.label),
    text: stringValue(input.text),
    mime: stringValue(input.mime),
    attachToTurn: input.attachToTurn === true,
  };
}

export function createArtifactAgentTools(handlers: ArtifactToolHandlers): AgentToolPlugin<Record<string, unknown>>[] {
  return [
    {
      id: 'artifacts.declare',
      label: 'Declare Artifact',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'artifact_declare',
        description: 'Declare a reusable project-local Braid text artifact. Required: dataType, label, and text. Optional: mime. The payload is stored in the Braid artifact registry, not in project source files.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['dataType', 'label', 'text'],
          properties: {
            dataType: { type: 'string', description: 'Open payload type used by artifact pins, such as spec, plan, report, or note.' },
            label: { type: 'string', description: 'Human-readable artifact label.' },
            text: { type: 'string', description: 'Artifact payload text to store.' },
            mime: { type: 'string', description: 'Text MIME type. Defaults to text/markdown.' },
            attachToTurn: { type: 'boolean', description: 'When true, also attach the artifact to the current turn as a board output.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.declare(ctx, normalizeArtifactDeclareArgs(input));
      },
    },
  ];
}
