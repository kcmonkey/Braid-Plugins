import type {
  PluginManifest,
  VideoGenerationProvider,
  VideoGenerationProviderContext,
  VideoGenerationProviderPlugin,
  VideoGenerationRequest,
  VideoGenerationResultMetadata,
  VideoGenerationTaskSnapshot,
} from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;
export const GROK_VIDEO_PROVIDER_ID = 'grok-video';
export const GROK_VIDEO_API_KEY_SECRET = 'apiKey';
export const GROK_VIDEO_API_KEY_SCOPED_SECRET = `plugin:video-artifacts.grok-video-provider:secret:${GROK_VIDEO_API_KEY_SECRET}`;
const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_VIDEO_MODEL = 'grok-imagine-video';

type FetchLike = typeof fetch;

interface GrokVideoProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJson(text: string): any {
  try { return text ? JSON.parse(text) : {}; }
  catch { return {}; }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function errorFromJson(json: any, fallback: string): string {
  const direct = stringField(json?.message) ?? stringField(json?.error);
  if (direct) return direct;
  const nested = stringField(json?.error?.message) ?? stringField(json?.error?.type);
  if (nested) return nested;
  return fallback;
}

function contentTypeVideo(raw: string | null): string | undefined {
  const mime = raw?.split(';')[0]?.trim().toLowerCase();
  return mime?.startsWith('video/') ? mime : undefined;
}

function extensionForMime(mime: string): string {
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  return 'mp4';
}

function responseId(json: any, fallback: string): string {
  return stringField(json?.request_id) ?? stringField(json?.id) ?? fallback;
}

function normalizeStatus(status: unknown): VideoGenerationTaskSnapshot['status'] {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (value === 'done' || value === 'succeeded' || value === 'completed') return 'succeeded';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'expired') return 'expired';
  if (value === 'canceled' || value === 'cancelled') return 'canceled';
  if (value === 'queued' || value === 'pending' || value === 'running' || value === 'processing') return 'running';
  return 'running';
}

function outputLabel(requestId: string, mime: string): string {
  return `${requestId}.${extensionForMime(mime)}`;
}

function normalizedRequestBody(request: VideoGenerationRequest): Record<string, unknown> {
  const options = request.options ?? {};
  const model = stringField(options.model) ?? XAI_VIDEO_MODEL;
  const body: Record<string, unknown> = { model };
  if (request.prompt) body.prompt = request.prompt;
  const duration = numberField(options.duration);
  if (duration !== undefined) body.duration = duration;
  const aspectRatio = stringField(options.aspect_ratio) ?? stringField(options.aspectRatio);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  const resolution = stringField(options.resolution);
  if (resolution) body.resolution = resolution;
  return body;
}

class GrokVideoProvider implements VideoGenerationProvider {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly ctx: VideoGenerationProviderContext, options: GrokVideoProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? XAI_BASE_URL;
  }

  async createTask(request: VideoGenerationRequest, signal: AbortSignal): Promise<VideoGenerationTaskSnapshot> {
    if (request.kind !== 'text-to-video') throw new Error('Grok Video currently supports text-to-video requests.');
    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error('Grok Video generation requires a prompt.');
    const secret = await this.ctx.readSecret(GROK_VIDEO_API_KEY_SECRET);
    if (secret.error) throw new Error(secret.error);
    if (!secret.stored || !secret.value) throw new Error('Grok Video API key is not configured. Configure the service-scoped apiKey secret before generating videos.');

    const response = await this.fetchImpl(new URL('/v1/videos/generations', this.baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.value}` },
      body: JSON.stringify(normalizedRequestBody({ ...request, prompt })),
      signal,
    });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      throw new Error(`Grok Video API request failed (${response.status}): ${errorFromJson(json, stripHtml(text) || response.statusText)}`);
    }
    const providerTaskId = stringField(json?.request_id);
    if (!providerTaskId) throw new Error('Grok Video API did not return a request_id.');
    return { providerTaskId, status: 'queued' };
  }

  async readTask(providerTaskId: string, signal?: AbortSignal): Promise<VideoGenerationTaskSnapshot> {
    const secret = await this.ctx.readSecret(GROK_VIDEO_API_KEY_SECRET);
    if (secret.error) throw new Error(secret.error);
    if (!secret.stored || !secret.value) throw new Error('Grok Video API key is not configured. Configure the service-scoped apiKey secret before reading video task status.');
    const response = await this.fetchImpl(new URL(`/v1/videos/${encodeURIComponent(providerTaskId)}`, this.baseUrl).toString(), {
      headers: { Authorization: `Bearer ${secret.value}` },
      signal,
    });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      throw new Error(`Grok Video status request failed (${response.status}): ${errorFromJson(json, stripHtml(text) || response.statusText)}`);
    }

    const requestId = responseId(json, providerTaskId);
    const status = normalizeStatus(json?.status);
    if (status === 'failed') {
      return { providerTaskId: requestId, status, error: errorFromJson(json, 'Grok Video generation failed.') };
    }
    if (status === 'expired') {
      return { providerTaskId: requestId, status, error: 'Grok Video generation expired before the temporary result could be downloaded.' };
    }
    if (status === 'canceled') {
      return { providerTaskId: requestId, status, error: 'Grok Video generation was canceled.' };
    }
    if (status !== 'succeeded') {
      return {
        providerTaskId: requestId,
        status: 'running',
        ...(typeof json?.progress === 'number' ? { progress: json.progress } : {}),
      };
    }

    const url = stringField(json?.video?.url);
    if (!url) return { providerTaskId: requestId, status: 'failed', error: 'Grok Video generation completed without a downloadable video URL.' };
    const mime = stringField(json?.video?.mime_type) ?? 'video/mp4';
    const result: VideoGenerationResultMetadata = {
      mime: mime.startsWith('video/') ? mime : 'video/mp4',
      format: extensionForMime(mime),
      label: outputLabel(requestId, mime),
      url,
      metadata: {
        provider: GROK_VIDEO_PROVIDER_ID,
        model: stringField(json?.model),
        duration: numberField(json?.video?.duration),
        progress: numberField(json?.progress),
        respectModeration: typeof json?.respect_moderation === 'boolean' ? json.respect_moderation : undefined,
      },
    };
    return { providerTaskId: requestId, status: 'succeeded', progress: 100, result };
  }

  async downloadResult(result: VideoGenerationResultMetadata, signal?: AbortSignal) {
    const url = stringField(result.url);
    if (!url) throw new Error('Grok Video result did not include a temporary URL to download.');
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Grok Video download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = contentTypeVideo(response.headers.get('Content-Type')) ?? result.mime ?? 'video/mp4';
    return {
      bytes,
      mime,
      label: result.label ?? outputLabel('grok-video', mime),
      metadata: result.metadata,
    };
  }
}

export function createGrokVideoGenerationProviderPlugin(options: GrokVideoProviderOptions = {}): VideoGenerationProviderPlugin {
  return {
    id: 'video-artifacts.grok-video-provider',
    label: 'Grok Video API key',
    manifest,
    providerId: GROK_VIDEO_PROVIDER_ID,
    credentialSecretKey: GROK_VIDEO_API_KEY_SECRET,
    capabilities: {
      textToVideo: true,
      supportedOutputMimes: ['video/mp4', 'video/webm', 'video/quicktime'],
      supportsCancellation: false,
      requiresCostConfirmation: true,
      options: ['model', 'duration', 'aspect_ratio', 'aspectRatio', 'resolution'],
    },
    create: (ctx) => new GrokVideoProvider(ctx, options),
  };
}

export const grokVideoGenerationProviderPlugin = createGrokVideoGenerationProviderPlugin();
