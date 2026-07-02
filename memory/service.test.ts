import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { memoryHostServicePlugin } from './service';
import { memoryPaths } from './storage';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

function makeHarness(project: string) {
  const ctx: HostServiceContext = {
    cwd: () => project,
    liveOwnerKeys: () => new Set(),
    openCanvasIds: () => ['c1'],
    liveBoardKeys: () => [],
    hasLiveBoardKey: () => false,
    deliverLiveBoardMessage: () => false,
    captureFileSnapshot: () => undefined,
    publishWorkspaceState: () => undefined,
    publishWorkspaceEvent: () => undefined,
  };
  const service = memoryHostServicePlugin.create(ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 0, provider: 'claude', signal }, args);
  };
  return { service, call, tools };
}

describe('memory host service', () => {
  it('records to project-local storage and recalls after service recreation', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-service-'));
    try {
      const first = makeHarness(project);
      await expect(first.call('memory_record', {
        title: 'Memory persistence',
        content: 'Records survive host service recreation.',
        scope: 'tests',
        tags: 'persistence',
      })).resolves.toMatchObject({ ok: true });

      const paths = memoryPaths(project);
      expect(fs.existsSync(paths.file)).toBe(true);
      expect(path.relative(project, paths.file).replace(/\\/g, '/')).toBe('.braid/memory/memories.json');

      const second = makeHarness(project);
      await expect(second.call('memory_recall', {
        query: 'service recreation persistence',
        scope: 'tests',
        limit: '3',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Memory persistence'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('treats missing or corrupt stores as empty and repairs on the next record', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-corrupt-'));
    try {
      const paths = memoryPaths(project);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.file, '{ not json');

      const service = makeHarness(project);
      await expect(service.call('memory_recall', { query: 'anything' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('No matching Braid memories'),
      });

      await expect(service.call('memory_record', {
        title: 'Repair corrupt store',
        content: 'Writing a new memory replaces invalid JSON with a valid store.',
      })).resolves.toMatchObject({ ok: true });

      const raw = JSON.parse(fs.readFileSync(paths.file, 'utf8'));
      expect(raw.records.map((record: any) => record.title)).toEqual(['Repair corrupt store']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps all memory paths contained under the workspace .braid/memory directory', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-paths-'));
    try {
      const paths = memoryPaths(project);
      const relativeDir = path.relative(project, paths.dir).replace(/\\/g, '/');
      const relativeFile = path.relative(project, paths.file).replace(/\\/g, '/');

      expect(relativeDir).toBe('.braid/memory');
      expect(relativeFile).toBe('.braid/memory/memories.json');
      expect(relativeDir.startsWith('..')).toBe(false);
      expect(relativeFile.startsWith('..')).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
