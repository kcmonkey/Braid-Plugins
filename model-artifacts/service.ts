import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  ModelGenerationProviderPlugin,
  ModelGenerationProvider,
  ModelGenerationRequest,
  ModelGenerationRequestKind,
  ModelGenerationTaskSnapshot,
  PluginEventInput,
  PluginManifest,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { artifactGenerationDefaultFor } from '../../../src/artifactGeneration';
import { artifactOutputObligationId } from '../../../src/obligations';
import manifestJson from './plugin.json';
import { MODEL_3D_DATA_TYPE, MODEL_3D_GLB_MIME } from './artifactType';
import { createModelGenerateAgentTool, type ModelGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'request:';
const WATCH_INITIAL_DELAY_MS = 10;
const WATCH_BASE_DELAY_MS = 10;
const WATCH_MAX_DELAY_MS = 200;
const WATCH_MAX_POLLS = 30;

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

interface DriverRecord {
  requestKey: string;
  canvasId: string;
  boardId: string;
  turnIndex: number;
  providerId: string;
  request: ModelGenerationRequest;
  providerTaskId?: string;
  status: DriverStatus;
  attachToTurn?: boolean;
  artifactId?: string;
  error?: string;
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

function providerSupports(plugin: ModelGenerationProviderPlugin, kind: ModelGenerationRequestKind): boolean {
  return kind === 'image-to-3d' ? plugin.capabilities.imageTo3d === true : plugin.capabilities.textTo3d === true;
}

export type ModelGenerationProviderResolver = (
  serviceId: string,
  kind: ModelGenerationRequestKind,
) => ModelGenerationProviderPlugin | undefined;

function taskIsTerminal(task: ModelGenerationTaskSnapshot): boolean {
  return task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled';
}

class ModelArtifactsHostService implements HostService {
  id = 'model-artifacts.hostService';
  label = 'Model Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, DriverRecord>();
  private readonly inFlight = new Map<string, Promise<AgentToolResult>>();
  private readonly watchers = new Map<string, { abort: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number }>();

  constructor(
    private readonly host: HostServiceContext,
    private readonly resolveProvider: ModelGenerationProviderResolver,
  ) {}

  agentTools() {
    return [createModelGenerateAgentTool(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) })];
  }

  async onBoardAbort(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, 'Generation request was interrupted; re-run model_generate with the same requestId to resume the provider task.');
  }

  async onRunError(event: HostRunBoardEvent): Promise<void> {
    await this.releaseLiveBoardRecords(event, event.message || 'Generation request was interrupted; re-run model_generate with the same requestId to resume the provider task.');
  }

  async onCanvasClose(canvasId: string): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.canvasId === canvasId) this.stopWatcher(record.requestKey);
    }
  }

  private requestKey(ctx: AgentToolContext, providerId: string, req: ModelGenerateToolRequest, kind: ModelGenerationRequestKind): string {
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

  private async writeRecord(record: DriverRecord, kind = 'model-generation-record'): Promise<void> {
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

  private recordPendingGeneration(record: DriverRecord, latest: ModelGenerationTaskSnapshot): void {
    this.host.recordObligationEvent?.({
      type: 'artifact-generation-pending',
      obligationId: this.obligationId(record),
      target: { canvasId: record.canvasId, boardId: record.boardId, turnIndex: record.turnIndex },
      dataType: MODEL_3D_DATA_TYPE,
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
      dataType: MODEL_3D_DATA_TYPE,
      requestId: record.requestKey,
      providerTaskId: providerTaskId ?? record.providerTaskId,
      status,
    });
  }

  private providerContext(plugin: ModelGenerationProviderPlugin) {
    return {
      readSecret: (key: string) => this.host.readSecret(plugin.id, key),
      writeSecret: (key: string, value: string) => this.host.writeSecret(plugin.id, key, value),
      clearSecret: (key: string) => this.host.clearSecret(plugin.id, key),
    };
  }

  private providerById(serviceId: string, kind: ModelGenerationRequestKind): ModelGenerationProviderPlugin | undefined {
    const normalized = serviceId.trim();
    if (!normalized) return undefined;
    const plugin = this.resolveProvider(normalized, kind);
    return plugin && providerSupports(plugin, kind) ? plugin : undefined;
  }

  private stopWatcher(requestKey: string): void {
    const watcher = this.watchers.get(requestKey);
    if (!watcher) return;
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.abort.abort();
    this.watchers.delete(requestKey);
  }

  private startWatcher(record: DriverRecord, providerPlugin: ModelGenerationProviderPlugin, initialDelayMs = WATCH_INITIAL_DELAY_MS): void {
    if (record.status !== 'pending' || !record.providerTaskId || this.watchers.has(record.requestKey)) return;
    const watcher = { abort: new AbortController(), polls: 0 } as { abort: AbortController; timer?: ReturnType<typeof setTimeout>; polls: number };
    const provider = providerPlugin.create(this.providerContext(providerPlugin));
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
          const timedOut = { ...current, status: 'pending' as DriverStatus, error: 'Generation watcher reached its idle polling limit; re-run model_generate with the same requestId to resume.' };
          await this.writeRecord(timedOut, 'model-generation-watch-idle');
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
          await this.writeRecord({ ...current, error: String(e?.message ?? e) }, 'model-generation-watch-error');
          schedule(delayed);
        }
      }, delayMs);
    };
    this.watchers.set(record.requestKey, watcher);
    schedule(initialDelayMs);
  }

  private configuredProvider(ctx: AgentToolContext, kind: ModelGenerationRequestKind): { plugin?: ModelGenerationProviderPlugin; error?: string } {
    const serviceId = artifactGenerationDefaultFor(this.host.artifactDefaults(ctx.canvasId), 'model-3d');
    if (!serviceId) {
      return {
        error: 'No default 3D model generation service is configured. Choose one in Braid Settings > Artifact Defaults.',
      };
    }
    const plugin = this.providerById(serviceId, kind);
    if (!plugin) {
      return {
        error: `The configured 3D model generation service '${serviceId}' is unavailable or does not support ${kind}. Choose a valid service in Braid Settings > Artifact Defaults.`,
      };
    }
    return { plugin };
  }

  private result(ok: boolean, body: unknown): AgentToolResult {
    return { ok, result: JSON.stringify(body, null, 2) };
  }

  private async handleGenerate(ctx: AgentToolContext, req: ModelGenerateToolRequest): Promise<AgentToolResult> {
    const kind: ModelGenerationRequestKind = req.kind === 'image-to-3d' ? 'image-to-3d' : 'text-to-3d';
    if (kind === 'text-to-3d' && !req.prompt?.trim()) {
      return this.result(false, { error: 'A prompt is required for text-to-3d model generation.' });
    }
    const existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    const configured = existingById ? undefined : this.configuredProvider(ctx, kind);
    const providerPlugin = existingById
      ? this.providerById(existingById.providerId, existingById.request.kind)
      : configured?.plugin;
    if (!providerPlugin) {
      const error = existingById
        ? `The recorded 3D model generation service '${existingById.providerId}' is unavailable.`
        : configured?.error ?? `No model-generation provider is available for ${kind}.`;
      return this.result(false, { error });
    }
    const requestKey = existingById?.requestKey ?? this.requestKey(ctx, providerPlugin.providerId, req, kind);
    if (req.cancel) {
      const existing = existingById ?? await this.readRecord(requestKey);
      return this.cancelRequest(providerPlugin, existing, requestKey);
    }
    const alreadyRunning = this.inFlight.get(requestKey);
    if (alreadyRunning) return alreadyRunning;
    const running = this.dispatchGenerate(ctx, req, kind, providerPlugin, requestKey, existingById)
      .finally(() => this.inFlight.delete(requestKey));
    this.inFlight.set(requestKey, running);
    return running;
  }

  private async dispatchGenerate(
    ctx: AgentToolContext,
    req: ModelGenerateToolRequest,
    kind: ModelGenerationRequestKind,
    providerPlugin: ModelGenerationProviderPlugin,
    requestKey: string,
    existingById: DriverRecord | undefined,
  ): Promise<AgentToolResult> {
    const existing = existingById ?? await this.readRecord(requestKey);
    if (existing?.status === 'succeeded') return this.result(true, { requestId: requestKey, status: 'succeeded', artifactId: existing.artifactId, reused: true });
    if (existing?.status === 'failed' || existing?.status === 'canceled') {
      return this.result(false, { requestId: requestKey, status: existing.status, error: existing.error || 'Request is no longer active.', reused: true });
    }
    if (!existing && providerPlugin.capabilities.requiresCostConfirmation !== false && req.confirmCost !== true) {
      return this.result(false, {
        requestId: requestKey,
        error: 'This provider may consume paid credits. Re-run with confirmCost: true to dispatch it.',
      });
    }

    const provider = providerPlugin.create(this.providerContext(providerPlugin));
    let record = existing;
    if (!record) {
      const request: ModelGenerationRequest = {
        requestId: requestKey,
        kind,
        prompt: req.prompt,
        options: req.options,
      };
      const created = await provider.createTask(request, ctx.signal);
      record = {
        requestKey,
        canvasId: ctx.canvasId,
        boardId: ctx.boardId,
        turnIndex: ctx.turnIndex,
        providerId: providerPlugin.providerId,
        request,
        providerTaskId: created.providerTaskId,
        status: taskIsTerminal(created) ? this.driverStatus(created) : 'pending',
        attachToTurn: req.attachToTurn !== false,
        ...(created.error ? { error: created.error } : {}),
      };
      await this.writeRecord(record, 'model-generation-created');
      if (created.status === 'failed' || created.status === 'canceled') {
        this.recordSettledGeneration(record, created.status, created.providerTaskId);
        return this.result(false, { requestId: requestKey, status: created.status, error: created.error });
      }
    }

    const latest = await provider.readTask(record.providerTaskId!, ctx.signal);
    const outcome = await this.applyTaskSnapshot(provider, record, latest, ctx.signal);
    if (!outcome.terminal) this.startWatcher(outcome.record, providerPlugin);
    return outcome.result;
  }

  private async applyTaskSnapshot(
    provider: ModelGenerationProvider,
    record: DriverRecord,
    latest: ModelGenerationTaskSnapshot,
    signal: AbortSignal,
  ): Promise<{ record: DriverRecord; result: AgentToolResult; terminal: boolean }> {
    if (latest.status === 'failed' || latest.status === 'canceled') {
      const next = { ...record, status: this.driverStatus(latest), providerTaskId: latest.providerTaskId, error: latest.error || latest.status };
      await this.writeRecord(next, `model-generation-${latest.status}`);
      this.recordSettledGeneration(next, latest.status, latest.providerTaskId);
      return { record: next, result: this.result(false, { requestId: record.requestKey, status: next.status, error: next.error }), terminal: true };
    }
    if (latest.status !== 'succeeded' || !latest.result) {
      const next = { ...record, status: 'pending' as DriverStatus, providerTaskId: latest.providerTaskId };
      await this.writeRecord(next, 'model-generation-pending');
      this.recordPendingGeneration(next, latest);
      return { record: next, result: this.result(true, { requestId: record.requestKey, status: latest.status, providerTaskId: latest.providerTaskId }), terminal: false };
    }

    const cached = await this.readRecord(record.requestKey);
    if (cached?.status === 'succeeded' && cached.artifactId) {
      return { record: cached, result: this.result(true, { requestId: record.requestKey, status: 'succeeded', artifactId: cached.artifactId, reused: true }), terminal: true };
    }

    const downloaded = await provider.downloadResult(latest.result, signal);
    const produced = await this.host.produceArtifact(record.canvasId, record.boardId, {
      source: 'born',
      dataType: MODEL_3D_DATA_TYPE,
      label: downloaded.label || latest.result.label || `${MODEL_3D_DATA_TYPE}.glb`,
      mime: downloaded.mime || latest.result.mime || MODEL_3D_GLB_MIME,
      pluginId: manifest.id,
      bytes: downloaded.bytes,
      ...(record.attachToTurn !== false ? { attachTo: { turnIndex: record.turnIndex } } : {}),
    });
    if (produced.error || !produced.ref) {
      const failed = { ...record, status: 'failed' as DriverStatus, providerTaskId: latest.providerTaskId, error: produced.error || 'Artifact production failed.' };
      await this.writeRecord(failed, 'model-generation-artifact-failed');
      this.recordSettledGeneration(failed, 'failed', latest.providerTaskId);
      return { record: failed, result: this.result(false, { requestId: record.requestKey, status: 'failed', error: failed.error }), terminal: true };
    }
    const next = { ...record, status: 'succeeded' as DriverStatus, providerTaskId: latest.providerTaskId, artifactId: produced.ref.id, error: undefined };
    await this.writeRecord(next, 'model-generation-succeeded');
    this.recordSettledGeneration(next, 'succeeded', latest.providerTaskId);
    return { record: next, result: this.result(true, { requestId: record.requestKey, status: 'succeeded', artifact: produced.ref, path: produced.path }), terminal: true };
  }

  private async cancelRequest(providerPlugin: ModelGenerationProviderPlugin, record: DriverRecord | undefined, requestKey: string): Promise<AgentToolResult> {
    if (!record) return this.result(false, { requestId: requestKey, error: 'No active generation request exists for this requestId.' });
    if (record.status === 'succeeded') return this.result(false, { requestId: requestKey, error: 'Cannot cancel a completed generation request.' });
    if (record.status === 'canceled') return this.result(true, { requestId: requestKey, status: 'canceled', reused: true });
    this.stopWatcher(requestKey);
    const provider = providerPlugin.create(this.providerContext(providerPlugin));
    const canceledTask = provider.cancelTask && record.providerTaskId ? await provider.cancelTask(record.providerTaskId) : undefined;
    const canceled = { ...record, status: 'canceled' as DriverStatus, error: 'Generation request canceled.' };
    await this.writeRecord(canceled, 'model-generation-canceled');
    const providerTaskId = canceledTask && typeof canceledTask === 'object' ? canceledTask.providerTaskId : record.providerTaskId;
    this.recordSettledGeneration(canceled, 'canceled', providerTaskId);
    return this.result(true, { requestId: requestKey, status: 'canceled' });
  }

  private driverStatus(task: ModelGenerationTaskSnapshot): DriverStatus {
    if (task.status === 'succeeded') return 'succeeded';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'canceled') return 'canceled';
    return 'pending';
  }

  private async releaseLiveBoardRecords(event: HostRunBoardEvent, message: string): Promise<void> {
    const updates = [...this.records.values()]
      .filter((record) => record.canvasId === event.canvasId && record.boardId === event.boardId && record.status === 'pending');
    for (const record of updates) {
      this.stopWatcher(record.requestKey);
      await this.writeRecord({ ...record, status: 'pending', error: message }, 'model-generation-released');
      this.records.delete(record.requestKey);
    }
  }
}

export function createModelArtifactsHostServicePlugin(
  resolveProvider: ModelGenerationProviderResolver,
): HostServicePlugin {
  return {
    id: 'model-artifacts.host-service',
    label: 'Model Artifacts Host Service',
    manifest,
    create: (ctx) => new ModelArtifactsHostService(ctx, resolveProvider),
  };
}
