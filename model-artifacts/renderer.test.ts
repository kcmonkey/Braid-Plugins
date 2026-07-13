import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { configurePbrRenderer } from './renderer';

describe('model-3d PBR renderer configuration', () => {
  it('uses sRGB output with ACES filmic tone mapping', () => {
    const renderer = {
      outputColorSpace: THREE.LinearSRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 0,
    };

    configurePbrRenderer(renderer);

    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});
