import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_ROLES,
  asOrchestrationState,
  initialOrchestrationState,
  parseOrchestrationDecision,
  parseWorkPackages,
  roleLabel,
  routeRolesForDecision,
  upsertRole,
} from './model';

describe('orchestration role model', () => {
  it('defines every MVP role with stable identifiers', () => {
    expect(ORCHESTRATION_ROLES).toEqual([
      'architect',
      'leadEngineer',
      'workerEngineer',
      'testEngineer',
      'reviewer',
    ]);
    expect(roleLabel('leadEngineer')).toBe('Lead Engineer');
    expect(roleLabel('workerEngineer')).toBe('Worker Engineer');
  });

  it('normalizes plugin-owned state and rejects malformed roles', () => {
    const state = initialOrchestrationState('run-1', 'architect', { planId: 'demo-plan' });
    expect(asOrchestrationState(state)).toMatchObject({ runId: 'run-1', role: 'architect', planId: 'demo-plan' });
    expect(asOrchestrationState({ runId: 'run-1', role: 'codex' })).toBeUndefined();
    expect(asOrchestrationState({ role: 'architect' })).toBeUndefined();
  });

  it('updates role without losing the run identity or plan binding', () => {
    const state = initialOrchestrationState('run-1', 'architect', { planId: 'demo-plan' });
    expect(upsertRole(state, 'reviewer')).toMatchObject({
      runId: 'run-1',
      role: 'reviewer',
      planId: 'demo-plan',
    });
  });

  it('parses explicit work packages and falls back to a safe single package', () => {
    const parsed = parseWorkPackages(`
## Work Packages
- WP1: Renderer cleanup - files under src/webview
- WP2: Tests - plugin runtime tests
`);
    expect(parsed).toEqual([
      { id: 'wp1', title: 'Renderer cleanup', scope: 'files under src/webview' },
      { id: 'wp2', title: 'Tests', scope: 'plugin runtime tests' },
    ]);

    expect(parseWorkPackages('No split here')).toEqual([
      {
        id: 'wp1',
        title: 'Current phase implementation',
        scope: 'Use the Lead Engineer report as the package brief. Stop and report if the scope is not safely parallelizable.',
      },
    ]);
  });

  it('parses dynamic orchestration decisions without inventing packages', () => {
    const decision = parseOrchestrationDecision(`
## Orchestration Decision
Route: parallel-workers
Plan: demo-plan
Rationale: UI and test work can proceed independently.
Next: Worker Engineer boards

## Work Packages
- WP1: UI route display - plugins/builtin/orchestration/index.tsx
- WP2: Decision tests - plugins/builtin/orchestration/model.test.ts
`);

    expect(decision).toMatchObject({
      route: 'parallel-workers',
      planId: 'demo-plan',
      rationale: 'UI and test work can proceed independently',
      workPackages: [
        { id: 'wp1', title: 'UI route display', scope: 'plugins/builtin/orchestration/index.tsx' },
        { id: 'wp2', title: 'Decision tests', scope: 'plugins/builtin/orchestration/model.test.ts' },
      ],
    });
    expect(routeRolesForDecision(decision!)).toEqual(['workerEngineer']);

    const single = parseOrchestrationDecision(`
## Orchestration Decision
Route: single lead
Rationale: The current phase is narrow.
`);
    expect(single).toMatchObject({ route: 'single-lead', workPackages: [] });
    expect(routeRolesForDecision(single!)).toEqual(['leadEngineer']);
  });

  it('normalizes state with a current orchestration decision', () => {
    const state = initialOrchestrationState('run-1', 'architect', {
      decision: {
        route: 'test-gate',
        rationale: 'Implementation already exists and needs validation.',
        workPackages: [],
      },
    });
    expect(asOrchestrationState(state)?.decision).toMatchObject({
      route: 'test-gate',
      rationale: 'Implementation already exists and needs validation.',
    });
  });

  it('does not treat an unfilled route-choice template as a decision', () => {
    expect(parseOrchestrationDecision(`
## Orchestration Decision
Route: single-lead | parallel-workers | test-gate | review | blocked
Plan: <plan-id or none>
Rationale: <why this route fits the current task>
Next: <visible role board(s) the plugin should create>
`)).toBeUndefined();
  });

  it('only takes decision work packages from the Work Packages section', () => {
    const decision = parseOrchestrationDecision(`
- Maybe package-looking bullet - but this is just prose

## Orchestration Decision
Route: parallel-workers
Rationale: Real split comes below.

## Work Packages
- WP1: Real package - owned scope
`);
    expect(decision?.workPackages).toEqual([
      { id: 'wp1', title: 'Real package', scope: 'owned scope' },
    ]);
  });
});
