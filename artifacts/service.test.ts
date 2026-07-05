import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { artifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, LiveMessageContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { registerArtifactType } from '../../../src/plugin-runtime/registry';

function makeHarness(project: string, options: { live?: boolean } = {}) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const delivered: LiveMessageContext[] = [];
  let deliveryAttempts = 0;
  const targetKey = 'c1::b1';
  const ctx: HostServiceContext = {
    cwd: () => project,
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
  const service = artifactsHostServicePlugin.create(ctx);
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
  return { call, tools, produceCalls, service, delivered, get deliveryAttempts() { return deliveryAttempts; }, observeToolUse, settle };
}

describe('artifacts host service', () => {
  it('exposes artifact declaration guidance on the core artifact tool contract', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-guidance-'));
    const unregister = registerArtifactType({
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
      const harness = makeHarness(project);
      const description = harness.tools.find((tool) => tool.tool.name === 'artifact_declare')?.tool.description ?? '';

      expect(description).toContain('durable');
      expect(description).toContain('bounded');
      expect(description).toContain('presentable');
      expect(description).toContain('declare it as an artifact');
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
    const unregister = registerArtifactType({
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
      const harness = makeHarness(project);

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

  it('fetches one artifact type with schema detail and reports Meta fallback for unknown types', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-type-detail-'));
    const schema = {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    };
    const unregister = registerArtifactType({
      id: 'test.phase9-brief-detail',
      dataType: 'phase9-brief-detail',
      label: 'Phase 9 Brief Detail',
      description: 'A typed brief with detail schema.',
      schema,
      validate: () => ({ ok: true }),
    });
    try {
      const harness = makeHarness(project);

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

  it('nudges the producer once for an unclaimed deliverable candidate after successful settle', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ path: 'mockups/checkout.html' });
      await harness.settle();
      await harness.settle();

      expect(harness.delivered).toHaveLength(1);
      expect(harness.delivered[0]).toMatchObject({
        canvasId: 'c1',
        targetKey: 'c1::b1',
        fromBoardId: 'b1',
        kind: 'artifact-deliverable-self-check',
        injected: true,
      });
      expect(harness.delivered[0].text).toContain('mockups/checkout.html');
      expect(harness.delivered[0].text).toContain('artifact_declare');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not nudge when the candidate was manually declared and attached', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-nudge-covered-'));
    try {
      const harness = makeHarness(project, { live: true });

      await harness.observeToolUse({ file_path: 'mockups/attached.html' });
      const result = await harness.call('artifact_declare', {
        dataType: 'mockup',
        label: 'Attached mockup',
        path: 'mockups/attached.html',
        storageMode: 'external-ref',
        attachToTurn: true,
      });
      await harness.settle();

      expect(result.ok).toBe(true);
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
      await errored.observeToolUse({ path: 'mockups/error.html' });
      await errored.service.onRunError?.({ canvasId: 'c1', boardId: 'b1', provider: 'codex', message: 'failed' });
      await errored.settle();
      expect(errored.delivered).toHaveLength(0);

      const aborted = makeHarness(abortedProject, { live: true });
      await aborted.observeToolUse({ path: 'mockups/abort.html' });
      await aborted.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1', message: 'aborted' });
      await aborted.settle();
      expect(aborted.delivered).toHaveLength(0);

      const unavailable = makeHarness(unavailableProject, { live: false });
      await unavailable.observeToolUse({ path: 'mockups/cold.html' });
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

      await harness.observeToolUse({ path: 'mockups/closed.html' });
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

      await harness.observeToolUse({ path: 'mockups/other.html' });
      await harness.service.onCanvasClose?.('c2'); // unrelated canvas — must not sweep c1's candidate
      await harness.settle();

      expect(harness.delivered).toHaveLength(1);
      expect(harness.delivered[0].text).toContain('mockups/other.html');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
