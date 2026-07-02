import { describe, expect, it } from 'vitest';
import type { HostServiceContext } from '../../../src/plugin-api/types';
import { KNOWLEDGE_USAGE_STATE_KEY, knowledgeUsageHostServicePlugin } from './service';
import { emptyUsage, type KnowledgeUsageSnapshot } from './usage';

// A fake HostServiceContext that records the most recent published snapshot per canvas.
function fakeCtx(): { ctx: HostServiceContext; snapshots: Map<string, KnowledgeUsageSnapshot> } {
  const snapshots = new Map<string, KnowledgeUsageSnapshot>();
  const ctx: HostServiceContext = {
    cwd: () => '.',
    liveOwnerKeys: () => new Set<string>(),
    openCanvasIds: () => [],
    liveBoardKeys: () => [],
    hasLiveBoardKey: () => false,
    deliverLiveBoardMessage: () => false,
    captureFileSnapshot: () => {},
    publishWorkspaceState: ({ stateKey, canvasIds, snapshotForCanvas }) => {
      expect(stateKey).toBe(KNOWLEDGE_USAGE_STATE_KEY);
      for (const cid of canvasIds) snapshots.set(cid, snapshotForCanvas(cid) as KnowledgeUsageSnapshot);
    },
    publishWorkspaceEvent: () => {},
  };
  return { ctx, snapshots };
}

function observe(svc: ReturnType<typeof knowledgeUsageHostServicePlugin.create>, canvasId: string, boardId: string, turnIndex: number, toolName: string, input: unknown) {
  svc.toolMiddleware!()[0].observeToolUse!({ canvasId, boardId, turnIndex, source: 'observed', toolName, input });
}

describe('knowledge usage service', () => {
  it('counts recalls and records from the observed tool stream', () => {
    const { ctx, snapshots } = fakeCtx();
    const svc = knowledgeUsageHostServicePlugin.create(ctx);
    observe(svc, 'c1', 'b1', 0, 'Read', { file_path: '.braid/knowledge/x.md' });
    observe(svc, 'c1', 'b1', 0, 'Write', { file_path: '.braid/knowledge/x.md' });
    observe(svc, 'c1', 'b1', 0, 'Read', { file_path: 'src/unrelated.ts' }); // ignored
    expect(snapshots.get('c1')).toEqual({ recalls: 1, records: 1, gaps: 0 });
  });

  it('correlates a settled lesson-claim with no vault write into a GAP', () => {
    const { ctx, snapshots } = fakeCtx();
    const svc = knowledgeUsageHostServicePlugin.create(ctx);
    observe(svc, 'c1', 'b1', 2, 'Read', { file_path: '.braid/knowledge/x.md' });
    svc.onTurnSettled!({ canvasId: 'c1', boardId: 'b1', turnIndex: 2, answer: '我记下了三条教训' });
    expect(snapshots.get('c1')).toEqual({ recalls: 1, records: 0, gaps: 1 });
  });

  it('does NOT count a GAP when the same turn wrote to the vault', () => {
    const { ctx, snapshots } = fakeCtx();
    const svc = knowledgeUsageHostServicePlugin.create(ctx);
    observe(svc, 'c1', 'b1', 3, 'Write', { file_path: '.braid/knowledge/x.md' });
    svc.onTurnSettled!({ canvasId: 'c1', boardId: 'b1', turnIndex: 3, answer: '我记下了三条教训' });
    expect(snapshots.get('c1')).toEqual({ recalls: 0, records: 1, gaps: 0 });
  });

  it('keeps per-canvas counts isolated and clears a canvas on close', () => {
    const { ctx, snapshots } = fakeCtx();
    const svc = knowledgeUsageHostServicePlugin.create(ctx);
    observe(svc, 'c1', 'b1', 0, 'Read', { file_path: '.braid/knowledge/a.md' });
    observe(svc, 'c2', 'b1', 0, 'Write', { file_path: '.braid/knowledge/b.md' });
    expect(snapshots.get('c1')).toEqual({ recalls: 1, records: 0, gaps: 0 });
    expect(snapshots.get('c2')).toEqual({ recalls: 0, records: 1, gaps: 0 });
    svc.onCanvasClose!('c1');
    expect(snapshots.get('c1')).toEqual(emptyUsage()); // cleared on close
    observe(svc, 'c2', 'b1', 1, 'Read', { file_path: '.braid/knowledge/c.md' });
    expect(snapshots.get('c2')).toEqual({ recalls: 1, records: 1, gaps: 0 }); // c2 untouched by c1's close
  });
});
