import type {
  ModelGenerationProvider,
  ModelGenerationProviderContext,
  ModelGenerationProviderPlugin,
  ModelGenerationRequest,
  ModelGenerationResultMetadata,
  ModelGenerationTaskSnapshot,
  PluginManifest,
} from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';
import { MODEL_3D_GLB_MIME } from './artifactType';

const manifest = manifestJson as PluginManifest;
export const MESHY_PROVIDER_ID = 'meshy';
export const MESHY_API_KEY_SECRET = 'apiKey';
const DEFAULT_BASE_URL = 'https://api.meshy.ai';

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

interface MeshyProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

interface MeshyTaskObject {
  id?: string;
  type?: string;
  status?: string;
  progress?: number;
  model_urls?: Record<string, string | undefined>;
  expires_at?: number;
  task_error?: { message?: string };
}

interface NormalizedOptions {
  preview: JsonObject;
  refine: JsonObject;
  image: JsonObject;
  shouldTexture: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function responseTaskId(value: unknown): string {
  if (!value || typeof value !== 'object') throw new Error('Meshy response did not include a task id.');
  const result = (value as { result?: unknown }).result;
  if (typeof result !== 'string' || !result.trim()) throw new Error('Meshy response did not include a task id.');
  return result;
}

function textPreviewTaskId(taskId: string, refine?: JsonObject): string {
  return refine ? `text-preview:${taskId}:${encodeJson(refine)}` : `text-preview:${taskId}`;
}

function textRefineTaskId(taskId: string): string {
  return `text-refine:${taskId}`;
}

function imageTaskId(taskId: string): string {
  return `image:${taskId}`;
}

function parseProviderTaskId(providerTaskId: string): { kind: 'text-preview' | 'text-refine' | 'image'; id: string; refine?: JsonObject } {
  const [kind, id, encoded] = providerTaskId.split(':');
  if ((kind !== 'text-preview' && kind !== 'text-refine' && kind !== 'image') || !id) {
    throw new Error(`Unsupported Meshy provider task id: ${providerTaskId}`);
  }
  return {
    kind,
    id,
    ...(encoded ? { refine: decodeJson<JsonObject>(encoded) } : {}),
  };
}

function readString(options: JsonObject, used: Set<string>, keys: string[], field: string, allowed?: string[], maxLength?: number): string | undefined {
  const found = keys.filter((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (!found.length) return undefined;
  for (const key of found) used.add(key);
  if (found.length > 1) throw new Error(`Use only one of ${found.join(', ')} for ${field}.`);
  const value = options[found[0]];
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (maxLength !== undefined && trimmed.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  if (allowed && !allowed.includes(trimmed)) throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  return trimmed;
}

function readBoolean(options: JsonObject, used: Set<string>, keys: string[], field: string): boolean | undefined {
  const found = keys.filter((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (!found.length) return undefined;
  for (const key of found) used.add(key);
  if (found.length > 1) throw new Error(`Use only one of ${found.join(', ')} for ${field}.`);
  const value = options[found[0]];
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`);
  return value;
}

function readInteger(options: JsonObject, used: Set<string>, keys: string[], field: string, min?: number, max?: number, allowed?: number[]): number | undefined {
  const found = keys.filter((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (!found.length) return undefined;
  for (const key of found) used.add(key);
  if (found.length > 1) throw new Error(`Use only one of ${found.join(', ')} for ${field}.`);
  const value = options[found[0]];
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  const numberValue = value as number;
  if (allowed && !allowed.includes(numberValue)) throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  if (min !== undefined && numberValue < min) throw new Error(`${field} must be at least ${min}.`);
  if (max !== undefined && numberValue > max) throw new Error(`${field} must be at most ${max}.`);
  return numberValue;
}

function readFormats(options: JsonObject, used: Set<string>): string[] {
  const found = ['target_formats', 'targetFormats'].filter((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (!found.length) return ['glb'];
  for (const key of found) used.add(key);
  if (found.length > 1) throw new Error('Use only one of target_formats or targetFormats.');
  const value = options[found[0]];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('target_formats must be an array of format strings.');
  }
  const formats = value.map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(['glb', 'obj', 'fbx', 'stl', 'usdz', '3mf']);
  const unsupported = formats.filter((item) => !allowed.has(item));
  if (unsupported.length) throw new Error(`Unsupported target format(s): ${unsupported.join(', ')}.`);
  if (!formats.includes('glb')) throw new Error('Meshy generation must request glb so Braid can produce a model-3d artifact.');
  return formats.length ? formats : ['glb'];
}

function assignIfDefined(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function normalizeOptions(options: JsonObject | undefined, kind: ModelGenerationRequest['kind']): NormalizedOptions {
  const input = options ?? {};
  const used = new Set<string>();
  const targetFormats = readFormats(input, used);
  const common: JsonObject = { target_formats: targetFormats };
  assignIfDefined(common, 'model_type', readString(input, used, ['model_type', 'modelType'], 'model_type', ['standard', 'lowpoly']));
  assignIfDefined(common, 'ai_model', readString(input, used, ['ai_model', 'aiModel'], 'ai_model', ['meshy-5', 'meshy-6', 'latest']));
  assignIfDefined(common, 'should_remesh', readBoolean(input, used, ['should_remesh', 'shouldRemesh'], 'should_remesh'));
  assignIfDefined(common, 'topology', readString(input, used, ['topology'], 'topology', ['quad', 'triangle']));
  assignIfDefined(common, 'target_polycount', readInteger(input, used, ['target_polycount', 'targetPolycount'], 'target_polycount', 100, 300_000));
  assignIfDefined(common, 'decimation_mode', readInteger(input, used, ['decimation_mode', 'decimationMode'], 'decimation_mode', undefined, undefined, [1, 2, 3, 4]));
  assignIfDefined(common, 'pose_mode', readString(input, used, ['pose_mode', 'poseMode'], 'pose_mode', ['a-pose', 't-pose', '']));
  assignIfDefined(common, 'moderation', readBoolean(input, used, ['moderation'], 'moderation'));
  assignIfDefined(common, 'auto_size', readBoolean(input, used, ['auto_size', 'autoSize'], 'auto_size'));
  assignIfDefined(common, 'alpha_thumbnail', readBoolean(input, used, ['alpha_thumbnail', 'alphaThumbnail'], 'alpha_thumbnail'));
  assignIfDefined(common, 'origin_at', readString(input, used, ['origin_at', 'originAt'], 'origin_at', ['bottom', 'center']));

  const shouldTexture = readBoolean(input, used, ['texture', 'should_texture', 'shouldTexture'], 'texture') !== false;
  const texture: JsonObject = {};
  assignIfDefined(texture, 'enable_pbr', readBoolean(input, used, ['enable_pbr', 'enablePbr'], 'enable_pbr'));
  assignIfDefined(texture, 'hd_texture', readBoolean(input, used, ['hd_texture', 'hdTexture'], 'hd_texture'));
  assignIfDefined(texture, 'texture_prompt', readString(input, used, ['texture_prompt', 'texturePrompt'], 'texture_prompt', undefined, 600));
  assignIfDefined(texture, 'texture_image_url', readString(input, used, ['texture_image_url', 'textureImageUrl'], 'texture_image_url'));
  assignIfDefined(texture, 'remove_lighting', readBoolean(input, used, ['remove_lighting', 'removeLighting'], 'remove_lighting'));

  const image: JsonObject = { ...common, ...texture };
  assignIfDefined(image, 'input_task_id', readString(input, used, ['input_task_id', 'inputTaskId'], 'input_task_id'));
  assignIfDefined(image, 'image_url', readString(input, used, ['image_url', 'imageUrl'], 'image_url'));
  assignIfDefined(image, 'should_texture', shouldTexture);
  assignIfDefined(image, 'save_pre_remeshed_model', readBoolean(input, used, ['save_pre_remeshed_model', 'savePreRemeshedModel'], 'save_pre_remeshed_model'));
  assignIfDefined(image, 'image_enhancement', readBoolean(input, used, ['image_enhancement', 'imageEnhancement'], 'image_enhancement'));
  assignIfDefined(image, 'multi_view_thumbnails', readBoolean(input, used, ['multi_view_thumbnails', 'multiViewThumbnails'], 'multi_view_thumbnails'));

  const refine: JsonObject = { target_formats: targetFormats, ...texture };
  assignIfDefined(refine, 'ai_model', common.ai_model);
  assignIfDefined(refine, 'moderation', common.moderation);
  assignIfDefined(refine, 'auto_size', common.auto_size);
  assignIfDefined(refine, 'alpha_thumbnail', common.alpha_thumbnail);
  assignIfDefined(refine, 'origin_at', common.origin_at);

  if (kind === 'text-to-3d') {
    const unsupported = Object.keys(input).filter((key) => !used.has(key));
    if (unsupported.length) throw new Error(`Unsupported Meshy option(s): ${unsupported.join(', ')}.`);
    return { preview: common, refine, image, shouldTexture };
  }

  const unsupported = Object.keys(input).filter((key) => !used.has(key));
  if (unsupported.length) throw new Error(`Unsupported Meshy option(s): ${unsupported.join(', ')}.`);
  return { preview: common, refine, image, shouldTexture };
}

function mapStatus(task: MeshyTaskObject): ModelGenerationTaskSnapshot['status'] {
  if (task.status === 'SUCCEEDED') return 'succeeded';
  if (task.status === 'FAILED') return 'failed';
  if (task.status === 'CANCELED') return 'canceled';
  if (task.status === 'PENDING') return 'queued';
  return 'running';
}

function taskError(task: MeshyTaskObject): string | undefined {
  return task.task_error?.message?.trim() || undefined;
}

function resultFromTask(task: MeshyTaskObject): ModelGenerationResultMetadata | undefined {
  const status = mapStatus(task);
  if (status !== 'succeeded') return undefined;
  const url = task.model_urls?.glb;
  if (!url) throw new Error('Meshy task succeeded but did not include model_urls.glb.');
  return {
    mime: MODEL_3D_GLB_MIME,
    format: 'glb',
    label: `${task.type || 'meshy-model'}.glb`,
    url,
    ...(task.expires_at ? { expiresAt: new Date(task.expires_at).toISOString() } : {}),
    metadata: {
      provider: MESHY_PROVIDER_ID,
      taskType: task.type,
      progress: task.progress,
    },
  };
}

class MeshyProvider implements ModelGenerationProvider {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly ctx: ModelGenerationProviderContext, options: MeshyProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async createTask(request: ModelGenerationRequest, signal: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    try {
      if (request.kind === 'image-to-3d') return await this.createImageTask(request, signal);
      return await this.createTextTask(request, signal);
    } catch (error) {
      return { providerTaskId: `meshy-error:${request.requestId}`, status: 'failed', error: errorMessage(error) };
    }
  }

  async readTask(providerTaskId: string, signal?: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    try {
      const parsed = parseProviderTaskId(providerTaskId);
      if (parsed.kind === 'image') return await this.readImageTask(parsed.id, signal);
      if (parsed.kind === 'text-refine') return await this.readTextTask(textRefineTaskId(parsed.id), parsed.id, signal);
      const preview = await this.readTextTask(providerTaskId, parsed.id, signal);
      if (preview.status !== 'succeeded' || !parsed.refine) return preview;
      const response = await this.apiJson('/openapi/v2/text-to-3d', {
        method: 'POST',
        body: JSON.stringify({ ...parsed.refine, mode: 'refine', preview_task_id: parsed.id }),
      }, signal);
      const refineId = responseTaskId(response);
      return { providerTaskId: textRefineTaskId(refineId), status: 'running', progress: 0 };
    } catch (error) {
      return { providerTaskId, status: 'failed', error: errorMessage(error) };
    }
  }

  async cancelTask(providerTaskId: string, signal?: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    try {
      const parsed = parseProviderTaskId(providerTaskId);
      const path = parsed.kind === 'image' ? `/openapi/v1/image-to-3d/${encodeURIComponent(parsed.id)}` : `/openapi/v2/text-to-3d/${encodeURIComponent(parsed.id)}`;
      await this.apiJson(path, { method: 'DELETE' }, signal);
      return { providerTaskId, status: 'canceled' };
    } catch (error) {
      return { providerTaskId, status: 'failed', error: errorMessage(error) };
    }
  }

  async downloadResult(result: ModelGenerationResultMetadata, signal?: AbortSignal) {
    if (!result.url) throw new Error('Meshy result did not include a GLB URL.');
    const response = await this.fetchImpl(result.url, { signal });
    if (!response.ok) throw new Error(`Meshy GLB download failed with ${response.status}.`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime: result.mime || MODEL_3D_GLB_MIME,
      label: result.label ?? 'meshy-model.glb',
      metadata: result.metadata,
    };
  }

  private async createTextTask(request: ModelGenerationRequest, signal: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    if (!request.prompt?.trim()) throw new Error('Meshy Text-to-3D requires a prompt.');
    if (request.prompt.length > 600) throw new Error('Meshy Text-to-3D prompt must be 600 characters or fewer.');
    const options = normalizeOptions(request.options, request.kind);
    const response = await this.apiJson('/openapi/v2/text-to-3d', {
      method: 'POST',
      body: JSON.stringify({ ...options.preview, mode: 'preview', prompt: request.prompt.trim() }),
    }, signal);
    const id = responseTaskId(response);
    return { providerTaskId: textPreviewTaskId(id, options.shouldTexture ? options.refine : undefined), status: 'queued', progress: 0 };
  }

  private async createImageTask(request: ModelGenerationRequest, signal: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    const options = normalizeOptions(request.options, request.kind);
    if (!options.image.image_url && !options.image.input_task_id) {
      throw new Error('Meshy Image-to-3D requires options.imageUrl as a public URL/data URI or options.inputTaskId.');
    }
    const response = await this.apiJson('/openapi/v1/image-to-3d', {
      method: 'POST',
      body: JSON.stringify(options.image),
    }, signal);
    const id = responseTaskId(response);
    return { providerTaskId: imageTaskId(id), status: 'queued', progress: 0 };
  }

  private async readTextTask(providerTaskId: string, taskId: string, signal?: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    const task = await this.apiJson(`/openapi/v2/text-to-3d/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal) as MeshyTaskObject;
    return this.snapshot(providerTaskId, task);
  }

  private async readImageTask(taskId: string, signal?: AbortSignal): Promise<ModelGenerationTaskSnapshot> {
    const task = await this.apiJson(`/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal) as MeshyTaskObject;
    return this.snapshot(imageTaskId(taskId), task);
  }

  private snapshot(providerTaskId: string, task: MeshyTaskObject): ModelGenerationTaskSnapshot {
    const status = mapStatus(task);
    return {
      providerTaskId,
      status,
      progress: task.progress,
      ...(status === 'succeeded' ? { result: resultFromTask(task) } : {}),
      ...(status === 'failed' ? { error: taskError(task) || 'Meshy task failed.' } : {}),
      ...(status === 'canceled' ? { error: taskError(task) || 'Meshy task was canceled.' } : {}),
    };
  }

  private async apiJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const secret = await this.ctx.readSecret(MESHY_API_KEY_SECRET);
    if (secret.error) throw new Error(secret.error);
    if (!secret.stored || !secret.value) {
      throw new Error('Meshy API key is not configured. Configure the service-scoped Meshy apiKey secret before generating models.');
    }
    const response = await this.fetchImpl(new URL(path, this.baseUrl).toString(), {
      ...init,
      signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${secret.value}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: any = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    if (!response.ok) {
      const message = typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : stripHtml(text) || response.statusText;
      throw new Error(`Meshy API request failed (${response.status}): ${message}`);
    }
    return body;
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function createMeshyModelGenerationProviderPlugin(options: MeshyProviderOptions = {}): ModelGenerationProviderPlugin {
  return {
    id: 'model-artifacts.meshy-provider',
    label: 'Meshy',
    manifest,
    providerId: MESHY_PROVIDER_ID,
    credentialSecretKey: MESHY_API_KEY_SECRET,
    capabilities: {
      textTo3d: true,
      imageTo3d: true,
      supportedOutputMimes: [MODEL_3D_GLB_MIME],
      supportsCancellation: true,
      requiresCostConfirmation: true,
      options: [
        'modelType', 'aiModel', 'shouldRemesh', 'topology', 'targetPolycount', 'decimationMode',
        'poseMode', 'texture', 'enablePbr', 'hdTexture', 'texturePrompt', 'textureImageUrl',
        'imageUrl', 'inputTaskId', 'imageEnhancement', 'removeLighting', 'autoSize',
        'alphaThumbnail', 'multiViewThumbnails', 'originAt', 'moderation',
      ],
    },
    create: (ctx) => new MeshyProvider(ctx, options),
  };
}

export const meshyModelGenerationProviderPlugin = createMeshyModelGenerationProviderPlugin();
