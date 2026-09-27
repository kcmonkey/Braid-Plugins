import type {
  AgentToolContext,
  HostRunBoardEvent,
  HostRunLifecycleEvent,
  HostService,
  HostServiceContext,
  HostServicePlugin,
  ImageGenerationProviderPlugin,
  ImageGenerationRequest,
  ImageGenerationResult,
  PluginEventInput,
  PluginManifest,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { EngineId } from '../../../src/protocol';
import { artifactGenerationDefaultFor, parseEngineImageServiceId, parseEngineImageServiceModel } from '../../../src/artifactGeneration';
import { artifactOutputObligationId } from '../../../src/obligations';
import { createHash } from 'crypto';
import manifestJson from './plugin.json';
import { createImageGenerateAgentTool, type ImageGenerateToolRequest } from './agentTool';

const manifest = manifestJson as PluginManifest;
const AGGREGATE_PREFIX = 'image-request-v1-';
const AGGREGATE_ID_PATTERN = new RegExp(`^${AGGREGATE_PREFIX}[0-9a-f]{64}$`);

type DriverStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';
type TerminalDriverStatus = Exclude<DriverStatus, 'pending'>;

const IMAGE_DATA_TYPE = 'image';
const IMAGE_JOB_PREFIX = 'image-job:';
const RECOVERED_PENDING_ERROR = 'Image generation was already dispatched but has no terminal provider result; replay is disabled to prevent duplicate provider dispatch.';
const IMAGE_RECORD_KEYS = new Set([
  'requestKey', 'agentId', 'canvasId', 'boardId', 'turnIndex', 'providerId', 'request', 'providerTaskId',
  'status', 'obligationPendingRecorded', 'obligationSettledRecorded', 'artifactId', 'error',
]);
const IMAGE_REQUEST_KEYS = new Set(['requestId', 'prompt', 'options']);

interface ImageDriverRecord {
  requestKey: string;
  /** Absent only in persisted pre-Agent records. */
  agentId?: string;
  canvasId?: string;
  boardId?: string;
  turnIndex: number;
  providerId: string;
  request: ImageGenerationRequest;
  /** Stable logical provider job identity for the one-shot image route. */
  providerTaskId: string;
  status: DriverStatus;
  /** Durable markers describe the aggregate; process-local sets below own emission dedupe. */
  obligationPendingRecorded?: boolean;
  obligationSettledRecorded?: boolean;
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

type ProducedArtifact = Awaited<ReturnType<HostServiceContext['produceArtifact']>>;

interface ArtifactCommitResult {
  record: ImageDriverRecord;
  produced?: ProducedArtifact;
  error?: string;
}

interface InFlightGeneration {
  agentId: string;
  promise: Promise<AgentToolResult>;
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

export function imageGenerationAggregateId(requestKey: string): string {
  return `${AGGREGATE_PREFIX}${createHash('sha256').update(requestKey, 'utf8').digest('hex')}`;
}

function providerTaskIdFor(providerId: string, requestKey: string): string {
  return `${IMAGE_JOB_PREFIX}${providerId}:${requestKey}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTerminalStatus(status: DriverStatus): status is TerminalDriverStatus {
  return status !== 'pending';
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strictString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function asRecord(value: unknown, expectedRequestKey?: string): ImageDriverRecord | undefined {
  if (!plainObject(value)) return undefined;
  const candidate = value as unknown as ImageDriverRecord;
  if (Object.keys(candidate).some((key) => !IMAGE_RECORD_KEYS.has(key))) return undefined;
  if (!strictString(candidate.requestKey)
    || (expectedRequestKey !== undefined && candidate.requestKey !== expectedRequestKey)
    || (candidate.agentId !== undefined && !strictString(candidate.agentId))
    || (candidate.canvasId !== undefined && !strictString(candidate.canvasId))
    || (candidate.boardId !== undefined && !strictString(candidate.boardId))
    || ((candidate.canvasId === undefined) !== (candidate.boardId === undefined))
    || (!candidate.agentId && (!candidate.canvasId || !candidate.boardId))
    || !Number.isSafeInteger(candidate.turnIndex)
    || candidate.turnIndex < 0
    || !strictString(candidate.providerId)
    || !plainObject(candidate.request)
    || !strictString(candidate.providerTaskId)
    || candidate.providerTaskId !== providerTaskIdFor(candidate.providerId, candidate.requestKey)
    || !isTerminalOrPendingStatus(candidate.status)) return undefined;

  const request = candidate.request as unknown as ImageGenerationRequest;
  if (Object.keys(request).some((key) => !IMAGE_REQUEST_KEYS.has(key))) return undefined;
  if (!strictString(request.requestId)
    || request.requestId !== candidate.requestKey
    || !strictString(request.prompt)
    || (request.options !== undefined && !plainObject(request.options))) return undefined;
  if (candidate.obligationPendingRecorded !== undefined && typeof candidate.obligationPendingRecorded !== 'boolean') return undefined;
  if (candidate.obligationSettledRecorded !== undefined && typeof candidate.obligationSettledRecorded !== 'boolean') return undefined;
  if (candidate.artifactId !== undefined && !strictString(candidate.artifactId)) return undefined;
  if (candidate.error !== undefined && !strictString(candidate.error)) return undefined;

  if (candidate.status === 'pending') {
    if (candidate.artifactId !== undefined || candidate.error !== undefined) return undefined;
  } else if (candidate.status === 'succeeded') {
    if (!strictString(candidate.artifactId) || candidate.error !== undefined) return undefined;
  } else {
    if (candidate.artifactId !== undefined) return undefined;
    if (!strictString(candidate.error)) return undefined;
  }
  return candidate;
}

function isTerminalOrPendingStatus(value: unknown): value is DriverStatus {
  return value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'canceled';
}

class ImageArtifactsHostService implements HostService {
  id = 'image-artifacts.hostService';
  label = 'Image Artifacts Host Service';
  manifest = manifest;
  private readonly records = new Map<string, ImageDriverRecord>();
  private readonly inFlight = new Map<string, InFlightGeneration>();
  private readonly pendingLifecycle = new Map<string, Promise<ImageDriverRecord>>();
  private readonly terminalSettlements = new Map<string, Promise<ImageDriverRecord>>();
  private readonly artifactCommitWindows = new Map<string, Promise<ArtifactCommitResult>>();
  private readonly emittedPending = new Set<string>();
  private readonly emittedSettled = new Set<string>();

  constructor(
    private readonly host: HostServiceContext,
    private readonly resolveProvider: ImageGenerationProviderResolver,
  ) {}

  agentTools() {
    return [createImageGenerateAgentTool(this.host, { generate: (ctx, req) => this.handleGenerate(ctx, req) })];
  }

  async onBoardAsyncIdle(event: HostRunBoardEvent): Promise<void> {
    await this.hydrateBoardRecords(event.canvasId, event.boardId);
  }

  async onRunSettled(event: HostRunLifecycleEvent): Promise<void> {
    for (const boardId of event.boardIds) await this.hydrateBoardRecords(event.canvasId, boardId);
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
    return `agent:${ctx.agentId}:${ctx.turnIndex}:${shortHash(stableJson({
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

  private async readAggregateRecord(
    storedAggregateId: string,
    expectedRequestKey?: string,
    options: { project?: boolean } = {},
  ): Promise<ImageDriverRecord | undefined> {
    if (!AGGREGATE_ID_PATTERN.test(storedAggregateId)) {
      throw new Error(`Invalid persisted image generation aggregate id '${storedAggregateId}'.`);
    }
    const aggregate = await this.host.readPluginAggregate(manifest.id, storedAggregateId);
    if (aggregate.error) throw new Error(`Failed to read image generation state: ${aggregate.error}`);
    if (aggregate.pluginId !== manifest.id || aggregate.aggregateId !== storedAggregateId) {
      throw new Error(`Invalid persisted image generation aggregate identity for '${storedAggregateId}'.`);
    }
    if (!Array.isArray(aggregate.events)) throw new Error(`Invalid persisted image generation aggregate for '${storedAggregateId}'.`);
    if (!aggregate.events.length) return undefined;
    let latest: ImageDriverRecord | undefined;
    for (const event of aggregate.events) {
      if (!plainObject(event) || !('payload' in event)) {
        throw new Error(`Invalid persisted image generation event for aggregate '${storedAggregateId}'.`);
      }
      const record = asRecord(event.payload, expectedRequestKey);
      if (!record || imageGenerationAggregateId(record.requestKey) !== storedAggregateId) {
        throw new Error(`Invalid persisted image generation record for aggregate '${storedAggregateId}'.`);
      }
      if (latest && latest.requestKey !== record.requestKey) {
        throw new Error(`Persisted image generation aggregate '${storedAggregateId}' contains multiple request keys.`);
      }
      latest = record;
    }
    if (!latest) return undefined;
    this.records.set(latest.requestKey, latest);
    if (options.project !== false) this.projectRecord(latest);
    return latest;
  }

  private async readRecord(requestKey: string, options: { project?: boolean } = {}): Promise<ImageDriverRecord | undefined> {
    const cached = this.records.get(requestKey);
    if (cached) {
      if (options.project !== false) this.projectRecord(cached);
      return cached;
    }
    return this.readAggregateRecord(imageGenerationAggregateId(requestKey), requestKey, options);
  }

  private async writeRecord(record: ImageDriverRecord, kind = 'image-generation-record'): Promise<void> {
    const validated = asRecord(record, record.requestKey);
    if (!validated) throw new Error(`Refusing to persist an invalid image generation record for request '${record.requestKey}'.`);
    const event: PluginEventInput = {
      kind,
      payload: validated,
      timestamp: new Date().toISOString(),
    };
    const appended = await this.host.appendPluginEvent(manifest.id, imageGenerationAggregateId(validated.requestKey), event);
    if (appended.error) throw new Error(`Failed to persist image generation state: ${appended.error}`);
    this.records.set(validated.requestKey, validated);
  }

  private obligationId(record: ImageDriverRecord): string {
    return artifactOutputObligationId(this.obligationTarget(record));
  }

  private obligationTarget(record: ImageDriverRecord) {
    return record.canvasId && record.boardId
      ? { canvasId: record.canvasId, boardId: record.boardId, turnIndex: record.turnIndex }
      : { agentId: record.agentId, turnIndex: record.turnIndex };
  }

  private async ensureProviderIdentity(record: ImageDriverRecord): Promise<ImageDriverRecord> {
    const identified = asRecord(record, record.requestKey);
    if (!identified) throw new Error(`Invalid image generation record for request '${record.requestKey}'.`);
    return identified;
  }

  private async recordPendingGeneration(record: ImageDriverRecord): Promise<ImageDriverRecord> {
    const existing = this.pendingLifecycle.get(record.requestKey);
    if (existing) return existing;
    let pending!: Promise<ImageDriverRecord>;
    pending = this.persistPendingGeneration(record).finally(() => {
      if (this.pendingLifecycle.get(record.requestKey) === pending) this.pendingLifecycle.delete(record.requestKey);
    });
    this.pendingLifecycle.set(record.requestKey, pending);
    return pending;
  }

  private async persistPendingGeneration(record: ImageDriverRecord): Promise<ImageDriverRecord> {
    const identified = await this.ensureProviderIdentity(record);
    this.emitPendingProjection(identified);
    if (identified.obligationPendingRecorded) return identified;
    const marked = { ...identified, obligationPendingRecorded: true };
    await this.writeRecord(marked, 'image-generation-pending');
    return marked;
  }

  private settleGeneration(
    record: ImageDriverRecord,
    requestedStatus: TerminalDriverStatus,
    error?: string,
    kind = `image-generation-${requestedStatus}`,
    withinArtifactCommit = false,
  ): Promise<ImageDriverRecord> {
    if (!withinArtifactCommit) {
      const commit = this.artifactCommitWindows.get(record.requestKey);
      if (commit) return commit.then((result) => result.record);
    }
    const existing = this.terminalSettlements.get(record.requestKey);
    if (existing) return existing;
    let pending!: Promise<ImageDriverRecord>;
    pending = this.persistGenerationSettlement(record, requestedStatus, error, kind, withinArtifactCommit).finally(() => {
      if (this.terminalSettlements.get(record.requestKey) === pending) this.terminalSettlements.delete(record.requestKey);
    });
    this.terminalSettlements.set(record.requestKey, pending);
    return pending;
  }

  private async persistGenerationSettlement(
    record: ImageDriverRecord,
    requestedStatus: TerminalDriverStatus,
    error: string | undefined,
    kind: string,
    withinArtifactCommit = false,
  ): Promise<ImageDriverRecord> {
    if (!withinArtifactCommit) {
      const commit = this.artifactCommitWindows.get(record.requestKey);
      if (commit) return commit.then((result) => result.record);
    }
    // A provider response can race a board abort/run error. Always adjudicate against the
    // newest local durable projection so a late success cannot overwrite a terminal cancel/fail.
    const cached = this.records.get(record.requestKey);
    let current = cached ?? record;
    current = await this.ensureProviderIdentity(current);
    const status: TerminalDriverStatus = isTerminalStatus(current.status) ? current.status : requestedStatus;
    const artifactId = record.artifactId ?? current.artifactId;
    const terminalError = status === 'succeeded'
      ? undefined
      : stringField(error) ?? stringField(current.error) ?? (status === 'canceled' ? 'Generation request canceled.' : 'Image generation failed.');

    if (status === 'succeeded' && !strictString(artifactId)) {
      throw new Error(`Image generation request '${current.requestKey}' cannot succeed without a committed artifact.`);
    }
    current = await this.recordPendingGeneration(current);
    if (current.status !== status || current.error !== terminalError || current.artifactId !== artifactId) {
      current = {
        ...current,
        status,
        ...(artifactId ? { artifactId } : {}),
        ...(terminalError ? { error: terminalError } : { error: undefined }),
        obligationSettledRecorded: current.obligationSettledRecorded === true,
      };
      await this.writeRecord(current, kind);
    }
    this.emitSettledProjection(current);
    if (!this.host.recordObligationEvent || current.obligationSettledRecorded) return current;
    const settled = { ...current, obligationSettledRecorded: true };
    await this.writeRecord(settled, 'image-generation-obligation-settled');
    return settled;
  }

  private async ensureTerminalSettlement(record: ImageDriverRecord): Promise<ImageDriverRecord> {
    const identified = await this.ensureProviderIdentity(record);
    if (!isTerminalStatus(identified.status)) return identified;
    if (this.emittedSettled.has(identified.requestKey) && identified.obligationSettledRecorded) return identified;
    return this.settleGeneration(identified, identified.status, identified.error, 'image-generation-recovered');
  }

  private projectRecord(record: ImageDriverRecord): void {
    this.emitPendingProjection(record);
    if (isTerminalStatus(record.status)) this.emitSettledProjection(record);
  }

  private emitPendingProjection(record: ImageDriverRecord): void {
    if (!this.host.recordObligationEvent || this.emittedPending.has(record.requestKey)) return;
    this.host.recordObligationEvent({
      type: 'artifact-generation-pending',
      obligationId: this.obligationId(record),
      target: this.obligationTarget(record),
      dataType: IMAGE_DATA_TYPE,
      requestId: record.requestKey,
      providerTaskId: record.providerTaskId,
      status: 'pending',
    });
    this.emittedPending.add(record.requestKey);
  }

  private emitSettledProjection(record: ImageDriverRecord): void {
    if (!this.host.recordObligationEvent || !isTerminalStatus(record.status) || this.emittedSettled.has(record.requestKey)) return;
    this.emitPendingProjection(record);
    this.host.recordObligationEvent({
      type: 'artifact-generation-settled',
      obligationId: this.obligationId(record),
      target: this.obligationTarget(record),
      dataType: IMAGE_DATA_TYPE,
      requestId: record.requestKey,
      providerTaskId: record.providerTaskId,
      status: record.status,
    });
    this.emittedSettled.add(record.requestKey);
  }

  private async hydrateBoardRecords(canvasId: string, boardId: string): Promise<void> {
    const listed = await this.host.listPluginAggregates(manifest.id);
    if (listed.error) throw new Error(`Failed to list image generation state: ${listed.error}`);
    if (listed.aggregates !== undefined && !Array.isArray(listed.aggregates)) {
      throw new Error('Invalid persisted image generation aggregate listing.');
    }
    for (const aggregate of listed.aggregates ?? []) {
      if (typeof aggregate !== 'string') throw new Error('Invalid persisted image generation aggregate id.');
      if (!aggregate.startsWith(AGGREGATE_PREFIX)) continue;
      if (!AGGREGATE_ID_PATTERN.test(aggregate)) throw new Error('Invalid persisted image generation aggregate id.');
      const record = await this.readAggregateRecord(aggregate, undefined, { project: false });
      if (record?.canvasId !== canvasId || record.boardId !== boardId) continue;
      this.projectRecord(record);
      if (record.status !== 'succeeded' || !record.artifactId || !this.host.reconcileArtifactRoot) continue;
      const reconciled = await this.host.reconcileArtifactRoot(record.canvasId, record.boardId, {
        id: record.artifactId,
        version: 1,
      }, record.agentId);
      if (reconciled.error) {
        throw new Error(`Failed to reconcile image artifact root for '${record.requestKey}': ${reconciled.error}`);
      }
    }
  }

  private terminalResult(record: ImageDriverRecord, reused = true): AgentToolResult {
    if (record.status === 'succeeded') {
      return this.result(true, {
        requestId: record.requestKey,
        providerTaskId: record.providerTaskId,
        status: record.status,
        ...(record.artifactId ? { artifactId: record.artifactId } : {}),
        reused,
      });
    }
    return this.result(false, {
      requestId: record.requestKey,
      providerTaskId: record.providerTaskId,
      status: record.status,
      error: record.error || 'Request is no longer active.',
      reused,
    });
  }

  private async cancelRecord(record: ImageDriverRecord): Promise<AgentToolResult> {
    const identified = await this.ensureProviderIdentity(record);
    if (identified.status === 'succeeded') {
      await this.ensureTerminalSettlement(identified);
      return this.result(false, { requestId: identified.requestKey, providerTaskId: identified.providerTaskId, error: 'Cannot cancel a completed generation request.', reused: true });
    }
    if (identified.status === 'canceled') {
      const canceled = await this.ensureTerminalSettlement(identified);
      return this.result(true, {
        requestId: canceled.requestKey,
        providerTaskId: canceled.providerTaskId,
        status: canceled.status,
        reused: true,
      });
    }
    if (identified.status === 'failed') return this.terminalResult(await this.ensureTerminalSettlement(identified));
    const canceled = await this.settleGeneration(identified, 'canceled', 'Generation request canceled.', 'image-generation-canceled');
    if (canceled.status === 'succeeded') {
      return this.result(false, {
        requestId: canceled.requestKey,
        providerTaskId: canceled.providerTaskId,
        error: 'Cannot cancel a completed generation request.',
        reused: true,
      });
    }
    return this.result(true, {
      requestId: canceled.requestKey,
      providerTaskId: canceled.providerTaskId,
      status: canceled.status,
      reused: false,
    });
  }

  private async recoverPendingRecord(record: ImageDriverRecord): Promise<AgentToolResult> {
    // The provider-neutral image seam is one-shot and has no read/cancel operation. An orphaned
    // pending record therefore settles as an unknown/failed outcome instead of risking a second
    // paid dispatch; the persisted providerTaskId remains the replay identity.
    const recovered = await this.settleGeneration(record, 'failed', RECOVERED_PENDING_ERROR, 'image-generation-recovered');
    return this.result(false, {
      requestId: recovered.requestKey,
      providerTaskId: recovered.providerTaskId,
      status: recovered.status,
      error: recovered.error,
      recovered: true,
      reused: true,
    });
  }

  private async handleGenerate(ctx: AgentToolContext, req: ImageGenerateToolRequest): Promise<AgentToolResult> {
    if (!ctx.agentId) return this.result(false, { error: 'Image generation requires an exact executing Agent identity.' });
    if (req.cancel && !req.requestId && !req.prompt?.trim()) {
      return this.result(false, { error: 'requestId or prompt is required to cancel an image generation request.' });
    }
    let existingById: ImageDriverRecord | undefined;
    try {
      existingById = req.requestId ? await this.readRecord(req.requestId) : undefined;
    } catch (error: any) {
      return this.result(false, { requestId: req.requestId, error: String(error?.message ?? error) });
    }
    if (existingById) {
      if (!this.requestOwnedBy(existingById, ctx)) {
        return this.result(false, {
          requestId: existingById.requestKey,
          error: `Request '${existingById.requestKey}' belongs to another Agent or legacy presentation.`,
        });
      }
      if (req.cancel) return this.cancelRecord(existingById);
      if (existingById.status === 'succeeded' || existingById.status === 'failed' || existingById.status === 'canceled') {
        const identified = await this.ensureTerminalSettlement(existingById);
        return this.terminalResult(identified);
      }
      const alreadyRunning = this.inFlight.get(existingById.requestKey);
      if (alreadyRunning) {
        if (alreadyRunning.agentId !== ctx.agentId) {
          return this.result(false, { requestId: existingById.requestKey, error: 'Request belongs to another Agent.' });
        }
        return alreadyRunning.promise;
      }
      return this.recoverPendingRecord(existingById);
    }
    if (req.cancel && req.requestId) {
      return this.result(false, { requestId: req.requestId, error: 'No active generation request exists for this requestId.' });
    }
    // A persisted requestId is sufficient to replay a terminal result. Only new dispatches
    // require a prompt; this keeps reconnect/replay independent from the original prompt payload.
    if (!req.prompt?.trim()) return this.result(false, { requestId: req.requestId, error: 'A prompt is required for image generation.' });
    const configured = this.configuredService(ctx);
    const target = configured.target;
    if (!target) {
      const error = configured.error ?? 'No image generation provider is available.';
      return this.result(false, { error });
    }
    const requestKey = this.requestKey(ctx, target.providerId, req);
    const alreadyRunning = this.inFlight.get(requestKey);
    if (alreadyRunning) {
      if (alreadyRunning.agentId !== ctx.agentId) {
        return this.result(false, { requestId: requestKey, error: 'Request belongs to another Agent.' });
      }
      const current = await this.readRecord(requestKey);
      if (current && isTerminalStatus(current.status)) return this.terminalResult(await this.ensureTerminalSettlement(current));
      return alreadyRunning.promise;
    }
    const running = this.dispatchGenerate(ctx, req, target, requestKey, existingById)
      .finally(() => {
        if (this.inFlight.get(requestKey)?.promise === running) this.inFlight.delete(requestKey);
      });
    this.inFlight.set(requestKey, { agentId: ctx.agentId, promise: running });
    return running;
  }

  private async dispatchGenerate(
    ctx: AgentToolContext,
    req: ImageGenerateToolRequest,
    target: ImageServiceTarget,
    requestKey: string,
    existingById: ImageDriverRecord | undefined,
  ): Promise<AgentToolResult> {
    let existing: ImageDriverRecord | undefined;
    try {
      existing = existingById ?? await this.readRecord(requestKey);
    } catch (error: any) {
      return this.result(false, { requestId: requestKey, error: String(error?.message ?? error) });
    }
    if (existing) {
      if (!this.requestOwnedBy(existing, ctx)) {
        return this.result(false, { requestId: existing.requestKey, error: 'Request belongs to another Agent or legacy presentation.' });
      }
      const identified = await this.ensureProviderIdentity(existing);
      if (req.cancel) return this.cancelRecord(identified);
      if (identified.status === 'succeeded' || identified.status === 'failed' || identified.status === 'canceled') {
        return this.terminalResult(await this.ensureTerminalSettlement(identified));
      }
      return this.recoverPendingRecord(identified);
    }
    if (req.cancel) return this.result(false, { requestId: requestKey, error: 'No active generation request exists for this requestId.' });
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
    let record: ImageDriverRecord | undefined;
    try {
      record = {
        requestKey,
        agentId: ctx.agentId,
        canvasId: ctx.presentation === 'headless' ? undefined : ctx.canvasId,
        boardId: ctx.presentation === 'headless' ? undefined : ctx.boardId,
        turnIndex: ctx.turnIndex,
        providerId: target.providerId,
        request,
        providerTaskId: providerTaskIdFor(target.providerId, requestKey),
        status: 'pending',
      };
      await this.writeRecord(record, 'image-generation-created');
      record = await this.recordPendingGeneration(record);
      const beforeProvider = await this.readRecord(requestKey);
      if (beforeProvider && beforeProvider.status !== 'pending') {
        return this.terminalResult(await this.ensureTerminalSettlement(beforeProvider));
      }
      if (ctx.signal.aborted) {
        const canceled = await this.settleGeneration(record, 'canceled', 'Generation request canceled before provider dispatch.', 'image-generation-canceled');
        return this.result(true, {
          requestId: canceled.requestKey,
          providerTaskId: canceled.providerTaskId,
          status: canceled.status,
          reused: false,
        });
      }
      const image = target.plugin
        ? await target.plugin.create(this.providerContext(target.plugin)).generate(record.request, ctx.signal)
        : await this.host.generateImageWithEngine!(target.engine!, record.request, ctx.signal);
      const afterProvider = await this.readRecord(requestKey);
      if (afterProvider && afterProvider.status !== 'pending') {
        return this.terminalResult(await this.ensureTerminalSettlement(afterProvider));
      }
      if (ctx.signal.aborted) {
        const canceled = await this.settleGeneration(record, 'canceled', 'Generation request canceled before artifact production.', 'image-generation-canceled');
        return this.result(true, {
          requestId: canceled.requestKey,
          providerTaskId: canceled.providerTaskId,
          status: canceled.status,
          reused: false,
        });
      }
      let commit!: Promise<ArtifactCommitResult>;
      commit = Promise.resolve()
        .then(() => this.commitArtifact(ctx, req, record!, image))
        .finally(() => {
          if (this.artifactCommitWindows.get(requestKey) === commit) this.artifactCommitWindows.delete(requestKey);
        });
      this.artifactCommitWindows.set(requestKey, commit);
      const committed = await commit;
      const succeeded = committed.record;
      const produced = committed.produced;
      if (committed.error) {
        return this.result(false, {
          requestId: requestKey,
          status: succeeded.status,
          error: committed.error,
          ...(produced?.ref ? { artifact: produced.ref, path: produced.path } : {}),
        });
      }
      if (!produced?.ref || succeeded.status !== 'succeeded') return this.terminalResult(succeeded, false);
      return this.result(true, {
        requestId: requestKey,
        providerTaskId: succeeded.providerTaskId,
        status: succeeded.status,
        artifact: produced.ref,
        path: produced.path,
      });
    } catch (error: any) {
      const current = this.records.get(requestKey) ?? record;
      if (current && isTerminalStatus(current.status)) return this.terminalResult(await this.ensureTerminalSettlement(current));
      const status: TerminalDriverStatus = isAbortError(error, ctx.signal) ? 'canceled' : 'failed';
      const message = String(error?.message ?? error);
      const settled = await this.settleGeneration(current ?? record!, status, message, `image-generation-${status}`);
      return this.terminalResult(settled, false);
    }
  }

  private requestOwnedBy(record: ImageDriverRecord, ctx: AgentToolContext): boolean {
    if (record.agentId) return record.agentId === ctx.agentId;
    // Retain exact replay of durable pre-Agent requests without adopting them into a Worker.
    return ctx.presentation !== 'headless' && !!ctx.canvasId && !!ctx.boardId
      && record.canvasId === ctx.canvasId && record.boardId === ctx.boardId;
  }

  private async commitArtifact(
    ctx: AgentToolContext,
    req: ImageGenerateToolRequest,
    record: ImageDriverRecord,
    image: ImageGenerationResult,
  ): Promise<ArtifactCommitResult> {
    const existingSettlement = this.terminalSettlements.get(record.requestKey);
    if (existingSettlement) {
      const settled = await existingSettlement;
      if (isTerminalStatus(settled.status)) return { record: settled };
    }
    const current = await this.readRecord(record.requestKey);
    if (current && current.status !== 'pending') return { record: current };
    const active = current ?? record;
    if (ctx.signal.aborted) {
      const canceled = await this.settleGeneration(active, 'canceled', 'Generation request canceled before artifact production.', 'image-generation-canceled', true);
      return { record: canceled };
    }
    const atomicCommit = this.host.commitBornArtifactWithPluginEvent;
    if (!atomicCommit) {
      const failed = await this.settleGeneration(
        active,
        'failed',
        'The host does not expose the atomic ArtifactStore/PluginStateStore image settlement boundary.',
        'image-generation-artifact-failed',
        true,
      );
      return { record: failed };
    }
    let produced: ProducedArtifact;
    try {
      produced = await atomicCommit(
        record.canvasId,
        record.boardId,
        {
          producerAgentId: record.agentId,
          source: 'born',
          dataType: IMAGE_DATA_TYPE,
          label: image.label || `${record.requestKey}.png`,
          mime: image.mime || 'image/png',
          ...(image.metadata ? { metadata: image.metadata } : {}),
          pluginId: manifest.id,
          bytes: image.bytes,
          ...(req.attachToTurn !== false && record.canvasId && record.boardId ? { attachTo: { turnIndex: record.turnIndex } } : {}),
        },
        {
          pluginId: manifest.id,
          aggregateId: imageGenerationAggregateId(active.requestKey),
          eventForArtifact: (ref) => {
            const terminal = asRecord({
              ...active,
              status: 'succeeded',
              artifactId: ref.id,
              obligationSettledRecorded: true,
            }, active.requestKey);
            if (!terminal) {
              throw new Error(`Image generation request '${active.requestKey}' produced an invalid terminal record.`);
            }
            return {
              kind: 'image-generation-succeeded',
              payload: terminal,
              timestamp: new Date().toISOString(),
            };
          },
        },
      );
    } catch (error: any) {
      const failed = await this.settleGeneration(active, 'failed', String(error?.message ?? error), 'image-generation-artifact-failed', true);
      return { record: failed };
    }
    if (produced.error || !produced.ref) {
      const failed = await this.settleGeneration(active, 'failed', produced.error || 'Artifact production failed.', 'image-generation-artifact-failed', true);
      return { record: failed };
    }
    const succeeded: ImageDriverRecord = {
      ...active,
      status: 'succeeded',
      artifactId: produced.ref.id,
      obligationSettledRecorded: true,
    };
    this.records.set(succeeded.requestKey, succeeded);
    this.emitSettledProjection(succeeded);
    return { record: succeeded, produced };
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
