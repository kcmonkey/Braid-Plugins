import { describe, expect, it, vi } from 'vitest';
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
  const snapshots: { canvasId: string; boardId: string; path: string }[] = [];
  const liveKeys = new Set(opts.liveKeys ?? []);
  const ctx: HostServiceContext = {
    cwd: () => project,
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    liveOwnerKeys: () => new Set(liveKeys),
    openCanvasIds: () => opts.openCanvasIds ?? ['c1'],
    liveBoardKeys: () => [...liveKeys],
    hasLiveBoardKey: (key) => liveKeys.has(key),
    deliverLiveBoardMessage: (msg) => {
      delivered.push(msg);
      return opts.deliver?.(msg) ?? true;
    },
    captureFileSnapshot: (canvasId, boardId, filePath) => {
      snapshots.push({ canvasId, boardId, path: filePath });
    },
    publishWorkspaceState: ({ canvasIds, snapshotForCanvas }) => {
      for (const canvasId of canvasIds) states.push({ canvasId, data: snapshotForCanvas(canvasId) });
    },
    publishWorkspaceEvent: () => undefined,
  };
  const service = coordinatorHostServicePlugin.create(ctx);
  const tool = service.agentTools?.()[0] as AgentToolPlugin<Record<string, unknown>>;
  const call = (canvasId: string, boardId: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> =>
    tool.call({ canvasId, boardId, turnIndex: 0, provider: 'claude', signal }, args);
  return { service, call, delivered, states, snapshots, liveKeys };
}

describe('coordinator host service', () => {
  it('rejects traversal and absolute paths outside the workspace while accepting an absolute in-workspace path', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-path-boundary-'));
    try {
      writeResources(project, []);
      const { call, states } = makeHarness(project);
      const outsidePaths = [
        '../outside.ts',
        path.resolve(project, '..', 'outside.ts'),
      ];

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

  it('leaves rollback snapshot ownership to the admitted write after an immediate wait-file claim', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-snapshot-owner-'));
    try {
      writeResources(project, []);
      const { service, call, snapshots } = makeHarness(project, { liveKeys: ['c1::writer'] });

      await expect(call('c1', 'writer', { action: 'wait-file', path: 'src/shared.ts' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringMatching(/HOLD.*ACTIVE/),
      });
      expect(snapshots).toEqual([]);

      const gate = service.toolMiddleware!()[0];
      await gate.gateToolUse!({
        canvasId: 'c1', boardId: 'writer', source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: new AbortController().signal,
      });
      expect(snapshots).toEqual([{ canvasId: 'c1', boardId: 'writer', path: 'src/shared.ts' }]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

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

  it('wait-file stays pending behind a live holder, then atomically becomes ACTIVE before another writer', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { service, call, states, snapshots, delivered } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter', 'c1::writer'],
      });
      const gate = service.toolMiddleware!()[0];
      const edit = (boardId: string) => gate.gateToolUse!({
        canvasId: 'c1', boardId, source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: abort.signal,
      });

      await edit('holder');
      snapshots.length = 0;
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      const firstTurn = await Promise.race([
        waitP.then(() => 'settled' as const),
        flush().then(() => 'pending' as const),
      ]);
      expect(firstTurn).toBe('pending');
      expect(delivered).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetKey: 'c1::holder', kind: 'coordination.notice' }),
      ]));

      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['holder'], provider: 'claude' });
      await expect(waitP).resolves.toMatchObject({
        ok: true,
        result: expect.stringMatching(/HOLD.*ACTIVE/),
      });
      expect((states.at(-1)!.data as any).claims).toEqual(expect.arrayContaining([
        expect.objectContaining({ boardId: 'waiter', path: 'src/shared.ts', access: 'edit', status: 'active' }),
      ]));
      expect(snapshots).toEqual([]);

      await edit('waiter');
      expect(snapshots).toEqual([{ canvasId: 'c1', boardId: 'waiter', path: 'src/shared.ts' }]);

      const thirdWriter = await edit('writer');
      expect((thirdWriter as any)?.deny).toBe(true);
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate wait-file call before draining its original waiter', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-duplicate-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { service, call, liveKeys } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter'],
      });
      const gate = service.toolMiddleware!()[0];
      await gate.gateToolUse!({
        canvasId: 'c1', boardId: 'holder', source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: abort.signal,
      });
      const originalWait = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();

      liveKeys.delete('c1::holder');
      await expect(call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal)).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('already waiting'),
      });

      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['holder'], provider: 'claude' });
      await expect(originalWait).resolves.toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('drains an older queued wait-file before a newcomer wait-file claim', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-fifo-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { service, call, liveKeys } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::older', 'c1::newcomer'],
      });
      const gate = service.toolMiddleware!()[0];
      await gate.gateToolUse!({
        canvasId: 'c1', boardId: 'holder', source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: abort.signal,
      });
      const olderWait = call('c1', 'older', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();

      liveKeys.delete('c1::holder');
      const newcomerWait = call('c1', 'newcomer', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      const firstGranted = await Promise.race([
        olderWait.then((result) => ({ boardId: 'older', result })),
        newcomerWait.then((result) => ({ boardId: 'newcomer', result })),
      ]);
      expect(firstGranted).toMatchObject({
        boardId: 'older',
        result: { ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) },
      });

      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['older'], provider: 'claude' });
      await expect(newcomerWait).resolves.toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('disposes file and resource waiters idempotently, removing listeners and every owned timer', async () => {
    vi.useFakeTimers();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-service-dispose-'));
    try {
      writeResources(project, [{ id: 'build', kind: 'exclusive' }]);
      const { service, call } = makeHarness(project, {
        liveKeys: ['c1::resource-holder', 'c1::file-holder', 'c1::resource-waiter', 'c1::file-waiter'],
      });
      await call('c1', 'resource-holder', { action: 'claim', resource: 'build' });
      await service.toolMiddleware!()[0].gateToolUse!({
        canvasId: 'c1', boardId: 'file-holder', source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: new AbortController().signal,
      });

      const resourceAbort = new AbortController();
      const fileAbort = new AbortController();
      const resourceRemove = vi.spyOn(resourceAbort.signal, 'removeEventListener');
      const fileRemove = vi.spyOn(fileAbort.signal, 'removeEventListener');
      const resourceWait = call('c1', 'resource-waiter', { action: 'wait', resource: 'build' }, resourceAbort.signal);
      const fileWait = call('c1', 'file-waiter', { action: 'wait-file', path: 'src/shared.ts' }, fileAbort.signal);
      const resourceSettled = vi.fn();
      const fileSettled = vi.fn();
      void resourceWait.then(resourceSettled);
      void fileWait.then(fileSettled);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(service.dispose).toBeTypeOf('function');

      await service.dispose?.();
      await service.dispose?.();
      await expect(resourceWait).resolves.toMatchObject({ ok: false, result: expect.stringContaining('disposed') });
      await expect(fileWait).resolves.toMatchObject({ ok: false, result: expect.stringContaining('disposed') });
      expect(resourceSettled).toHaveBeenCalledTimes(1);
      expect(fileSettled).toHaveBeenCalledTimes(1);
      expect(resourceRemove).toHaveBeenCalledTimes(1);
      expect(fileRemove).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      resourceAbort.abort();
      fileAbort.abort();
      await Promise.resolve();
      expect(resourceSettled).toHaveBeenCalledTimes(1);
      expect(fileSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('drains a queued wait-file before a newcomer when holder liveness disappears', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-live-drain-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { service, call, liveKeys } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter', 'c1::newcomer'],
      });
      const gate = service.toolMiddleware!()[0];
      const edit = (boardId: string) => gate.gateToolUse!({
        canvasId: 'c1', boardId, source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: abort.signal,
      });

      await edit('holder');
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      await flush();

      liveKeys.delete('c1::holder');
      const newcomer = await edit('newcomer');
      const waiterTurn = await Promise.race([
        waitP.then((value) => ({ status: 'settled' as const, value })),
        flush().then(() => ({ status: 'pending' as const })),
      ]);

      expect({ newcomerDenied: (newcomer as any)?.deny === true, waiterTurn }).toMatchObject({
        newcomerDenied: true,
        waiterTurn: {
          status: 'settled',
          value: { ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) },
        },
      });
    } finally {
      abort.abort();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rechecks a queued wait-file when holder liveness disappears without another coordination event', async () => {
    vi.useFakeTimers();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-live-recheck-'));
    const abort = new AbortController();
    try {
      writeResources(project, []);
      const { service, call, liveKeys } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter'],
      });
      const gate = service.toolMiddleware!()[0];

      await gate.gateToolUse!({
        canvasId: 'c1', boardId: 'holder', source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: abort.signal,
      });
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, abort.signal);
      let settled: AgentToolResult | undefined;
      void waitP.then((result) => { settled = result; });

      liveKeys.delete('c1::holder');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toMatchObject({ ok: true, result: expect.stringMatching(/HOLD.*ACTIVE/) });
    } finally {
      abort.abort();
      vi.useRealTimers();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('wait-file abort removes the waiter and prevents a ghost claim after the holder settles', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-abort-'));
    try {
      writeResources(project, []);
      const { service, call, states } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter', 'c1::writer'],
      });
      const gate = service.toolMiddleware!()[0];
      const gateSignal = new AbortController().signal;
      const edit = (boardId: string) => gate.gateToolUse!({
        canvasId: 'c1', boardId, source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: gateSignal,
      });

      await edit('holder');
      const waitAbort = new AbortController();
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' }, waitAbort.signal);
      await flush();
      waitAbort.abort();
      await expect(waitP).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('canceled'),
      });

      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['holder'], provider: 'claude' });
      const writer = await edit('writer');
      expect((writer as any)?.deny).toBeFalsy();
      expect((states.at(-1)!.data as any).claims).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ boardId: 'waiter', path: 'src/shared.ts', status: 'active' }),
      ]));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails a non-live wait-file requester closed and leaves no ghost claim on holder settle', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-wait-non-live-'));
    try {
      writeResources(project, []);
      const { service, call, states, liveKeys } = makeHarness(project, {
        liveKeys: ['c1::holder', 'c1::waiter', 'c1::writer'],
      });
      const gate = service.toolMiddleware!()[0];
      const gateSignal = new AbortController().signal;
      const edit = (boardId: string) => gate.gateToolUse!({
        canvasId: 'c1', boardId, source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: gateSignal,
      });

      await edit('holder');
      const waitP = call('c1', 'waiter', { action: 'wait-file', path: 'src/shared.ts' });
      await flush();

      liveKeys.delete('c1::waiter');
      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['holder'], provider: 'claude' });
      const waitResult = await waitP;
      const claimsAfterSettle = (states.at(-1)!.data as any).claims;
      const writer = await edit('writer');

      expect({
        waitResult,
        ghostActive: claimsAfterSettle.some((claim: any) =>
          claim.boardId === 'waiter' && claim.path === 'src/shared.ts' && claim.status === 'active'),
        writerDenied: (writer as any)?.deny === true,
      }).toMatchObject({
        waitResult: { ok: false, result: expect.stringMatching(/canceled|non-live|no longer live/i) },
        ghostActive: false,
        writerDenied: false,
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

  it('Part A: a finished board\'s request negotiation/messages are retired on run settle', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-retire-'));
    try {
      writeResources(project, [{ id: 'editor', kind: 'state', states: ['open', 'closed'] }]);
      const { service, call, states } = makeHarness(project, { liveKeys: ['c1::requester'] });

      await call('c1', 'requester', { action: 'request', resource: 'editor', text: 'please free the editor' });
      let snap = states.at(-1)!.data as any;
      expect(snap.negotiations.some((n: any) => n.boardIds.includes('requester') && n.status === 'proposed')).toBe(true);
      expect(snap.messages.some((m: any) => m.fromBoardId === 'requester' && m.kind === 'question')).toBe(true);

      // The requester's run ends → Part A resolves the negotiation it originated and drops its request message,
      // so other boards stop seeing "requester requested editor" once its session is gone.
      service.onRunSettled?.({ canvasId: 'c1', boardIds: ['requester'], provider: 'claude' });
      snap = states.at(-1)!.data as any;
      expect(snap.negotiations.find((n: any) => n.boardIds.includes('requester'))?.status).toBe('resolved');
      expect(snap.messages.some((m: any) => m.fromBoardId === 'requester' && m.kind === 'question')).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('Part B: a non-live board\'s request is NOT injected into another board\'s context (panel ledger keeps it)', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-livegate-'));
    try {
      writeResources(project, [{ id: 'editor', kind: 'state', states: ['open', 'closed'] }]);
      // Only `viewer` is a live owner; `holder`/`requester` issued claims but are no longer running.
      const { call, states } = makeHarness(project, { liveKeys: ['c1::viewer'] });

      await call('c1', 'holder', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'closed' });
      await call('c1', 'requester', { action: 'claim', resource: 'editor', mode: 'state', desiredState: 'open' });

      const status = await call('c1', 'viewer', { action: 'status' });
      // Part B: requester is not live → its conflict negotiation/request is NOT narrated to viewer's context.
      expect(status.result).not.toContain('Resource conflict: editor');
      expect(status.result).not.toMatch(/requester requested/);
      // But the published snapshot (panel ledger) still records it — Part B is injection-only.
      const snap = states.at(-1)!.data as any;
      expect(snap.negotiations.some((n: any) => n.topic === 'Resource conflict: editor')).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('D21: a settled board\'s file edit-lock stops blocking live boards and leaves their context', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-coord-file-livegate-'));
    try {
      writeResources(project, []);
      const { service, liveKeys } = makeHarness(project, { liveKeys: ['c1::holder'] });
      const gate = service.toolMiddleware!()[0];
      const turnContext = service.turnContext!()[0];
      const sig = new AbortController().signal;
      const edit = (boardId: string) => gate.gateToolUse!({
        canvasId: 'c1', boardId, source: 'preToolUse', toolName: 'Edit',
        input: { file_path: 'src/shared.ts' }, signal: sig,
      });

      // holder (live) takes the edit-lock; a second LIVE board's write to the same file is blocked.
      await edit('holder');
      const blockedWhileLive = await edit('writer');
      expect((blockedWhileLive as any)?.deny).toBe(true);

      // holder's run ends → no longer a live owner, but its claim is still in state (a missed/late release).
      liveKeys.delete('c1::holder');

      // The settled holder's leftover lock no longer blocks a live board's write...
      const afterSettle = await edit('writer2');
      expect((afterSettle as any)?.deny).toBeFalsy();
      // ...and is not narrated into another live board's injected coordination context.
      const ctxText = turnContext.provideTurnContext?.({ canvasId: 'c1', boardId: 'viewer' }) ?? '';
      expect(ctxText).not.toContain('src/shared.ts');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

});
