import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  PluginEventInput,
  PluginManifest,
  VideoGenerationProvider,
  VideoGenerationProviderPlugin,
  VideoGenerationRequest,
  VideoGenerationRequestKind,
  VideoGenerationTaskSnapshot,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId } from '../../../src/protocol';
import { artifactGenerationDefaultFor, parseEngineVideoServiceId, parseEngineVideoServiceModel } from '../../../src/artifactGeneration';
import { artifactOutputObligationId } from '../../../src/obligations';
import { videoGenerationProviderPlugins } from '../../../src/plugin-runtime/registry';
import manifestJson from './plugin.json';
import { VIDEO_DATA_TYPE, VIDEO_MP4_MIME } from './artifactType';
import { createVideoGenerateAgentTool, type VideoGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'request:';
const WATCH_INITIAL_DELAY_MS = 10;
const WATCH_BASE_DELAY_MS = 10;
const WATCH_MAX_DELAY_MS = 200;
const WATCH_MAX_POLLS = 30;

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'expired';

interface DriverRecord {
  requestKey: string;
  canvasId: string;
  boardId: string;
  turnIndex: number;
  providerId: string;
  request: VideoGenerationRequest;
  providerTaskId?: string;
  status: DriverStatus;
  attachToTurn?: boolean;
  artifactId?: string;
  error?: string;
}

type TaskSnapshotOutcome = { record: DriverRecord; result: AgentToolResult; terminal: boolean };
type SucceededTaskSnapshot = VideoGenerationTaskSnapshot & { status: 'succeeded'; result: NonNullable<VideoGenerationTaskSnapshot['result']> };

interface VideoServiceTarget {
  providerId: string;
  plugin?: VideoGenerationProviderPlugin;
  engine?: EngineId;
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

function asRecord(value: unknown): DriverRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as DriverRecord;
  if (!candidate.requestKey || !candidate.providerId || !candidate.request) return undefined;
  return candidate;
}

function providerSupports(plugin: VideoGenerationProviderPlugin, kind: VideoGenerationRequestKind): boolean {
  return kind === 'image-to-video' ? plugin.capabilities.imageToVideo === true : plugin.capabilities.textToVideo === true;
}

function taskIsTerminal(task: VideoGenerationTaskSnapshot): boolean {
  return task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled' || task.status === 'expired';
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

class VideoArtifactsHostService implements HostService {
  id = 'video-artifacts.hostService';
  label = 'Video Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, DriverRecord>();
  private readonly inFlight = new Map<string, Promise<AgentToolResult>>();
  private readonly watchers = new Map<string, { abort: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number }>();
  private readonly terminalSettlements = new Map<string, Promise<TaskSnapshotOutcome>>();

  constructor(private readonly host: HostServiceContext) {}

  agentTools() {
    return [createVideoGenerateAgentTool(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) })];
  }

  async onBoardAbort(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, 'Generation request was interrupted; re-run video_generate with the same requestId to resume the provider task.');
  }

  async onRunError(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, event.message || 'Generation request was interrupted; re-run video_generate with the same requestId to resume the provider task.');
  }

  async onCanvasReady(canvasId: string): Promise<void> {
    const aggregates = await this.host.listPluginAggregates(manifest.id);
    for (const id of aggregates.aggregates ?? []) {
      if (!id.startsWith(AGGREGATE_PREFIX)) continue;
      const requestKey = id.slice(AGGREGATE_PREFIX.length);
      const record = await this.readRecord(requestKey);
      if (!record || record.canvasId !== canvasId || record.status !== 'pending' || !record.providerTaskId) continue;
      const target = this.targetForRecord(record);
      const provider = target ? this.providerForTarget(target) : undefined;
      if (provider) this.startWatcher(record, provider, 0);
    }
  }

  async onCanvasClose(canvasId: string): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.canvasId === canvasId) this.stopWatcher(record.requestKey);
    }
  }

  private requestKey(ctx: AgentToolContext, providerId: string, req: VideoGenerateToolRequest, kind: VideoGenerationRequestKind): string {
    if (req.requestId) return req.requestId;
    return `${ctx.canvasId}:${ctx.boardId}:${ctx.turnIndex}:${shortHash(stableJson({
      providerId,
      kind,
      prompt: req.prompt ?? '',
      options: req.options ?? {},
    }))}`;
  }

  private async readRecord(requestKey: string): Promise<DriverRecord | undefined> {
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

  private async writeRecord(record: DriverRecord, kind = 'video-generation-record'): Promise<void> {
    this.records.set(record.requestKey, record);
    const event: PluginEventInput = {
      kind,
      payload: record,
      timestamp: new Date().toISOString(),
    };
    await this.host.appendPluginEvent(manifest.id, aggregateId(record.requestKey), event);
  }

  private obligationId(record: DriverRecord): string {
    return artifactOutputObligationId({ canvasId: record.canvasId, boardId: record.boardId, turnIndex: record.turnIndex });
  }

  private recordPendingGeneration(record: DriverRecord, latest: VideoGenerationTaskSnapshot): void {
    this.host.recordObligationEvent?.({
      type: 'artifact-generation-pending',
      obligationId: this.obligationId(record),
      target: { canvasId: record.canvasId, boardId: record.boardId, turnIndex: record.turnIndex },
      dataType: VIDEO_DATA_TYPE,
      requestId: record.requestKey,
      providerTaskId: latest.providerTaskId,
      status: latest.status,
    });
  }

  private recordSettledGeneration(record: DriverRecord, status: 'succeeded' | 'failed' | 'canceled', providerTaskId?: string): void {
    this.host.recordObligationEvent?.({
      type: 'artifact-generation-settled',
      obligationId: this.obligationId(record),
      target: { canvasId: record.canvasId, boardId: record.boardId, turnIndex: record.turnIndex },
      dataType: VIDEO_DATA_TYPE,
      requestId: record.requestKey,
      providerTaskId: providerTaskId ?? record.providerTaskId,
      status,
    });
  }

  private providerContext(plugin: VideoGenerationProviderPlugin) {
    return {
      readSecret: (key: string) => this.host.readSecret(plugin.id, key),
      writeSecret: (key: string, value: string) => this.host.writeSecret(plugin.id, key, value),
      clearSecret: (key: string) => this.host.clearSecret(plugin.id, key),
    };
  }

  private providerById(serviceId: string, kind: VideoGenerationRequestKind): VideoGenerationProviderPlugin | undefined {
    const normalized = serviceId.trim();
    if (!normalized) return undefined;
    return videoGenerationProviderPlugins()
      .find((plugin) => (plugin.providerId === normalized || plugin.id === normalized) && providerSupports(plugin, kind));
  }

  private targetForRecord(record: DriverRecord): VideoServiceTarget | undefined {
    const engine = parseEngineVideoServiceId(record.providerId);
    if (engine) {
      return this.host.videoGenerationProviderForEngine?.(engine)
        ? { providerId: record.providerId, engine, requiresCostConfirmation: true }
        : undefined;
    }
    const plugin = this.providerById(record.providerId, record.request.kind);
    return plugin ? { providerId: plugin.providerId, plugin, requiresCostConfirmation: plugin.capabilities.requiresCostConfirmation !== false } : undefined;
  }

  private providerForTarget(target: VideoServiceTarget): VideoGenerationProvider | undefined {
    if (target.plugin) return target.plugin.create(this.providerContext(target.plugin));
    if (target.engine) return this.host.videoGenerationProviderForEngine?.(target.engine);
    return undefined;
  }

  private stopWatcher(requestKey: string): void {
    const watcher = this.watchers.get(requestKey);
    if (!watcher) return;
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.abort.abort();
    this.watchers.delete(requestKey);
  }

  private startWatcher(record: DriverRecord, provider: VideoGenerationProvider, initialDelayMs = WATCH_INITIAL_DELAY_MS): void {
    if (record.status !== 'pending' || !record.providerTaskId || this.watchers.has(record.requestKey)) return;
    const watcher = { abort: new AbortController(), polls: 0 } as { abort: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number };
    const schedule = (delayMs: number) => {
      watcher.timer = setTimeout(async () => {
        if (watcher.abort.signal.aborted) return;
        watcher.polls += 1;
        const current = await this.readRecord(record.requestKey) ?? record;
        if (current.status !== 'pending' || !current.providerTaskId) {
          this.stopWatcher(record.requestKey);
          return;
        }
        if (watcher.polls > WATCH_MAX_POLLS) {
          const timedOut = { ...current, status: 'pending' as DriverStatus, error: 'Generation watcher reached its idle polling limit; re-run video_generate with the same requestId to resume.' };
          await this.writeRecord(timedOut, 'video-generation-watch-idle');
          this.stopWatcher(record.requestKey);
          return;
        }
        try {
          const latest = await provider.readTask(current.providerTaskId, watcher.abort.signal);
          const outcome = await this.applyTaskSnapshot(provider, current, latest, watcher.abort.signal);
          if (outcome.terminal) {
            this.stopWatcher(record.requestKey);
            return;
          }
          const nextDelay = Math.min(WATCH_MAX_DELAY_MS, WATCH_BASE_DELAY_MS * Math.max(1, watcher.polls));
          schedule(nextDelay);
        } catch (e: any) {
          if (watcher.abort.signal.aborted) return;
          const delayed = Math.min(WATCH_MAX_DELAY_MS, WATCH_BASE_DELAY_MS * Math.max(1, watcher.polls));
          await this.writeRecord({ ...current, error: String(e?.message ?? e) }, 'video-generation-watch-error');
          schedule(delayed);
        }
      }, delayMs);
    };
    this.watchers.set(record.requestKey, watcher);
    schedule(initialDelayMs);
  }

  private configuredProvider(ctx: AgentToolContext, kind: VideoGenerationRequestKind): { target?: VideoServiceTarget; error?: string } {
    const serviceId = artifactGenerationDefaultFor(this.host.artifactDefaults(ctx.canvasId), VIDEO_DATA_TYPE);
    if (!serviceId) {
      return {
        error: 'No default video generation service is configured. Choose one in Braid Settings > Artifact Defaults.',
      };
    }
    const engine = parseEngineVideoServiceId(serviceId);
    if (engine) {
      if (!this.host.videoGenerationProviderForEngine?.(engine)) {
        return {
          error: `The configured video generation service '${serviceId}' is unavailable in this host.`,
        };
      }
      return { target: { providerId: serviceId, engine, requiresCostConfirmation: true } };
    }
    const plugin = this.providerById(serviceId, kind);
    if (!plugin) {
      return {
        error: `The configured video generation service '${serviceId}' is unavailable or does not support ${kind}. Choose a valid service in Braid Settings > Artifact Defaults.`,
      };
    }
    return { target: { providerId: plugin.providerId, plugin, requiresCostConfirmation: plugin.capabilities.requiresCostConfirmation !== false } };
  }

  private async validateEngineCapability(ctx: AgentToolContext, target: VideoServiceTarget, request: VideoGenerationRequest): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const model = stringField(request.options?.model);
    if (!model) return 'OpenRouter video generation requires a video-capable model in request options.';
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    const scopes = service?.capabilityScopes ?? [];
    const supported = scopes.some((scope) => scope.provider === 'openrouter'
      && scope.dataType === 'video'
      && scope.endpoint === '/videos'
      && scope.model === model);
    if (!supported) {
      return `OpenRouter model '${model}' is not advertised as video-capable for the /videos endpoint. Choose a model from Braid Settings > Artifact Defaults.`;
    }
    return undefined;
  }

  private async openRouterDefaultModel(ctx: AgentToolContext, target: VideoServiceTarget): Promise<string | undefined> {
    if (target.engine !== 'openrouter') return undefined;
    const scopedModel = parseEngineVideoServiceModel(target.providerId);
    if (scopedModel) return scopedModel;
    const services = await this.host.artifactGenerationServices?.(ctx.canvasId);
    const service = services?.find((candidate) => candidate.serviceId === target.providerId);
    return service?.capabilityScopes?.find((scope) => scope.provider === 'openrouter'
      && scope.dataType === 'video'
      && scope.endpoint === '/videos'
      && stringField(scope.model))?.model;
  }

  private async withOpenRouterDefaultModel(ctx: AgentToolContext, target: VideoServiceTarget, request: VideoGenerationRequest): Promise<VideoGenerationRequest> {
    if (target.engine !== 'openrouter' || stringField(request.options?.model)) return request;
    const model = await this.openRouterDefaultModel(ctx, target);
    return model ? { ...request, options: { ...(request.options ?? {}), model } } : request;
  }

  private result(ok: boolean, body: unknown): AgentToolResult {
    return { ok, result: JSON.stringify(body, null, 2) };
  }

  private async handleGenerate(ctx: AgentToolContext, req: VideoGenerateToolRequest): Promise<AgentToolResult> {
    const kind: VideoGenerationRequestKind = req.kind === 'image-to-video' ? 'image-to-video' : 'text-to-video';
    if (kind === 'text-to-video' && !req.prompt?.trim()) {
      return this.result(false, { error: 'A prompt is required for text-to-video generation.' });
    }
    const existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    const configured = existingById ? undefined : this.configuredProvider(ctx, kind);
    const target = existingById ? this.targetForRecord(existingById) : configured?.target;
    if (!target) {
      const error = existingById
        ? `The recorded video generation service '${existingById.providerId}' is unavailable.`
        : configured?.error ?? `No video-generation provider is available for ${kind}.`;
      return this.result(false, { error });
    }
    const requestKey = existingById?.requestKey ?? this.requestKey(ctx, target.providerId, req, kind);
    if (req.cancel) {
      const existing = existingById ?? await this.readRecord(requestKey);
      const provider = this.providerForTarget(target);
      return this.cancelRequest(provider, existing, requestKey);
    }
    const alreadyRunning = this.inFlight.get(requestKey);
    if (alreadyRunning) return alreadyRunning;
    const running = this.dispatchGenerate(ctx, req, kind, target, requestKey, existingById)
      .finally(() => this.inFlight.delete(requestKey));
    this.inFlight.set(requestKey, running);
    return running;
  }

  private async dispatchGenerate(
    ctx: AgentToolContext,
    req: VideoGenerateToolRequest,
    kind: VideoGenerationRequestKind,
    target: VideoServiceTarget,
    requestKey: string,
    existingById: DriverRecord | undefined,
  ): Promise<AgentToolResult> {
    const existing = existingById ?? await this.readRecord(requestKey);
    if (existing?.status === 'succeeded') return this.result(true, { requestId: requestKey, status: 'succeeded', artifactId: existing.artifactId, reused: true });
    if (existing?.status === 'failed' || existing?.status === 'canceled' || existing?.status === 'expired') {
      return this.result(false, { requestId: requestKey, status: existing.status, error: existing.error || 'Request is no longer active.', reused: true });
    }
    if (!existing && target.requiresCostConfirmation && req.confirmCost !== true) {
      return this.result(false, {
        requestId: requestKey,
        error: 'This provider may consume paid credits. Re-run with confirmCost: true to dispatch it.',
      });
    }

    const provider = this.providerForTarget(target);
    if (!provider) return this.result(false, { requestId: requestKey, status: 'failed', error: `The configured video generation service '${target.providerId}' is unavailable.` });
    let record = existing;
    if (!record) {
      const request: VideoGenerationRequest = await this.withOpenRouterDefaultModel(ctx, target, {
        requestId: requestKey,
        kind,
        prompt: req.prompt,
        options: req.options,
      });
      const capabilityError = await this.validateEngineCapability(ctx, target, request);
      if (capabilityError) return this.result(false, { requestId: requestKey, status: 'failed', error: capabilityError });
      const created = await provider.createTask(request, ctx.signal);
      record = {
        requestKey,
        canvasId: ctx.canvasId,
        boardId: ctx.boardId,
        turnIndex: ctx.turnIndex,
        providerId: target.providerId,
        request,
        providerTaskId: created.providerTaskId,
        status: taskIsTerminal(created) ? this.driverStatus(created) : 'pending',
        attachToTurn: req.attachToTurn !== false,
        ...(created.error ? { error: created.error } : {}),
      };
      await this.writeRecord(record, 'video-generation-created');
      if (created.status === 'failed' || created.status === 'canceled' || created.status === 'expired') {
        this.recordSettledGeneration(record, created.status === 'canceled' ? 'canceled' : 'failed', created.providerTaskId);
        return this.result(false, { requestId: requestKey, status: created.status, error: created.error });
      }
    }

    const latest = await provider.readTask(record.providerTaskId!, ctx.signal);
    const outcome = await this.applyTaskSnapshot(provider, record, latest, ctx.signal);
    if (!outcome.terminal) this.startWatcher(outcome.record, provider);
    return outcome.result;
  }

  private async applyTaskSnapshot(
    provider: VideoGenerationProvider,
    record: DriverRecord,
    latest: VideoGenerationTaskSnapshot,
    signal: AbortSignal,
  ): Promise<TaskSnapshotOutcome> {
    if (latest.status === 'failed' || latest.status === 'canceled' || latest.status === 'expired') {
      const next = { ...record, status: this.driverStatus(latest), providerTaskId: latest.providerTaskId, error: latest.error || latest.status };
      await this.writeRecord(next, `video-generation-${latest.status}`);
      this.recordSettledGeneration(next, latest.status === 'canceled' ? 'canceled' : 'failed', latest.providerTaskId);
      return { record: next, result: this.result(false, { requestId: record.requestKey, status: next.status, error: next.error }), terminal: true };
    }
    if (latest.status !== 'succeeded' || !latest.result) {
      const next = { ...record, status: 'pending' as DriverStatus, providerTaskId: latest.providerTaskId };
      await this.writeRecord(next, 'video-generation-pending');
      this.recordPendingGeneration(next, latest);
      return { record: next, result: this.result(true, { requestId: record.requestKey, status: latest.status, providerTaskId: latest.providerTaskId }), terminal: false };
    }

    return this.settleSucceededTask(provider, record, latest as SucceededTaskSnapshot, signal);
  }

  private settleSucceededTask(
    provider: VideoGenerationProvider,
    record: DriverRecord,
    latest: SucceededTaskSnapshot,
    signal: AbortSignal,
  ): Promise<TaskSnapshotOutcome> {
    const existing = this.terminalSettlements.get(record.requestKey);
    if (existing) return existing;
    let pending!: Promise<TaskSnapshotOutcome>;
    pending = this.produceSucceededTask(provider, record, latest, signal)
      .finally(() => {
        if (this.terminalSettlements.get(record.requestKey) === pending) {
          this.terminalSettlements.delete(record.requestKey);
        }
      });
    this.terminalSettlements.set(record.requestKey, pending);
    return pending;
  }

  private async produceSucceededTask(
    provider: VideoGenerationProvider,
    record: DriverRecord,
    latest: SucceededTaskSnapshot,
    signal: AbortSignal,
  ): Promise<TaskSnapshotOutcome> {
    const cached = await this.readRecord(record.requestKey);
    if (cached?.status === 'succeeded' && cached.artifactId) {
      return { record: cached, result: this.result(true, { requestId: record.requestKey, status: 'succeeded', artifactId: cached.artifactId, reused: true }), terminal: true };
    }

    const downloaded = await provider.downloadResult(latest.result, signal);
    const produced = await this.host.produceArtifact(record.canvasId, record.boardId, {
      source: 'born',
      dataType: VIDEO_DATA_TYPE,
      label: downloaded.label || latest.result.label || `${VIDEO_DATA_TYPE}.mp4`,
      mime: downloaded.mime || latest.result.mime || VIDEO_MP4_MIME,
      pluginId: manifest.id,
      ...(downloaded.metadata ? { metadata: downloaded.metadata } : {}),
      bytes: downloaded.bytes,
      ...(record.attachToTurn !== false ? { attachTo: { turnIndex: record.turnIndex } } : {}),
    });
    if (produced.error || !produced.ref) {
      const failed = { ...record, status: 'failed' as DriverStatus, providerTaskId: latest.providerTaskId, error: produced.error || 'Artifact production failed.' };
      await this.writeRecord(failed, 'video-generation-artifact-failed');
      this.recordSettledGeneration(failed, 'failed', latest.providerTaskId);
      return { record: failed, result: this.result(false, { requestId: record.requestKey, status: 'failed', error: failed.error }), terminal: true };
    }
    const next = { ...record, status: 'succeeded' as DriverStatus, providerTaskId: latest.providerTaskId, artifactId: produced.ref.id, error: undefined };
    await this.writeRecord(next, 'video-generation-succeeded');
    this.recordSettledGeneration(next, 'succeeded', latest.providerTaskId);
    return { record: next, result: this.result(true, { requestId: record.requestKey, status: 'succeeded', artifact: produced.ref, path: produced.path }), terminal: true };
  }

  private async cancelRequest(provider: VideoGenerationProvider | undefined, record: DriverRecord | undefined, requestKey: string): Promise<AgentToolResult> {
    if (!record) return this.result(false, { requestId: requestKey, error: 'No active generation request exists for this requestId.' });
    if (record.status === 'succeeded') return this.result(false, { requestId: requestKey, error: 'Cannot cancel a completed generation request.' });
    if (record.status === 'canceled') return this.result(true, { requestId: requestKey, status: 'canceled', reused: true });
    this.stopWatcher(requestKey);
    const canceledTask = provider?.cancelTask && record.providerTaskId ? await provider.cancelTask(record.providerTaskId) : undefined;
    const canceled = { ...record, status: 'canceled' as DriverStatus, error: 'Generation request canceled.' };
    await this.writeRecord(canceled, 'video-generation-canceled');
    const providerTaskId = canceledTask && typeof canceledTask === 'object' ? canceledTask.providerTaskId : record.providerTaskId;
    this.recordSettledGeneration(canceled, 'canceled', providerTaskId);
    return this.result(true, { requestId: requestKey, status: 'canceled' });
  }

  private driverStatus(task: VideoGenerationTaskSnapshot): DriverStatus {
    if (task.status === 'succeeded') return 'succeeded';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'canceled') return 'canceled';
    if (task.status === 'expired') return 'expired';
    return 'pending';
  }

  private async releaseLiveBoardRecords(event: HostRunBoardEvent, message: string): Promise<void> {
    const updates = [...this.records.values()]
      .filter((record) => record.canvasId === event.canvasId && record.boardId === event.boardId && record.status === 'pending');
    for (const record of updates) {
      this.stopWatcher(record.requestKey);
      await this.writeRecord({ ...record, status: 'pending', error: message }, 'video-generation-released');
      this.records.delete(record.requestKey);
    }
  }
}

export const videoArtifactsHostServicePlugin: HostServicePlugin = {
  id: 'video-artifacts.host-service',
  label: 'Video Artifacts Host Service',
  manifest,
  create: (ctx) => new VideoArtifactsHostService(ctx),
};
