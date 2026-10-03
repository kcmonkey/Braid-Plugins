import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createImageArtifactsHostServicePlugin, imageGenerationAggregateId } from './service';
import type {
  AgentToolPlugin,
  HostServiceArtifactSettlementInput,
  HostServiceArtifactSettlementResult,
  HostServiceBornArtifactInput,
  HostServiceContext,
  ImageGenerationProviderPlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults, ArtifactGenerationServiceView } from '../../../src/protocol';
import { PluginStateStore } from '../../../src/persistence/pluginStateStore';
import { ArtifactStore } from '../../../src/persistence/artifactStore';

interface ImageTestOptions {
  generateImageWithEngine?: HostServiceContext['generateImageWithEngine'];
  artifactGenerationServices?: ArtifactGenerationServiceView[];
  aggregates?: Map<string, any[]>;
  obligationEvents?: any[];
  produceArtifact?: HostServiceContext['produceArtifact'];
  commitBornArtifactWithPluginEvent?: HostServiceContext['commitBornArtifactWithPluginEvent'];
  pluginStateStore?: PluginStateStore;
}

interface ImageHarnessOptions extends ImageTestOptions {
  canvasId?: string;
  boardId?: string;
  turnIndex?: number;
}

const testProviders: ImageGenerationProviderPlugin[] = [];
const imageArtifactsHostServicePlugin = createImageArtifactsHostServicePlugin((serviceId) =>
  testProviders.find((plugin) => plugin.providerId === serviceId || plugin.id === serviceId));

function registerTestProvider(provider: ImageGenerationProviderPlugin): () => void {
  testProviders.push(provider);
  return () => {
    const index = testProviders.indexOf(provider);
    if (index >= 0) testProviders.splice(index, 1);
  };
}

/**
 * Real-store host seam used only by the fault tests below.  E2E cannot
 * deterministically fail one filesystem rename without a paid/live provider;
 * this exercises the shipped store implementations and their actual OS-temp
 * files while keeping the provider synthetic.
 */
function realArtifactSettlement(
  artifactStore: ArtifactStore,
  pluginStateStore: PluginStateStore,
): NonNullable<HostServiceContext['commitBornArtifactWithPluginEvent']> {
  return async (canvasId, boardId, input, settlement) => {
    const prepared = await artifactStore.prepareRegistration({
      kind: 'payload',
      value: {
        class: 'born',
        dataType: input.dataType,
        mime: input.mime,
        label: input.label,
        producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
        bytes: input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    });
    try {
      const event = settlement.eventForArtifact(prepared.ref);
      const appended = await pluginStateStore.appendEvents(settlement.pluginId, settlement.aggregateId, [event]);
      prepared.commit();
      const payloadPath = await artifactStore.payloadPath(prepared.ref);
      return {
        ref: prepared.ref,
        ...(payloadPath ? { path: payloadPath } : {}),
        seq: appended.seq,
      };
    } catch (error: any) {
      let compensation: string;
      try {
        const rollback = await prepared.rollback();
        compensation = rollback.status === 'rolled-back'
          ? rollback.payloadCleanup === 'complete' ? 'rolled back registry and payload' : `residual payload: ${rollback.error}`
          : `retained (${rollback.reason})`;
      } catch (rollbackError: any) {
        compensation = `compensation failed: ${String(rollbackError?.message ?? rollbackError)}`;
      }
      return {
        error: `Terminal artifact settlement failed: ${String(error?.message ?? error)} [artifact compensation: ${compensation}]`,
      };
    }
  };
}

function makeCtx(project: string, artifactDefaults: ArtifactGenerationDefaults = { image: '', 'model-3d': '' }, options: ImageTestOptions = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const aggregates = options.aggregates ?? new Map<string, any[]>();
  const obligationEvents = options.obligationEvents ?? [];
  const produceArtifact = options.produceArtifact ?? (async (canvasId: string, boardId: string, input: any) => {
    produceCalls.push({ canvasId, boardId, input });
    return {
      ref: {
        id: `image-${produceCalls.length}`,
        class: input.source,
        dataType: input.dataType ?? 'meta',
        version: 1,
        mime: input.mime ?? 'image/png',
        producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
        label: input.label ?? 'image.png',
      },
      path: path.join(project, '.braid', 'artifacts', 'objects', `image-${produceCalls.length}`, 'v1.png'),
    };
  });
  const appendPluginEvent = async (pluginId: string, aggregateId: string, event: any) => {
    if (options.pluginStateStore) {
      const result = await options.pluginStateStore.appendEvents(pluginId, aggregateId, [event]);
      return { pluginId, aggregateId, seq: result.seq };
    }
    const events = aggregates.get(aggregateId) ?? [];
    events.push(event);
    aggregates.set(aggregateId, events);
    return { pluginId, aggregateId, seq: events.length };
  };
  const commitBornArtifactWithPluginEvent: NonNullable<HostServiceContext['commitBornArtifactWithPluginEvent']> = options.commitBornArtifactWithPluginEvent ?? (async (
    canvasId: string,
    boardId: string,
    input: HostServiceBornArtifactInput,
    settlement: HostServiceArtifactSettlementInput,
  ): Promise<HostServiceArtifactSettlementResult> => {
    const produced = await produceArtifact(canvasId, boardId, input);
    if (produced.error || !produced.ref) return produced;
    const event = settlement.eventForArtifact(produced.ref);
    const appended = await appendPluginEvent(settlement.pluginId, settlement.aggregateId, event);
    return appended.error
      ? { ...produced, error: appended.error }
      : { ...produced, ...(appended.seq !== undefined ? { seq: appended.seq } : {}) };
  });
  const ctx: HostServiceContext = {
    cwd: () => project,
    artifactDefaults: () => artifactDefaults,
    artifactGenerationServices: () => options.artifactGenerationServices ?? [],
    ...(options.generateImageWithEngine ? { generateImageWithEngine: options.generateImageWithEngine } : {}),
    produceArtifact,
    commitBornArtifactWithPluginEvent,
    recordObligationEvent: (event) => obligationEvents.push(event),
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    appendPluginEvent,
    readPluginAggregate: async (pluginId, aggregateId) => {
      if (options.pluginStateStore) {
        const aggregate = await options.pluginStateStore.readAggregate(pluginId, aggregateId);
        return { pluginId, aggregateId, version: aggregate.version, events: aggregate.events };
      }
      return { pluginId, aggregateId, version: 1, events: aggregates.get(aggregateId) ?? [] };
    },
    listPluginAggregates: async (pluginId) => ({
      pluginId,
      aggregates: options.pluginStateStore
        ? await options.pluginStateStore.listAggregates(pluginId)
        : [...aggregates.keys()],
    }),
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
    agentIdForBoard: () => undefined,
    deliverLiveAgentMessage: async () => false,
    publishWorkspaceState: () => undefined,
    publishWorkspaceEvent: () => undefined,
  } as HostServiceContext;
  return { ctx, produceCalls, aggregates, obligationEvents };
}

function makeHarness(project: string, artifactDefaults?: ArtifactGenerationDefaults, options: ImageHarnessOptions = {}) {
  const host = makeCtx(project, artifactDefaults, options);
  const service = imageArtifactsHostServicePlugin.create(host.ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const callAs = (canvasId: string, boardId: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get('image_generate');
    if (!tool) throw new Error('missing image_generate tool');
    return tool.call({
      canvasId,
      boardId,
      // Presentation is not execution identity. Distinct boards in these fixtures are distinct Agents.
      agentId: `agent-${boardId}`,
      turnIndex: options.turnIndex ?? 2,
      provider: 'codex',
      signal,
    }, args);
  };
  const call = (args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> =>
    callAs(options.canvasId ?? 'c1', options.boardId ?? 'b1', args, signal);
  return { service, tools, call, callAs, ...host };
}

function registerFakeProvider(options: {
  id?: string;
  requiresCostConfirmation?: boolean;
  generate?: () => Promise<{ bytes: Uint8Array; mime: string; label?: string }> | { bytes: Uint8Array; mime: string; label?: string };
}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let generateCalls = 0;
  const provider: ImageGenerationProviderPlugin = {
    id: `fake-image-provider-${suffix}`,
    providerId: options.id ?? `fake-image-${suffix}`,
    label: 'Fake Image Provider',
    capabilities: {
      supportedOutputMimes: ['image/png'],
      requiresCostConfirmation: options.requiresCostConfirmation ?? false,
    },
    create: () => ({
      generate: async () => {
        generateCalls += 1;
        return await (options.generate?.() ?? { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', label: 'fake.png' });
      },
    }),
  };
  const unregister = registerTestProvider(provider);
  return {
    provider,
    unregister,
    counts: {
      get generate() { return generateCalls; },
    },
  };
}

function parse(result: AgentToolResult): any {
  return JSON.parse(result.result);
}

describe('image artifacts host service', () => {
  it('exposes image_generate without provider selection arguments', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-tool-'));
    try {
      const harness = makeHarness(project);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'image_generate');
      expect(tool?.tool.namespace).toBe('braid');
      expect(tool?.tool.description).toContain('normal chat');
      expect(tool?.tool.description).toContain('Braid Settings');
      expect(tool?.tool.description).not.toContain('providerId');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('providerId');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when no default image service is configured', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-no-default-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project);
      const result = await harness.call({ requestId: 'missing-image', prompt: 'a poster' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('Braid Settings');
      expect(fake.counts.generate).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when the configured image service is invalid', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-invalid-default-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project, { image: 'missing-service', 'model-3d': '' });
      const result = await harness.call({ requestId: 'invalid-image', prompt: 'a poster' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('missing-service');
      expect(fake.counts.generate).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('generates and attaches an image artifact through the configured default', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-generate-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' });
      const result = await harness.call({ requestId: 'image-1', prompt: 'a poster', confirmCost: true });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'image-1', status: 'succeeded' });
      expect(fake.counts.generate).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'image',
        mime: 'image/png',
        label: 'fake.png',
        attachTo: { turnIndex: 2 },
      });
      expect(harness.produceCalls[0].input.bytes).toBeInstanceOf(Uint8Array);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('dispatches a subscription-backed engine image default without a producer API key', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-engine-default-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, { image: 'engine:xai:image', 'model-3d': '' }, {
        generateImageWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('xai');
          expect(request.prompt).toBe('a subscription image');
          return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', label: 'subscription.png' };
        },
      });
      const result = await harness.call({ requestId: 'engine-image', prompt: 'a subscription image', confirmCost: true });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'engine-image', status: 'succeeded' });
      expect(engineCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'image',
        mime: 'image/png',
        label: 'subscription.png',
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('dispatches an OpenRouter engine image default through provider-account credentials and preserves metadata for production', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-openrouter-default-'));
    let engineCalls = 0;
    let secretReads = 0;
    try {
      const harness = makeHarness(project, { image: 'engine:openrouter:image', 'model-3d': '' }, {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:image',
          label: 'OpenRouter Image',
          dataTypes: ['image'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'image',
            model: 'bytedance-seed/seedream-4.5',
            endpoint: '/images',
          }],
        }],
        generateImageWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request.prompt).toBe('an openrouter image');
          expect(request.options).toMatchObject({ model: 'bytedance-seed/seedream-4.5', output_format: 'png' });
          return {
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            mime: 'image/png',
            label: 'openrouter.png',
            metadata: {
              provider: 'openrouter',
              model: 'bytedance-seed/seedream-4.5',
              endpoint: '/images',
              cost: 0.04,
              provider_image_id: 'or-provider-image-123',
            },
          };
        },
      });
      harness.ctx.readSecret = async (pluginId, key) => {
        secretReads += 1;
        return { pluginId, key, stored: false };
      };
      const result = await harness.call({
        requestId: 'openrouter-image',
        prompt: 'an openrouter image',
        options: { model: 'bytedance-seed/seedream-4.5', output_format: 'png' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-image', status: 'succeeded' });
      expect(parse(result).artifact.id).toBe('image-1');
      expect(parse(result).artifact.id).not.toBe('or-provider-image-123');
      expect(engineCalls).toBe(1);
      expect(secretReads).toBe(0);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'image',
        mime: 'image/png',
        label: 'openrouter.png',
        metadata: {
          provider: 'openrouter',
          model: 'bytedance-seed/seedream-4.5',
          endpoint: '/images',
          cost: 0.04,
          provider_image_id: 'or-provider-image-123',
        },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('uses the selected OpenRouter image default model when the agent omits options.model', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-openrouter-default-model-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, { image: 'engine:openrouter:image:bytedance-seed%2Fseedream-4.5', 'model-3d': '' }, {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:image:bytedance-seed%2Fseedream-4.5',
          label: 'OpenRouter Image: Seedream',
          dataTypes: ['image'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'image',
            model: 'bytedance-seed/seedream-4.5',
            endpoint: '/images',
          }],
        }],
        generateImageWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request.options).toMatchObject({ model: 'bytedance-seed/seedream-4.5', output_format: 'png' });
          return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', label: 'openrouter.png' };
        },
      });
      const result = await harness.call({
        requestId: 'openrouter-image-default-model',
        prompt: 'an openrouter image',
        options: { output_format: 'png' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-image-default-model', status: 'succeeded' });
      expect(engineCalls).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed before engine dispatch when the OpenRouter image model is not capability-scoped', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-openrouter-capability-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, { image: 'engine:openrouter:image', 'model-3d': '' }, {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:image',
          label: 'OpenRouter Image',
          dataTypes: ['image'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'image',
            model: 'bytedance-seed/seedream-4.5',
            endpoint: '/images',
          }],
        }],
        generateImageWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };
        },
      });
      const result = await harness.call({
        requestId: 'openrouter-bad-model',
        prompt: 'an openrouter image',
        options: { model: 'openai/gpt-4o-mini' },
        confirmCost: true,
      });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('not advertised as image-capable');
      expect(engineCalls).toBe(0);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps API-key image providers fail-closed when their own key is missing', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-plugin-key-missing-'));
    let secretReads = 0;
    const provider: ImageGenerationProviderPlugin = {
      id: 'api-key-image-provider',
      providerId: 'api-key-image',
      label: 'API Key Image',
      credentialSecretKey: 'apiKey',
      capabilities: {
        supportedOutputMimes: ['image/png'],
        requiresCostConfirmation: false,
      },
      create: (ctx) => ({
        generate: async () => {
          const secret = await ctx.readSecret('apiKey');
          secretReads += 1;
          if (!secret.stored) throw new Error('API key missing');
          return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' };
        },
      }),
    };
    const unregister = registerTestProvider(provider);
    try {
      const harness = makeHarness(project, { image: provider.providerId, 'model-3d': '' });
      const result = await harness.call({ requestId: 'api-key-missing', prompt: 'a poster' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('API key missing');
      expect(secretReads).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not dispatch paid image providers before explicit confirmation', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-cost-'));
    const fake = registerFakeProvider({ requiresCostConfirmation: true });
    try {
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' });
      const result = await harness.call({ requestId: 'paid-image', prompt: 'a poster' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('confirmCost');
      expect(fake.counts.generate).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not create duplicate image provider calls for concurrent same-request dispatch', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-concurrent-'));
    const fake = registerFakeProvider({
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', label: 'same.png' };
      },
    });
    try {
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' });
      const [first, second] = await Promise.all([
        harness.call({ requestId: 'same-image', prompt: 'a poster' }),
        harness.call({ requestId: 'same-image', prompt: 'a poster' }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(fake.counts.generate).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when a project-wide requestId is reused from another Board', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-board-scope-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' });
      const first = await harness.call({ requestId: 'board-bound-image', prompt: 'a poster', confirmCost: true });
      expect(first.ok).toBe(true);
      const collision = await harness.callAs('c1', 'b2', { requestId: 'board-bound-image', prompt: 'another poster', confirmCost: true });
      expect(collision.ok).toBe(false);
      expect(parse(collision).error).toContain('another Agent');
      expect(fake.counts.generate).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('hydrates durable pending/settled projection after a service restart and dedupes within that process', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-restart-hydration-'));
    const aggregates = new Map<string, any[]>();
    const firstEvents: any[] = [];
    const restartEvents: any[] = [];
    const fake = registerFakeProvider({});
    try {
      const first = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, { aggregates, obligationEvents: firstEvents });
      const generated = await first.call({ requestId: 'restart-image', prompt: 'a poster', confirmCost: true });
      expect(generated.ok).toBe(true);
      expect(firstEvents.filter((event) => event.type === 'artifact-generation-pending')).toHaveLength(1);
      expect(firstEvents.filter((event) => event.type === 'artifact-generation-settled')).toHaveLength(1);

      const restarted = makeHarness(project, undefined, { aggregates, obligationEvents: restartEvents });
      await restarted.service.onBoardAsyncIdle?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      expect(restartEvents.map((event) => event.type)).toEqual([
        'artifact-generation-pending',
        'artifact-generation-settled',
      ]);
      await restarted.service.onBoardAsyncIdle?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      expect(restartEvents).toHaveLength(2);
      const replay = await restarted.call({ requestId: 'restart-image' });
      expect(replay.ok).toBe(true);
      expect(parse(replay)).toMatchObject({ requestId: 'restart-image', status: 'succeeded', reused: true });
      expect(fake.counts.generate).toBe(1);
      expect(restartEvents).toHaveLength(2);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('lets an artifact commit win an abort race before terminalizing the driver record', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-commit-race-'));
    const aggregates = new Map<string, any[]>();
    const obligationEvents: any[] = [];
    let releaseProduce!: () => void;
    let signalProduceStarted!: () => void;
    const produceStarted = new Promise<void>((resolve) => { signalProduceStarted = resolve; });
    const produceGate = new Promise<void>((resolve) => { releaseProduce = resolve; });
    const produced: any[] = [];
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, {
        aggregates,
        obligationEvents,
        produceArtifact: async (canvasId, boardId, input) => {
          produced.push({ canvasId, boardId, input });
          signalProduceStarted();
          await produceGate;
          return {
            ref: {
              id: 'race-artifact',
              class: input.source,
              dataType: input.dataType ?? 'meta',
              version: 1,
              mime: input.mime ?? 'image/png',
              producer: { canvasId, boardId },
              label: input.label ?? 'race.png',
            },
            path: path.join(project, '.braid', 'artifacts', 'objects', 'race-artifact', 'v1.png'),
          };
        },
      });
      const generation = harness.call({ requestId: 'commit-race', prompt: 'a poster', confirmCost: true });
      await produceStarted;
      const cancel = harness.call({ requestId: 'commit-race', cancel: true });
      const abort = harness.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      releaseProduce();
      const result = await generation;
      const cancelResult = await cancel;
      await abort;
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'commit-race', status: 'succeeded' });
      expect(cancelResult.ok).toBe(false);
      expect(parse(cancelResult)).toMatchObject({ requestId: 'commit-race', error: 'Cannot cancel a completed generation request.' });
      expect(produced).toHaveLength(1);
      const records = aggregates.get(imageGenerationAggregateId('commit-race')) ?? [];
      expect(records.at(-1)?.payload).toMatchObject({ status: 'succeeded', artifactId: 'race-artifact' });
      expect(obligationEvents.filter((event) => event.type === 'artifact-generation-settled').map((event) => event.status)).toEqual(['succeeded']);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('uses a PluginStateStore-safe aggregate id and rebuilds terminal projection after restart', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-real-store-restart-'));
    const artifactStore = ArtifactStore.forWorkspace(project);
    const pluginStateStore = PluginStateStore.forWorkspace(project);
    const firstEvents: any[] = [];
    const restartEvents: any[] = [];
    const fake = registerFakeProvider({});
    try {
      const first = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, {
        pluginStateStore,
        commitBornArtifactWithPluginEvent: realArtifactSettlement(artifactStore, pluginStateStore),
        obligationEvents: firstEvents,
      });
      const generated = await first.call({ requestId: 'real-store-image', prompt: 'a poster', confirmCost: true });
      expect(generated.ok).toBe(true);

      const aggregateIds = await pluginStateStore.listAggregates('image-artifacts');
      expect(aggregateIds).toEqual([imageGenerationAggregateId('real-store-image')]);
      expect(aggregateIds[0]).toMatch(/^image-request-v1-[0-9a-f]{64}$/);
      const aggregate = await pluginStateStore.readAggregate('image-artifacts', aggregateIds[0]);
      expect(aggregate.events.map((event) => (event.payload as any).status)).toEqual([
        'pending',
        'pending',
        'succeeded',
      ]);
      const refs = await artifactStore.listRefs();
      expect(refs).toHaveLength(1);
      expect((aggregate.events.at(-1)?.payload as any).artifactId).toBe(refs[0].id);

      const restarted = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, {
        pluginStateStore,
        obligationEvents: restartEvents,
      });
      await restarted.service.onBoardAsyncIdle?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      expect(restartEvents.map((event) => event.type)).toEqual([
        'artifact-generation-pending',
        'artifact-generation-settled',
      ]);
      await restarted.service.onBoardAsyncIdle?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex' });
      expect(restartEvents).toHaveLength(2);
      const replay = await restarted.call({ requestId: 'real-store-image' });
      expect(replay.ok).toBe(true);
      expect(parse(replay)).toMatchObject({ requestId: 'real-store-image', status: 'succeeded', reused: true });
      expect(fake.counts.generate).toBe(1);
      expect(await artifactStore.listRefs()).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('compensates a prepared real artifact when terminal settlement fails, then recovers without redispatch', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-real-store-compensation-'));
    const artifactStore = ArtifactStore.forWorkspace(project);
    const pluginStateStore = PluginStateStore.forWorkspace(project);
    const aggregateId = imageGenerationAggregateId('real-store-compensation');
    let armed = false;
    let injected = false;
    // Terminal PluginStateStore appends are in-place SQLite writes. The old aggregate-file
    // rename no longer runs after the pending record is migrated, so inject the one-shot
    // terminal failure at the store boundary the settlement helper actually calls.
    const originalAppend = pluginStateStore.appendEvents.bind(pluginStateStore);
    pluginStateStore.appendEvents = async (pluginId, aggregateIdArg, events) => {
      if (armed && !injected && aggregateIdArg === aggregateId) {
        injected = true;
        const error = new Error('synthetic terminal PluginStateStore append failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalAppend(pluginId, aggregateIdArg, events);
    };
    const fake = registerFakeProvider({
      generate: () => {
        // Pending state has already been durably written before provider dispatch returns.
        armed = true;
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png', label: 'compensated.png' };
      },
    });
    try {
      const first = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, {
        pluginStateStore,
        commitBornArtifactWithPluginEvent: realArtifactSettlement(artifactStore, pluginStateStore),
      });
      const failed = await first.call({ requestId: 'real-store-compensation', prompt: 'a poster', confirmCost: true });
      expect(failed.ok).toBe(false);
      expect(parse(failed)).toMatchObject({ requestId: 'real-store-compensation', status: 'failed' });
      expect(injected).toBe(true);
      expect(fake.counts.generate).toBe(1);
      expect(await artifactStore.listRefs()).toEqual([]);

      const afterFailure = await pluginStateStore.readAggregate('image-artifacts', aggregateId);
      expect(afterFailure.events.map((event) => (event.payload as any).status)).toEqual([
        'pending',
        'pending',
        'failed',
        'failed',
      ]);
      expect((afterFailure.events.at(-1)?.payload as any).obligationSettledRecorded).toBe(true);

      const restarted = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, {
        pluginStateStore,
        commitBornArtifactWithPluginEvent: realArtifactSettlement(artifactStore, pluginStateStore),
      });
      const replay = await restarted.call({ requestId: 'real-store-compensation' });
      expect(replay.ok).toBe(false);
      expect(parse(replay)).toMatchObject({
        requestId: 'real-store-compensation',
        status: 'failed',
        reused: true,
      });
      expect(fake.counts.generate).toBe(1);
      expect(await artifactStore.listRefs()).toEqual([]);
      expect((await pluginStateStore.readAggregate('image-artifacts', aggregateId)).events).toHaveLength(4);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('terminalizes a real-store orphan pending record without redispatch', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-real-store-orphan-'));
    const pluginStateStore = PluginStateStore.forWorkspace(project);
    const fake = registerFakeProvider({});
    try {
      const seeded = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, { pluginStateStore });
      const created = await seeded.call({ requestId: 'real-store-orphan', prompt: 'a poster', confirmCost: true });
      expect(created.ok).toBe(true);
      expect(fake.counts.generate).toBe(1);

      const aggregateId = imageGenerationAggregateId('real-store-orphan');
      const prior = await pluginStateStore.readAggregate('image-artifacts', aggregateId);
      const pending = prior.events.find((event) => (event.payload as any).status === 'pending');
      expect(pending).toBeDefined();
      await pluginStateStore.deleteAggregate('image-artifacts', aggregateId);
      await pluginStateStore.appendEvents('image-artifacts', aggregateId, [{
        kind: 'image-generation-pending',
        payload: pending!.payload,
      }]);

      const recovered = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, { pluginStateStore });
      const result = await recovered.call({ requestId: 'real-store-orphan' });
      expect(result.ok).toBe(false);
      expect(parse(result)).toMatchObject({
        requestId: 'real-store-orphan',
        status: 'failed',
        recovered: true,
      });
      expect(fake.counts.generate).toBe(1);
      const terminal = await pluginStateStore.readAggregate('image-artifacts', aggregateId);
      expect((terminal.events.at(-1)?.payload as any).status).toBe('failed');
      expect((terminal.events.at(-1)?.payload as any).artifactId).toBeUndefined();
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects unknown status and malformed target records without dispatch', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-image-corrupt-record-'));
    const aggregates = new Map<string, any[]>();
    const fake = registerFakeProvider({});
    try {
      const providerTaskId = `image-job:${fake.provider.providerId}:corrupt-status`;
      aggregates.set(imageGenerationAggregateId('corrupt-status'), [{
        kind: 'image-generation-record',
        payload: {
          requestKey: 'corrupt-status', canvasId: 'c1', boardId: 'b1', turnIndex: 2,
          providerId: fake.provider.providerId,
          providerTaskId,
          request: { requestId: 'corrupt-status', prompt: 'a poster' },
          status: 'unknown',
        },
      }]);
      const invalidTargetTaskId = `image-job:${fake.provider.providerId}:invalid-target`;
      aggregates.set(imageGenerationAggregateId('invalid-target'), [{
        kind: 'image-generation-record',
        payload: {
          requestKey: 'invalid-target', canvasId: 'c1', boardId: 'b1', turnIndex: -1,
          providerId: fake.provider.providerId,
          providerTaskId: invalidTargetTaskId,
          request: { requestId: 'invalid-target', prompt: 'a poster' },
          status: 'pending',
        },
      }]);
      const harness = makeHarness(project, { image: fake.provider.providerId, 'model-3d': '' }, { aggregates });
      const unknownStatus = await harness.call({ requestId: 'corrupt-status', prompt: 'a poster', confirmCost: true });
      const invalidTarget = await harness.call({ requestId: 'invalid-target', prompt: 'a poster', confirmCost: true });
      expect(unknownStatus.ok).toBe(false);
      expect(parse(unknownStatus).error).toContain('Invalid persisted image generation record');
      expect(invalidTarget.ok).toBe(false);
      expect(parse(invalidTarget).error).toContain('Invalid persisted image generation record');
      expect(fake.counts.generate).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
