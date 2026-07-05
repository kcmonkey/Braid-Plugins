import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { artifactsHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

function makeHarness(project: string) {
  const produceCalls: Array<{ canvasId: string; boardId: string; input: any }> = [];
  const ctx: HostServiceContext = {
    cwd: () => project,
    produceArtifact: async (canvasId, boardId, input) => {
      produceCalls.push({ canvasId, boardId, input });
      return {
        ref: {
          id: 'declared-spec-test',
          class: input.source,
          dataType: input.dataType ?? 'spec',
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
    liveBoardKeys: () => [],
    hasLiveBoardKey: () => false,
    deliverLiveBoardMessage: () => false,
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
  return { call, tools, produceCalls };
}

describe('artifacts host service', () => {
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

  it('rejects empty declaration fields before touching the registry', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-artifacts-invalid-'));
    try {
      const harness = makeHarness(project);
      const result = await harness.call('artifact_declare', {
        dataType: '',
        label: 'No type',
        text: 'content',
      });
      expect(result).toMatchObject({ ok: false, result: expect.stringContaining('dataType') });
      expect(harness.produceCalls).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
