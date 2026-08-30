import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coordinatorHostServicePlugin } from './service';
import type { AgentToolPlugin, HostServiceContext, LiveMessageContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function writeResources(project: string, resources: unknown[]) {
  fs.mkdirSync(path.join(project, '.braid'), { recursive: true });
  fs.writeFileSync(path.join(project, '.braid', 'resources.json'), JSON.stringify({ resources }));
}

/**
 * E2E cannot reliably observe the exact in-process ordering of FIFO waiters,
 * cancellation, and delivery deduplication. These focused tests cover only those
 * deterministic algorithms; they never stand in for Runtime recovery evidence.
 */
function makeHarness(project: string, opts: {
  agentIds?: Record<string, string>;
  deliver?: (message: LiveMessageContext) => boolean | Promise<boolean>;
} = {}) {
  const delivered: LiveMessageContext[] = [];
  const states: { canvasId: string; data: unknown }[] = [];
  const agentIds = new Map(Object.entries(opts.agentIds ?? {}));
  const ctx = {
    cwd: () => project,
    readSecret: async (pluginId: string, key: string) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId: string, key: string) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId: string, key: string) => ({ pluginId, key, cleared: true }),
    agentIdForBoard: (canvasId: string, boardId: string) => agentIds.get(`${canvasId}::${boardId}`),
    deliverLiveAgentMessage: async (message: LiveMessageContext) => {
      delivered.push(message);
      return await (opts.deliver?.(message) ?? true);
    },
    publishWorkspaceState: ({ canvasIds, snapshotForCanvas }: {
      canvasIds: string[];
      snapshotForCanvas(canvasId: string): unknown;
    }) => {
      for (const canvasId of canvasIds) states.push({ canvasId, data: snapshotForCanvas(canvasId) });
    },
    publishWorkspaceEvent: () => undefined,
  } as HostServiceContext;
  const service = coordinatorHostServicePlugin.create(ctx);
  const tool = service.agentTools?.()[0] as AgentToolPlugin<Record<string, unknown>>;
  const call = (
    canvasId: string,
    boardId: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal,
  ): Promise<AgentToolResult> => tool.call({ canvasId, boardId, turnIndex: 0, provider: 'claude', signal }, args);
  return { call, delivered, states };
}

describe('coordinator host service — deterministic resource arbitration', () => {
  it('rejects traversal and absolute paths outside the workspace while accepting an absolute in-workspace path', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-path-boundary-'));
    try {
      writeResources(project, []);
      const { call, states } = makeHarness(project);
      const outsidePaths = ['../outside.ts', path.resolve(project, '..', 'outside.ts')];

      for (const [index, outsidePath] of outsidePaths.entries()) {
        await expect(call('c1', `outside-${index}`, { action: 'wait-file', path: outsidePath })).resolves.toMatchObject({
          ok: false,
          result: expect.stringContaining('workspace-relative'),
        });
      }

      const insidePath = path.join(project, 'src', 'shared.ts');
      await expect(call('c1', 'inside', { action: 'wait-file', path: insidePath })).resolves.toMatchObject({
        ok: true,
        result: expect.stringMatching(/HOLD.*ACTIVE/),
      });
      expect((states.at(-1)!.data as any).claims).toEqual(expect.arrayContaining([
        expect.objectContaining({ boardId: 'inside', path: 'src/shared.ts', status: 'active' }),
      ]));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate wait-file call before draining its original waiter', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-duplicate-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { call } = makeHarness(project);
      await call('c1', 'holder', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      const originalWait = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();

      await expect(call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal)).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('already waiting'),
      });
      await call('c1', 'holder', { action: 'release' });
      await expect(originalWait).resolves.toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('grants queued wait-file claims FIFO after explicit releases', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-fifo-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { call } = makeHarness(project);
      await call('c1', 'holder', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      const olderWait = call('c1', 'older', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();
      const newcomerWait = call('c1', 'newcomer', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();

      await call('c1', 'holder', { action: 'release' });
      await expect(olderWait).resolves.toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
      const newcomerBeforeRelease = await Promise.race([
        newcomerWait.then(() => 'settled' as const),
        flush().then(() => 'pending' as const),
      ]);
      expect(newcomerBeforeRelease).toBe('pending');

      await call('c1', 'older', { action: 'release' });
      await expect(newcomerWait).resolves.toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('removes an aborted waiter so a later explicit release creates no ghost claim', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-abort-'));
    try {
      writeResources(project, []);
      const { call, states } = makeHarness(project);
      await call('c1', 'holder', { action: 'wait-file', path: 'src/shared.ts' });
      const waitAbort = new AbortController();
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, waitAbort.signal);
      await flush();
      waitAbort.abort();
      await expect(waitP).resolves.toMatchObject({ ok: false, result: expect.stringContaining('canceled') });

      await call('c1', 'holder', { action: 'release' });
      await expect(call('c1', 'writer', { action: 'wait-file', path: 'src/shared.ts' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringMatching(/HOLD.*ACTIVE/),
      });
      expect((states.at(-1)!.data as any).claims).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ boardId: 'waiter', path: 'src/shared.ts', status: 'active' }),
      ]));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records one dedup key when the exact-agent delivery port rejects a notice', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-dedup-'));
    try {
      writeResources(project, [{ id: 'editor', kind: 'state', states: ['open', 'closed'] }]);
      const { call, delivered } = makeHarness(project, {
        agentIds: { 'c1::holder': 'agent-holder' },
        deliver: () => false,
      });

      await call('c1', 'holder', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'closed' });
      await call('c1', 'requester-1', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'open' });
      await call('c1', 'requester-2', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'open' });

      const notices = delivered.filter((message) => message.kind === 'coordination.notice');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ agentId: 'agent-holder', canvasId: 'c1', boardId: 'holder' });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
