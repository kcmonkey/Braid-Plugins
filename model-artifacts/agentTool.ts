import type { AgentToolContext, AgentToolPlugin, HostServiceContext, ModelGenerationRequestKind } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

export interface ModelGenerateToolRequest {
  requestId?: string;
  kind?: string;
  prompt?: string;
  options?: Record<string, unknown>;
  optionsJson?: string;
  confirmCost?: boolean;
  attachToTurn?: boolean;
  cancel?: boolean;
}

export interface ModelGenerateToolHandlers {
  generate(ctx: AgentToolContext, req: ModelGenerateToolRequest): Promise<AgentToolResult>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function kindValue(value: unknown): ModelGenerationRequestKind {
  return value === 'image-to-3d' ? 'image-to-3d' : 'text-to-3d';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseOptionsJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

export function normalizeModelGenerateArgs(input: Record<string, unknown>): ModelGenerateToolRequest {
  const optionsJson = stringValue(input.optionsJson);
  return {
    requestId: stringValue(input.requestId),
    kind: kindValue(input.kind),
    prompt: stringValue(input.prompt),
    options: objectValue(input.options) ?? parseOptionsJson(optionsJson),
    optionsJson,
    confirmCost: input.confirmCost === true,
    attachToTurn: input.attachToTurn !== false,
    cancel: input.cancel === true,
  };
}

export function createModelGenerateAgentTool(_host: HostServiceContext, handlers: ModelGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'model-artifacts.model-generate-tool',
    label: 'Generate 3D Model',
    tool: {
      namespace: 'braid',
      name: 'model_generate',
      description: [
        'Generate a 3D model artifact through Braid model-generation providers.',
        'Use this when the user asks in normal chat for a 3D model, mesh, GLB, or game-ready asset.',
        'The result is stored as a born model-3d artifact and attached to the current turn by default.',
        'The model-generation service is selected by the user in Braid Settings > Artifact Defaults, not by tool arguments.',
        'text-to-3d supports prompt plus optionsJson fields modelType, aiModel, shouldRemesh, topology, targetPolycount, decimationMode, poseMode, texture, enablePbr, hdTexture, texturePrompt, textureImageUrl, autoSize, alphaThumbnail, originAt, and moderation. image-to-3d additionally supports imageUrl or inputTaskId, shouldTexture, imageEnhancement, removeLighting, and multiViewThumbnails.',
        'Service API keys are configured outside chat and stored in host secure storage.',
        'Paid providers require confirmCost true before dispatch; retry the same requestId to resume instead of creating duplicate provider jobs.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'Stable logical request id. Reuse it when retrying or repairing the same request.' },
          kind: { type: 'string', enum: ['text-to-3d', 'image-to-3d'], description: 'Generation workflow kind.' },
          prompt: { type: 'string', description: 'Text prompt for the 3D model.' },
          optionsJson: { type: 'string', description: 'JSON object with provider-neutral model options such as quality, topology, pose, or texture preferences.' },
          confirmCost: { type: 'boolean', description: 'Must be true before dispatching providers that may consume paid credits.' },
          attachToTurn: { type: 'boolean', description: 'Attach the finished artifact to this turn. Defaults to true.' },
          cancel: { type: 'boolean', description: 'Cancel the existing requestId instead of creating or polling a task.' },
        },
      },
    },
    call: (ctx, input) => handlers.generate(ctx, normalizeModelGenerateArgs(input)),
  };
}
