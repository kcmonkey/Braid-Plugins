import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { audioArtifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults, ArtifactGenerationServiceView } from '../../../src/protocol';

function defaults(audio = ''): ArtifactGenerationDefaults {
  return { image: '', 'model-3d': '', video: '', audio };
}

function makeCtx(project: string, artifactDefaults: ArtifactGenerationDefaults = defaults(), options: {
  generateAudioWithEngine?: HostServiceContext['generateAudioWithEngine'];
  artifactGenerationServices?: ArtifactGenerationServiceView[];
} = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const aggregates = new Map<string, any[]>();
  const ctx: HostServiceContext = {
    cwd: () => project,
    artifactDefaults: () => artifactDefaults,
    artifactGenerationServices: () => options.artifactGenerationServices ?? [],
    ...(options.generateAudioWithEngine ? { generateAudioWithEngine: options.generateAudioWithEngine } : {}),
    produceArtifact: async (canvasId, boardId, input) => {
      produceCalls.push({ canvasId, boardId, input });
      return {
        ref: {
          id: `audio-${produceCalls.length}`,
          class: input.source,
          dataType: input.dataType ?? 'meta',
          version: 1,
          mime: input.mime ?? 'audio/mpeg',
          producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
          label: input.label ?? 'audio.mp3',
        },
        path: path.join(project, '.braid', 'artifacts', 'objects', `audio-${produceCalls.length}`, 'v1.mp3'),
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
  generateAudioWithEngine?: HostServiceContext['generateAudioWithEngine'];
  artifactGenerationServices?: ArtifactGenerationServiceView[];
}) {
  const host = makeCtx(project, artifactDefaults, options);
  const service = audioArtifactsHostServicePlugin.create(host.ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get('audio_generate');
    if (!tool) throw new Error('missing audio_generate tool');
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 6, provider: 'codex', signal }, args);
  };
  return { service, tools, call, ...host };
}

function parse(result: AgentToolResult): any {
  return JSON.parse(result.result);
}

function openRouterService(model = 'openai/tts-1', serviceId = 'engine:openrouter:audio'): ArtifactGenerationServiceView {
  return {
    serviceId,
    label: 'OpenRouter Audio',
    dataTypes: ['audio'],
    source: 'engine',
    provider: 'openrouter',
    authKind: 'provider-account',
    configured: true,
    credentialStatus: 'configured',
    requiresCostConfirmation: true,
    capabilityScopes: [{ provider: 'openrouter', dataType: 'audio', model, endpoint: '/audio/speech' }],
  };
}

describe('audio artifacts host service', () => {
  it('exposes audio_generate without provider selection arguments', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-tool-'));
    try {
      const harness = makeHarness(project);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'audio_generate');
      expect(tool?.tool.namespace).toBe('braid');
      expect(tool?.tool.description).toContain('Braid Settings');
      expect(tool?.tool.description).toContain('confirmCost');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('providerId');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed when no default audio service is configured', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-no-default-'));
    try {
      const harness = makeHarness(project);
      const result = await harness.call({ requestId: 'missing-audio', input: 'hello' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('Braid Settings');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocks paid OpenRouter TTS until confirmCost is explicit', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-cost-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      const result = await harness.call({ requestId: 'paid-audio', input: 'hello', options: { model: 'openai/tts-1', voice: 'alloy' } });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('confirmCost');
      expect(engineCalls).toBe(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('dispatches OpenRouter TTS through provider-account credentials and preserves metadata for production', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-default-'));
    let engineCalls = 0;
    let secretReads = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request).toMatchObject({
            requestId: 'openrouter-audio',
            input: 'Hello artifact world.',
            options: { model: 'openai/tts-1', voice: 'alloy', response_format: 'mp3' },
          });
          return {
            bytes: new Uint8Array([0x49, 0x44, 0x33]),
            mime: 'audio/mpeg',
            label: 'openrouter-audio.mp3',
            metadata: {
              provider: 'openrouter',
              endpoint: '/audio/speech',
              model: 'openai/tts-1',
              voice: 'alloy',
              response_format: 'mp3',
              generation_id: 'gen-audio-123',
            },
          };
        },
      });
      harness.ctx.readSecret = async (pluginId, key) => {
        secretReads += 1;
        return { pluginId, key, stored: false };
      };
      const result = await harness.call({
        requestId: 'openrouter-audio',
        input: 'Hello artifact world.',
        options: { model: 'openai/tts-1', voice: 'alloy', response_format: 'mp3' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-audio', status: 'succeeded' });
      expect(parse(result).artifact.id).toBe('audio-1');
      expect(parse(result).artifact.id).not.toBe('gen-audio-123');
      expect(engineCalls).toBe(1);
      expect(secretReads).toBe(0);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'audio',
        mime: 'audio/mpeg',
        label: 'openrouter-audio.mp3',
        attachTo: { turnIndex: 6 },
        metadata: {
          provider: 'openrouter',
          endpoint: '/audio/speech',
          model: 'openai/tts-1',
          voice: 'alloy',
          response_format: 'mp3',
          generation_id: 'gen-audio-123',
        },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('uses the selected OpenRouter audio default model when the agent omits options.model', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-default-model-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:openai%2Ftts-1'), {
        artifactGenerationServices: [openRouterService('openai/tts-1', 'engine:openrouter:audio:openai%2Ftts-1')],
        generateAudioWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request.options).toMatchObject({ model: 'openai/tts-1', voice: 'alloy' });
          return {
            bytes: new Uint8Array([0x49, 0x44, 0x33]),
            mime: 'audio/mpeg',
            label: 'speech.mp3',
          };
        },
      });
      const result = await harness.call({
        requestId: 'openrouter-audio-default-model',
        input: 'hello',
        options: { voice: 'alloy' },
        confirmCost: true,
      });
      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-audio-default-model', status: 'succeeded' });
      expect(engineCalls).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed before engine dispatch when the OpenRouter speech model is not capability-scoped', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-capability-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio'), {
        artifactGenerationServices: [openRouterService('openai/tts-1')],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      const result = await harness.call({
        requestId: 'bad-audio-model',
        input: 'Hello artifact world.',
        options: { model: 'openai/gpt-4o-mini', voice: 'alloy' },
        confirmCost: true,
      });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('not advertised as speech-capable');
      expect(engineCalls).toBe(0);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reuses a completed OpenRouter audio request by requestId', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-idempotent-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([0x49, 0x44, 0x33]), mime: 'audio/mpeg', label: 'speech.mp3' };
        },
      });
      const first = await harness.call({
        requestId: 'audio-idem',
        input: 'Hello artifact world.',
        options: { model: 'openai/tts-1', voice: 'alloy' },
        confirmCost: true,
      });
      expect(first.ok).toBe(true);
      expect(parse(first)).toMatchObject({ requestId: 'audio-idem', status: 'succeeded' });

      const second = await harness.call({
        requestId: 'audio-idem',
        input: 'Hello artifact world.',
        options: { model: 'openai/tts-1', voice: 'alloy' },
        confirmCost: true,
      });
      expect(second.ok).toBe(true);
      expect(parse(second)).toMatchObject({ requestId: 'audio-idem', status: 'succeeded', artifactId: 'audio-1', reused: true });
      expect(engineCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
