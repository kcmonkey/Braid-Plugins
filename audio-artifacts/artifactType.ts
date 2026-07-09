import type { ArtifactTypePlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

export const AUDIO_DATA_TYPE = 'audio';
export const AUDIO_DEFAULT_MIME = 'audio/mpeg';

const manifest = manifestJson as PluginManifest;

function normalizeMime(mime: string): string {
  return mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export const audioArtifactType: ArtifactTypePlugin = {
  id: 'audio-artifacts.audio-type',
  label: 'Audio',
  manifest,
  dataType: AUDIO_DATA_TYPE,
  validationInput: 'metadata',
  description: 'First-class audio artifact. Accepts audio/* payloads produced by TTS or imported as project media.',
  schema: {
    type: 'object',
    properties: {
      mime: { type: 'string', pattern: '^audio/' },
    },
    required: ['mime'],
  },
  validate(ctx) {
    const mime = normalizeMime(ctx.mime);
    if (mime.startsWith('audio/') && mime.length > 'audio/'.length) return { ok: true };
    return {
      ok: false,
      reason: 'audio artifacts require an audio/* MIME type such as "audio/mpeg" or "audio/wav".',
    };
  },
};
