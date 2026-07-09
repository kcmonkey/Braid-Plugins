import { describe, expect, it } from 'vitest';
import { createMeshyModelGenerationProviderPlugin, MESHY_API_KEY_SECRET, MESHY_PROVIDER_ID } from './meshyProvider';
import type { ModelGenerationProviderContext } from '../../../src/plugin-api/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status, headers: { 'Content-Type': 'model/gltf-binary' } });
}

function textResponse(body: string, status = 500, statusText = 'Bad Gateway'): Response {
  return new Response(body, { status, statusText, headers: { 'Content-Type': 'text/html' } });
}

function makeHarness(responses: Response[], secret: string | null = 'msy_dummy_api_key_for_test_mode_12345678') {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call: ${String(input)}`);
    return next;
  };
  const plugin = createMeshyModelGenerationProviderPlugin({ fetch: fetchImpl as typeof fetch });
  const ctx: ModelGenerationProviderContext = {
    readSecret: async (key) => ({ pluginId: plugin.id, key, stored: Boolean(secret), ...(secret ? { value: secret } : {}) }),
    writeSecret: async (key) => ({ pluginId: plugin.id, key, stored: true }),
    clearSecret: async (key) => ({ pluginId: plugin.id, key, cleared: true }),
  };
  return { plugin, provider: plugin.create(ctx), calls };
}

function body(call: { init?: RequestInit }): any {
  return JSON.parse(String(call.init?.body ?? '{}'));
}

describe('Meshy model-generation provider', () => {
  it('registers as Meshy and exposes the bounded provider capability surface', () => {
    const { plugin } = makeHarness([]);
    expect(plugin.providerId).toBe(MESHY_PROVIDER_ID);
    expect(plugin.capabilities).toMatchObject({
      textTo3d: true,
      imageTo3d: true,
      supportsCancellation: true,
      requiresCostConfirmation: true,
    });
    expect(plugin.capabilities.options).toContain('targetPolycount');
    expect(plugin.capabilities.options).toContain('imageUrl');
  });

  it('runs Text-to-3D v2 preview, refine, status polling, and unsigned GLB download', async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const harness = makeHarness([
      jsonResponse({ result: 'preview-1' }),
      jsonResponse({ id: 'preview-1', type: 'text-to-3d-preview', status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.meshy.ai/preview.glb?Expires=1' } }),
      jsonResponse({ result: 'refine-1' }),
      jsonResponse({ id: 'refine-1', type: 'text-to-3d-refine', status: 'SUCCEEDED', progress: 100, expires_at: 1692771679037, model_urls: { glb: 'https://assets.meshy.ai/refine.glb?Expires=2' } }),
      binaryResponse(glb),
    ]);

    const created = await harness.provider.createTask({
      requestId: 'robot-1',
      kind: 'text-to-3d',
      prompt: 'a futuristic robot warrior',
      options: {
        texture: true,
        enablePbr: true,
        aiModel: 'meshy-6',
        shouldRemesh: true,
        targetPolycount: 100000,
        poseMode: 'a-pose',
      },
    }, new AbortController().signal);
    expect(created.providerTaskId).toMatch(/^text-preview:preview-1:/);

    const refining = await harness.provider.readTask(created.providerTaskId);
    expect(refining).toMatchObject({ providerTaskId: 'text-refine:refine-1', status: 'running' });
    const done = await harness.provider.readTask(refining.providerTaskId);
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ mime: 'model/gltf-binary', format: 'glb', label: 'text-to-3d-refine.glb' });
    const downloaded = await harness.provider.downloadResult(done.result!);
    expect(downloaded.bytes).toEqual(glb);

    expect(harness.calls[0].url).toBe('https://api.meshy.ai/openapi/v2/text-to-3d');
    expect(body(harness.calls[0])).toMatchObject({
      mode: 'preview',
      prompt: 'a futuristic robot warrior',
      ai_model: 'meshy-6',
      should_remesh: true,
      target_polycount: 100000,
      pose_mode: 'a-pose',
      target_formats: ['glb'],
    });
    expect(harness.calls[2].url).toBe('https://api.meshy.ai/openapi/v2/text-to-3d');
    expect(body(harness.calls[2])).toMatchObject({
      mode: 'refine',
      preview_task_id: 'preview-1',
      enable_pbr: true,
      ai_model: 'meshy-6',
      target_formats: ['glb'],
    });
    expect((harness.calls[0].init?.headers as any).Authorization).toContain('Bearer ');
    expect((harness.calls[4].init?.headers as any)?.Authorization).toBeUndefined();
  });

  it('runs Image-to-3D v1 from URL or data URI and downloads the final GLB', async () => {
    const glb = new Uint8Array([1, 2, 3, 4]);
    const harness = makeHarness([
      jsonResponse({ result: 'image-1' }),
      jsonResponse({ id: 'image-1', type: 'image-to-3d', status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.meshy.ai/image.glb?Expires=3' } }),
      binaryResponse(glb),
    ]);

    const created = await harness.provider.createTask({
      requestId: 'image-1',
      kind: 'image-to-3d',
      options: {
        imageUrl: 'data:image/png;base64,AAAA',
        shouldTexture: false,
        imageEnhancement: false,
        targetFormats: ['glb'],
      },
    }, new AbortController().signal);
    expect(created).toMatchObject({ providerTaskId: 'image:image-1', status: 'queued' });
    const done = await harness.provider.readTask(created.providerTaskId);
    const downloaded = await harness.provider.downloadResult(done.result!);

    expect(harness.calls[0].url).toBe('https://api.meshy.ai/openapi/v1/image-to-3d');
    expect(body(harness.calls[0])).toMatchObject({
      image_url: 'data:image/png;base64,AAAA',
      should_texture: false,
      image_enhancement: false,
      target_formats: ['glb'],
    });
    expect(downloaded).toMatchObject({ mime: 'model/gltf-binary', label: 'image-to-3d.glb' });
    expect(downloaded.bytes).toEqual(glb);
  });

  it('returns actionable errors for missing credentials, unsupported options, provider failures, cancellations, and missing GLB URLs', async () => {
    const missingKey = makeHarness([], null);
    const noKey = await missingKey.provider.createTask({ requestId: 'no-key', kind: 'text-to-3d', prompt: 'crate' }, new AbortController().signal);
    expect(noKey).toMatchObject({ status: 'failed' });
    expect(noKey.error).toContain('API key');

    const unsupported = makeHarness([]);
    const badOption = await unsupported.provider.createTask({
      requestId: 'bad-option',
      kind: 'image-to-3d',
      options: { imageUrl: 'data:image/png;base64,AAAA', license: 'private' },
    }, new AbortController().signal);
    expect(badOption).toMatchObject({ status: 'failed' });
    expect(badOption.error).toContain('Unsupported Meshy option');

    const failed = makeHarness([
      jsonResponse({ result: 'image-failed' }),
      jsonResponse({ id: 'image-failed', status: 'FAILED', task_error: { message: 'provider rejected prompt' } }),
      jsonResponse({}),
      jsonResponse({ result: 'image-missing' }),
      jsonResponse({ id: 'image-missing', status: 'SUCCEEDED', model_urls: {} }),
    ]);
    const created = await failed.provider.createTask({ requestId: 'fail', kind: 'image-to-3d', options: { imageUrl: 'data:image/png;base64,AAAA' } }, new AbortController().signal);
    const failure = await failed.provider.readTask(created.providerTaskId);
    expect(failure).toMatchObject({ status: 'failed', error: 'provider rejected prompt' });

    const canceled = await failed.provider.cancelTask?.(created.providerTaskId);
    expect(canceled).toMatchObject({ status: 'canceled' });
    expect(failed.calls[2].url).toBe('https://api.meshy.ai/openapi/v1/image-to-3d/image-failed');
    expect(failed.calls[2].init?.method).toBe('DELETE');

    const missing = await failed.provider.createTask({ requestId: 'missing', kind: 'image-to-3d', options: { imageUrl: 'data:image/png;base64,AAAA' } }, new AbortController().signal);
    const missingGlb = await failed.provider.readTask(missing.providerTaskId);
    expect(missingGlb).toMatchObject({ status: 'failed' });
    expect(missingGlb.error).toContain('model_urls.glb');
  });

  it('does not expose the secret name incorrectly in host secret calls', async () => {
    const harness = makeHarness([
      jsonResponse({ result: 'preview-1' }),
    ]);
    await harness.provider.createTask({ requestId: 'secret-key', kind: 'text-to-3d', prompt: 'crate', options: { texture: false } }, new AbortController().signal);
    expect(MESHY_API_KEY_SECRET).toBe('apiKey');
    expect((harness.calls[0].init?.headers as any).Authorization).toContain('msy_dummy_api_key_for_test_mode_12345678');
  });

  it('preserves HTTP status details when Meshy returns a non-JSON error page', async () => {
    const harness = makeHarness([
      textResponse('<html>rate limited</html>', 429, 'Too Many Requests'),
    ]);

    const result = await harness.provider.createTask({ requestId: 'html-error', kind: 'text-to-3d', prompt: 'crate' }, new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Meshy API request failed (429)');
    expect(result.error).toContain('rate limited');
    expect(result.error).not.toContain('Unexpected token');
  });
});
