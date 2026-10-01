import { randomUUID } from 'node:crypto';
import type { CuaDriverLike, CuaDriverSessionLike, ToolResult } from '@trycua/cua-driver';
import type { AgentToolResult } from '../../../src/engine/types';
import type {
  AgentToolContext, HostAgentExecutionReleasedEvent, HostService, HostServiceContext, HostServicePlugin,
} from '../../../src/plugin-api/types';
import { createComputerUseAgentTools, manifest } from './agentTool';

type DriverSdk = typeof import('@trycua/cua-driver');
interface DriverRuntime { sdk: DriverSdk; driver: CuaDriverLike }
interface AgentSession {
  controller: AbortController;
  native?: CuaDriverSessionLike;
}
interface DriverTool extends Record<string, unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}
interface DriverCatalog extends Record<string, unknown> { tools: DriverTool[] }
interface DriverAction { action: string; args: Record<string, unknown> }
interface BatchStep {
  index: number;
  action: string;
  ok: boolean;
  result: unknown;
  imageIndices: number[];
}

// Cua's normal session bounds. Expiry is enforced by the native runtime, not a Braid timer.
const SESSION_TTL_SECONDS = 28_800n;
const SESSION_IDLE_TTL_SECONDS = 300n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field);
}

function actionRequest(input: Record<string, unknown>): DriverAction {
  if (typeof input.action !== 'string' || !input.action.trim()) throw new Error('A Driver action name is required.');
  if (!isRecord(input.arguments)) throw new Error('Driver arguments must be a JSON object.');
  return { action: input.action, args: input.arguments };
}

function request(input: Record<string, unknown>): { actions: DriverAction[]; batch: boolean } {
  if (input.actions === undefined) return { actions: [actionRequest(input)], batch: false };
  if (input.action !== undefined || input.arguments !== undefined) throw new Error('Use either actions or action with arguments, not both.');
  if (!Array.isArray(input.actions) || !input.actions.length) throw new Error('Driver actions must be a nonempty array.');
  return {
    batch: true,
    actions: input.actions.map((value, index) => {
      if (!isRecord(value)) throw new Error(`Driver actions[${index}] must be an object.`);
      return actionRequest(value);
    }),
  };
}

function failure(error: unknown, dispatched = false): AgentToolResult {
  return {
    ok: false,
    result: json({
      error: error instanceof Error ? error.message : String(error),
      // UniFFI errors carry the attested completion/refusal detail in inner.
      ...(isRecord(error) && 'inner' in error ? { details: error.inner } : {}),
      ...(dispatched ? { warning: 'The action may have completed. Do not retry a non-idempotent action until a fresh observation resolves its outcome.' } : {}),
    }),
  };
}

function toolResult(action: string, result: ToolResult): AgentToolResult {
  let structured: unknown = result.structuredJson;
  if (result.structuredJson) {
    try { structured = JSON.parse(result.structuredJson); } catch { /* Preserve opaque platform results. */ }
  }
  return {
    ok: !result.isError,
    result: json({
      action, text: result.text, structured, errorCode: result.errorCode,
      degraded: result.degraded, actionResult: result.action, verification: result.verification,
    }),
    ...(result.images.length ? { images: result.images.map((image) => ({ mediaType: image.mimeType, data: image.dataBase64 })) } : {}),
  };
}

function batchResult(total: number, results: BatchStep[], images: NonNullable<AgentToolResult['images']>): AgentToolResult {
  const failed = results.find((step) => !step.ok);
  return {
    ok: !failed && results.length === total,
    result: json({ total, completed: results.filter((step) => step.ok).length, results, ...(failed ? { stoppedAt: failed.index } : {}) }),
    ...(images.length ? { images } : {}),
  };
}

function closeNativeSession(scope: AgentSession): void {
  if (!scope.native) return;
  const session = scope.native;
  scope.native = undefined;
  try { session.close(); } finally {
    if ('uniffiDestroy' in session && typeof session.uniffiDestroy === 'function') session.uniffiDestroy();
  }
}

function closeSession(scope: AgentSession): void {
  scope.controller.abort();
  closeNativeSession(scope);
}

export class ComputerUseHostService implements HostService {
  readonly id = 'computer-use.hostService';
  readonly label = 'Computer Use';
  readonly manifest = manifest;
  private runtime?: Promise<DriverRuntime>;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  private disposal?: Promise<void>;

  constructor(private readonly host: Pick<HostServiceContext, 'readPluginConfig'>) {}

  agentTools() {
    return createComputerUseAgentTools({
      discover: (ctx, input) => this.discover(ctx, input),
      execute: (ctx, input) => this.execute(ctx, input),
      requiresApproval: (input) => this.requiresApproval(input),
    });
  }

  hasActiveWork(): boolean { return this.active.size > 0; }

  onAgentExecutionReleased(event: HostAgentExecutionReleasedEvent): void {
    const scope = this.sessions.get(event.agentId);
    this.sessions.delete(event.agentId);
    if (scope) closeSession(scope);
  }

  drain(): Promise<void> { return this.dispose(); }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      const errors: unknown[] = [];
      for (const scope of this.sessions.values()) {
        try { closeSession(scope); } catch (error) { errors.push(error); }
      }
      this.sessions.clear();
      await Promise.allSettled(this.active);
      if (this.runtime) {
        // Failed initialization has no surviving runtime to close.
        const runtime = await this.runtime.catch(() => undefined);
        if (runtime) {
          try { await runtime.driver.shutdown(); } finally {
            if ('uniffiDestroy' in runtime.driver && typeof runtime.driver.uniffiDestroy === 'function') runtime.driver.uniffiDestroy();
          }
        }
      }
      if (errors.length) throw new Error(errors.map(String).join('\n'));
    })();
    return this.disposal;
  }

  private assertEnabled(): void {
    if (this.closing) throw new Error('Computer Use service is shutting down.');
    if (this.host.readPluginConfig?.(manifest.id, {}).enabled === false) throw new Error('Computer Use plugin is disabled.');
  }

  private loadRuntime(): Promise<DriverRuntime> {
    this.assertEnabled();
    if (this.runtime) return this.runtime;
    const initializing = import('@trycua/cua-driver').then((sdk) => {
      this.assertEnabled();
      const mode = sdk.SessionPermissionMode.Standard;
      const driver = sdk.CuaDriver.createConfigured({
        claudeCodeCompatibility: false,
        authorization: {
          allowedModes: [mode], compatibilityMode: mode, unrestrictedAcknowledged: false,
          maxSessionTtlSeconds: SESSION_TTL_SECONDS, maxIdleTtlSeconds: SESSION_IDLE_TTL_SECONDS,
        },
      });
      return { sdk, driver };
    });
    this.runtime = initializing;
    void initializing.catch(() => {
      // No runtime was created. A later explicit call can try again after setup or enablement changes.
      if (this.runtime === initializing) this.runtime = undefined;
    });
    return initializing;
  }

  private async catalog(runtime: DriverRuntime, signal?: AbortSignal): Promise<DriverCatalog> {
    const value: unknown = JSON.parse(await runtime.driver.listToolsJson(signal ? { signal } : undefined));
    if (!isRecord(value) || !Array.isArray(value.tools) || !value.tools.every((tool) =>
      isRecord(tool) && typeof tool.name === 'string' && typeof tool.description === 'string' && isRecord(tool.inputSchema))) {
      throw new Error('Cua Driver returned an invalid tool catalog.');
    }
    return value as DriverCatalog;
  }

  private findTool(catalog: DriverCatalog, name: string): DriverTool {
    const tool = catalog.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown computer-use action: ${name}. Discover actions with computer_use_tools.`);
    return tool;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    return operation.finally(() => this.active.delete(operation));
  }

  private async requiresApproval(input: Record<string, unknown>): Promise<boolean> {
    const { actions } = request(input);
    const runtime = await this.loadRuntime();
    const catalog = await this.catalog(runtime);
    // Validate every name before deciding: a write action must not short-circuit validation of later actions.
    const approvals = actions.map(({ action, args }) => {
      const tool = this.findTool(catalog, action);
      // Capture tools are annotated read-only but can optionally write a screenshot to a caller-selected path.
      return tool.annotations?.readOnlyHint !== true || args.screenshot_out_file !== undefined;
    });
    this.assertEnabled();
    return approvals.some(Boolean);
  }

  private discover(ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolResult> {
    return this.track((async () => {
      this.assertEnabled();
      if (ctx.signal.aborted) throw new Error('Computer Use discovery canceled.');
      if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('Action name must be a nonempty string.');
      const runtime = await this.loadRuntime();
      const catalog = await this.catalog(runtime, ctx.signal);
      this.assertEnabled();
      if (ctx.signal.aborted) throw new Error('Computer Use discovery canceled.');
      return { ok: true, result: json(input.name ? this.findTool(catalog, input.name as string) : {
        schema_version: catalog.schema_version,
        capability_version: catalog.capability_version,
        tools: catalog.tools.map((tool) => ({
          name: tool.name, description: tool.description.split('\n')[0], annotations: tool.annotations,
        })),
        usage: 'Pass an exact name to computer_use_tools for the complete schema. Call computer_use with actions:[{action,arguments},...] for ordered execution, or action and arguments for one action. Omit arguments.session; the host binds it to this Agent.',
      }) };
    })().catch(failure));
  }

  private execute(ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolResult> {
    return this.track((async () => {
      this.assertEnabled();
      if (!ctx.agentId) throw new Error('Computer Use requires an exact Agent identity.');
      if (ctx.signal.aborted) throw new Error('Computer Use call canceled before dispatch.');
      const { actions, batch } = request(input);
      let scope = this.sessions.get(ctx.agentId);
      if (!scope) {
        scope = { controller: new AbortController() };
        this.sessions.set(ctx.agentId, scope);
      }
      const signal = new AbortController();
      const abort = () => signal.abort();
      ctx.signal.addEventListener('abort', abort, { once: true });
      scope.controller.signal.addEventListener('abort', abort, { once: true });
      const results: BatchStep[] = [];
      const images: NonNullable<AgentToolResult['images']> = [];
      let index = 0;
      let preflightComplete = false;
      let dispatched = false;
      try {
        const runtime = await this.loadRuntime();
        const catalog = await this.catalog(runtime, signal.signal);
        for (const { action } of actions) this.findTool(catalog, action);
        preflightComplete = true;
        for (index = 0; index < actions.length; index++) {
          const { action, args } = actions[index];
          dispatched = false;
          this.assertEnabled();
          if (signal.signal.aborted || scope.controller.signal.aborted) throw new Error('Computer Use call canceled before dispatch.');
          scope.native ??= runtime.sdk.createTrustedSession(runtime.driver, {
            // Cua retains a closed public name's transport ownership. Each new grant needs a fresh name;
            // the exact Agent identity remains the sole key in this service's session ownership map.
            publicSession: `braid-${randomUUID()}`,
            mode: runtime.sdk.SessionPermissionMode.Standard,
            ttlSeconds: SESSION_TTL_SECONDS, idleTtlSeconds: SESSION_IDLE_TTL_SECONDS,
          });
          dispatched = true;
          const native = await scope.native.callTool(action, json(args), { signal: signal.signal });
          if (action === 'end_session' && !native.isError) {
            // End revokes the native grant, not the Agent's cancellation scope. A later explicit action
            // (including the next batch step) may create a fresh grant; never replay the completed action.
            closeNativeSession(scope);
          }
          const result = toolResult(action, native);
          if (!batch) return result;
          const imageIndices = (result.images ?? []).map((_, offset) => images.length + offset);
          images.push(...(result.images ?? []));
          results.push({ index, action, ok: result.ok, result: JSON.parse(result.result), imageIndices });
          if (!result.ok) break;
        }
        return batchResult(actions.length, results, images);
      } catch (error) {
        const result = failure(error, dispatched);
        // Invalid input/catalog admission executes nothing and retains the common error response.
        if (!batch || !preflightComplete) return result;
        results.push({ index, action: actions[index].action, ok: false, result: JSON.parse(result.result), imageIndices: [] });
        return batchResult(actions.length, results, images);
      } finally {
        ctx.signal.removeEventListener('abort', abort);
        scope.controller.signal.removeEventListener('abort', abort);
      }
    })().catch(failure));
  }
}

export const computerUseHostServicePlugin: HostServicePlugin = {
  id: 'computer-use.hostService',
  label: 'Computer Use',
  manifest,
  create: (host) => new ComputerUseHostService(host),
};
