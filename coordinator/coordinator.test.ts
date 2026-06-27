import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coordinatorHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, LiveMessageContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function writeResources(project: string, resources: unknown[]) {
  fs.mkdirSync(path.join(project, '.braid'), { recursive: true });
  fs.writeFileSync(path.join(project, '.braid', 'resources.json'), JSON.stringify({ resources }));
}

function makeHarness(project: string, opts: {
  liveKeys?: string[];
  openCanvasIds?: string[];
  deliver?: (msg: LiveMessageContext) => boolean;
} = {}) {
  const delivered: LiveMessageContext[] = [];
  const states: { canvasId: string; data: unknown }[] = [];
  const liveKeys = new Set(opts.liveKeys ?? []);
  const ctx: HostServiceContext = {
    cwd: () => project,
    liveOwnerKeys: () => new Set(liveKeys),
    openCanvasIds: () => opts.openCanvasIds ?? ['c1'],
    liveBoardKeys: () => [...liveKeys],
    hasLiveBoardKey: (key) => liveKeys.has(key),
    deliverLiveBoardMessage: (msg) => {
      delivered.push(msg);
      return opts.deliver?.(msg) ?? true;
    },
    captureFileSnapshot: () => undefined,
    publishWorkspaceState: ({ canvasIds, snapshotForCanvas }) => {
      for (const canvasId of canvasIds) states.push({ canvasId, data: snapshotForCanvas(canvasId) });
    },
    publishWorkspaceEvent: () => undefined,
  };
  const service = coordinatorHostServicePlugin.create(ctx);
  const tool = service.agentTools?.()[0] as AgentToolPlugin<Record<string, unknown>>;
  const call = (canvasId: string, boardId: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> =>
    tool.call({ canvasId, boardId, turnIndex: 0, provider: 'claude', signal }, args);
  return { service, call, delivered, states };
}

describe('coordinator host service', () => {
  it('drains canvas-owned waits when a canvas closes', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-close-'));
    try {
      writeResources(project, [{ id: 'build', kind: 'exclusive' }]);
      const { service, call } = makeHarness(project);

      await call('c1', 'holder', { action: 'claim', resource: 'build' });
      const waitP = call('c1', 'waiter', { action: 'wait', resource: 'build' });
      await flush();

      service.onCanvasClose?.('c1');
      await expect(waitP).resolves.toMatchObject({
        ok: false,
        result: 'Wait canceled because the canvas was closed.',
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records live-notice dedup keys even when immediate delivery fails', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-dedup-'));
    try {
      writeResources(project, [{ id: 'editor', kind: 'state', states: ['open', 'closed'] }]);
      const { call, delivered } = makeHarness(project, {
        liveKeys: ['c1::holder'],
        deliver: () => false,
      });

      await call('c1', 'holder', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'closed' });
      await call('c1', 'requester-1', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'open' });
      await call('c1', 'requester-2', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'open' });

      const notices = delivered.filter((msg) => msg.kind === 'coordination.notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].targetKey).toBe('c1::holder');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('lets the coordinator choose same-canvas live request targets', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-targets-'));
    try {
      const { call, delivered } = makeHarness(project, {
        liveKeys: ['c1::target', 'c2::target'],
      });

      const result = await call('c1', 'source', { action: 'request', toBoardId: 'target', text: 'Please release when safe.' });

      expect(result.result).toContain('notified now');
      expect(delivered.map((msg) => msg.targetKey)).toEqual(['c1::target']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not reload resources.json from publish-only lifecycle hooks', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-cache-'));
    try {
      writeResources(project, [{ id: 'build', kind: 'exclusive' }]);
      const { service, call, states } = makeHarness(project);
      const resourceFile = path.join(project, '.braid', 'resources.json');

      service.onCanvasReady?.('c1');
      fs.writeFileSync(resourceFile, JSON.stringify({ resources: [{ id: 'editor', kind: 'exclusive' }] }));

      service.onRunSettled?.({ canvasId: 'c1', boardIds: [], provider: 'claude' });
      const publishedResources = (states.at(-1)?.data as any).resources.map((r: any) => r.id);
      expect(publishedResources).toEqual(['build']);

      const changed = await call('c1', 'builder', { action: 'status' });
      expect(changed.result).toContain('editor');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
