import type { AgentToolContext, AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolPropertySchema, AgentToolResult } from '../../../src/engine/types';
import type { AudioGenerationKind } from '../../../src/protocol';

export interface AudioGenerateToolRequest {
  kind: AudioGenerationKind;
  requestId?: string;
  input?: string;
  prompt?: string;
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

function normalizeCommon(input: Record<string, unknown>, kind: AudioGenerationKind): AudioGenerateToolRequest {
  const optionsJson = stringValue(input.optionsJson);
  return {
    kind,
    requestId: stringValue(input.requestId),
    options: objectValue(input.options) ?? parseOptionsJson(optionsJson),
    optionsJson,
    confirmCost: input.confirmCost === true,
    attachToTurn: input.attachToTurn !== false,
  };
}

export function normalizeSpeechGenerateArgs(input: Record<string, unknown>): AudioGenerateToolRequest {
  return {
    ...normalizeCommon(input, 'speech'),
    input: stringValue(input.input) ?? stringValue(input.text),
  };
}

export function normalizeSoundEffectGenerateArgs(input: Record<string, unknown>): AudioGenerateToolRequest {
  return {
    ...normalizeCommon(input, 'sound-effect'),
    prompt: stringValue(input.prompt),
  };
}

export function normalizeMusicGenerateArgs(input: Record<string, unknown>): AudioGenerateToolRequest {
  return {
    ...normalizeCommon(input, 'music'),
    prompt: stringValue(input.prompt),
  };
}

/** Compatibility normalizer: legacy `audio_generate` remains speech-only. */
export function normalizeAudioGenerateArgs(input: Record<string, unknown>): AudioGenerateToolRequest {
  return normalizeSpeechGenerateArgs(input);
}

function commonProperties(inputDescription: string, inputName: 'input' | 'prompt', optionsDescription: string): Record<string, AgentToolPropertySchema> {
  const properties: Record<string, AgentToolPropertySchema> = {
    requestId: { type: 'string', description: 'Stable logical request id. Reuse it when retrying the same audio request.' },
    [inputName]: { type: 'string', description: inputDescription },
    optionsJson: { type: 'string', description: optionsDescription },
    confirmCost: { type: 'boolean', description: 'Must be true before dispatching providers that may consume paid credits.' },
    attachToTurn: { type: 'boolean', description: 'Attach the generated audio artifact to this turn. Defaults to true.' },
  };
  return properties;
}

function createTool(
  name: 'speech_generate' | 'sound_effect_generate' | 'music_generate' | 'audio_generate',
  label: string,
  description: string[],
  properties: Record<string, AgentToolPropertySchema>,
  requiredInput: 'input' | 'prompt',
  normalize: (input: Record<string, unknown>) => AudioGenerateToolRequest,
  handlers: AudioGenerateToolHandlers,
): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: `audio-artifacts.${name.replace(/_/g, '-')}-tool`,
    label,
    tool: {
      namespace: 'braid',
      name,
      description: description.join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [requiredInput],
        properties,
      },
    },
    call: (ctx, input) => handlers.generate(ctx, normalize(input)),
  };
}

export function createAudioGenerateAgentTools(_host: HostServiceContext, handlers: AudioGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>>[] {
  const shared = [
    'The result is stored as a born audio artifact and attached to the current turn by default.',
    'The generation service is selected by the user in Braid Settings > Artifact Defaults, not by tool arguments.',
    'Paid providers require confirmCost true before dispatch; retry the same requestId to avoid duplicate provider jobs.',
  ];
  return [
    createTool(
      'speech_generate',
      'Generate Speech',
      [
        'Generate spoken audio through the speech service selected in Braid Settings > Artifact Defaults.',
        'Use this for text-to-speech, narration, dialogue, voice, or other spoken audio.',
        ...shared,
        'For OpenRouter TTS, the model comes from the selected Speech default; optionsJson may specify voice, response_format, speed, or a supported model override.',
      ],
      commonProperties('Text to convert into speech.', 'input', 'JSON object with speech options such as model, voice, response_format, speed, or provider-specific options.'),
      'input',
      normalizeSpeechGenerateArgs,
      handlers,
    ),
    createTool(
      'sound_effect_generate',
      'Generate Sound Effect',
      [
        'Generate a sound-effect audio artifact through the Sound Effect service selected in Braid Settings > Artifact Defaults.',
        'Use this for environmental sounds, Foley, impacts, ambience, UI sounds, loops, and other non-speech effects.',
        ...shared,
        'Do not substitute a speech provider when no sound-effect service is configured.',
      ],
      commonProperties('Acoustic description of the sound effect to generate.', 'prompt', 'JSON object with sound-effect options such as duration_seconds, loop, variation, or output format.'),
      'prompt',
      normalizeSoundEffectGenerateArgs,
      handlers,
    ),
    createTool(
      'music_generate',
      'Generate Music',
      [
        'Generate a music audio artifact through the Music service selected in Braid Settings > Artifact Defaults.',
        'Use this for songs, instrumentals, scores, jingles, stems, or other composed music.',
        ...shared,
        'Do not substitute a speech provider when no music service is configured.',
        'For OpenRouter Music, select a verified Lyria model in Settings. Output is MP3; optionsJson may specify format or response_format only as mp3, or a capability-scoped Lyria model override.',
      ],
      commonProperties('Description of the music to compose.', 'prompt', 'JSON object with music options such as duration_seconds, bpm, key, structure, lyrics, instrumental, or output format.'),
      'prompt',
      normalizeMusicGenerateArgs,
      handlers,
    ),
    createTool(
      'audio_generate',
      'Generate Speech (compatibility alias)',
      [
        'Compatibility alias for speech_generate. It always means text-to-speech and never sound effects or music.',
        ...shared,
      ],
      commonProperties('Text to convert into speech.', 'input', 'JSON object with speech options such as model, voice, response_format, speed, or provider-specific options.'),
      'input',
      normalizeAudioGenerateArgs,
      handlers,
    ),
  ];
}

/** Backward-compatible factory retained for consumers that imported the former singular helper. */
export function createAudioGenerateAgentTool(host: HostServiceContext, handlers: AudioGenerateToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return createAudioGenerateAgentTools(host, handlers).find((tool) => tool.tool.name === 'audio_generate')!;
}
