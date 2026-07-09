import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { modelArtifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, ModelGenerationProviderPlugin, ModelGenerationTaskSnapshot } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults } from '../../../src/protocol';
import { registerModelGenerationProvider } from '../../../src/plugin-runtime/registry';

function makeCtx(project: string, artifactDefaults: ArtifactGenerationDefaults = { image: '', 'model-3d': '' }) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const aggregates = new Map<string, any[]>();
  const obligationEvents: any[] = [];
  const ctx: HostServiceContext = {
    cwd: () => project,
    artifactDefaults: () => artifactDefaults,
    produceArtifact: async (canvasId, boardId, input) => {
      produceCalls.push({ canvasId, boardId, input });
      return {
        ref: {
          id: `model-${produceCalls.length}`,
          class: input.source,
          dataType: input.dataType ?? 'meta',
          version: 1,
          mime: input.mime ?? 'application/octet-stream',
          producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
          label: input.label ?? 'model.glb',
        },
        path: path.join(project, '.braid', 'artifacts', 'objects', `model-${produceCalls.length}`, 'v1.glb'),
      };
    },
    recordObligationEvent: (event) => {
      obligationEvents.push(event);
    },
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    appendPluginEvent: async (pluginId, aggregateId, event) => {
      const events = aggregates.get(aggregateId) ?? [];
      events.push(event);
      aggregates.set(aggregateId, events);
      return { pluginId, aggregateId, seq: events.length };
    },
    readPluginAggregate: async (pluginId, aggregateId) => ({ pluginId, aggregateId, version: 1, events: aggregates.get(aggregateId) ?? [] }),
    listPluginAggregates: async (pluginId) => ({ pluginId, aggregates: [...aggregates.keys()] }),
    deletePluginAggregate: async (_pluginId, aggregateId) => {
      aggregates.delete(aggregateId);
      return { aggregateId };
    },
    prunePluginAggregate: async (_pluginId, aggregateId) => ({ aggregateId }),
    sendBoardMessage: async () => ({ delivered: true }),
    readBoardMessages: async () => ({ messages: [] }),
    updateAggregateRun: async (update) => ({ pluginId: update.pluginId, aggregateId: update.aggregateId }),
    readAggregateRun: async (pluginId, aggregateId) => ({ pluginId, aggregateId }),
    writeAggregateContext: async (block) => ({ pluginId: block.pluginId, aggregateId: block.aggregateId, scope: block.scope }),
    readAggregateContext: async (pluginId, aggregateId) => ({ pluginId, aggregateId }),
    liveOwnerKeys: () => new Set(),
    openCanvasIds: () => ['c1'],
    liveBoardKeys: () => [],
    hasLiveBoardKey: () => false,
    deliverLiveBoardMessage: () => false,
    captureFileSnapshot: () => undefined,
    publishWorkspaceState: () => undefined,
    publishWorkspaceEvent: () => undefined,
  } as HostServiceContext;
  return { ctx, produceCalls, aggregates, obligationEvents };
}

function makeHarness(project: string, artifactDefaults?: ArtifactGenerationDefaults) {
  const host = makeCtx(project, artifactDefaults);
  const service = modelArtifactsHostServicePlugin.create(host.ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get('model_generate');
    if (!tool) throw new Error('missing model_generate tool');
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 3, provider: 'codex', signal }, args);
  };
  return { service, tools, call, ...host };
}

function registerFakeProvider(options: {
  id?: string;
  requiresCostConfirmation?: boolean;
  createTask?: () => ModelGenerationTaskSnapshot | Promise<ModelGenerationTaskSnapshot>;
  readTasks?: ModelGenerationTaskSnapshot[];
  downloadBytes?: Uint8Array;
}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let createCalls = 0;
  let readCalls = 0;
  let downloadCalls = 0;
  let cancelCalls = 0;
  const readIds: string[] = [];
  const readTasks = [...(options.readTasks ?? [{ providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'fake.glb' } }])];
  const provider: ModelGenerationProviderPlugin = {
    id: `fake-model-provider-${suffix}`,
    providerId: options.id ?? `fake-provider-${suffix}`,
    label: 'Fake Model Provider',
    capabilities: {
      textTo3d: true,
      supportedOutputMimes: ['model/gltf-binary'],
      supportsCancellation: true,
      requiresCostConfirmation: options.requiresCostConfirmation ?? false,
    },
    create: () => ({
      createTask: async () => {
        createCalls += 1;
        return await (options.createTask?.() ?? { providerTaskId: 'task-1', status: 'queued' });
      },
      readTask: async (providerTaskId) => {
        readCalls += 1;
        readIds.push(providerTaskId);
        return readTasks.shift() ?? { providerTaskId: 'task-1', status: 'running' };
      },
      cancelTask: async () => {
        cancelCalls += 1;
        return { providerTaskId: 'task-1', status: 'canceled' };
      },
      downloadResult: async () => {
        downloadCalls += 1;
        return { bytes: options.downloadBytes ?? new Uint8Array([0x67, 0x6c, 0x54, 0x46]), mime: 'model/gltf-binary', label: 'fake.glb' };
      },
    }),
  };
  const unregister = registerModelGenerationProvider(provider);
  return {
    provider,
    unregister,
    counts: {
      get create() { return createCalls; },
      get read() { return readCalls; },
      get download() { return downloadCalls; },
      get cancel() { return cancelCalls; },
      get readIds() { return readIds; },
    },
  };
}

function parse(result: AgentToolResult): any {
  return JSON.parse(result.result);
}

describe('model artifacts host service', () => {
  it('exposes model_generate as a normal Braid agent tool', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-tool-'));
    try {
      const harness = makeHarness(project);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'model_generate');
      expect(tool?.tool.namespace).toBe('braid');
      expect(tool?.tool.description).toContain('normal chat');
      expect(tool?.tool.description).toContain('Braid Settings');
      expect(tool?.tool.description).toContain('confirmCost');
      expect(tool?.tool.description).toContain('requestId');
      expect(tool?.tool.description).toContain('targetPolycount');
      expect(tool?.tool.description).not.toContain('providerId');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('providerId');
      expect(tool?.tool.description).not.toContain('first capable');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocks cost-confirmed providers until confirmCost is explicit', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-cost-'));
    const fake = registerFakeProvider({ requiresCostConfirmation: true });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const result = await harness.call({ requestId: 'paid-1', prompt: 'a stylized crate' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('confirmCost');
      expect(fake.counts.create).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when no default 3D model service is configured', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-no-default-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project);
      const result = await harness.call({ requestId: 'missing-default-1', prompt: 'a stylized crate' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('Braid Settings');
      expect(fake.counts.create).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when the configured 3D model service is invalid', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-invalid-default-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': 'missing-service' });
      const result = await harness.call({ requestId: 'invalid-default-1', prompt: 'a stylized crate' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('missing-service');
      expect(parse(result).error).toContain('Braid Settings');
      expect(fake.counts.create).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reuses one provider task for retry of the same logical request and attaches the finished artifact', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-idempotent-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'crate.glb' } },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'crate-1', prompt: 'a stylized crate' });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'crate-1', status: 'running', providerTaskId: 'task-1' });
      expect(fake.counts.create).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-generation-pending',
        target: { canvasId: 'c1', boardId: 'b1', turnIndex: 3 },
        dataType: 'model-3d',
        requestId: 'crate-1',
        providerTaskId: 'task-1',
        status: 'running',
      }));

      const second = await harness.call({ requestId: 'crate-1', prompt: 'a stylized crate' });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'crate-1', status: 'succeeded' });
      expect(fake.counts.create).toBe(1);
      expect(fake.counts.download).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'model-3d',
        mime: 'model/gltf-binary',
        label: 'fake.glb',
        attachTo: { turnIndex: 3 },
      });
      expect(harness.produceCalls[0].input.bytes).toBeInstanceOf(Uint8Array);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('watches a pending provider task to success and attaches without a second agent call', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-watch-success-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'watched.glb' } },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'watched-success-1', prompt: 'a watched crate' });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'watched-success-1', status: 'running' });

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(fake.counts.create).toBe(1);
      expect(fake.counts.download).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-generation-settled',
        obligationId: 'artifacts.output.b1.3',
        dataType: 'model-3d',
        requestId: 'watched-success-1',
        providerTaskId: 'task-1',
        status: 'succeeded',
      }));
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('watches a pending provider task to failure without producing an artifact', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-watch-fail-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'failed', error: 'provider failed later' },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'watched-fail-1', prompt: 'a failing crate' });
      expect(first.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(harness.produceCalls).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-generation-settled',
        obligationId: 'artifacts.output.b1.3',
        dataType: 'model-3d',
        requestId: 'watched-fail-1',
        providerTaskId: 'task-1',
        status: 'failed',
      }));
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('recovers a pending watcher from aggregate records on canvas ready', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-watch-recover-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'recovered.glb' } },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'watched-recover-1', prompt: 'a recoverable crate' });
      expect(first.ok).toBe(true);
      await harness.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });

      const recreated = modelArtifactsHostServicePlugin.create(harness.ctx);
      await recreated.onCanvasReady?.('c1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(fake.counts.create).toBe(1);
      expect(fake.counts.download).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-generation-settled',
        requestId: 'watched-recover-1',
        status: 'succeeded',
      }));
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not create duplicate provider tasks for concurrent same-request dispatch', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-concurrent-'));
    const fake = registerFakeProvider({
      createTask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { providerTaskId: 'task-1', status: 'queued' };
      },
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'running' },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const [first, second] = await Promise.all([
        harness.call({ requestId: 'same-paid-request', prompt: 'a stylized crate' }),
        harness.call({ requestId: 'same-paid-request', prompt: 'a stylized crate' }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(fake.counts.create).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('persists provider task id transitions for multi-stage providers', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-stage-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'stage-2', status: 'running' },
        { providerTaskId: 'stage-2', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'staged.glb' } },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'staged-1', prompt: 'a staged model' });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'staged-1', status: 'running', providerTaskId: 'stage-2' });

      const second = await harness.call({ requestId: 'staged-1', prompt: 'a staged model' });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'staged-1', status: 'succeeded' });
      expect(fake.counts.readIds).toEqual(['task-1', 'stage-2']);
      expect(fake.counts.create).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('returns actionable failures and cancellations without producing partial artifacts', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-fail-cancel-'));
    const failed = registerFakeProvider({
      id: 'fake-failure-provider',
      readTasks: [{ providerTaskId: 'task-1', status: 'failed', error: 'provider rejected prompt' }],
    });
    const canceled = registerFakeProvider({
      id: 'fake-cancel-provider',
      readTasks: [{ providerTaskId: 'task-1', status: 'running' }],
    });
    try {
      const defaults: ArtifactGenerationDefaults = { image: '', 'model-3d': failed.provider.providerId };
      const harness = makeHarness(project, defaults);
      const failResult = await harness.call({ requestId: 'bad-1', prompt: 'bad' });
      expect(failResult.ok).toBe(false);
      expect(parse(failResult)).toMatchObject({ requestId: 'bad-1', status: 'failed', error: 'provider rejected prompt' });

      defaults['model-3d'] = canceled.provider.providerId;
      const pending = await harness.call({ requestId: 'cancel-1', prompt: 'cancel me' });
      expect(pending.ok).toBe(true);
      const cancelResult = await harness.call({ requestId: 'cancel-1', prompt: 'cancel me', cancel: true });
      expect(cancelResult.ok).toBe(true);
      expect(parse(cancelResult)).toMatchObject({ requestId: 'cancel-1', status: 'canceled' });
      expect(canceled.counts.cancel).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      failed.unregister();
      canceled.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps an aborted pending provider task resumable across service recreation without duplicating jobs', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-model-recreate-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'model/gltf-binary', format: 'glb', label: 'reload.glb' } },
      ],
    });
    try {
      const harness = makeHarness(project, { image: '', 'model-3d': fake.provider.providerId });
      const first = await harness.call({ requestId: 'reload-1', prompt: 'a reload-safe object' });
      expect(first.ok).toBe(true);
      await harness.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      const releaseEvents = [...harness.aggregates.values()].flat().filter((event: any) => event.kind === 'model-generation-released');
      expect(releaseEvents).toHaveLength(1);
      expect(releaseEvents[0].payload).toMatchObject({
        requestKey: 'reload-1',
        status: 'pending',
        error: expect.stringContaining('resume'),
      });

      const recreated = modelArtifactsHostServicePlugin.create(harness.ctx);
      const tool = recreated.agentTools?.()[0] as AgentToolPlugin<Record<string, unknown>>;
      const second = await tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 3, provider: 'codex', signal: new AbortController().signal }, {
        requestId: 'reload-1',
        prompt: 'a reload-safe object',
      });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'reload-1', status: 'succeeded' });
      expect(fake.counts.create).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
