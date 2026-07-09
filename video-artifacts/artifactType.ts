import type { ArtifactTypePlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

export const VIDEO_DATA_TYPE = 'video';
export const VIDEO_MP4_MIME = 'video/mp4';

const manifest = manifestJson as PluginManifest;

function normalizeMime(mime: string): string {
  return mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export const videoArtifactType: ArtifactTypePlugin = {
  id: 'video-artifacts.video-type',
  label: 'Video',
  manifest,
  dataType: VIDEO_DATA_TYPE,
  validationInput: 'metadata',
  description: 'First-class video artifact. Accepts file-backed video/* payloads such as video/mp4 and video/webm without forcing payload bytes through graph state.',
  schema: {
    type: 'object',
    properties: {
      mime: { type: 'string', pattern: '^video/' },
    },
    required: ['mime'],
  },
  validate(ctx) {
    const mime = normalizeMime(ctx.mime);
    if (mime.startsWith('video/') && mime.length > 'video/'.length) return { ok: true };
    return {
      ok: false,
      reason: 'video artifacts require a video/* MIME type such as "video/mp4" or "video/webm".',
    };
  },
};
