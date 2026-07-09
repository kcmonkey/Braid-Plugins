import type { AgentToolContext, AgentToolPlugin, HostServiceContext, VideoGenerationRequestKind } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

export interface VideoGenerateToolRequest {
  requestId?: string;
  kind?: string;
  prompt?: string;
  options?: Record<string, unknown>;
  optionsJson?: string;
  confirmCost?: boolean;
  attachToTurn?: boolean;
  cancel?: boolean;
}

export interface VideoGenerateToolHandlers {
  generate(ctx: AgentToolContext, req: VideoGenerateToolRequest): Promise<AgentToolResult>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function kindValue(value: unknown): VideoGenerationRequestKind {
  return value === 'image-to-video' ? 'image-to-video' : 'text-to-video';
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

export function normalizeVideoGenerateArgs(input: Record<string, unknown>): VideoGenerateToolRequest {
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

export function createVideoGenerateAgentTool(_host: HostServiceContext, handlers: VideoGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'video-artifacts.video-generate-tool',
    label: 'Generate Video',
    tool: {
      namespace: 'braid',
      name: 'video_generate',
      description: [
        'Generate a video artifact through Braid video-generation providers.',
        'Use this when the user asks in normal chat for a generated video, clip, animation, or text-to-video result.',
        'The result is stored as a born video artifact and attached to the current turn by default.',
        'The video-generation service is selected by the user in Braid Settings > Artifact Defaults, not by tool arguments.',
        'text-to-video supports prompt plus optionsJson fields such as model, duration, aspect_ratio, aspectRatio, and resolution when supported by the configured service.',
        'Service API keys are configured outside chat and stored in host secure storage.',
        'Paid providers require confirmCost true before dispatch; retry the same requestId to resume instead of creating duplicate provider jobs.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'Stable logical request id. Reuse it when retrying or repairing the same request.' },
          kind: { type: 'string', enum: ['text-to-video', 'image-to-video'], description: 'Generation workflow kind.' },
          prompt: { type: 'string', description: 'Text prompt for video generation.' },
          optionsJson: { type: 'string', description: 'JSON object with provider-neutral video options such as duration, aspect ratio, resolution, or model.' },
          confirmCost: { type: 'boolean', description: 'Must be true before dispatching providers that may consume paid credits.' },
          attachToTurn: { type: 'boolean', description: 'Attach the finished artifact to this turn. Defaults to true.' },
          cancel: { type: 'boolean', description: 'Cancel the existing requestId instead of creating or polling a task.' },
        },
      },
    },
    call: (ctx, input) => handlers.generate(ctx, normalizeVideoGenerateArgs(input)),
  };
}
