import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createArtifactsHostServicePlugin, type ArtifactTypeRegistryView } from './service';
import type { AgentToolPlugin, HostServiceContext, LiveMessageContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { HostPluginRegistry, META_ARTIFACT_DATA_TYPE } from '../../../src/plugin-runtime/hostRegistry';
import type { ObligationLedgerEvent } from '../../../src/obligations';
import { VIDEO_DATA_TYPE, VIDEO_MP4_MIME, videoArtifactType } from '../video-artifacts/artifactType';

function artifactTypes(registry: HostPluginRegistry): ArtifactTypeRegistryView {
  return {
    metaDataType: META_ARTIFACT_DATA_TYPE,
    descriptors: (options) => registry.artifactTypeDescriptors(options),
    resolve: (dataType, options) => registry.resolveArtifactTypeDescriptor(dataType, options),
  };
}

function makeHarness(project: string, options: { live?: boolean; registry?: HostPluginRegistry } = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const attachedObligations: any[] = [];
  const delivered: LiveMessageContext[] = [];
  const obligationEvents: ObligationLedgerEvent[] = [];
  let deliveryAttempts = 0;
  const targetKey = 'c1::b1';
  const ctx: HostServiceContext = {
    cwd: () => project,
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    produceArtifact: async (canvasId, boardId, input) => {
      produceCalls.push({ canvasId, boardId, input });
      return {
        ref: {
          id: 'declared-spec-test',
          class: input.source,
          dataType: input.dataType ?? 'meta',
          version: 1,
          mime: input.mime ?? 'text/markdown',
          producer: { canvasId, boardId, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
          label: input.label ?? 'Shared spec',
        },
        path: path.join(project, '.braid', 'artifacts', 'objects', 'declared-spec-test', 'v1.md'),
      };
    },
    recordObligationEvent: (event) => {
      obligationEvents.push(event);
    },
    attachObligation: (obligation) => {
      attachedObligations.push(obligation);
      return { obligationId: obligation.id };
    },
    liveOwnerKeys: () => new Set(),
    openCanvasIds: () => ['c1'],
    liveBoardKeys: () => options.live ? [targetKey] : [],
    hasLiveBoardKey: (key) => Boolean(options.live) && key === targetKey,
    deliverLiveBoardMessage: (message) => {
      deliveryAttempts += 1;
      if (!options.live || message.targetKey !== targetKey) return false;
      delivered.push(message);
      return true;
    },
    captureFileSnapshot: () => undefined,
    publishWorkspaceState: () => undefined,
    publishWorkspaceEvent: () => undefined,
  } as HostServiceContext;
  const registry = options.registry ?? new HostPluginRegistry();
  const service = createArtifactsHostServicePlugin(artifactTypes(registry)).create(ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 2, provider: 'codex', signal }, args);
  };
  const observeToolUse = async (input: unknown, toolName = 'write_file', turnIndex = 2) => {
    const middleware = service.toolMiddleware?.() ?? [];
    const observer = middleware.find((plugin) => plugin.observeToolUse);
    if (!observer?.observeToolUse) throw new Error('missing artifact tool observer');
    await observer.observeToolUse({
      canvasId: 'c1',
      boardId: 'b1',
      turnIndex,
      provider: 'codex',
      source: 'observed',
      toolName,
      input,
    });
  };
  const settle = async (turnIndex = 2) => {
    await service.onTurnSettled?.({ canvasId: 'c1', boardId: 'b1', turnIndex, provider: 'codex', answer: 'done' });
  };
  return { call, tools, produceCalls, attachedObligations, obligationEvents, service, registry, delivered, get deliveryAttempts() { return deliveryAttempts; }, observeToolUse, settle };
}

describe('artifacts host service', () => {
  it('exposes artifact declaration guidance on the core artifact tool contract', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-guidance-'));
    const registry = new HostPluginRegistry();
    const unregister = registry.registrar.registerArtifactType({
      id: 'test.phase9-brief-description',
      dataType: 'phase9-brief-description',
      label: 'Phase 9 Brief',
      description: 'A concise handoff brief for type discovery tests.',
      schema: {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      },
    });
    try {
      const harness = makeHarness(project, { registry });
      const description = harness.tools.find((tool) => tool.tool.name === 'artifact_declare')?.tool.description ?? '';

      expect(description).toContain('durable');
      expect(description).toContain('bounded');
      expect(description).toContain('presentable');
      expect(description).toContain('declare it as an artifact');
      expect(description).toContain('standalone');
      expect(description).toContain('runnable');
      expect(description).toContain('demo');
      expect(description).toContain('not excluded merely because it is code');
      expect(description).not.toContain('HTML');
      expect(description).not.toContain('.html');
      expect(description).not.toContain('.docx');
      expect(description).not.toContain('.glb');
      expect(description).toContain('Do not declare source files');
      expect(description).toContain('scratch files');
      expect(description).toContain('build outputs');
      expect(description).toContain('test logs');
      expect(description).toContain('transient control messages');
      expect(description).toContain('phase9-brief-description');
      expect(description).toContain('Phase 9 Brief');
      expect(description).toContain('braid.artifact_types');
      expect(description).not.toContain('"required"');
    } finally {
      unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('lists defined artifact types without injecting schema payloads', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-type-list-'));
    const registry = new HostPluginRegistry();
    const unregister = registry.registrar.registerArtifactType({
      id: 'test.phase9-brief-list',
      dataType: 'phase9-brief-list',
      label: 'Phase 9 Brief List',
      description: 'A typed brief that should appear in the list response.',
      schema: {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      },
      validate: () => ({ ok: true }),
    });
    try {
      const harness = makeHarness(project, { registry });

      const result = await harness.call('artifact_types', {});

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.defaultDataType).toBe('meta');
      const meta = parsed.types.find((type: any) => type.dataType === 'meta');
      const brief = parsed.types.find((type: any) => type.dataType === 'phase9-brief-list');
      expect(meta).toMatchObject({ dataType: 'meta', label: 'Meta Artifact', hasValidator: true, hasSchema: false });
      expect(brief).toMatchObject({
        dataType: 'phase9-brief-list',
        label: 'Phase 9 Brief List',
        description: 'A typed brief that should appear in the list response.',
        hasValidator: true,
        hasSchema: true,
      });
      expect(brief.schema).toBeUndefined();
    } finally {
      unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('lists the video artifact type and validates video MIME metadata', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-video-type-'));
    const registry = new HostPluginRegistry();
    const unregister = registry.registrar.registerArtifactType(videoArtifactType);
    try {
      const harness = makeHarness(project, { registry });

      const result = await harness.call('artifact_types', {});

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.result);
      const video = parsed.types.find((type: any) => type.dataType === VIDEO_DATA_TYPE);
      expect(video).toMatchObject({
        dataType: VIDEO_DATA_TYPE,
        label: 'Video',
        hasValidator: true,
      });
      expect(video.description).toContain(VIDEO_MP4_MIME);

      const type = registry.resolveArtifactType(VIDEO_DATA_TYPE);
      await expect(Promise.resolve(type.validate?.({
        dataType: VIDEO_DATA_TYPE,
        artifactClass: 'born',
        mime: VIDEO_MP4_MIME,
        label: 'clip.mp4',
      }))).resolves.toEqual({ ok: true });
      await expect(Promise.resolve(type.validate?.({
        dataType: VIDEO_DATA_TYPE,
        artifactClass: 'external-ref',
        mime: 'video/webm; codecs=vp9',
        label: 'clip.webm',
      }))).resolves.toEqual({ ok: true });
      await expect(Promise.resolve(type.validate?.({
        dataType: VIDEO_DATA_TYPE,
        artifactClass: 'born',
        mime: 'image/png',
        label: 'clip.png',
      }))).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining('video/'),
      });
    } finally {
      unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fetches one artifact type with schema detail and reports Meta fallback for unknown types', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-type-detail-'));
    const schema = {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    };
    const registry = new HostPluginRegistry();
    const unregister = registry.registrar.registerArtifactType({
      id: 'test.phase9-brief-detail',
      dataType: 'phase9-brief-detail',
      label: 'Phase 9 Brief Detail',
      description: 'A typed brief with detail schema.',
      schema,
      validate: () => ({ ok: true }),
    });
    try {
      const harness = makeHarness(project, { registry });

      const exact = JSON.parse((await harness.call('artifact_types', { dataType: 'phase9-brief-detail' })).result);
      expect(exact).toMatchObject({
        requestedDataType: 'phase9-brief-detail',
        resolved: 'exact',
        type: {
          dataType: 'phase9-brief-detail',
          label: 'Phase 9 Brief Detail',
          hasSchema: true,
          hasValidator: true,
        },
      });
      expect(exact.type.schema).toEqual(schema);

      const fallback = JSON.parse((await harness.call('artifact_types', { dataType: 'phase9-missing-type' })).result);
      expect(fallback).toMatchObject({
        requestedDataType: 'phase9-missing-type',
        resolved: 'meta',
        type: { dataType: 'meta', label: 'Meta Artifact' },
      });
    } finally {
      unregister();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('declares text artifacts through the core production seam and can attach to the current turn', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-service-'));
    try {
      const harness = makeHarness(project);
      expect(harness.tools.map((tool) => tool.tool.name)).toContain('artifact_declare');

      const result = await harness.call('artifact_declare', {
        dataType: 'spec',
        label: 'Shared spec',
        text: '# Shared Spec\n\nReusable board output.',
        attachToTurn: true,
      });

      expect(result.ok).toBe(true);
      expect(harness.produceCalls).toEqual([{
        canvasId: 'c1',
        boardId: 'b1',
        input: {
          source: 'declared',
          dataType: 'spec',
          mime: 'text/markdown',
          label: 'Shared spec',
          text: '# Shared Spec\n\nReusable board output.',
          pluginId: 'artifacts',
          attachTo: { turnIndex: 2 },
        },
      }]);
      const parsed = JSON.parse(result.result);
      expect(parsed.ref).toMatchObject({
        class: 'declared',
        dataType: 'spec',
        mime: 'text/markdown',
        producer: { canvasId: 'c1', boardId: 'b1', pluginId: 'artifacts' },
        label: 'Shared spec',
      });
      expect(path.relative(project, parsed.path).replace(/\\/g, '/')).toMatch(/^\.braid\/artifacts\/objects\//);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('defaults omitted dataType to the Meta root type', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-service-meta-'));
    try {
      const harness = makeHarness(project);

      const result = await harness.call('artifact_declare', {
        label: 'Loose note',
        text: 'Free-form handoff note.',
        attachToTurn: true,
      });

      expect(result.ok).toBe(true);
      expect(harness.produceCalls).toEqual([{
        canvasId: 'c1',
        boardId: 'b1',
        input: {
          source: 'declared',
          dataType: 'meta',
          mime: 'text/markdown',
          label: 'Loose note',
          text: 'Free-form handoff note.',
          pluginId: 'artifacts',
          attachTo: { turnIndex: 2 },
        },
      }]);
      const parsed = JSON.parse(result.result);
      expect(parsed.ref).toMatchObject({ class: 'declared', dataType: 'meta', label: 'Loose note' });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('declares workspace files as live external-ref artifacts through the production seam', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-live-file-'));
    try {
      const harness = makeHarness(project);

      const result = await harness.call('artifact_declare', {
        dataType: 'mockup',
        label: 'Live mockup',
        path: 'mockups/live.html',
        storageMode: 'external-ref',
        mime: 'text/html',
        attachToTurn: true,
      });

      expect(result.ok).toBe(true);
      expect(harness.produceCalls).toEqual([{
        canvasId: 'c1',
        boardId: 'b1',
        input: {
          source: 'external-ref',
          dataType: 'mockup',
          mime: 'text/html',
          label: 'Live mockup',
          path: 'mockups/live.html',
          pluginId: 'artifacts',
          attachTo: { turnIndex: 2 },
        },
      }]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('declares workspace files as born snapshot artifacts through the production seam', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-snapshot-file-'));
    try {
      const harness = makeHarness(project);

      const result = await harness.call('artifact_declare', {
        dataType: 'mockup',
        label: 'Snapshot mockup',
        path: 'mockups/snapshot.html',
        storageMode: 'born',
        mime: 'text/html',
      });

      expect(result.ok).toBe(true);
      expect(harness.produceCalls).toEqual([{
        canvasId: 'c1',
        boardId: 'b1',
        input: {
          source: 'born',
          dataType: 'mockup',
          mime: 'text/html',
          label: 'Snapshot mockup',
          path: 'mockups/snapshot.html',
          pluginId: 'artifacts',
        },
      }]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous file declarations before touching the registry', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-ambiguous-file-'));
    try {
      const harness = makeHarness(project);

      await expect(harness.call('artifact_declare', {
        dataType: 'mockup',
        label: 'No mode',
        path: 'mockups/no-mode.html',
      })).resolves.toMatchObject({ ok: false, result: expect.stringContaining('storageMode') });
      await expect(harness.call('artifact_declare', {
        dataType: 'mockup',
        label: 'Both payloads',
        path: 'mockups/file.html',
        storageMode: 'born',
        text: '<html></html>',
      })).resolves.toMatchObject({ ok: false, result: expect.stringContaining('either text or path') });
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects empty declaration fields before touching the registry', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-invalid-'));
    try {
      const harness = makeHarness(project);
      const result = await harness.call('artifact_declare', {
        dataType: 'spec',
        label: '',
        text: 'content',
      });
      expect(result).toMatchObject({ ok: false, result: expect.stringContaining('label') });
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('exposes and validates artifact expectations without declaring artifacts', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-contract-'));
    try {
      const harness = makeHarness(project);
      const tool = harness.tools.find((candidate) => candidate.tool.name === 'artifact_expect');
      expect(tool?.tool.description).toContain('not an artifact declaration');
      expect(tool?.tool.description).toContain('artifact_declare');
      expect(tool?.tool.description).toContain('expect nothing');
      expect(tool?.tool.description).toContain('latest expectation');
      expect(tool?.tool.description).toContain('agent judgment');
      expect(tool?.tool.description).toContain('accepted and ignored');
      expect(tool?.tool.description).not.toContain('Never pass nothing:false');
      expect(tool?.tool.description).toContain('attachToTurn:true');
      // F6: no oneOf/const acrobatics — schema stays shape-only; the handler owns semantics.
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('"oneOf"');
      expect(JSON.stringify(tool?.tool.inputSchema)).not.toContain('"const"');
      expect(tool?.tool.description).not.toContain('observed new output files');
      expect(tool?.tool.description).not.toContain('self-check');

      await expect(harness.call('artifact_expect', { dataType: 'report' })).resolves.toMatchObject({ ok: true });
      await expect(harness.call('artifact_expect', { nothing: true, reason: 'analysis only' })).resolves.toMatchObject({ ok: true });
      // F6: a redundant nothing:false alongside dataType is unambiguous — accepted, not scolded.
      await expect(harness.call('artifact_expect', { dataType: 'report', nothing: false })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('ignored-nothing-false'),
      });
      await expect(harness.call('artifact_expect', { dataType: 'report', nothing: true })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('either dataType or nothing'),
      });
      await expect(harness.call('artifact_expect', {})).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('needs either dataType or nothing'),
      });
      // F6: bare nothing:false gets an actionable error pointing at dataType.
      await expect(harness.call('artifact_expect', { nothing: false })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('pass dataType'),
      });
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records repeated artifact_expect decisions so the latest one can be audited', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-latest-'));
    try {
      const harness = makeHarness(project);

      await expect(harness.call('artifact_expect', { dataType: 'report', reason: 'Initial artifact judgment.' })).resolves.toMatchObject({ ok: true });
      await expect(harness.call('artifact_expect', { nothing: true, reason: 'Revised judgment: no user-facing artifact.' })).resolves.toMatchObject({ ok: true });

      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toEqual([
        {
          type: 'artifact-expectation-decided',
          target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
          decision: { kind: 'dataType', dataType: 'report', reason: 'Initial artifact judgment.' },
        },
        {
          type: 'artifact-expectation-decided',
          target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
          decision: { kind: 'nothing', reason: 'Revised judgment: no user-facing artifact.' },
        },
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records expected dataTypes for host-owned artifact-output attribution', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-obligation-default-'));
    try {
      const harness = makeHarness(project);

      const result = await harness.call('artifact_expect', { dataType: 'report', reason: 'User asked for a report file.' });

      expect(result.ok).toBe(true);
      expect(harness.attachedObligations).toHaveLength(0);
      const parsed = JSON.parse(result.result);
      expect(parsed).toMatchObject({ dataType: 'report' });
      expect(parsed.obligationId).toBeUndefined();
      expect(harness.obligationEvents).toContainEqual({
        type: 'artifact-expectation-decided',
        target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
        decision: { kind: 'dataType', dataType: 'report', reason: 'User asked for a report file.' },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records expect-nothing decisions for host-owned artifact-output attribution', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-nothing-obligation-'));
    try {
      const harness = makeHarness(project);

      const result = await harness.call('artifact_expect', { nothing: true, reason: 'Only scratch work.' });

      expect(result.ok).toBe(true);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual({
        type: 'artifact-expectation-decided',
        target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
        decision: { kind: 'nothing', reason: 'Only scratch work.' },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records repair-turn artifact_expect decisions without plugin-side obligation resolution', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-repair-target-'));
    try {
      const harness = makeHarness(project);

      await expect(harness.call('artifact_expect', { dataType: 'report', reason: 'Repair the original turn.' })).resolves.toMatchObject({ ok: true });

      expect(harness.attachedObligations).toEqual([]);
      expect(harness.obligationEvents).toContainEqual({
        type: 'artifact-expectation-decided',
        target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
        decision: { kind: 'dataType', dataType: 'report', reason: 'Repair the original turn.' },
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not self-check nudge when an expected output is declared and attached', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-covered-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'reports/expected.docx' });
      await harness.call('artifact_expect', { dataType: 'report' });
      const declared = await harness.call('artifact_declare', {
        dataType: 'report',
        label: 'Expected report',
        path: 'reports/expected.docx',
        storageMode: 'external-ref',
        attachToTurn: true,
      });
      await harness.settle();

      expect(declared.ok).toBe(true);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.delivered).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not live-nudge observed output after expect nothing', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-expect-nothing-challenge-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'reports/ignored.docx' });
      const result = await harness.call('artifact_expect', { nothing: true, reason: 'Only scratch work.' });
      await harness.settle();

      expect(result.ok).toBe(true);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.delivered).toHaveLength(0);
      expect(harness.obligationEvents).toEqual([
        {
          type: 'artifact-output-candidate-observed',
          target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
          path: 'reports/ignored.docx',
          toolName: 'write_file',
        },
        {
          type: 'artifact-expectation-decided',
          target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
          decision: { kind: 'nothing', reason: 'Only scratch work.' },
        },
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records host-obligation candidates for undeclared new output files without a positive deliverable-type list', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'report.docx' });
      await harness.observeToolUse({ path: 'deck.pptx' });
      await harness.observeToolUse({ path: 'workbook.xlsx' });
      await harness.observeToolUse({ path: 'brief.pdf' });
      await harness.observeToolUse({ file_path: 'snake.html' });
      await harness.settle();
      await harness.settle();

      expect(harness.delivered).toHaveLength(0);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'report.docx',
      }));
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'deck.pptx',
      }));
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'workbook.xlsx',
      }));
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'brief.pdf',
      }));
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'snake.html',
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records a host-obligation candidate for a new nested source-looking file because the agent judges deliverable intent', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-html-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'src/generated-report.html' }, 'Write');
      await harness.settle();

      expect(harness.delivered).toHaveLength(0);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'src/generated-report.html',
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records artifact-output intent for artifact-producing agent tools without declaring expectations', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-producer-tool-'));
    try {
      const harness = makeHarness(project, { live: true });
      const tools = [
        'agent__braid__image_generate',
        'agent__braid__video_generate',
        'agent__braid__speech_generate',
        'agent__braid__sound_effect_generate',
        'agent__braid__music_generate',
        'agent__braid__audio_generate',
        'agent__braid__model_generate',
        'video_generate',
      ];

      for (const [index, toolName] of tools.entries()) {
        await harness.observeToolUse({ prompt: 'deliver a user-facing artifact' }, toolName, 20 + index);
      }

      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents.some((event) => event.type === 'artifact-expectation-decided')).toBe(false);
      expect(harness.obligationEvents.some((event) => event.type === 'artifact-output-candidate-observed')).toBe(false);
      expect(harness.obligationEvents).toEqual([
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'image_generate', dataType: 'image' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'video_generate', dataType: 'video' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'speech_generate', dataType: 'audio' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'sound_effect_generate', dataType: 'audio' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'music_generate', dataType: 'audio' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'audio_generate', dataType: 'audio' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'model_generate', dataType: 'model-3d' }),
        expect.objectContaining({ type: 'artifact-output-intent-observed', toolName: 'video_generate', dataType: 'video' }),
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not arm artifact-output obligations for canceled artifact-producing agent tools', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-producer-tool-cancel-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ requestId: 'video-1', cancel: true }, 'agent__braid__video_generate');

      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toEqual([]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not nudge for ordinary source edits or infra and scratch outputs', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-excluded-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ file_path: 'src/App.html' }, 'Edit');
      await harness.observeToolUse({ path: '.braid/live-refs/note.md' }, 'Write');
      await harness.observeToolUse({ path: 'node_modules/pkg/index.js' }, 'Write');
      await harness.observeToolUse({ path: 'tmp-report/out.md' }, 'Write');
      await harness.observeToolUse({ path: 'probe-run/out.md' }, 'Write');
      await harness.observeToolUse({ path: 'dist/app.js' }, 'Write');
      await harness.settle();

      expect(harness.deliveryAttempts).toBe(0);
      expect(harness.delivered).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not nudge when the candidate was manually declared and attached', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-covered-'));
    try {
      const harness = makeHarness(project, { live: true });

      const files = ['reports/attached.docx', 'reports/attached.pptx', 'reports/attached.xlsx', 'reports/attached.pdf'];
      for (const file of files) {
        await harness.observeToolUse({ file_path: file });
        const result = await harness.call('artifact_declare', {
          dataType: 'report',
          label: `Attached ${path.basename(file)}`,
          path: file,
          storageMode: 'external-ref',
          attachToTurn: true,
        });
        expect(result.ok).toBe(true);
      }
      await harness.settle();

      expect(harness.delivered).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not nudge on error, abort, or unavailable live-board delivery', async () => {
    const erroredProject = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-error-'));
    const abortedProject = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-abort-'));
    const unavailableProject = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-unavailable-'));
    try {
      const errored = makeHarness(erroredProject, { live: true });
      await errored.observeToolUse({ path: 'reports/error.docx' });
      await errored.service.onRunError?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex', message: 'failed' });
      await errored.settle();
      expect(errored.delivered).toHaveLength(0);

      const aborted = makeHarness(abortedProject, { live: true });
      await aborted.observeToolUse({ path: 'reports/abort.docx' });
      await aborted.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1', message: 'aborted' });
      await aborted.settle();
      expect(aborted.delivered).toHaveLength(0);

      const unavailable = makeHarness(unavailableProject, { live: false });
      await unavailable.observeToolUse({ path: 'reports/cold.docx' });
      await unavailable.settle();
      expect(unavailable.deliveryAttempts).toBe(0);
      expect(unavailable.delivered).toHaveLength(0);
    } finally {
      fs.rmSync(erroredProject, { recursive: true, force: true });
      fs.rmSync(abortedProject, { recursive: true, force: true });
      fs.rmSync(unavailableProject, { recursive: true, force: true });
    }
  });

  it('retires pending deliverable candidates when the owning canvas closes', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-close-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'reports/closed.docx' });
      await harness.service.onCanvasClose?.('c1');
      await harness.settle();

      // The candidate was retired on canvas close, so a late turn-settle finds nothing to nudge —
      // the in-memory candidate/covered maps do not outlive their owning canvas. (code-review LOW-1)
      expect(harness.delivered).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('leaves another canvas\'s pending candidates intact when a different canvas closes', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-close-scope-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'reports/other.docx' });
      await harness.service.onCanvasClose?.('c2'); // unrelated canvas — must not sweep c1's candidate
      await harness.settle();

      expect(harness.delivered).toHaveLength(0);
      expect(harness.attachedObligations).toHaveLength(0);
      expect(harness.obligationEvents).toContainEqual(expect.objectContaining({
        type: 'artifact-output-candidate-observed',
        path: 'reports/other.docx',
      }));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
