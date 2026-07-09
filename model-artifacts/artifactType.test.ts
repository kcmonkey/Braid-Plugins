import { describe, expect, it } from 'vitest';
import { artifactTypeDescriptors, registerArtifactType, resolveArtifactTypePlugin } from '../../../src/plugin-runtime/registry';
import { MODEL_3D_DATA_TYPE, MODEL_3D_GLB_MIME, model3dArtifactType } from './artifactType';

describe('model-3d artifact type', () => {
  it('is discoverable with GLB MIME guidance and validates v1 payload metadata', async () => {
    const unregister = registerArtifactType(model3dArtifactType);
    try {
      const descriptor = artifactTypeDescriptors().find((type) => type.dataType === MODEL_3D_DATA_TYPE);
      expect(descriptor).toMatchObject({
        dataType: MODEL_3D_DATA_TYPE,
        label: '3D Model',
        hasValidator: true,
        hasSchema: false,
      });
      expect(descriptor?.description).toContain(MODEL_3D_GLB_MIME);

      const type = resolveArtifactTypePlugin(MODEL_3D_DATA_TYPE);
      await expect(Promise.resolve(type.validate?.({
        dataType: MODEL_3D_DATA_TYPE,
        artifactClass: 'born',
        mime: MODEL_3D_GLB_MIME,
        label: 'mesh.glb',
      }))).resolves.toEqual({ ok: true });
      await expect(Promise.resolve(type.validate?.({
        dataType: MODEL_3D_DATA_TYPE,
        artifactClass: 'born',
        mime: 'application/octet-stream',
        label: 'mesh.bin',
      }))).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining(MODEL_3D_GLB_MIME),
      });
    } finally {
      unregister();
    }
  });
});
