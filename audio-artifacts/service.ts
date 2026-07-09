import type {
  AgentToolContext,
  AudioGenerationRequest,
  HostRunBoardEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  PluginEventInput,
  PluginManifest,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId } from '../../../src/protocol';
import { artifactGenerationDefaultFor, parseEngineAudioServiceId, parseEngineAudioServiceModel } from '../../../src/artifactGeneration';
import manifestJson from './plugin.json';
import { AUDIO_DATA_TYPE, AUDIO_DEFAULT_MIME } from './artifactType';
import { createAudioGenerateAgentTool, type AudioGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'audio-request:';

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

interface AudioDriverRecord {
  requestKey: string;
  canvasId: string;
  boardId: string;
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
  requiresCostConfirmation: boolean;
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
  return candidate;
}

class AudioArtifactsHostService implements HostService {
  id = 'audio-artifacts.hostService';
  label = 'Audio Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, AudioDriverRecord>();
  private readonly inFlight = new Map<string, Promise<AgentToolResult>>();

  constructor(private readonly host: HostServiceContext) {}

  agentTools() {
    return [createAudioGenerateAgentTool(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) })];
  }

  async onBoardAbort(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, 'Audio generation request was interrupted; re-run audio_generate with the same requestId to resume.');
  }

  async onRunError(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, event.message || 'Audio generation request was interrupted; re-run audio_generate with the same requestId to resume.');
  }

  private configuredService(ctx: AgentToolContext): { target?: AudioServiceTarget; error?: string } {
    const serviceId = artifactGenerationDefaultFor(this.host.artifactDefaults(ctx.canvasId), AUDIO_DATA_TYPE);
    if (!serviceId) {
      return {
        error: 'No default audio generation service is configured. Choose one in Braid Settings > Artifact Defaults.',
      };
    }
    const engine = parseEngineAudioServiceId(serviceId);
    if (!engine || !this.host.generateAudioWithEngine) {
      return {
        error: `The configured audio generation service '${serviceId}' is unavailable in this host.`,
      };
    }
    return { target: { providerId: serviceId, engine, requiresCostConfirmation: true } };
  }

  private requestKey(ctx: AgentToolContext, providerId: string, req: AudioGenerateToolRequest): string {
    if (req.requestId) return req.requestId;
    return `${ctx.canvasId}:${ctx.boardId}:${ctx.turnIndex}:${shortHash(stableJson({
      providerId,
      input: req.input ?? '',
      options: req.options ?? {},
    }))}`;
  }

  private result(ok: boolean, body: unknown): AgentToolResult {
    return { ok, result: JSON.stringify(body, null, 2) };
  }

  private async validateEngineCapability(ctx: AgentToolContext, target: AudioServiceTarget, request: AudioGenerationRequest): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const model = stringField(request.options?.model);
    if (!model) return 'OpenRouter audio generation requires a speech-capable model in request options.';
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    const scopes = service?.capabilityScopes ?? [];
    const supported = scopes.some((scope) => scope.provider === 'openrouter'
      && scope.dataType === AUDIO_DATA_TYPE
      && scope.endpoint === '/audio/speech'
      && scope.model === model);
    if (!supported) {
      return `OpenRouter model '${model}' is not advertised as speech-capable for the /audio/speech endpoint. Choose a model from Braid Settings > Artifact Defaults.`;
    }
    return undefined;
  }

  private async openRouterDefaultModel(ctx: AgentToolContext, target: AudioServiceTarget): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const scopedModel = parseEngineAudioServiceModel(target.providerId);
    if (scopedModel) return scopedModel;
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    return service?.capabilityScopes?.find((scope) => scope.provider === 'openrouter'
      && scope.dataType === AUDIO_DATA_TYPE
      && scope.endpoint === '/audio/speech'
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
    if (!req.input?.trim()) return this.result(false, { error: 'Input text is required for audio generation.' });
    const existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    const configured = existingById ? undefined : this.configuredService(ctx);
    const target = existingById
      ? (() => {
        const engine = parseEngineAudioServiceId(existingById.providerId);
        return engine && this.host.generateAudioWithEngine ? { providerId: existingById.providerId, engine, requiresCostConfirmation: true } : undefined;
      })()
      : configured?.target;
    if (!target) {
      const error = existingById
        ? `The recorded audio generation service '${existingById.providerId}' is unavailable.`
        : configured?.error ?? 'No audio generation provider is available.';
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
    const request: AudioGenerationRequest = await this.withOpenRouterDefaultModel(ctx, target, {
      requestId: requestKey,
      input: req.input!.trim(),
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
      await this.writeRecord(record, 'audio-generation-created');
    }
    try {
      const audio = await this.host.generateAudioWithEngine!(target.engine, record.request, ctx.signal);
      const produced = await this.host.produceArtifact(ctx.canvasId, ctx.boardId, {
        source: 'born',
        dataType: AUDIO_DATA_TYPE,
        label: audio.label || `${requestKey}.mp3`,
        mime: audio.mime || AUDIO_DEFAULT_MIME,
        ...(audio.metadata ? { metadata: audio.metadata } : {}),
        pluginId: manifest.id,
        bytes: audio.bytes,
        ...(req.attachToTurn !== false ? { attachTo: { turnIndex: ctx.turnIndex } } : {}),
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

  private async releaseLiveBoardRecords(event: HostRunBoardEvent, message: string): Promise<void> {
    const updates = [...this.records.values()]
      .filter((record) => record.canvasId === event.canvasId && record.boardId === event.boardId && record.status === 'pending');
    for (const record of updates) {
      await this.writeRecord({ ...record, error: message }, 'audio-generation-released');
      this.records.delete(record.requestKey);
    }
  }
}

export const audioArtifactsHostServicePlugin: HostServicePlugin = {
  id: 'audio-artifacts.host-service',
  label: 'Audio Artifacts Host Service',
  manifest,
  create: (ctx) => new AudioArtifactsHostService(ctx),
};
