import type {
  AgentToolContext,
  AudioGenerationRequest,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  PluginEventInput,
  PluginManifest,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationProducerKind, AudioGenerationKind, EngineId } from '../../../src/protocol';
import {
  artifactGenerationDefaultFor,
  artifactGenerationServiceSupports,
  engineAudioServiceId,
  parseEngineAudioServiceId,
  parseEngineAudioServiceKind,
  parseEngineAudioServiceModel,
} from '../../../src/artifactGeneration';
import manifestJson from './plugin.json';
import { AUDIO_DATA_TYPE, AUDIO_DEFAULT_MIME } from './artifactType';
import { createAudioGenerateAgentTools, type AudioGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'audio-request:';

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

interface AudioDriverRecord {
  requestKey: string;
  /** Absent only in persisted pre-Agent records. */
  agentId?: string;
  canvasId?: string;
  boardId?: string;
  turnIndex: number;
  providerId: string;
  request: AudioGenerationRequest;
  status: DriverStatus;
  artifactId?: string;
  error?: string;
}

interface AudioServiceTarget {
  providerId: string;
  engine: EngineId;
  kind: AudioGenerationKind;
  producerKind: ArtifactGenerationProducerKind;
  requiresCostConfirmation: boolean;
}

function producerKindFor(kind: AudioGenerationKind): ArtifactGenerationProducerKind {
  if (kind === 'speech') return 'audio.speech';
  if (kind === 'sound-effect') return 'audio.soundEffect';
  return 'audio.music';
}

function kindLabel(kind: AudioGenerationKind): string {
  if (kind === 'speech') return 'Speech';
  if (kind === 'sound-effect') return 'Sound Effect';
  return 'Music';
}

function canonicalProviderId(providerId: string): string {
  const engine = parseEngineAudioServiceId(providerId);
  const kind = parseEngineAudioServiceKind(providerId);
  if (!engine || !kind) return providerId;
  return engineAudioServiceId(engine, parseEngineAudioServiceModel(providerId), kind);
}

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

function asRecord(value: unknown): AudioDriverRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as AudioDriverRecord;
  if (!candidate.requestKey || !candidate.providerId || !candidate.request) return undefined;
  const providerId = canonicalProviderId(candidate.providerId);
  const request = candidate.request as unknown as { kind?: AudioGenerationKind; input?: unknown; prompt?: unknown } & Record<string, unknown>;
  if (!request.kind && typeof request.input === 'string') {
    // Persisted records from the pre-classification audio tool were always TTS.
    return { ...candidate, providerId, request: { ...request, kind: 'speech', input: request.input } as AudioGenerationRequest };
  }
  if (request.kind !== 'speech' && request.kind !== 'sound-effect' && request.kind !== 'music') return undefined;
  if (request.kind === 'speech' ? typeof request.input !== 'string' : typeof request.prompt !== 'string') return undefined;
  return providerId === candidate.providerId ? candidate : { ...candidate, providerId };
}

class AudioArtifactsHostService implements HostService {
  id = 'audio-artifacts.hostService';
  label = 'Audio Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, AudioDriverRecord>();
  private readonly inFlight = new Map<string, { agentId: string; kind: AudioGenerationKind; promise: Promise<AgentToolResult> }>();

  constructor(private readonly host: HostServiceContext) {}

  agentTools() {
    return createAudioGenerateAgentTools(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) });
  }

  private async configuredService(ctx: AgentToolContext, kind: AudioGenerationKind): Promise<{ target?: AudioServiceTarget; error?: string }> {
    const producerKind = producerKindFor(kind);
    const serviceId = artifactGenerationDefaultFor(this.host.artifactDefaults(ctx.canvasId), producerKind);
    if (!serviceId) {
      return {
        error: `No default ${kindLabel(kind)} generation service is configured. Choose one in Braid Settings > Artifact Defaults.`,
      };
    }
    const engine = parseEngineAudioServiceId(serviceId);
    if (!engine || !this.host.generateAudioWithEngine) {
      return {
        error: `The configured ${kindLabel(kind)} generation service '${serviceId}' is unavailable in this host.`,
      };
    }
    const serviceKind = parseEngineAudioServiceKind(serviceId);
    if (serviceKind && serviceKind !== kind) {
      return { error: `The configured service '${serviceId}' is a ${kindLabel(serviceKind)} producer, not ${kindLabel(kind)}.` };
    }
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === serviceId);
    if (!service || !artifactGenerationServiceSupports(service, producerKind)) {
      return { error: `The configured service '${serviceId}' is not advertised for ${kindLabel(kind)} generation.` };
    }
    return { target: { providerId: serviceId, engine, kind, producerKind, requiresCostConfirmation: service.requiresCostConfirmation !== false } };
  }

  private requestKey(ctx: AgentToolContext, providerId: string, req: AudioGenerateToolRequest): string {
    if (req.requestId) return req.requestId;
    return `agent:${ctx.agentId}:${ctx.turnIndex}:${shortHash(stableJson({
      providerId,
      kind: req.kind,
      content: req.kind === 'speech' ? req.input ?? '' : req.prompt ?? '',
      options: req.options ?? {},
    }))}`;
  }

  private result(ok: boolean, body: unknown): AgentToolResult {
    return { ok, result: JSON.stringify(body, null, 2) };
  }

  private async validateEngineCapability(ctx: AgentToolContext, target: AudioServiceTarget, request: AudioGenerationRequest): Promise<string | undefined> {
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    if (!service || !artifactGenerationServiceSupports(service, target.producerKind)) {
      return `The configured service '${target.providerId}' is not advertised for ${kindLabel(request.kind)} generation.`;
    }
    if (target.engine !== 'openrouter') return undefined;
    if (request.kind === 'sound-effect') {
      return 'OpenRouter does not advertise a Sound Effect generation endpoint. Configure a compatible provider in Braid Settings > Artifact Defaults.';
    }
    const model = stringField(request.options?.model);
    if (!model) {
      return request.kind === 'speech'
        ? 'OpenRouter speech generation requires a speech-capable model in request options.'
        : 'OpenRouter Music generation requires a music-capable model in request options.';
    }
    const expectedProducerKind = producerKindFor(request.kind);
    const expectedEndpoint = request.kind === 'speech' ? '/audio/speech' : '/chat/completions';
    const scopes = service?.capabilityScopes ?? [];
    const supported = scopes.some((scope) => scope.provider === 'openrouter'
      && scope.dataType === AUDIO_DATA_TYPE
      && (scope.producerKind ?? 'audio.speech') === expectedProducerKind
      && scope.endpoint === expectedEndpoint
      && scope.model === model);
    if (!supported) {
      const capabilityLabel = request.kind === 'speech' ? 'speech' : 'Music';
      return `OpenRouter model '${model}' is not advertised as ${capabilityLabel}-capable for the ${expectedEndpoint} endpoint. Choose a model from Braid Settings > Artifact Defaults.`;
    }
    return undefined;
  }

  private async openRouterDefaultModel(ctx: AgentToolContext, target: AudioServiceTarget): Promise<string | undefined> {
    if (target.engine !== 'openrouter' || target.kind === 'sound-effect') return undefined;
    const scopedModel = parseEngineAudioServiceModel(target.providerId);
    if (scopedModel) return scopedModel;
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    const expectedEndpoint = target.kind === 'speech' ? '/audio/speech' : '/chat/completions';
    return service?.capabilityScopes?.find((scope) => scope.provider === 'openrouter'
      && scope.dataType === AUDIO_DATA_TYPE
      && (scope.producerKind ?? 'audio.speech') === target.producerKind
      && scope.endpoint === expectedEndpoint
      && stringField(scope.model))?.model;
  }

  private async withOpenRouterDefaultModel(ctx: AgentToolContext, target: AudioServiceTarget, request: AudioGenerationRequest): Promise<AudioGenerationRequest> {
    if (target.engine !== 'openrouter' || stringField(request.options?.model)) return request;
    const model = await this.openRouterDefaultModel(ctx, target);
    return model ? { ...request, options: { ...(request.options ?? {}), model } } : request;
  }

  private async readRecord(requestKey: string): Promise<AudioDriverRecord | undefined> {
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

  private async writeRecord(record: AudioDriverRecord, kind = 'audio-generation-record'): Promise<void> {
    this.records.set(record.requestKey, record);
    const event: PluginEventInput = {
      kind,
      payload: record,
      timestamp: new Date().toISOString(),
    };
    await this.host.appendPluginEvent(manifest.id, aggregateId(record.requestKey), event);
  }

  private async handleGenerate(ctx: AgentToolContext, req: AudioGenerateToolRequest): Promise<AgentToolResult> {
    if (!ctx.agentId) return this.result(false, { error: 'Audio generation requires an exact executing Agent identity.' });
    if (req.optionsJson && !req.options) {
      return this.result(false, { error: 'optionsJson must be a valid JSON object.' });
    }
    const content = req.kind === 'speech' ? req.input?.trim() : req.prompt?.trim();
    if (!content) {
      return this.result(false, {
        error: req.kind === 'speech'
          ? 'Input text is required for Speech generation.'
          : `A prompt is required for ${kindLabel(req.kind)} generation.`,
      });
    }
    const existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    if (existingById && (existingById.agentId ? existingById.agentId !== ctx.agentId
      : ctx.presentation === 'headless' || !ctx.canvasId || !ctx.boardId || existingById.canvasId !== ctx.canvasId || existingById.boardId !== ctx.boardId)) {
      return this.result(false, { requestId: req.requestId, error: 'This generation request belongs to another Agent or legacy presentation.' });
    }
    if (existingById && existingById.request.kind !== req.kind) {
      return this.result(false, {
        requestId: req.requestId,
        error: `Request '${req.requestId}' belongs to ${kindLabel(existingById.request.kind)} generation and cannot be reused for ${kindLabel(req.kind)}.`,
      });
    }
    const configured = existingById ? undefined : await this.configuredService(ctx, req.kind);
    const target = existingById
      ? (() => {
        const engine = parseEngineAudioServiceId(existingById.providerId);
        const kind = existingById.request.kind;
        return engine && this.host.generateAudioWithEngine
          ? { providerId: existingById.providerId, engine, kind, producerKind: producerKindFor(kind), requiresCostConfirmation: true }
          : undefined;
      })()
      : configured?.target;
    if (!target) {
      const error = existingById
        ? `The recorded ${kindLabel(existingById.request.kind)} generation service '${existingById.providerId}' is unavailable.`
        : configured?.error ?? `No ${kindLabel(req.kind)} generation provider is available.`;
      return this.result(false, { error });
    }
    const requestKey = existingById?.requestKey ?? this.requestKey(ctx, target.providerId, req);
    const alreadyRunning = this.inFlight.get(requestKey);
    if (alreadyRunning) {
      if (alreadyRunning.agentId !== ctx.agentId) return this.result(false, { requestId: requestKey, error: 'This generation request belongs to another Agent.' });
      if (alreadyRunning.kind !== req.kind) {
        return this.result(false, {
          requestId: requestKey,
          error: `Request '${requestKey}' is already running as ${kindLabel(alreadyRunning.kind)} generation and cannot run as ${kindLabel(req.kind)}.`,
        });
      }
      return alreadyRunning.promise;
    }
    const running = this.dispatchGenerate(ctx, req, target, requestKey, existingById)
      .finally(() => this.inFlight.delete(requestKey));
    this.inFlight.set(requestKey, { agentId: ctx.agentId, kind: req.kind, promise: running });
    return running;
  }

  private async dispatchGenerate(
    ctx: AgentToolContext,
    req: AudioGenerateToolRequest,
    target: AudioServiceTarget,
    requestKey: string,
    existingById: AudioDriverRecord | undefined,
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
    const content = req.kind === 'speech' ? req.input!.trim() : req.prompt!.trim();
    const base = { requestId: requestKey, options: req.options };
    const semanticRequest: AudioGenerationRequest = req.kind === 'speech'
      ? { ...base, kind: 'speech', input: content }
      : req.kind === 'sound-effect'
        ? { ...base, kind: 'sound-effect', prompt: content }
        : { ...base, kind: 'music', prompt: content };
    const request: AudioGenerationRequest = await this.withOpenRouterDefaultModel(ctx, target, semanticRequest);
    const capabilityError = await this.validateEngineCapability(ctx, target, request);
    if (capabilityError) return this.result(false, { requestId: requestKey, status: 'failed', error: capabilityError });
    let record = existing;
    if (!record) {
      record = {
        requestKey,
        agentId: ctx.agentId,
        canvasId: ctx.presentation === 'headless' ? undefined : ctx.canvasId,
        boardId: ctx.presentation === 'headless' ? undefined : ctx.boardId,
        turnIndex: ctx.turnIndex,
        providerId: target.providerId,
        request,
        status: 'pending',
      };
      await this.writeRecord(record, 'audio-generation-created');
    }
    try {
      const audio = await this.host.generateAudioWithEngine!(target.engine, record.request, ctx.signal);
      const produced = await this.host.produceArtifact(record.canvasId, record.boardId, {
        producerAgentId: ctx.agentId,
        source: 'born',
        dataType: AUDIO_DATA_TYPE,
        label: audio.label || `${requestKey}.mp3`,
        mime: audio.mime || AUDIO_DEFAULT_MIME,
        metadata: { ...(audio.metadata ?? {}), generationKind: record.request.kind },
        pluginId: manifest.id,
        bytes: audio.bytes,
        ...(req.attachToTurn !== false && ctx.presentation !== 'headless' && ctx.canvasId && ctx.boardId ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
      });
      if (produced.error || !produced.ref) {
        record = { ...record, status: 'failed', error: produced.error || 'Artifact production failed.' };
        await this.writeRecord(record, 'audio-generation-artifact-failed');
        return this.result(false, { requestId: requestKey, status: 'failed', error: record.error });
      }
      record = { ...record, status: 'succeeded', artifactId: produced.ref.id, error: undefined };
      await this.writeRecord(record, 'audio-generation-succeeded');
      return this.result(true, { requestId: requestKey, status: 'succeeded', artifact: produced.ref, path: produced.path });
    } catch (error: any) {
      record = { ...record, status: 'failed', error: String(error?.message ?? error) };
      await this.writeRecord(record, 'audio-generation-failed');
      return this.result(false, { requestId: requestKey, status: 'failed', error: record.error });
    }
  }

}

export const audioArtifactsHostServicePlugin: HostServicePlugin = {
  id: 'audio-artifacts.host-service',
  label: 'Audio Artifacts Host Service',
  manifest,
  create: (ctx) => new AudioArtifactsHostService(ctx),
};
