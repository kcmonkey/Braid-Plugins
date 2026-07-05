import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardLike } from '../shared/board';
import {
  applyOrchestrationDecision,
  applyRecordedOrchestrationDecision,
  buildOrchestrationRunViewModelFromSnapshot,
  CardTableau,
  isSelectableCard,
  materializeManualOrchestrationArchetype,
  materializeOrchestrationRoleBoard,
  readOrchestrationRunSnapshot,
  readOrchestrationRunViewModel,
  SteeringControls,
} from './index';
import { ORCHESTRATION_PLUGIN_ID, ORCHESTRATION_ROLES, initialOrchestrationState, type OrchestrationDecision } from './model';

function api(boardId = 'child-1') {
  const events: any[] = [];
  const blocks: any[] = [];
  return {
    events,
    materializeBoard: vi.fn(async () => ({ boardId, started: true, rolledBack: false })),
    rollbackMaterializedBoard: vi.fn(() => true),
    patchBoard: vi.fn(),
    appendPluginEvent: vi.fn(async (pluginId: string, aggregateId: string, event: any) => {
      events.push({ version: 1, seq: events.length + 1, kind: event.kind, payload: event.payload });
      return { pluginId, aggregateId, seq: events.length };
    }),
    readPluginAggregate: vi.fn(async (pluginId: string, aggregateId: string) => ({ pluginId, aggregateId, version: 1, events })),
    updateAggregateRun: vi.fn(async (update: any) => ({ snapshot: { version: 1, pluginId: update.pluginId, aggregateId: update.aggregateId, boardIds: update.boardIds ?? [], events: [] } })),
    readAggregateRun: vi.fn(async (pluginId: string, aggregateId: string) => ({ pluginId, aggregateId, snapshot: { version: 1, pluginId, aggregateId, boardIds: [boardId], events: [] } })),
    writeAggregateContext: vi.fn(async (block: any) => {
      blocks.push(block);
      return { block };
    }),
    readAggregateContext: vi.fn(async (pluginId: string, aggregateId: string, scope?: string) => ({ pluginId, aggregateId, blocks: scope ? blocks.filter((b) => b.scope === scope) : blocks })),
    sendBoardMessage: vi.fn(async (message: any) => ({ message: { ...message, version: 1, id: 'm1', seq: 1, sourceCanvasId: 'c', targetCanvasId: 'c', status: 'undelivered', createdAt: 'now' } })),
    readBoardMessages: vi.fn(async (pluginId: string, aggregateId: string) => ({ pluginId, aggregateId, messages: [] })),
    upsertGraphProjectionEdge: vi.fn(() => ({ edgeId: 'projection-1' })),
  };
}

describe('orchestration cutover', () => {
  it('materializes role boards through the core materialization transaction and records aggregate workflow state', async () => {
    const fake = api('lead-1');
    const state = initialOrchestrationState('run-1', 'leadEngineer', { planId: 'plan-a', stage: 'execution' });

    const id = await materializeOrchestrationRoleBoard(fake as any, 'architect-1', state, 'lead prompt');

    expect(id).toBe('lead-1');
    expect(fake.materializeBoard).toHaveBeenCalledWith({
      parentBoardId: 'architect-1',
      select: true,
      prompt: 'lead prompt',
      rollbackOnStartFailure: true,
      data: {
        elements: {
          [ORCHESTRATION_PLUGIN_ID]: state,
        },
      },
    });
    expect(fake.updateAggregateRun).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: ORCHESTRATION_PLUGIN_ID,
      aggregateId: 'run-1',
      status: 'running',
      boardIds: ['lead-1'],
    }));
    expect(fake.writeAggregateContext).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: ORCHESTRATION_PLUGIN_ID,
      aggregateId: 'run-1',
      blockId: 'role:lead-1',
      scope: 'leadEngineer',
    }));
    expect(fake.sendBoardMessage).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: ORCHESTRATION_PLUGIN_ID,
      aggregateId: 'run-1',
      sourceBoardId: 'architect-1',
      targetBoardId: 'lead-1',
      correlationId: 'role:lead-1',
    }));
    expect(fake.upsertGraphProjectionEdge).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: ORCHESTRATION_PLUGIN_ID,
      overlayKind: 'role-materialized',
      sourceBoardId: 'architect-1',
      targetBoardId: 'lead-1',
    }));
    expect(fake.readAggregateRun).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1');
    expect(fake.readAggregateContext).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1', 'leadEngineer');
  });

  it('fails role materialization when authoritative aggregate recording fails', async () => {
    const fake = api('lead-1');
    fake.updateAggregateRun.mockResolvedValueOnce({ error: 'store unavailable' });
    const state = initialOrchestrationState('run-1', 'leadEngineer', { planId: 'plan-a', stage: 'execution' });

    await expect(materializeOrchestrationRoleBoard(fake as any, 'architect-1', state, 'lead prompt')).rejects.toThrow(/store unavailable/);
    expect(fake.rollbackMaterializedBoard).toHaveBeenCalledWith('lead-1');
    expect(fake.writeAggregateContext).not.toHaveBeenCalled();
  });

  it('does not mutate architect state when no decision can be recorded or replayed', async () => {
    const fake = api('lead-1');
    const board: BoardLike = {
      prompt: 'build feature',
      answer: '',
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning', architectBoardId: 'architect-1' });

    await expect(applyRecordedOrchestrationDecision(fake as any, 'architect-1', board, state)).resolves.toBe(false);

    expect(fake.patchBoard).not.toHaveBeenCalled();
    expect(fake.materializeBoard).not.toHaveBeenCalled();
  });

  it('applies a decision through materialized boards and stores the new board id as projection state', async () => {
    const fake = api('lead-1');
    const board: BoardLike = {
      prompt: 'build feature',
      answer: 'Plan id: plan-a',
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning', architectBoardId: 'architect-1' });
    const decision: OrchestrationDecision = { route: 'single-lead', planId: 'plan-a', workPackages: [] };

    await applyOrchestrationDecision(fake as any, 'architect-1', board, state, decision);

    expect(fake.materializeBoard).toHaveBeenCalledTimes(1);
    expect(fake.materializeBoard.mock.calls[0][0]).toEqual(expect.objectContaining({
      parentBoardId: 'architect-1',
      rollbackOnStartFailure: true,
    }));
    expect(fake.patchBoard).toHaveBeenCalledWith('architect-1', {
      elements: {
        [ORCHESTRATION_PLUGIN_ID]: expect.objectContaining({
          runId: 'run-1',
          role: 'architect',
          leadBoardId: 'lead-1',
          planId: 'plan-a',
        }),
      },
    });
  });

  it('applies a recorded aggregate decision without reading the board answer as the route source', async () => {
    const fake = api('lead-1');
    const board: BoardLike = {
      prompt: 'build feature',
      answer: '',
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning', architectBoardId: 'architect-1' });
    const decision: OrchestrationDecision = { route: 'single-lead', planId: 'plan-a', workPackages: [] };
    fake.events.push({
      version: 1,
      seq: 1,
      kind: 'orchestration-decision',
      payload: { version: 1, type: 'decision', sourceBoardId: 'architect-1', decision },
    });

    await expect(applyRecordedOrchestrationDecision(fake as any, 'architect-1', board, state)).resolves.toBe(true);

    expect(fake.readPluginAggregate).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1');
    expect(fake.materializeBoard).toHaveBeenCalledTimes(1);
    expect(fake.patchBoard).toHaveBeenCalledWith('architect-1', {
      elements: {
        [ORCHESTRATION_PLUGIN_ID]: expect.objectContaining({
          runId: 'run-1',
          role: 'architect',
          leadBoardId: 'lead-1',
          planId: 'plan-a',
        }),
      },
    });
  });

  it('captures the current architect answer instead of replaying a stale aggregate decision', async () => {
    const fake = api('lead-1');
    const board: BoardLike = {
      prompt: 'build feature',
      answer: [
        '## Orchestration Decision',
        'Route: single-lead',
        'Plan: plan-new',
      ].join('\n'),
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning', architectBoardId: 'architect-1' });
    fake.events.push({
      version: 1,
      seq: 1,
      kind: 'orchestration-decision',
      payload: {
        version: 1,
        type: 'decision',
        sourceBoardId: 'architect-1',
        decision: { route: 'blocked', rationale: 'old answer', workPackages: [] },
      },
    });

    await expect(applyRecordedOrchestrationDecision(fake as any, 'architect-1', board, state)).resolves.toBe(true);

    expect(fake.appendPluginEvent).toHaveBeenCalledWith(
      ORCHESTRATION_PLUGIN_ID,
      'run-1',
      expect.objectContaining({
        kind: 'orchestration-decision',
        payload: expect.objectContaining({
          decision: expect.objectContaining({ route: 'single-lead', planId: 'plan-new' }),
        }),
      }),
    );
    expect(fake.materializeBoard).toHaveBeenCalledTimes(1);
  });

  it('reads live run data into the card tableau view-model without scripted mockup data', async () => {
    const architectState = initialOrchestrationState('run-1', 'architect', { stage: 'planning' });
    const leadState = initialOrchestrationState('run-1', 'leadEngineer', { stage: 'execution', architectBoardId: 'architect-1' });
    const workerState = initialOrchestrationState('run-1', 'workerEngineer', { stage: 'worker', leadBoardId: 'lead-1', packageTitle: 'Renderer' });
    const boards = new Map<string, BoardLike>([
      ['architect-1', { prompt: 'start', answer: 'route', status: 'done', elements: { [ORCHESTRATION_PLUGIN_ID]: architectState } }],
      ['lead-1', { prompt: 'lead', answer: 'spawn workers', status: 'done', elements: { [ORCHESTRATION_PLUGIN_ID]: leadState } }],
      ['worker-1', { prompt: 'work', answer: '', status: 'streaming', elements: { [ORCHESTRATION_PLUGIN_ID]: workerState } }],
    ]);
    const fake = {
      readAggregateRun: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        snapshot: { version: 1, pluginId, aggregateId, boardIds: ['architect-1', 'lead-1', 'worker-1'], events: [] },
      })),
      readAggregateContext: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        blocks: [{
          version: 1,
          pluginId,
          aggregateId,
          blockId: 'role:worker-1',
          scope: 'workerEngineer',
          title: 'Worker output',
          content: 'worker notes',
          updatedAt: 'now',
          payload: { runId: 'run-1', parentBoardId: 'lead-1', boardId: 'worker-1', role: 'workerEngineer', stage: 'worker', packageTitle: 'Renderer' },
        }],
      })),
      readBoardMessages: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        messages: [{
          version: 1,
          id: 'm1',
          seq: 1,
          pluginId,
          aggregateId,
          sourceCanvasId: 'c',
          targetCanvasId: 'c',
          sourceBoardId: 'lead-1',
          targetBoardId: 'worker-1',
          correlationId: 'role:worker-1',
          kind: 'role-materialized',
          status: 'undelivered',
          createdAt: 'now',
          text: 'Lead assigns renderer work.',
          payload: { runId: 'run-1', parentBoardId: 'lead-1', boardId: 'worker-1', role: 'workerEngineer', stage: 'worker' },
        }],
      })),
      listGraphProjectionEdges: vi.fn(() => [{
        edgeId: 'e1',
        pluginId: ORCHESTRATION_PLUGIN_ID,
        overlayKind: 'role-materialized',
        sourceBoardId: 'lead-1',
        targetBoardId: 'worker-1',
        payload: { runId: 'run-1', parentBoardId: 'lead-1', boardId: 'worker-1', role: 'workerEngineer', stage: 'worker' },
      }]),
      listBoards: vi.fn(() => [...boards].map(([boardId, board]) => ({ boardId, board }))),
      getBoard: vi.fn((boardId: string) => boards.get(boardId)),
    };

    const model = await readOrchestrationRunViewModel(fake as any, 'lead-1', boards.get('lead-1')!, leadState);

    expect(fake.readAggregateRun).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1');
    expect(fake.readAggregateContext).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1');
    expect(fake.readBoardMessages).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID, 'run-1');
    expect(fake.listGraphProjectionEdges).toHaveBeenCalledWith(ORCHESTRATION_PLUGIN_ID);
    expect(model?.cards.map((card) => [card.boardId, card.parentBoardId, card.status])).toEqual([
      ['architect-1', undefined, 'delivered'],
      ['lead-1', undefined, 'delivered'],
      ['worker-1', 'lead-1', 'running'],
    ]);
    expect(model?.cards.find((card) => card.boardId === 'worker-1')?.report.receivedOrder).toBe('Lead assigns renderer work.');
  });

  it('separates aggregate reads from live board rebuilds so streaming updates do not refetch the run', async () => {
    const leadState = initialOrchestrationState('run-1', 'leadEngineer', { stage: 'execution' });
    const workerState = initialOrchestrationState('run-1', 'workerEngineer', { stage: 'repair', leadBoardId: 'lead-1', packageTitle: 'Repair' });
    const boards = new Map<string, BoardLike>([
      ['lead-1', { prompt: 'lead', answer: 'repair', status: 'done', elements: { [ORCHESTRATION_PLUGIN_ID]: leadState } }],
      ['worker-1', { prompt: 'repair', answer: '', status: 'streaming', elements: { [ORCHESTRATION_PLUGIN_ID]: workerState } }],
    ]);
    const fake = {
      readAggregateRun: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        snapshot: { version: 1, pluginId, aggregateId, boardIds: ['lead-1', 'worker-1'], events: [] },
      })),
      readAggregateContext: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        blocks: [],
      })),
      readBoardMessages: vi.fn(async (pluginId: string, aggregateId: string) => ({
        pluginId,
        aggregateId,
        messages: [{
          version: 1,
          id: 'm1',
          seq: 1,
          pluginId,
          aggregateId,
          sourceCanvasId: 'c',
          targetCanvasId: 'c',
          sourceBoardId: 'lead-1',
          targetBoardId: 'worker-1',
          correlationId: 'role:worker-1',
          kind: 'role-materialized',
          status: 'undelivered',
          createdAt: 'now',
          text: 'Lead asks for repair.',
          payload: { runId: 'run-1', parentBoardId: 'lead-1', boardId: 'worker-1', role: 'workerEngineer', stage: 'repair' },
        }],
      })),
      listGraphProjectionEdges: vi.fn(() => []),
      listBoards: vi.fn(() => [...boards].map(([boardId, board]) => ({ boardId, board }))),
      getBoard: vi.fn((boardId: string) => boards.get(boardId)),
    };

    const snapshot = await readOrchestrationRunSnapshot(fake as any, leadState);
    const first = buildOrchestrationRunViewModelFromSnapshot(fake as any, 'lead-1', boards.get('lead-1')!, leadState, snapshot);

    boards.set('worker-1', { ...boards.get('worker-1')!, status: 'done', answer: 'Repair delivered.' });
    const second = buildOrchestrationRunViewModelFromSnapshot(fake as any, 'lead-1', boards.get('lead-1')!, leadState, snapshot);

    expect(fake.readAggregateRun).toHaveBeenCalledTimes(1);
    expect(fake.readAggregateContext).toHaveBeenCalledTimes(1);
    expect(fake.readBoardMessages).toHaveBeenCalledTimes(1);
    expect(first?.cards.find((card) => card.boardId === 'worker-1')?.status).toBe('running');
    expect(second?.cards.find((card) => card.boardId === 'worker-1')?.status).toBe('delivered');
  });

  it('renders view-model bubbles, speech tails, peer links, and scoped-intel wires from live model data', () => {
    const html = renderToStaticMarkup(
      <CardTableau
        initialSelectedId="lead-1"
        model={{
          runId: 'run-1',
          focusedBoardId: 'lead-1',
          cards: [{
            boardId: 'lead-1',
            runId: 'run-1',
            role: 'leadEngineer',
            roleLabel: 'Lead Engineer',
            stage: 'execution',
            stageLabel: 'Execution',
            title: 'Lead Engineer',
            status: 'delivered',
            statusLabel: '已交付',
            report: {
              status: 'delivered',
              statusLabel: '已交付',
              receivedOrder: 'Architect summons Lead.',
              artifacts: [{ blockId: 'artifact:lead', title: 'Integration Report', scope: 'leadEngineer', content: 'Integrated worker outputs.' }],
              timeline: [{ id: 'step:1', kind: 'message', text: 'Lead received order.', seq: 1 }],
            },
          }],
          scopedIntel: [
            { blockId: 'run:brief', title: 'Run Brief', tier: 'run-wide', content: 'Shared run context.' },
            { blockId: 'role:worker', title: 'Worker Notes', tier: 'role-scoped', scope: 'workerEngineer', producerBoardId: 'worker-1', producerRole: 'workerEngineer', content: 'Worker output context.' },
            { blockId: 'private:lead', title: 'Lead Scratch', tier: 'private', scope: 'board:lead-1', producerBoardId: 'lead-1', producerRole: 'leadEngineer', content: 'Private notes.' },
          ],
          bubbles: [
            { id: 'order-1', kind: 'order', relation: 'down', text: 'Assign work', sourceBoardId: 'lead-1', targetBoardId: 'worker-1', seq: 1 },
            { id: 'report-1', kind: 'report', relation: 'up', text: 'Report back', sourceBoardId: 'lead-1', targetBoardId: 'architect-1', seq: 2 },
            { id: 'verdict-1', kind: 'verdict', relation: 'up', text: 'Needs repair', sourceBoardId: 'lead-1', targetBoardId: 'test-1', seq: 3 },
            { id: 'peer-1', kind: 'peer', relation: 'peer', text: 'Peer note', sourceBoardId: 'lead-1', targetBoardId: 'worker-2', seq: 4 },
            { id: 'loose-1', kind: 'peer', relation: 'peer', text: 'Outside source', targetBoardId: 'lead-1', seq: 5 },
          ],
        }}
      />,
    );

    expect(html).toContain('orchestration-card-speech-anchor');
    expect(html).toContain('mc speaking');
    expect(html).toContain('THE LIEUTENANT');
    expect(html).toContain('orchestration-balloon--order');
    expect(html).toContain('orchestration-balloon--report');
    expect(html).toContain('orchestration-balloon--verdict');
    expect(html).toContain('orchestration-balloon--peer');
    expect(html).toContain('orchestration-balloon--down');
    expect(html).toContain('orchestration-balloon--up');
    expect(html).toContain('balloon');
    expect(html).toContain('balloon__tail');
    expect(html).toContain('orchestration-peerlink');
    expect(html).toContain('peerlink');
    expect(html).toContain('peerlink__b');
    expect(html).toContain('orchestration-speech-loose');
    // The org-chart command tree lives in a dedicated scroll container so a wide hierarchy
    // scrolls instead of clipping/exploding the panel (Phase 21: overflowX/Y → overflow:auto).
    expect(html).toContain('orchestration-tree-scroll');
    expect(html).toContain('Outside source');
    expect(html).toContain('orchestration-wires');
    expect(html).toContain('class="wire in orchestration-wire');
    expect(html).toContain('data-producer="worker-1"');
    expect(html).toContain('data-reader="lead-1"');
    expect(html).toContain('orchestration-intel-slot');
    expect(html).toContain('orchestration-intel');
    expect(html).toContain('orchestration-intel__title');
    expect(html).toContain('orchestration-tier--global');
    expect(html).toContain('orchestration-tier--squad');
    expect(html).toContain('orchestration-tier--unit');
    expect(html).toContain('orchestration-cardx');
    expect(html).toContain('orchestration-cardx__scope');
    expect(html).toContain('orchestration-cardx__producer');
    expect(html).toContain('orchestration-cardx__read');
    expect(html).toContain('sc-global');
    expect(html).toContain('sc-squad');
    expect(html).toContain('sc-unit');
    expect(html).toContain('max-height:76px');
    expect(html).toContain('overflow:auto');
    expect(html).toContain('Worker Engineer');
    expect(html).toContain('Worker output context.');
    expect(html).toContain('orchestration-modal');
    expect(html).toContain('modal on');
    expect(html).toContain('orchestration-sheet');
    expect(html).toContain('sheet__info');
    expect(html).toContain('orchestration-dossier');
    expect(html).toContain('orchestration-dossier__status');
    expect(html).toContain('orchestration-dossier__kv');
    expect(html).toContain('orchestration-dossier__artifact');
    expect(html).toContain('orchestration-dossier__step');
    expect(html).toContain('Architect summons Lead.');
    expect(html).toContain('Integration Report');
    expect(html).toContain('Lead received order.');
    expect(html).not.toContain('orchestration-report');
    expect(html).not.toContain('orchestration-bubble-stack');
    expect(html).not.toContain('orchestration-bubbles-loose');
    expect(html).not.toContain('orchestration-mini-card__portrait');

    const emptyHtml = renderToStaticMarkup(
      <CardTableau
        initialSelectedId="empty-1"
        model={{
          runId: 'run-empty',
          focusedBoardId: 'empty-1',
          cards: [{
            boardId: 'empty-1',
            runId: 'run-empty',
            role: 'workerEngineer',
            roleLabel: 'Worker Engineer',
            stage: 'worker',
            stageLabel: 'Worker',
            title: 'Worker Engineer',
            status: 'queued',
            statusLabel: '待命',
            report: { status: 'queued', statusLabel: '待命', artifacts: [], timeline: [] },
          }],
          scopedIntel: [],
          bubbles: [],
        }}
      />,
    );
    expect(emptyHtml).toContain('No received order recorded.');
    expect(emptyHtml).toContain('No produced artifacts recorded.');
    expect(emptyHtml).toContain('No action timeline recorded.');
  });

  it('renders Table, Deck, and Debug modes with archetype card primitives and full debug details', () => {
    const timeline = Array.from({ length: 10 }, (_, index) => ({
      id: `debug-step-${index + 1}`,
      kind: index % 2 ? 'tool' as const : 'message' as const,
      text: `debug timeline step ${index + 1}`,
      seq: index + 1,
    }));
    const html = renderToStaticMarkup(
      <CardTableau
        model={{
          runId: 'run-debug',
          focusedBoardId: 'lead-debug',
          cards: [{
            boardId: 'lead-debug',
            runId: 'run-debug',
            role: 'leadEngineer',
            roleLabel: 'Lead Engineer',
            stage: 'execution',
            stageLabel: 'Execution',
            title: 'Lead Engineer',
            status: 'running',
            statusLabel: '执行中',
            report: {
              status: 'running',
              statusLabel: '执行中',
              receivedOrder: 'Long architect order that must remain inspectable in Debug mode.',
              artifacts: [{
                blockId: 'artifact:long',
                title: 'Long Artifact',
                scope: 'leadEngineer',
                content: 'Full produced artifact text that must not disappear behind the card view preview.',
              }],
              timeline,
            },
          }],
          scopedIntel: [],
          bubbles: [],
        }}
      />,
    );

    expect(html).toContain('orchestration-mode-switch');
    expect(html).toContain('orchestration-mode-table');
    expect(html).toContain('orchestration-mode-deck');
    expect(html).toContain('orchestration-mode-debug');
    expect(html).toContain('牌桌');
    expect(html).toContain('牌库');
    expect(html).toContain('MISSION');
    expect(html).toContain('orchestration-mission');
    expect(html).toContain('orchestration-command-stage');
    expect(html).toContain('orchestration-tree');
    expect(html).toContain('orchestration-intel-slot');
    expect(html).toContain('class="mc orchestration-card');
    expect(html).toContain('mc__art');
    expect(html).toContain('class="pf"');
    expect(html).toContain('class="gr"');
    expect(html).toContain('class="vg"');
    expect(html).toContain('class="gem"');
    expect(html).toContain('mc__stat');
    expect(html).toContain('ss-work');
    expect(html).toContain('THE LIEUTENANT');
    expect(html).toContain('工程大档');
    expect(html).toContain('orchestration-debug');
    expect(html).toContain('overflow:auto');
    expect(html).toContain('lead-debug');
    expect(html).toContain('Long architect order that must remain inspectable in Debug mode.');
    expect(html).toContain('Full produced artifact text that must not disappear behind the card view preview.');
    expect(html).toContain('debug timeline step 10');
    expect(html).not.toContain('plan-panel nodrag nopan orchestration-tableau');
    expect(html).not.toContain('orchestration-mini-card__portrait');
    expect(html).not.toContain('♜');
    expect(html).not.toContain('◆');
  });

  it('projects all canonical and manual deck identities without expanding engine roles', () => {
    const html = renderToStaticMarkup(
      <CardTableau
        model={{
          runId: 'run-deck',
          focusedBoardId: 'architect-1',
          cards: [
            {
              boardId: 'architect-1',
              runId: 'run-deck',
              role: 'architect',
              roleLabel: 'Architect',
              stage: 'planning',
              stageLabel: 'Planning',
              title: 'Architect',
              status: 'queued',
              statusLabel: '待命',
              report: { status: 'queued', statusLabel: '待命', artifacts: [], timeline: [] },
            },
            {
              boardId: 'worker-1',
              runId: 'run-deck',
              role: 'workerEngineer',
              roleLabel: 'Worker Engineer',
              stage: 'worker',
              stageLabel: 'Worker',
              title: 'Worker Engineer',
              status: 'delivered',
              statusLabel: '已交付',
              report: { status: 'delivered', statusLabel: '已交付', artifacts: [], timeline: [] },
            },
            {
              boardId: 'test-1',
              runId: 'run-deck',
              role: 'testEngineer',
              roleLabel: 'Test Engineer',
              stage: 'test',
              stageLabel: 'Test',
              title: 'Test Engineer',
              status: 'passed',
              statusLabel: '已通过',
              report: { status: 'passed', statusLabel: '已通过', artifacts: [], timeline: [] },
            },
            {
              boardId: 'review-1',
              runId: 'run-deck',
              role: 'reviewer',
              roleLabel: 'Reviewer',
              stage: 'review',
              stageLabel: 'Review',
              title: 'Reviewer',
              status: 'rejected',
              statusLabel: '需返工',
              report: { status: 'rejected', statusLabel: '需返工', artifacts: [], timeline: [] },
            },
          ],
          scopedIntel: [],
          bubbles: [],
        }}
        onPlayArchetype={() => {}}
      />,
    );

    for (const name of [
      'THE BOSS',
      'THE LIEUTENANT',
      'THE WORKHORSE',
      'THE INSPECTOR',
      'THE CONSIGLIERE',
      'THE ENFORCER',
      'THE SCOUT',
      'THE FIXER',
    ]) {
      expect(html).toContain(name);
    }
    expect(html).toContain('deck');
    expect(html).toContain('card__b');
    expect(html).toContain('card__f');
    expect(html).toContain('打出到牌桌');
    expect(html).toContain('orchestration-deck-play');
    expect(ORCHESTRATION_ROLES).toEqual(['architect', 'leadEngineer', 'workerEngineer', 'testEngineer', 'reviewer']);
  });

  it('manual archetype cards materialize through existing orchestration roles only', async () => {
    const fake = api('manual-1');
    const board: BoardLike = {
      prompt: 'ship it',
      answer: 'current run',
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning', planId: 'plan-a' });

    await materializeManualOrchestrationArchetype(fake as any, 'architect-1', board, state, 'enforcer');

    expect(fake.materializeBoard).toHaveBeenCalledTimes(1);
    const materializedState = fake.materializeBoard.mock.calls[0][0].data.elements[ORCHESTRATION_PLUGIN_ID];
    expect(materializedState).toEqual(expect.objectContaining({
      runId: 'run-1',
      role: 'reviewer',
      stage: 'review',
      packageTitle: 'THE ENFORCER',
      packageScope: '安全审计',
    }));
    expect(fake.updateAggregateRun).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: ORCHESTRATION_PLUGIN_ID,
      aggregateId: 'run-1',
      boardIds: ['manual-1'],
    }));
  });

  it('renders in-tableau steering through existing role actions and live-card stop guidance', () => {
    const state = initialOrchestrationState('run-1', 'architect', { stage: 'planning' });
    const board: BoardLike = { prompt: 'plan', answer: '', status: 'streaming', elements: { [ORCHESTRATION_PLUGIN_ID]: state } };
    const html = renderToStaticMarkup(
      <SteeringControls
        boardId="architect-1"
        board={board}
        state={state}
        api={{ getBoard: (boardId: string) => ({ status: boardId === 'worker-1' ? 'streaming' : 'done', elements: {} }) } as any}
        onOpenCard={() => {}}
        model={{
          runId: 'run-1',
          cards: [
            {
              boardId: 'architect-1',
              runId: 'run-1',
              role: 'architect',
              roleLabel: 'Architect',
              stage: 'planning',
              stageLabel: 'Planning',
              title: 'Architect',
              status: 'running',
              statusLabel: '执行中',
              report: { status: 'running', statusLabel: '执行中', artifacts: [], timeline: [] },
            },
            {
              boardId: 'worker-1',
              parentBoardId: 'architect-1',
              runId: 'run-1',
              role: 'workerEngineer',
              roleLabel: 'Worker Engineer',
              stage: 'worker',
              stageLabel: 'Worker',
              title: 'Worker Engineer',
              status: 'running',
              statusLabel: '执行中',
              report: { status: 'running', statusLabel: '执行中', artifacts: [], timeline: [] },
            },
          ],
          bubbles: [],
          scopedIntel: [],
        }}
      />,
    );

    expect(html).toContain('orchestration-steering');
    expect(html).toContain('bsteer');
    expect(html).toContain('stbtn');
    expect(html).toContain('orchestration-stbtn');
    expect(html).toContain('Apply decision');
    expect(html).toContain('disabled=""');
    expect(html).toContain('orchestration-steering-stop-note');
    expect(html).toContain('orchestration-live-card');
    expect(html).toContain('Worker Engineer');
    expect(html).toContain('worker-1');
    expect(html).toContain('Use the board');
    expect(html).toContain('Stop');
  });

  it('keeps a live card selectable but treats a deliberate close and a stale board as not selectable', () => {
    const cards = [
      { boardId: 'lead-1' },
      { boardId: 'worker-1' },
    ] as any;
    // A live selection stays open.
    expect(isSelectableCard('lead-1', cards)).toBe(true);
    // A deliberate close (undefined) must NOT be re-opened by the reset effect.
    expect(isSelectableCard(undefined, cards)).toBe(false);
    // A selection whose board vanished mid-run is cleared, not resurrected.
    expect(isSelectableCard('gone', cards)).toBe(false);
  });
});
