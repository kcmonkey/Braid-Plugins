import type { ArtifactTypePlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

export const MODEL_3D_DATA_TYPE = 'model-3d';
export const MODEL_3D_GLB_MIME = 'model/gltf-binary';

const manifest = manifestJson as PluginManifest;

function normalizeMime(mime: string): string {
  return mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export const model3dArtifactType: ArtifactTypePlugin = {
  id: 'model-artifacts.model-3d-type',
  label: '3D Model',
  manifest,
  dataType: MODEL_3D_DATA_TYPE,
  description: 'First-class 3D model artifact. V1 accepts GLB payloads with MIME model/gltf-binary downloaded into Braid artifact storage.',
  validate(ctx) {
    if (normalizeMime(ctx.mime) === MODEL_3D_GLB_MIME) return { ok: true };
    return {
      ok: false,
      reason: 'model-3d v1 accepts GLB artifacts with MIME "model/gltf-binary".',
    };
  },
};
