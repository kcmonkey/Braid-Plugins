import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createImageArtifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, ImageGenerationProviderPlugin } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults, ArtifactGenerationServiceView } from '../../../src/protocol';

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

function makeCtx(project: string, artifactDefaults: ArtifactGenerationDefaults = { image: '', 'model-3d': '' }, options: {
  generateImageWithEngine?: HostServiceContext['generateImageWithEngine'];
  artifactGenerationServices?: ArtifactGenerationServiceView[];
} = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const aggregates = new Map<string, any[]>();
  const ctx: HostServiceContext = {
    cwd: () => project,
    artifactDefaults: () => artifactDefaults,
    artifactGenerationServices: () => options.artifactGenerationServices ?? [],
    ...(options.generateImageWithEngine ? { generateImageWithEngine: options.generateImageWithEngine } : {}),
    produceArtifact: async (canvasId, boardId, input) => {
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
  return { ctx, produceCalls, aggregates };
}

function makeHarness(project: string, artifactDefaults?: ArtifactGenerationDefaults, options?: {
  generateImageWithEngine?: HostServiceContext['generateImageWithEngine'];
  artifactGenerationServices?: ArtifactGenerationServiceView[];
}) {
  const host = makeCtx(project, artifactDefaults, options);
  const service = imageArtifactsHostServicePlugin.create(host.ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get('image_generate');
    if (!tool) throw new Error('missing image_generate tool');
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 2, provider: 'codex', signal }, args);
  };
  return { service, tools, call, ...host };
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
});
