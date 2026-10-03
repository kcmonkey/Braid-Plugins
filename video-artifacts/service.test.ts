import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createVideoArtifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, VideoGenerationProvider, VideoGenerationProviderPlugin, VideoGenerationTaskSnapshot } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults, ArtifactGenerationServiceView } from '../../../src/protocol';

const testProviders: VideoGenerationProviderPlugin[] = [];
const videoArtifactsHostServicePlugin = createVideoArtifactsHostServicePlugin((serviceId) =>
  testProviders.find((plugin) => plugin.providerId === serviceId || plugin.id === serviceId));

function registerTestProvider(provider: VideoGenerationProviderPlugin): () => void {
  testProviders.push(provider);
  return () => {
    const index = testProviders.indexOf(provider);
    if (index >= 0) testProviders.splice(index, 1);
  };
}

function defaults(video = ''): ArtifactGenerationDefaults {
  return { image: '', 'model-3d': '', video };
}

function makeCtx(project: string, artifactDefaults: ArtifactGenerationDefaults = defaults(), options: {
  artifactGenerationServices?: ArtifactGenerationServiceView[];
  videoGenerationProviderForEngine?: HostServiceContext['videoGenerationProviderForEngine'];
  produceDelay?: () => Promise<void>;
} = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const aggregates = new Map<string, any[]>();
  const obligationEvents: any[] = [];
  const ctx: HostServiceContext = {
    cwd: () => project,
    artifactDefaults: () => artifactDefaults,
    artifactGenerationServices: () => options.artifactGenerationServices ?? [],
    ...(options.videoGenerationProviderForEngine ? { videoGenerationProviderForEngine: options.videoGenerationProviderForEngine } : {}),
    produceArtifact: async (canvasId, boardId, input) => {
      produceCalls.push({ canvasId, boardId, input });
      await options.produceDelay?.();
      return {
        ref: {
          id: `video-${produceCalls.length}`,
          class: input.source,
          dataType: input.dataType ?? 'meta',
          version: 1,
          mime: input.mime ?? 'video/mp4',
          producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
          label: input.label ?? 'video.mp4',
        },
        path: path.join(project, '.braid', 'artifacts', 'objects', `video-${produceCalls.length}`, 'v1.mp4'),
      };
    },
    recordObligationEvent: (event) => { obligationEvents.push(event); },
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
    agentIdForBoard: () => undefined,
    deliverLiveAgentMessage: async () => false,
    publishWorkspaceState: () => undefined,
    publishWorkspaceEvent: () => undefined,
  } as HostServiceContext;
  return { ctx, produceCalls, aggregates, obligationEvents };
}

function makeHarness(project: string, artifactDefaults?: ArtifactGenerationDefaults, options?: {
  artifactGenerationServices?: ArtifactGenerationServiceView[];
  videoGenerationProviderForEngine?: HostServiceContext['videoGenerationProviderForEngine'];
}) {
  const host = makeCtx(project, artifactDefaults, options);
  const service = videoArtifactsHostServicePlugin.create(host.ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get('video_generate');
    if (!tool) throw new Error('missing video_generate tool');
    return tool.call({ canvasId: 'c1', boardId: 'b1', agentId: 'agent-b1', turnIndex: 4, provider: 'codex', signal }, args);
  };
  return { service, tools, call, ...host };
}

function registerFakeProvider(options: {
  id?: string;
  requiresCostConfirmation?: boolean;
  createTask?: () => VideoGenerationTaskSnapshot | Promise<VideoGenerationTaskSnapshot>;
  readTasks?: VideoGenerationTaskSnapshot[];
  downloadBytes?: Uint8Array;
}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let createCalls = 0;
  let readCalls = 0;
  let downloadCalls = 0;
  let cancelCalls = 0;
  const readIds: string[] = [];
  const resultUrl = 'https://provider.example/tmp/video.mp4';
  const readTasks = [...(options.readTasks ?? [{
    providerTaskId: 'task-1',
    status: 'succeeded',
    result: { mime: 'video/mp4', format: 'mp4', label: 'fake.mp4', url: resultUrl },
  } as VideoGenerationTaskSnapshot])];
  const provider: VideoGenerationProviderPlugin = {
    id: `fake-video-provider-${suffix}`,
    providerId: options.id ?? `fake-video-${suffix}`,
    label: 'Fake Video Provider',
    capabilities: {
      textToVideo: true,
      supportedOutputMimes: ['video/mp4'],
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
        return readTasks.shift() ?? { providerTaskId, status: 'running' };
      },
      cancelTask: async () => {
        cancelCalls += 1;
        return { providerTaskId: 'task-1', status: 'canceled' };
      },
      downloadResult: async (result) => {
        downloadCalls += 1;
        expect(result.url).toBe(resultUrl);
        return { bytes: options.downloadBytes ?? new Uint8Array([0x00, 0x00, 0x00, 0x18]), mime: 'video/mp4', label: 'downloaded.mp4' };
      },
    }),
  };
  const unregister = registerTestProvider(provider);
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
    resultUrl,
  };
}

function parse(result: AgentToolResult): any {
  return JSON.parse(result.result);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('video artifacts host service', () => {
  it('exposes video_generate without provider selection arguments', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-tool-'));
    try {
      const harness = makeHarness(project);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'video_generate');
      expect(tool?.tool.namespace).toBe('braid');
      expect(tool?.tool.description).toContain('normal chat');
      expect(tool?.tool.description).toContain('Braid Settings');
      expect(tool?.tool.description).toContain('confirmCost');
      expect(tool?.tool.description).toContain('requestId');
      expect(tool?.tool.description).not.toContain('providerId');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('providerId');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when no default video service is configured', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-no-default-'));
    const fake = registerFakeProvider({});
    try {
      const harness = makeHarness(project);
      const result = await harness.call({ requestId: 'missing-video', prompt: 'a short cinematic clip' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('Braid Settings');
      expect(fake.counts.create).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocks cost-confirmed providers until confirmCost is explicit', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-cost-'));
    const fake = registerFakeProvider({ requiresCostConfirmation: true });
    try {
      const harness = makeHarness(project, defaults(fake.provider.providerId));
      const result = await harness.call({ requestId: 'paid-video', prompt: 'a short cinematic clip' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('confirmCost');
      expect(fake.counts.create).toBe(0);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('dispatches an OpenRouter engine video default through provider-account credentials and preserves metadata for production', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-openrouter-default-'));
    let createCalls = 0;
    let readCalls = 0;
    let downloadCalls = 0;
    let secretReads = 0;
    const engineProvider: VideoGenerationProvider = {
      createTask: async (request) => {
        createCalls += 1;
        expect(request).toMatchObject({
          requestId: 'openrouter-video',
          kind: 'text-to-video',
          prompt: 'a cinematic artifact clip',
          options: { model: 'google/veo-3.1', resolution: '720p' },
        });
        return { providerTaskId: 'or-video-task-123', status: 'queued' };
      },
      readTask: async (providerTaskId) => {
        readCalls += 1;
        expect(providerTaskId).toBe('or-video-task-123');
        return {
          providerTaskId,
          status: 'succeeded',
          result: {
            mime: 'video/mp4',
            label: 'openrouter-video.mp4',
            url: 'https://openrouter.ai/api/v1/videos/or-video-task-123/content?index=0',
            metadata: {
              provider: 'openrouter',
              endpoint: '/videos',
              model: 'google/veo-3.1',
              provider_task_id: 'or-video-task-123',
              generation_id: 'gen-123',
              cost: 0.25,
            },
          },
        };
      },
      downloadResult: async (result) => {
        downloadCalls += 1;
        expect(result.url).toContain('/content');
        return {
          bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
          mime: 'video/mp4',
          label: 'openrouter-video.mp4',
          metadata: result.metadata,
        };
      },
    };
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:video'), {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:video',
          label: 'OpenRouter Video',
          dataTypes: ['video'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'video',
            model: 'google/veo-3.1',
            endpoint: '/videos',
          }],
        }],
        videoGenerationProviderForEngine: (provider) => provider === 'openrouter' ? engineProvider : undefined,
      });
      harness.ctx.readSecret = async (pluginId, key) => {
        secretReads += 1;
        return { pluginId, key, stored: false };
      };
      const result = await harness.call({
        requestId: 'openrouter-video',
        prompt: 'a cinematic artifact clip',
        options: { model: 'google/veo-3.1', resolution: '720p' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-video', status: 'succeeded' });
      expect(parse(result).artifact.id).toBe('video-1');
      expect(parse(result).artifact.id).not.toBe('or-video-task-123');
      expect(createCalls).toBe(1);
      expect(readCalls).toBe(1);
      expect(downloadCalls).toBe(1);
      expect(secretReads).toBe(0);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'video',
        mime: 'video/mp4',
        label: 'openrouter-video.mp4',
        metadata: {
          provider: 'openrouter',
          endpoint: '/videos',
          model: 'google/veo-3.1',
          provider_task_id: 'or-video-task-123',
          generation_id: 'gen-123',
          cost: 0.25,
        },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('uses the selected OpenRouter video default model when the agent omits options.model', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-openrouter-default-model-'));
    let createCalls = 0;
    const engineProvider: VideoGenerationProvider = {
      createTask: async (request) => {
        createCalls += 1;
        expect(request.options).toMatchObject({ model: 'google/veo-3.1', resolution: '720p' });
        return {
          providerTaskId: 'or-video-task-123',
          status: 'succeeded',
          result: {
            mime: 'video/mp4',
            url: 'https://openrouter.ai/api/v1/videos/or-video-task-123/content',
            metadata: { provider: 'openrouter', endpoint: '/videos', model: 'google/veo-3.1' },
          },
        };
      },
      readTask: async (providerTaskId) => ({
        providerTaskId,
        status: 'succeeded',
        result: {
          mime: 'video/mp4',
          url: 'https://openrouter.ai/api/v1/videos/or-video-task-123/content',
          metadata: { provider: 'openrouter', endpoint: '/videos', model: 'google/veo-3.1' },
        },
      }),
      downloadResult: async (result) => ({ bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]), mime: 'video/mp4', metadata: result.metadata }),
    };
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:video:google%2Fveo-3.1'), {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:video:google%2Fveo-3.1',
          label: 'OpenRouter Video: Veo 3.1',
          dataTypes: ['video'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'video',
            model: 'google/veo-3.1',
            endpoint: '/videos',
          }],
        }],
        videoGenerationProviderForEngine: (provider) => provider === 'openrouter' ? engineProvider : undefined,
      });
      const result = await harness.call({
        requestId: 'openrouter-video-default-model',
        prompt: 'a cinematic artifact clip',
        options: { resolution: '720p' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-video-default-model', status: 'succeeded' });
      expect(createCalls).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed before engine dispatch when the OpenRouter video model is not capability-scoped', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-openrouter-capability-'));
    let createCalls = 0;
    const engineProvider: VideoGenerationProvider = {
      createTask: async () => {
        createCalls += 1;
        return { providerTaskId: 'or-video-task-123', status: 'queued' };
      },
      readTask: async (providerTaskId) => ({ providerTaskId, status: 'running' }),
      downloadResult: async () => ({ bytes: new Uint8Array([0]), mime: 'video/mp4' }),
    };
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:video'), {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:video',
          label: 'OpenRouter Video',
          dataTypes: ['video'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'video',
            model: 'google/veo-3.1',
            endpoint: '/videos',
          }],
        }],
        videoGenerationProviderForEngine: (provider) => provider === 'openrouter' ? engineProvider : undefined,
      });
      const result = await harness.call({
        requestId: 'openrouter-bad-video-model',
        prompt: 'a cinematic artifact clip',
        options: { model: 'openai/gpt-4o-mini' },
        confirmCost: true,
      });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('not advertised as video-capable');
      expect(createCalls).toBe(0);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reuses one OpenRouter engine provider task for retry of the same logical request', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-openrouter-idempotent-'));
    let createCalls = 0;
    let readCalls = 0;
    let downloadCalls = 0;
    const readTasks: VideoGenerationTaskSnapshot[] = [
      { providerTaskId: 'or-video-task-123', status: 'running' },
      {
        providerTaskId: 'or-video-task-123',
        status: 'succeeded',
        result: {
          mime: 'video/mp4',
          label: 'openrouter-video.mp4',
          url: 'https://openrouter.ai/api/v1/videos/or-video-task-123/content?index=0',
          metadata: { provider: 'openrouter', endpoint: '/videos', model: 'google/veo-3.1', provider_task_id: 'or-video-task-123' },
        },
      },
    ];
    const engineProvider: VideoGenerationProvider = {
      createTask: async () => {
        createCalls += 1;
        return { providerTaskId: 'or-video-task-123', status: 'queued' };
      },
      readTask: async (providerTaskId) => {
        readCalls += 1;
        return readTasks.shift() ?? { providerTaskId, status: 'running' };
      },
      downloadResult: async (result) => {
        downloadCalls += 1;
        return { bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]), mime: 'video/mp4', label: 'openrouter-video.mp4', metadata: result.metadata };
      },
    };
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:video'), {
        artifactGenerationServices: [{
          serviceId: 'engine:openrouter:video',
          label: 'OpenRouter Video',
          dataTypes: ['video'],
          source: 'engine',
          provider: 'openrouter',
          authKind: 'provider-account',
          configured: true,
          credentialStatus: 'configured',
          requiresCostConfirmation: true,
          capabilityScopes: [{
            provider: 'openrouter',
            dataType: 'video',
            model: 'google/veo-3.1',
            endpoint: '/videos',
          }],
        }],
        videoGenerationProviderForEngine: (provider) => provider === 'openrouter' ? engineProvider : undefined,
      });
      const first = await harness.call({
        requestId: 'openrouter-video-idem',
        prompt: 'a cinematic artifact clip',
        options: { model: 'google/veo-3.1' },
        confirmCost: true,
      });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'openrouter-video-idem', status: 'running', providerTaskId: 'or-video-task-123' });
      expect(harness.produceCalls).toHaveLength(0);

      const second = await harness.call({
        requestId: 'openrouter-video-idem',
        prompt: 'a cinematic artifact clip',
        options: { model: 'google/veo-3.1' },
        confirmCost: true,
      });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'openrouter-video-idem', status: 'succeeded' });
      expect(createCalls).toBe(1);
      expect(readCalls).toBe(2);
      expect(downloadCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);

      const third = await harness.call({
        requestId: 'openrouter-video-idem',
        prompt: 'a cinematic artifact clip',
        options: { model: 'google/veo-3.1' },
        confirmCost: true,
      });
      expect(third.ok).toBe(true);
      expect(parse(third)).toMatchObject({ requestId: 'openrouter-video-idem', status: 'succeeded', artifactId: 'video-1', reused: true });
      expect(createCalls).toBe(1);
      expect(downloadCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reuses one provider task for retry of the same logical request and stores only a born video artifact', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-idempotent-'));
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'video/mp4', format: 'mp4', label: 'clip.mp4', url: 'https://provider.example/tmp/video.mp4' } },
      ],
    });
    try {
      const harness = makeHarness(project, defaults(fake.provider.providerId));
      const first = await harness.call({ requestId: 'clip-1', prompt: 'a short cinematic clip' });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'clip-1', status: 'running', providerTaskId: 'task-1' });
      expect(fake.counts.create).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);

      const second = await harness.call({ requestId: 'clip-1', prompt: 'a short cinematic clip' });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'clip-1', status: 'succeeded' });
      expect(fake.counts.create).toBe(1);
      expect(fake.counts.download).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'video',
        mime: 'video/mp4',
        label: 'downloaded.mp4',
        attachTo: { turnIndex: 4 },
      });
      expect(harness.produceCalls[0].input.bytes).toBeInstanceOf(Uint8Array);
      expect(JSON.stringify(harness.produceCalls[0].input)).not.toContain(fake.resultUrl);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('produces only one artifact when a foreground retry races the background watcher on success', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-watch-race-'));
    let releaseProduce!: () => void;
    const produceGate = new Promise<void>((resolve) => { releaseProduce = resolve; });
    const fake = registerFakeProvider({
      readTasks: [
        { providerTaskId: 'task-1', status: 'running' },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'video/mp4', format: 'mp4', label: 'clip.mp4', url: 'https://provider.example/tmp/video.mp4' } },
        { providerTaskId: 'task-1', status: 'succeeded', result: { mime: 'video/mp4', format: 'mp4', label: 'clip.mp4', url: 'https://provider.example/tmp/video.mp4' } },
      ],
    });
    try {
      const harness = makeHarness(project, defaults(fake.provider.providerId), {
        produceDelay: async () => { await produceGate; },
      });
      const first = await harness.call({ requestId: 'watch-race-1', prompt: 'a short cinematic clip' });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'watch-race-1', status: 'running' });

      const foreground = harness.call({ requestId: 'watch-race-1', prompt: 'a short cinematic clip' });
      await delay(50);
      releaseProduce();
      const second = await foreground;
      await delay(20);

      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'watch-race-1', status: 'succeeded' });
      expect(fake.counts.download).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fake.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('returns failed, expired, and canceled states without producing partial artifacts', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-video-failures-'));
    const failed = registerFakeProvider({
      id: 'fake-video-failed',
      readTasks: [{ providerTaskId: 'task-1', status: 'failed', error: 'provider rejected prompt' }],
    });
    const expired = registerFakeProvider({
      id: 'fake-video-expired',
      readTasks: [{ providerTaskId: 'task-1', status: 'expired', error: 'provider URL expired' }],
    });
    const canceled = registerFakeProvider({
      id: 'fake-video-canceled',
      readTasks: [{ providerTaskId: 'task-1', status: 'running' }],
    });
    try {
      const artifactDefaults = defaults(failed.provider.providerId);
      const harness = makeHarness(project, artifactDefaults);
      const failResult = await harness.call({ requestId: 'bad-video', prompt: 'bad' });
      expect(failResult.ok).toBe(false);
      expect(parse(failResult)).toMatchObject({ requestId: 'bad-video', status: 'failed', error: 'provider rejected prompt' });

      artifactDefaults.video = expired.provider.providerId;
      const expiredResult = await harness.call({ requestId: 'expired-video', prompt: 'expires' });
      expect(expiredResult.ok).toBe(false);
      expect(parse(expiredResult)).toMatchObject({ requestId: 'expired-video', status: 'expired', error: 'provider URL expired' });

      artifactDefaults.video = canceled.provider.providerId;
      const pending = await harness.call({ requestId: 'cancel-video', prompt: 'cancel me' });
      expect(pending.ok).toBe(true);
      const cancelResult = await harness.call({ requestId: 'cancel-video', prompt: 'cancel me', cancel: true });
      expect(cancelResult.ok).toBe(true);
      expect(parse(cancelResult)).toMatchObject({ requestId: 'cancel-video', status: 'canceled' });
      expect(canceled.counts.cancel).toBe(1);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      failed.unregister();
      expired.unregister();
      canceled.unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
