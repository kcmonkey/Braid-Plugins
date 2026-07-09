import type { AgentToolContext, AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

export interface ImageGenerateToolRequest {
  requestId?: string;
  prompt?: string;
  options?: Record<string, unknown>;
  optionsJson?: string;
  confirmCost?: boolean;
  attachToTurn?: boolean;
}

export interface ImageGenerateToolHandlers {
  generate(ctx: AgentToolContext, req: ImageGenerateToolRequest): Promise<AgentToolResult>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseOptionsJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function normalizeImageGenerateArgs(input: Record<string, unknown>): ImageGenerateToolRequest {
  const optionsJson = stringValue(input.optionsJson);
  return {
    requestId: stringValue(input.requestId),
    prompt: stringValue(input.prompt),
    options: objectValue(input.options) ?? parseOptionsJson(optionsJson),
    optionsJson,
    confirmCost: input.confirmCost === true,
    attachToTurn: input.attachToTurn !== false,
  };
}

export function createImageGenerateAgentTool(_host: HostServiceContext, handlers: ImageGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'image-artifacts.image-generate-tool',
    label: 'Generate Image',
    tool: {
      namespace: 'braid',
      name: 'image_generate',
      description: [
        'Generate an image artifact through the image generation service selected in Braid Settings > Artifact Defaults.',
        'Use this when the user asks in normal chat for an image, illustration, poster, concept art, or other generated raster asset.',
        'The image service is selected by the user in Braid Settings, not by tool arguments.',
        'The result is stored as a born image artifact and attached to the current turn by default.',
        'Service API keys are configured outside chat and stored in host secure storage.',
        'Paid providers require confirmCost true before dispatch; retry the same requestId to avoid duplicate provider jobs.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'Stable logical request id. Reuse it when retrying the same image request.' },
          prompt: { type: 'string', description: 'Image generation prompt.' },
          optionsJson: { type: 'string', description: 'JSON object with provider-neutral image options when supported.' },
          confirmCost: { type: 'boolean', description: 'Must be true before dispatching providers that may consume paid credits.' },
          attachToTurn: { type: 'boolean', description: 'Attach the generated image artifact to this turn. Defaults to true.' },
        },
      },
    },
    call: (ctx, input) => handlers.generate(ctx, normalizeImageGenerateArgs(input)),
  };
}
