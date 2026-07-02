import { describe, expect, it, vi } from 'vitest';
import type { BoardLike } from '../shared/board';
import { captureWorkPackagesFromBoard } from './aggregate';
import { ORCHESTRATION_PLUGIN_ID, initialOrchestrationState } from './model';

describe('orchestration aggregate capture', () => {
  it('captures current lead work packages instead of replaying a stale aggregate package list', async () => {
    const events: any[] = [{
      version: 1,
      seq: 1,
      kind: 'orchestration-work-packages',
      payload: {
        version: 1,
        type: 'work-packages',
        sourceBoardId: 'lead-1',
        packages: [{ id: 'wp1', title: 'Old package', scope: 'Old scope' }],
      },
    }];
    const api = {
      appendPluginEvent: vi.fn(async (pluginId: string, aggregateId: string, event: any) => {
        events.push({ version: 1, seq: events.length + 1, kind: event.kind, payload: event.payload });
        return { pluginId, aggregateId, seq: events.length };
      }),
      readPluginAggregate: vi.fn(async (pluginId: string, aggregateId: string) => ({ pluginId, aggregateId, version: 1, events })),
      readAggregateRun: vi.fn(),
      readAggregateContext: vi.fn(),
    };
    const board: BoardLike = {
      prompt: 'split the work',
      answer: '- WP2: New package - Change the new code path',
      status: 'done',
      elements: {},
    };
    const state = initialOrchestrationState('run-1', 'leadEngineer', { stage: 'execution' });

    const packages = await captureWorkPackagesFromBoard(api as any, 'lead-1', board, state);

    expect(packages).toEqual([{ id: 'wp2', title: 'New package', scope: 'Change the new code path' }]);
    expect(api.appendPluginEvent).toHaveBeenCalledWith(
      ORCHESTRATION_PLUGIN_ID,
      'run-1',
      expect.objectContaining({
        kind: 'orchestration-work-packages',
        payload: expect.objectContaining({
          packages: [{ id: 'wp2', title: 'New package', scope: 'Change the new code path' }],
        }),
      }),
    );
  });
});
