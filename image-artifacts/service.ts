import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  ImageGenerationProviderPlugin,
  ImageGenerationRequest,
  PluginEventInput,
  PluginManifest,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId } from '../../../src/protocol';
import { artifactGenerationDefaultFor, parseEngineImageServiceId, parseEngineImageServiceModel } from '../../../src/artifactGeneration';
import manifestJson from './plugin.json';
import { createImageGenerateAgentTool, type ImageGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'image-request:';

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

interface ImageDriverRecord {
  requestKey: string;
  canvasId: string;
  boardId: string;
  turnIndex: number;
  providerId: string;
  request: ImageGenerationRequest;
  status: DriverStatus;
  artifactId?: string;
  error?: string;
}

interface ImageServiceTarget {
  providerId: string;
  plugin?: ImageGenerationProviderPlugin;
  engine?: EngineId;
  requiresCostConfirmation: boolean;
}

export type ImageGenerationProviderResolver = (serviceId: string) => ImageGenerationProviderPlugin | undefined;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function aggregateId(requestKey: string): string {
  return `${AGGREGATE_PREFIX}${requestKey}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): ImageDriverRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as ImageDriverRecord;
  if (!candidate.requestKey || !candidate.providerId || !candidate.request) return undefined;
  return candidate;
}

class ImageArtifactsHostService implements HostService {
  id = 'image-artifacts.hostService';
  label = 'Image Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, ImageDriverRecord>();
  private readonly inFlight = new Map<string, Promise<AgentToolResult>>();

  constructor(
    private readonly host: HostServiceContext,
    private readonly resolveProvider: ImageGenerationProviderResolver,
  ) {}

  agentTools() {
    return [createImageGenerateAgentTool(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) })];
  }

  async onBoardAbort(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, 'Image generation request was interrupted; re-run image_generate with the same requestId to resume.');
  }

  async onRunError(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, event.message || 'Image generation request was interrupted; re-run image_generate with the same requestId to resume.');
  }

  private providerContext(plugin: ImageGenerationProviderPlugin) {
    return {
      readSecret: (key: string) => this.host.readSecret(plugin.id, key),
      writeSecret: (key: string, value: string) => this.host.writeSecret(plugin.id, key, value),
      clearSecret: (key: string) => this.host.clearSecret(plugin.id, key),
    };
  }

  private providerById(serviceId: string): ImageGenerationProviderPlugin | undefined {
    const normalized = serviceId.trim();
    if (!normalized) return undefined;
    return this.resolveProvider(normalized);
  }

  private configuredService(ctx: AgentToolContext): { target?: ImageServiceTarget; error?: string } {
    const serviceId = artifactGenerationDefaultFor(this.host.artifactDefaults(ctx.canvasId), 'image');
    if (!serviceId) {
      return {
        error: 'No default image generation service is configured. Choose one in Braid Settings > Artifact Defaults.',
      };
    }
    const engine = parseEngineImageServiceId(serviceId);
    if (engine) {
      if (!this.host.generateImageWithEngine) {
        return {
          error: `The configured image generation service '${serviceId}' is unavailable in this host.`,
        };
      }
      return { target: { providerId: serviceId, engine, requiresCostConfirmation: true } };
    }
    const plugin = this.providerById(serviceId);
    if (!plugin) {
      return {
        error: `The configured image generation service '${serviceId}' is unavailable. Choose a valid service in Braid Settings > Artifact Defaults.`,
      };
    }
    return { target: { providerId: plugin.providerId, plugin, requiresCostConfirmation: plugin.capabilities.requiresCostConfirmation !== false } };
  }

  private requestKey(ctx: AgentToolContext, providerId: string, req: ImageGenerateToolRequest): string {
    if (req.requestId) return req.requestId;
    return `${ctx.canvasId}:${ctx.boardId}:${ctx.turnIndex}:${shortHash(stableJson({
      providerId,
      prompt: req.prompt ?? '',
      options: req.options ?? {},
    }))}`;
  }

  private result(ok: boolean, body: unknown): AgentToolResult {
    return { ok, result: JSON.stringify(body, null, 2) };
  }

  private async validateEngineCapability(ctx: AgentToolContext, target: ImageServiceTarget, request: ImageGenerationRequest): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const model = stringField(request.options?.model);
    if (!model) return 'OpenRouter image generation requires an image-capable model in request options.';
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    const scopes = service?.capabilityScopes ?? [];
    const supported = scopes.some((scope) => scope.provider === 'openrouter'
      && scope.dataType === 'image'
      && scope.endpoint === '/images'
      && scope.model === model);
    if (!supported) {
      return `OpenRouter model '${model}' is not advertised as image-capable for the /images endpoint. Choose a model from Braid Settings > Artifact Defaults.`;
    }
    return undefined;
  }

  private async openRouterDefaultModel(ctx: AgentToolContext, target: ImageServiceTarget): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const scopedModel = parseEngineImageServiceModel(target.providerId);
    if (scopedModel) return scopedModel;
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    return service?.capabilityScopes?.find((scope) => scope.provider === 'openrouter'
      && scope.dataType === 'image'
      && scope.endpoint === '/images'
      && stringField(scope.model))?.model;
  }

  private async withOpenRouterDefaultModel(ctx: AgentToolContext, target: ImageServiceTarget, request: ImageGenerationRequest): Promise<ImageGenerationRequest> {
    if (target.engine !== 'openrouter' || stringField(request.options?.model)) return request;
    const model = await this.openRouterDefaultModel(ctx, target);
    return model ? { ...request, options: { ...(request.options ?? {}), model } } : request;
  }

  private async readRecord(requestKey: string): Promise<ImageDriverRecord | undefined> {
    const cached = this.records.get(requestKey);
    if (cached) return cached;
    const aggregate = await this.host.readPluginAggregate(manifest.id, aggregateId(requestKey));
    if (aggregate.error || !aggregate.events?.length) return undefined;
    for (let i = aggregate.events.length - 1; i >= 0; i -= 1) {
      const record = asRecord(aggregate.events[i]?.payload);
      if (record) {
        this.records.set(requestKey, record);
        return record;
      }
    }
    return undefined;
  }

  private async writeRecord(record: ImageDriverRecord, kind = 'image-generation-record'): Promise<void> {
    this.records.set(record.requestKey, record);
    const event: PluginEventInput = {
      kind,
      payload: record,
      timestamp: new Date().toISOString(),
    };
    await this.host.appendPluginEvent(manifest.id, aggregateId(record.requestKey), event);
  }

  private async handleGenerate(ctx: AgentToolContext, req: ImageGenerateToolRequest): Promise<AgentToolResult> {
    if (!req.prompt?.trim()) return this.result(false, { error: 'A prompt is required for image generation.' });
    const existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    const configured = existingById ? undefined : this.configuredService(ctx);
    const existingEngine = existingById ? parseEngineImageServiceId(existingById.providerId) : undefined;
    const target = existingById
      ? (existingEngine
        ? this.host.generateImageWithEngine
          ? { providerId: existingById.providerId, engine: existingEngine, requiresCostConfirmation: true }
          : undefined
        : (() => {
          const plugin = this.providerById(existingById.providerId);
          return plugin ? { providerId: plugin.providerId, plugin, requiresCostConfirmation: plugin.capabilities.requiresCostConfirmation !== false } : undefined;
        })())
      : configured?.target;
    if (!target) {
      const error = existingById
        ? `The recorded image generation service '${existingById.providerId}' is unavailable.`
        : configured?.error ?? 'No image generation provider is available.';
      return this.result(false, { error });
    }
    const requestKey = existingById?.requestKey ?? this.requestKey(ctx, target.providerId, req);
    const alreadyRunning = this.inFlight.get(requestKey);
    if (alreadyRunning) return alreadyRunning;
    const running = this.dispatchGenerate(ctx, req, target, requestKey, existingById)
      .finally(() => this.inFlight.delete(requestKey));
    this.inFlight.set(requestKey, running);
    return running;
  }

  private async dispatchGenerate(
    ctx: AgentToolContext,
    req: ImageGenerateToolRequest,
    target: ImageServiceTarget,
    requestKey: string,
    existingById: ImageDriverRecord | undefined,
  ): Promise<AgentToolResult> {
    const existing = existingById ?? await this.readRecord(requestKey);
    if (existing?.status === 'succeeded') return this.result(true, { requestId: requestKey, status: 'succeeded', artifactId: existing.artifactId, reused: true });
    if (existing?.status === 'failed' || existing?.status === 'canceled') {
      return this.result(false, { requestId: requestKey, status: existing.status, error: existing.error || 'Request is no longer active.', reused: true });
    }
    if (!existing && target.requiresCostConfirmation && req.confirmCost !== true) {
      return this.result(false, {
        requestId: requestKey,
        error: 'This provider may consume paid credits. Re-run with confirmCost: true to dispatch it.',
      });
    }

    const request: ImageGenerationRequest = await this.withOpenRouterDefaultModel(ctx, target, {
      requestId: requestKey,
      prompt: req.prompt!.trim(),
      options: req.options,
    });
    const capabilityError = await this.validateEngineCapability(ctx, target, request);
    if (capabilityError) return this.result(false, { requestId: requestKey, status: 'failed', error: capabilityError });
    let record = existing;
    if (!record) {
      record = {
        requestKey,
        canvasId: ctx.canvasId,
        boardId: ctx.boardId,
        turnIndex: ctx.turnIndex,
        providerId: target.providerId,
        request,
        status: 'pending',
      };
      await this.writeRecord(record, 'image-generation-created');
    }

    try {
      const image = target.plugin
        ? await target.plugin.create(this.providerContext(target.plugin)).generate(record.request, ctx.signal)
        : await this.host.generateImageWithEngine!(target.engine!, record.request, ctx.signal);
      const produced = await this.host.produceArtifact(ctx.canvasId, ctx.boardId, {
        source: 'born',
        dataType: 'image',
        label: image.label || `${requestKey}.png`,
        mime: image.mime || 'image/png',
        ...(image.metadata ? { metadata: image.metadata } : {}),
        pluginId: manifest.id,
        bytes: image.bytes,
        ...(req.attachToTurn !== false ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
      });
      if (produced.error || !produced.ref) {
        record = { ...record, status: 'failed', error: produced.error || 'Artifact production failed.' };
        await this.writeRecord(record, 'image-generation-artifact-failed');
        return this.result(false, { requestId: requestKey, status: 'failed', error: record.error });
      }
      record = { ...record, status: 'succeeded', artifactId: produced.ref.id, error: undefined };
      await this.writeRecord(record, 'image-generation-succeeded');
      return this.result(true, { requestId: requestKey, status: 'succeeded', artifact: produced.ref, path: produced.path });
    } catch (error: any) {
      record = { ...record, status: 'failed', error: String(error?.message ?? error) };
      await this.writeRecord(record, 'image-generation-failed');
      return this.result(false, { requestId: requestKey, status: 'failed', error: record.error });
    }
  }

  private async releaseLiveBoardRecords(event: HostRunBoardEvent, message: string): Promise<void> {
    const updates = [...this.records.values()]
      .filter((record) => record.canvasId === event.canvasId && record.boardId === event.boardId && record.status === 'pending');
    for (const record of updates) {
      await this.writeRecord({ ...record, error: message }, 'image-generation-released');
      this.records.delete(record.requestKey);
    }
  }
}

export function createImageArtifactsHostServicePlugin(
  resolveProvider: ImageGenerationProviderResolver,
): HostServicePlugin {
  return {
    id: 'image-artifacts.host-service',
    label: 'Image Artifacts Host Service',
    manifest,
    create: (ctx) => new ImageArtifactsHostService(ctx, resolveProvider),
  };
}
