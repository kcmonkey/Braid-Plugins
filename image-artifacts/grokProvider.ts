import type {
  ImageGenerationProvider,
  ImageGenerationProviderContext,
  ImageGenerationProviderPlugin,
  ImageGenerationRequest,
  ImageGenerationResult,
  PluginManifest,
} from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;
export const GROK_IMAGE_PROVIDER_ID = 'grok-image';
export const GROK_IMAGE_API_KEY_SECRET = 'apiKey';
export const GROK_IMAGE_API_KEY_SCOPED_SECRET = `plugin:image-artifacts.grok-provider:secret:${GROK_IMAGE_API_KEY_SECRET}`;
const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_IMAGE_MODEL = 'grok-imagine-image';

type FetchLike = typeof fetch;

interface GrokImageProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): any {
  try { return text ? JSON.parse(text) : {}; }
  catch { return {}; }
}

function imageMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6) {
    const head = ascii(bytes, 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('ascii');
}

function contentTypeImage(raw: string | null): string | undefined {
  const mime = raw?.split(';')[0]?.trim().toLowerCase();
  return mime?.startsWith('image/') ? mime : undefined;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

class GrokImageProvider implements ImageGenerationProvider {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly ctx: ImageGenerationProviderContext, options: GrokImageProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? XAI_BASE_URL;
  }

  async generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<ImageGenerationResult> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('Grok Image generation requires a prompt.');
    const secret = await this.ctx.readSecret(GROK_IMAGE_API_KEY_SECRET);
    if (secret.error) throw new Error(secret.error);
    if (!secret.stored || !secret.value) throw new Error('Grok Image API key is not configured. Configure the service-scoped apiKey secret before generating images.');

    const response = await this.fetchImpl(new URL('/v1/images/generations', this.baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.value}` },
      body: JSON.stringify({ model: XAI_IMAGE_MODEL, prompt }),
      signal,
    });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      const message = typeof json?.message === 'string'
        ? json.message
        : typeof json?.error === 'string'
          ? json.error
          : stripHtml(text) || response.statusText;
      throw new Error(`Grok Image API request failed (${response.status}): ${message}`);
    }
    const item = Array.isArray(json?.data) ? json.data[0] : undefined;
    if (!item) throw new Error('Grok Image generation returned no image data.');
    const image = await this.imageBytesFromItem(item, signal);
    if (!image) throw new Error('Grok Image generation returned an unsupported or missing image payload.');
    return {
      bytes: image.bytes,
      mime: image.mime,
      label: stringField(item?.revised_prompt) ?? `${request.requestId}.png`,
      metadata: { provider: GROK_IMAGE_PROVIDER_ID },
    };
  }

  private async imageBytesFromItem(item: any, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const b64 = stringField(item?.b64_json);
    if (b64) {
      const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
      const mime = imageMimeFromBytes(bytes) ?? stringField(item?.mime_type) ?? 'image/png';
      return mime.startsWith('image/') ? { bytes, mime } : null;
    }

    const url = stringField(item?.url);
    if (!url) return null;
    const response = await this.fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Grok Image download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = imageMimeFromBytes(bytes) ?? contentTypeImage(response.headers.get('Content-Type')) ?? 'image/jpeg';
    return { bytes, mime };
  }
}

export function createGrokImageGenerationProviderPlugin(options: GrokImageProviderOptions = {}): ImageGenerationProviderPlugin {
  return {
    id: 'image-artifacts.grok-provider',
    label: 'Grok Image API key',
    manifest,
    providerId: GROK_IMAGE_PROVIDER_ID,
    credentialSecretKey: GROK_IMAGE_API_KEY_SECRET,
    capabilities: {
      supportedOutputMimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      requiresCostConfirmation: true,
      options: [],
    },
    create: (ctx) => new GrokImageProvider(ctx, options),
  };
}

export const grokImageGenerationProviderPlugin = createGrokImageGenerationProviderPlugin();
