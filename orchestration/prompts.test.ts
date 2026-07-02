import { describe, expect, it } from 'vitest';
import { initialOrchestrationState, workerReports } from './model';
import { architectPrompt, integrationPrompt, leadPrompt, reviewPrompt, roleContextText, testPrompt, workerPrompt } from './prompts';

describe('orchestration prompts', () => {
  it('keeps Architect planning-only and names the visible-board contract', () => {
    const prompt = architectPrompt({ prompt: 'build feature', answer: 'needs plan' }, 'run-1');
    expect(prompt).toContain('Act as Architect');
    expect(prompt).toContain('Do not implement code in this role');
    expect(prompt).toContain('visible Braid board agent');
    expect(prompt).toContain('.braid/plans/<name>/');
    expect(prompt).toContain('## Orchestration Decision');
    expect(prompt).toContain('Route: single-lead | parallel-workers | test-gate | review | blocked');
    expect(prompt).toContain('The route must reflect the best next step for this task');
  });

  it('hands plan context from Architect to Lead Engineer', () => {
    const state = initialOrchestrationState('run-1', 'architect', { planId: 'demo-plan' });
    const prompt = leadPrompt({ answer: 'Plan id: demo-plan' }, state);
    expect(prompt).toContain('Act as Lead Engineer');
    expect(prompt).toContain('.braid/plans/demo-plan/');
    expect(prompt).toContain('## Work Packages');
  });

  it('scopes worker prompts to a package and requires coordination for shared resources', () => {
    const state = initialOrchestrationState('run-1', 'leadEngineer', { planId: 'demo-plan' });
    const prompt = workerPrompt({ answer: 'Lead brief' }, state, { id: 'wp1', title: 'UI slice', scope: 'src/webview only' });
    expect(prompt).toContain('Act as Worker Engineer for wp1: UI slice');
    expect(prompt).toContain('Scope: src/webview only');
    expect(prompt).toContain('coordinate/wait');
  });

  it('builds fan-in, test, and review prompts from visible board reports', () => {
    const state = initialOrchestrationState('run-1', 'leadEngineer', {
      planId: 'demo-plan',
      workerBoardIds: ['b1'],
      workPackages: [{ id: 'wp1', title: 'UI slice', scope: 'src/webview only' }],
    });
    const reports = workerReports([
      {
        boardId: 'b1',
        board: {
          status: 'done',
          answer: 'Completed worker',
          elements: { orchestration: initialOrchestrationState('run-1', 'workerEngineer', { packageId: 'wp1' }) },
        },
      },
    ], state);
    expect(integrationPrompt({ answer: 'Lead split' }, reports, state)).toContain('Worker reports:');
    expect(testPrompt({ answer: 'Integrated' }, state)).toContain('Act as Test Engineer');
    expect(reviewPrompt({ answer: 'Tests passed' }, state)).toContain('Act as Reviewer / Architect');
  });

  it('injects role context for bound orchestration boards', () => {
    const text = roleContextText(initialOrchestrationState('run-1', 'reviewer', {
      planId: 'demo-plan',
      decision: {
        route: 'review',
        rationale: 'Tests passed and final fit needs audit.',
        workPackages: [],
      },
    }));
    expect(text).toContain('Role: Reviewer');
    expect(text).toContain('Plan id: demo-plan');
    expect(text).toContain('Decision route: Review');
    expect(text).toContain('Decision rationale: Tests passed and final fit needs audit.');
    expect(text).toContain('produce the user report only after verification');
  });
});
