import { describe, expect, it } from 'vitest';
import { createGrokVideoGenerationProviderPlugin, GROK_VIDEO_API_KEY_SECRET, GROK_VIDEO_PROVIDER_ID } from './grokProvider';
import type { VideoGenerationProviderContext } from '../../../src/plugin-api/types';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function ctx(value = 'xai-key'): VideoGenerationProviderContext {
  return {
    readSecret: async (key) => ({ pluginId: 'video-artifacts.grok-video-provider', key, stored: true, value }),
    writeSecret: async (key) => ({ pluginId: 'video-artifacts.grok-video-provider', key, stored: true }),
    clearSecret: async (key) => ({ pluginId: 'video-artifacts.grok-video-provider', key, cleared: true }),
  };
}

describe('Grok video generation provider', () => {
  it('creates an xAI video job, maps request_id to providerTaskId, and downloads the temporary video URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith('/v1/videos/generations')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({ Authorization: `Bearer xai-key` });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'grok-imagine-video',
          prompt: 'a luminous city flythrough',
          duration: 6,
          aspect_ratio: '16:9',
        });
        return jsonResponse({ request_id: 'xai-request-1' });
      }
      if (href.endsWith('/v1/videos/xai-request-1')) {
        expect(init?.headers).toMatchObject({ Authorization: `Bearer xai-key` });
        return jsonResponse({
          request_id: 'xai-request-1',
          status: 'done',
          progress: 100,
          video: {
            url: 'https://temporary.example/video.mp4',
            duration: 6,
          },
          model: 'grok-imagine-video',
          respect_moderation: true,
        });
      }
      if (href === 'https://temporary.example/video.mp4') {
        return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18]), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const plugin = createGrokVideoGenerationProviderPlugin({ fetch: fetchImpl as typeof fetch });
    const provider = plugin.create(ctx());
    expect(plugin.providerId).toBe(GROK_VIDEO_PROVIDER_ID);
    expect(plugin.credentialSecretKey).toBe(GROK_VIDEO_API_KEY_SECRET);

    const created = await provider.createTask({
      requestId: 'clip-1',
      kind: 'text-to-video',
      prompt: 'a luminous city flythrough',
      options: { duration: 6, aspect_ratio: '16:9' },
    }, new AbortController().signal);
    expect(created).toMatchObject({ providerTaskId: 'xai-request-1', status: 'queued' });

    const done = await provider.readTask('xai-request-1');
    expect(done).toMatchObject({
      providerTaskId: 'xai-request-1',
      status: 'succeeded',
      result: {
        mime: 'video/mp4',
        url: 'https://temporary.example/video.mp4',
      },
    });
    expect(done.result?.metadata).toMatchObject({ provider: GROK_VIDEO_PROVIDER_ID });

    const downloaded = await provider.downloadResult(done.result!);
    expect(downloaded.mime).toBe('video/mp4');
    expect(downloaded.bytes).toBeInstanceOf(Uint8Array);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.x.ai/v1/videos/generations',
      'https://api.x.ai/v1/videos/xai-request-1',
      'https://temporary.example/video.mp4',
    ]);
  });

  it('maps failed, expired, and moderation-like provider failures to actionable generic snapshots', async () => {
    const responses = new Map<string, unknown>([
      ['failed', { status: 'failed', error: { message: 'moderation blocked prompt' } }],
      ['expired', { status: 'expired' }],
      ['pending', { status: 'pending', progress: 25 }],
    ]);
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const id = String(url).split('/').pop() ?? '';
      return jsonResponse({ request_id: id, ...responses.get(id) });
    };
    const provider = createGrokVideoGenerationProviderPlugin({ fetch: fetchImpl as typeof fetch }).create(ctx());

    await expect(provider.readTask('failed')).resolves.toMatchObject({
      providerTaskId: 'failed',
      status: 'failed',
      error: 'moderation blocked prompt',
    });
    await expect(provider.readTask('expired')).resolves.toMatchObject({
      providerTaskId: 'expired',
      status: 'expired',
      error: expect.stringContaining('expired'),
    });
    await expect(provider.readTask('pending')).resolves.toMatchObject({
      providerTaskId: 'pending',
      status: 'running',
      progress: 25,
    });
  });
});
