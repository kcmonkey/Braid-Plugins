import type { AgentToolContext, AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

export interface AudioGenerateToolRequest {
  requestId?: string;
  input?: string;
  options?: Record<string, unknown>;
  optionsJson?: string;
  confirmCost?: boolean;
  attachToTurn?: boolean;
}

export interface AudioGenerateToolHandlers {
  generate(ctx: AgentToolContext, req: AudioGenerateToolRequest): Promise<AgentToolResult>;
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

export function normalizeAudioGenerateArgs(input: Record<string, unknown>): AudioGenerateToolRequest {
  const optionsJson = stringValue(input.optionsJson);
  return {
    requestId: stringValue(input.requestId),
    input: stringValue(input.input) ?? stringValue(input.text),
    options: objectValue(input.options) ?? parseOptionsJson(optionsJson),
    optionsJson,
    confirmCost: input.confirmCost === true,
    attachToTurn: input.attachToTurn !== false,
  };
}

export function createAudioGenerateAgentTool(_host: HostServiceContext, handlers: AudioGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'audio-artifacts.audio-generate-tool',
    label: 'Generate Audio',
    tool: {
      namespace: 'braid',
      name: 'audio_generate',
      description: [
        'Generate an audio artifact through the audio generation service selected in Braid Settings > Artifact Defaults.',
        'Use this when the user asks in normal chat for text-to-speech, narration, voice, spoken audio, or generated speech.',
        'The result is stored as a born audio artifact and attached to the current turn by default.',
        'The audio service is selected by the user in Braid Settings, not by tool arguments.',
        'For OpenRouter TTS, the model comes from the selected Braid default; use optionsJson for voice, response_format, speed, or an explicit supported model override when needed.',
        'Paid providers require confirmCost true before dispatch; retry the same requestId to avoid duplicate provider jobs.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', description: 'Stable logical request id. Reuse it when retrying the same audio request.' },
          input: { type: 'string', description: 'Text to convert into speech.' },
          optionsJson: { type: 'string', description: 'JSON object with provider-neutral audio options such as model, voice, response_format, or speed.' },
          confirmCost: { type: 'boolean', description: 'Must be true before dispatching providers that may consume paid credits.' },
          attachToTurn: { type: 'boolean', description: 'Attach the generated audio artifact to this turn. Defaults to true.' },
        },
      },
    },
    call: (ctx, input) => handlers.generate(ctx, normalizeAudioGenerateArgs(input)),
  };
}
