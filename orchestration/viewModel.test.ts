import { describe, expect, it } from 'vitest';
import type { BoardLike } from '../shared/board';
import { ORCHESTRATION_PLUGIN_ID, initialOrchestrationState } from './model';
import { buildRunViewModel, type BoardMessageLike, type ContextBlockLike, type ProjectionEdgeLike, type RunBoardInput } from './viewModel';

function board(status: string, elements: Record<string, unknown>, patch: Partial<BoardLike> = {}): BoardLike {
  return {
    status,
    prompt: patch.prompt ?? '',
    answer: patch.answer ?? '',
    elements,
    ...patch,
  };
}

function roleBoard(boardId: string, state: ReturnType<typeof initialOrchestrationState>, patch: Partial<BoardLike> = {}): RunBoardInput {
  return {
    boardId,
    board: board(patch.status ?? 'done', { [ORCHESTRATION_PLUGIN_ID]: state }, patch),
  };
}

const payload = (parentBoardId: string | undefined, boardId: string, role: string, stage: string, extra: Record<string, unknown> = {}) => ({
  parentBoardId,
  boardId,
  runId: 'run-1',
  role,
  stage,
  ...extra,
});

function fixture() {
  const boards: RunBoardInput[] = [
    roleBoard('worker-2', initialOrchestrationState('run-1', 'workerEngineer', {
      leadBoardId: 'lead-1',
      packageId: 'wp2',
      packageTitle: 'Docs',
      stage: 'worker',
    }), { status: 'idle' }),
    roleBoard('review-1', initialOrchestrationState('run-1', 'reviewer', {
      testBoardId: 'test-1',
      stage: 'complete',
      completed: true,
    })),
    roleBoard('architect-1', initialOrchestrationState('run-1', 'architect', {
      sourceBoardId: 'source-1',
      stage: 'blocked',
    }), { status: 'error', answer: 'Blocked by missing requirements.' }),
    roleBoard('lead-1', initialOrchestrationState('run-1', 'leadEngineer', {
      architectBoardId: 'architect-1',
      stage: 'execution',
      workPackages: [
        { id: 'wp1', title: 'Renderer', scope: 'UI' },
        { id: 'wp2', title: 'Docs', scope: 'Docs' },
      ],
      workerBoardIds: ['worker-1', 'worker-2'],
    })),
    roleBoard('worker-1', initialOrchestrationState('run-1', 'workerEngineer', {
      leadBoardId: 'lead-1',
      packageId: 'wp1',
      packageTitle: 'Renderer',
      stage: 'worker',
    }), {
      status: 'streaming',
      turns: [{
        prompt: 'Build the renderer slice.',
        steps: [{ id: 'tool-1', name: 'Edit', input: { file: 'index.tsx' }, result: 'patched' }],
        answer: 'Renderer slice is in progress.',
      }],
    }),
    roleBoard('test-1', initialOrchestrationState('run-1', 'testEngineer', {
      leadBoardId: 'lead-1',
      stage: 'repair',
    }), { answer: 'Tests failed; repair required.' }),
  ];

  const contextBlocks: ContextBlockLike[] = [
    {
      blockId: 'run:brief',
      title: 'Run brief',
      content: 'Shared target for the run.',
      payload: { runId: 'run-1', boardId: 'architect-1' },
    },
    {
      blockId: 'role:worker-1',
      scope: 'workerEngineer',
      title: 'Worker Engineer Worker',
      content: 'Role instructions for the worker board.',
      payload: payload('lead-1', 'worker-1', 'workerEngineer', 'worker', { packageTitle: 'Renderer' }),
    },
    {
      blockId: 'artifact:worker-1',
      scope: 'workerEngineer',
      title: 'Worker Renderer Output',
      content: 'Renderer produced card tableau data.',
      payload: payload('lead-1', 'worker-1', 'workerEngineer', 'worker', { packageTitle: 'Renderer' }),
    },
    {
      blockId: 'private:worker-1',
      scope: 'board:worker-1',
      title: 'Private scratch',
      content: 'Temporary implementation notes.',
      payload: payload('lead-1', 'worker-1', 'workerEngineer', 'worker'),
    },
  ];

  const messages: BoardMessageLike[] = [
    {
      id: 'm1',
      seq: 1,
      kind: 'role-materialized',
      sourceBoardId: 'architect-1',
      targetBoardId: 'lead-1',
      correlationId: 'role:lead-1',
      text: 'Architect summons Lead Engineer.',
      payload: payload('architect-1', 'lead-1', 'leadEngineer', 'execution'),
    },
    {
      id: 'm2',
      seq: 2,
      kind: 'role-materialized',
      sourceBoardId: 'lead-1',
      targetBoardId: 'worker-1',
      correlationId: 'role:worker-1',
      text: 'Lead assigns renderer work.',
      payload: payload('lead-1', 'worker-1', 'workerEngineer', 'worker', { packageTitle: 'Renderer' }),
    },
    {
      id: 'm3',
      seq: 3,
      kind: 'worker-report',
      sourceBoardId: 'worker-1',
      targetBoardId: 'lead-1',
      correlationId: 'report:worker-1',
      text: 'Worker reports renderer progress.',
    },
    {
      id: 'm4',
      seq: 4,
      kind: 'peer-note',
      sourceBoardId: 'worker-1',
      targetBoardId: 'worker-2',
      correlationId: 'peer:workers',
      text: 'Worker one shares reusable notes.',
    },
    {
      id: 'm5',
      seq: 5,
      kind: 'test-verdict',
      sourceBoardId: 'test-1',
      targetBoardId: 'lead-1',
      correlationId: 'verdict:test',
      text: 'Tests failed; send back for repair.',
    },
    {
      id: 'm6',
      seq: 6,
      kind: 'review-verdict',
      sourceBoardId: 'review-1',
      targetBoardId: 'test-1',
      correlationId: 'verdict:review',
      text: 'Review passed.',
    },
  ];

  const projectionEdges: ProjectionEdgeLike[] = [
    { pluginId: ORCHESTRATION_PLUGIN_ID, overlayKind: 'role-materialized', sourceBoardId: 'architect-1', targetBoardId: 'lead-1', payload: payload('architect-1', 'lead-1', 'leadEngineer', 'execution') },
    { pluginId: ORCHESTRATION_PLUGIN_ID, overlayKind: 'role-materialized', sourceBoardId: 'lead-1', targetBoardId: 'worker-1', payload: payload('lead-1', 'worker-1', 'workerEngineer', 'worker') },
    { pluginId: ORCHESTRATION_PLUGIN_ID, overlayKind: 'role-materialized', sourceBoardId: 'lead-1', targetBoardId: 'worker-2', payload: payload('lead-1', 'worker-2', 'workerEngineer', 'worker') },
    { pluginId: ORCHESTRATION_PLUGIN_ID, overlayKind: 'role-materialized', sourceBoardId: 'lead-1', targetBoardId: 'test-1', payload: payload('lead-1', 'test-1', 'testEngineer', 'repair') },
    { pluginId: ORCHESTRATION_PLUGIN_ID, overlayKind: 'role-materialized', sourceBoardId: 'test-1', targetBoardId: 'review-1', payload: payload('test-1', 'review-1', 'reviewer', 'complete') },
  ];

  return { boards, contextBlocks, messages, projectionEdges };
}

describe('orchestration run view model', () => {
  it('builds a command tree from lineage records and projection edges rather than input order', () => {
    const model = buildRunViewModel({ runId: 'run-1', focusedBoardId: 'worker-1', ...fixture() });

    expect(model.cards.map((card) => [card.boardId, card.parentBoardId])).toEqual([
      ['architect-1', 'source-1'],
      ['lead-1', 'architect-1'],
      ['test-1', 'lead-1'],
      ['worker-1', 'lead-1'],
      ['worker-2', 'lead-1'],
      ['review-1', 'test-1'],
    ]);
    expect(model.cards.find((card) => card.boardId === 'worker-1')).toMatchObject({
      role: 'workerEngineer',
      title: 'Worker Engineer: Renderer',
      stage: 'worker',
    });
  });

  it('classifies real board messages into bubbles with level relations', () => {
    const model = buildRunViewModel({ runId: 'run-1', ...fixture() });

    expect(model.bubbles.map((bubble) => [bubble.id, bubble.kind, bubble.relation])).toEqual([
      ['m1', 'order', 'down'],
      ['m2', 'order', 'down'],
      ['m3', 'report', 'up'],
      ['m4', 'peer', 'peer'],
      ['m5', 'verdict', 'up'],
      ['m6', 'verdict', 'up'],
    ]);
  });

  it('maps aggregate-context blocks into scoped-intel tiers and producers', () => {
    const model = buildRunViewModel({ runId: 'run-1', ...fixture() });

    expect(model.scopedIntel.map((entry) => [entry.blockId, entry.tier, entry.producerBoardId, entry.producerRole])).toEqual([
      ['run:brief', 'run-wide', 'architect-1', 'architect'],
      ['role:worker-1', 'role-scoped', 'worker-1', 'workerEngineer'],
      ['artifact:worker-1', 'role-scoped', 'worker-1', 'workerEngineer'],
      ['private:worker-1', 'private', 'worker-1', 'workerEngineer'],
    ]);
  });

  it('derives per-card execution status and report data from real-shaped state', () => {
    const model = buildRunViewModel({ runId: 'run-1', ...fixture() });
    const byId = new Map(model.cards.map((card) => [card.boardId, card]));

    expect(byId.get('architect-1')?.status).toBe('blocked');
    expect(byId.get('lead-1')?.status).toBe('delivered');
    expect(byId.get('worker-1')?.status).toBe('running');
    expect(byId.get('worker-2')?.status).toBe('queued');
    expect(byId.get('test-1')?.status).toBe('rejected');
    expect(byId.get('review-1')?.status).toBe('passed');

    const worker = byId.get('worker-1');
    expect(worker?.report.receivedOrder).toBe('Lead assigns renderer work.');
    expect(worker?.report.artifacts.map((artifact) => artifact.title)).toEqual([
      'Worker Renderer Output',
      'Private scratch',
    ]);
    expect(worker?.report.timeline.map((item) => [item.kind, item.text])).toEqual([
      ['prompt', 'Build the renderer slice.'],
      ['tool', 'Edit: patched'],
      ['answer', 'Renderer slice is in progress.'],
      ['message', 'Lead assigns renderer work.'],
      ['message', 'Worker reports renderer progress.'],
      ['message', 'Worker one shares reusable notes.'],
    ]);
  });

  it('keeps live repair boards running and excludes role materialization context from produced artifacts', () => {
    const repairState = initialOrchestrationState('run-1', 'leadEngineer', {
      testBoardId: 'test-1',
      stage: 'repair',
    });
    const model = buildRunViewModel({
      runId: 'run-1',
      boards: [
        roleBoard('repair-1', repairState, { status: 'streaming' }),
      ],
      contextBlocks: [{
        blockId: 'role:repair-1',
        scope: 'leadEngineer',
        title: 'Lead Engineer Repair',
        content: 'Role instructions, not a produced artifact.',
        payload: payload('test-1', 'repair-1', 'leadEngineer', 'repair'),
      }],
      messages: [{
        id: 'm-repair',
        seq: 1,
        kind: 'role-materialized',
        sourceBoardId: 'test-1',
        targetBoardId: 'repair-1',
        correlationId: 'role:repair-1',
        text: 'Repair this failure.',
        payload: payload('test-1', 'repair-1', 'leadEngineer', 'repair'),
      }],
    });

    const repair = model.cards.find((card) => card.boardId === 'repair-1');
    expect(repair?.status).toBe('running');
    expect(repair?.report.status).toBe('running');
    expect(repair?.report.artifacts).toEqual([]);
  });
});
