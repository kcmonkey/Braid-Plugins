import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { audioArtifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ArtifactGenerationDefaults, ArtifactGenerationServiceView } from '../../../src/protocol';

function defaults(speech = '', soundEffect = '', music = ''): ArtifactGenerationDefaults {
  return { image: '', 'model-3d': '', video: '', audio: { speech, soundEffect, music } };
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
    agentIdForBoard: () => undefined,
    deliverLiveAgentMessage: async () => false,
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
  const call = (args: Record<string, unknown>, signal = new AbortController().signal, toolName = 'speech_generate'): Promise<AgentToolResult> => {
    const tool = byName.get(toolName);
    if (!tool) throw new Error(`missing ${toolName} tool`);
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 6, provider: 'codex', signal }, args);
  };
  return { service, tools, call, ...host };
}

function parse(result: AgentToolResult): any {
  return JSON.parse(result.result);
}

function openRouterService(model = 'openai/tts-1', serviceId = 'engine:openrouter:audio:speech'): ArtifactGenerationServiceView {
  return {
    serviceId,
    label: 'OpenRouter Audio',
    dataTypes: ['audio'],
    producerKinds: ['audio.speech'],
    source: 'engine',
    provider: 'openrouter',
    authKind: 'provider-account',
    configured: true,
    credentialStatus: 'configured',
    requiresCostConfirmation: true,
    capabilityScopes: [{ provider: 'openrouter', dataType: 'audio', producerKind: 'audio.speech', model, endpoint: '/audio/speech' }],
  };
}

function openRouterMusicService(
  model = 'google/lyria-3-clip-preview',
  serviceId = 'engine:openrouter:audio:music',
): ArtifactGenerationServiceView {
  return {
    serviceId,
    label: 'OpenRouter Music: Lyria 3 Clip Preview',
    dataTypes: ['audio'],
    producerKinds: ['audio.music'],
    source: 'engine',
    provider: 'openrouter',
    authKind: 'provider-account',
    configured: true,
    credentialStatus: 'configured',
    requiresCostConfirmation: true,
    capabilityScopes: [{ provider: 'openrouter', dataType: 'audio', producerKind: 'audio.music', model, endpoint: '/chat/completions' }],
  };
}

describe('audio artifacts host service', () => {
  it('exposes semantic audio producer tools plus the speech compatibility alias', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-tool-'));
    try {
      const harness = makeHarness(project);
      expect(harness.tools.map((candidate) => candidate.tool.name)).toEqual([
        'speech_generate',
        'sound_effect_generate',
        'music_generate',
        'audio_generate',
      ]);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'speech_generate');
      expect(tool?.tool.namespace).toBe('braid');
      expect(tool?.tool.description).toContain('Braid Settings');
      expect(tool?.tool.description).toContain('confirmCost');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('providerId');
      expect(tool?.tool.inputSchema.required).toEqual(['input']);
      expect(harness.tools.find((candidate) => candidate.tool.name === 'sound_effect_generate')?.tool.inputSchema.required).toEqual(['prompt']);
      expect(harness.tools.find((candidate) => candidate.tool.name === 'sound_effect_generate')?.tool.description).toContain('Do not substitute a speech provider');
      expect(harness.tools.find((candidate) => candidate.tool.name === 'music_generate')?.tool.description).toContain('Do not substitute a speech provider');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps audio_generate as a speech-only compatibility alias', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-alias-'));
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async (_provider, request) => {
          expect(request).toMatchObject({ kind: 'speech', input: 'legacy narration' });
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      const result = await harness.call({
        requestId: 'legacy-audio-alias',
        input: 'legacy narration',
        options: { model: 'openai/tts-1', voice: 'alloy' },
        confirmCost: true,
      }, new AbortController().signal, 'audio_generate');
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('migrates a persisted legacy TTS request and service id before retrying it', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-legacy-retry-'));
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async (provider, request) => {
          expect(provider).toBe('openrouter');
          expect(request).toMatchObject({
            requestId: 'legacy-pending',
            kind: 'speech',
            input: 'legacy narration',
          });
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      harness.aggregates.set('audio-request:legacy-pending', [{
        payload: {
          requestKey: 'legacy-pending',
          canvasId: 'c1',
          boardId: 'b1',
          turnIndex: 6,
          providerId: 'engine:openrouter:audio',
          request: {
            requestId: 'legacy-pending',
            input: 'legacy narration',
            options: { model: 'openai/tts-1', voice: 'alloy' },
          },
          status: 'pending',
        },
      }]);
      const result = await harness.call({
        requestId: 'legacy-pending',
        input: 'legacy narration',
        options: { model: 'openai/tts-1', voice: 'alloy' },
        confirmCost: true,
      }, new AbortController().signal, 'audio_generate');
      expect(result.ok).toBe(true);
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

  it('rejects malformed optionsJson before resolving or dispatching a provider', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-invalid-options-'));
    try {
      const harness = makeHarness(project);
      const result = await harness.call({ input: 'hello', optionsJson: '[not-json' });
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('valid JSON object');
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not route sound effects or music through the configured OpenRouter speech service', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-semantic-routing-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      const soundEffect = await harness.call({ requestId: 'sfx-1', prompt: 'single handgun shot', confirmCost: true }, new AbortController().signal, 'sound_effect_generate');
      const music = await harness.call({ requestId: 'music-1', prompt: 'slow piano nocturne', confirmCost: true }, new AbortController().signal, 'music_generate');
      expect(soundEffect.ok).toBe(false);
      expect(parse(soundEffect).error).toContain('Sound Effect');
      expect(music.ok).toBe(false);
      expect(parse(music).error).toContain('Music');
      expect(engineCalls).toBe(0);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects a speech service manually placed in the Sound Effect default slot', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-misbound-sfx-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('', 'engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });
      const result = await harness.call({ requestId: 'misbound-sfx', prompt: 'door slam', confirmCost: true }, new AbortController().signal, 'sound_effect_generate');
      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('Speech producer, not Sound Effect');
      expect(engineCalls).toBe(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocks paid OpenRouter TTS until confirmCost is explicit', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-cost-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
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
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request).toMatchObject({
            requestId: 'openrouter-audio',
            kind: 'speech',
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
          generationKind: 'speech',
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
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech:openai%2Ftts-1'), {
        artifactGenerationServices: [openRouterService('openai/tts-1', 'engine:openrouter:audio:speech:openai%2Ftts-1')],
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

  it('dispatches Music through the selected OpenRouter Lyria service and preserves Music metadata', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-music-'));
    let engineCalls = 0;
    try {
      const serviceId = 'engine:openrouter:audio:music';
      const harness = makeHarness(project, defaults('', '', serviceId), {
        artifactGenerationServices: [openRouterMusicService()],
        generateAudioWithEngine: async (provider, request) => {
          engineCalls += 1;
          expect(provider).toBe('openrouter');
          expect(request).toMatchObject({
            requestId: 'openrouter-music',
            kind: 'music',
            prompt: 'A warm analog synthwave loop.',
            options: { model: 'google/lyria-3-clip-preview' },
          });
          return {
            bytes: new Uint8Array([0x49, 0x44, 0x33]),
            mime: 'audio/mpeg',
            label: 'openrouter-music.mp3',
            metadata: {
              provider: 'openrouter',
              endpoint: '/chat/completions',
              model: 'google/lyria-3-clip-preview',
              format: 'mp3',
            },
          };
        },
      });

      const result = await harness.call({
        requestId: 'openrouter-music',
        prompt: 'A warm analog synthwave loop.',
        confirmCost: true,
      }, new AbortController().signal, 'music_generate');

      expect(result.ok).toBe(true);
      expect(parse(result)).toMatchObject({ requestId: 'openrouter-music', status: 'succeeded' });
      expect(engineCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
      expect(harness.produceCalls[0].input).toMatchObject({
        source: 'born',
        dataType: 'audio',
        mime: 'audio/mpeg',
        label: 'openrouter-music.mp3',
        metadata: {
          provider: 'openrouter',
          endpoint: '/chat/completions',
          model: 'google/lyria-3-clip-preview',
          format: 'mp3',
          generationKind: 'music',
        },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed before engine dispatch when an OpenRouter Music model is outside the selected capability scope', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-music-capability-'));
    let engineCalls = 0;
    try {
      const serviceId = 'engine:openrouter:audio:music';
      const harness = makeHarness(project, defaults('', '', serviceId), {
        artifactGenerationServices: [openRouterMusicService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
        },
      });

      const result = await harness.call({
        requestId: 'openrouter-not-music',
        prompt: 'A warm analog synthwave loop.',
        options: { model: 'openai/gpt-audio' },
        confirmCost: true,
      }, new AbortController().signal, 'music_generate');

      expect(result.ok).toBe(false);
      expect(parse(result).error).toContain('not advertised as Music-capable');
      expect(engineCalls).toBe(0);
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed before engine dispatch when the OpenRouter speech model is not capability-scoped', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-openrouter-capability-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
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
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
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

  it('does not reuse one requestId across different audio producer kinds', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-audio-cross-kind-id-'));
    let engineCalls = 0;
    try {
      const harness = makeHarness(project, defaults('engine:openrouter:audio:speech'), {
        artifactGenerationServices: [openRouterService()],
        generateAudioWithEngine: async () => {
          engineCalls += 1;
          return { bytes: new Uint8Array([0x49, 0x44, 0x33]), mime: 'audio/mpeg' };
        },
      });
      const speech = await harness.call({
        requestId: 'shared-audio-id',
        input: 'narration',
        options: { model: 'openai/tts-1', voice: 'alloy' },
        confirmCost: true,
      });
      const music = await harness.call({
        requestId: 'shared-audio-id',
        prompt: 'piano nocturne',
        confirmCost: true,
      }, new AbortController().signal, 'music_generate');
      expect(speech.ok).toBe(true);
      expect(music.ok).toBe(false);
      expect(parse(music).error).toContain('belongs to Speech generation');
      expect(engineCalls).toBe(1);
      expect(harness.produceCalls).toHaveLength(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
