import type { BoardLike } from '../shared/board';
import {
  boardAnswer,
  boardPrompt,
  decisionRouteLabel,
  roleDescription,
  roleLabel,
  safePlanId,
  type OrchestrationRole,
  type OrchestrationState,
  type WorkPackage,
  type WorkerReport,
} from './model';

const COMMON = [
  '[Braid orchestration]',
  'You are running as a visible Braid board agent. Do not use hidden provider-native subagents as the primary work unit.',
  'Keep work inspectable: tool calls, file edits, approvals, failures, and reports must stay on visible boards.',
  'When work may touch shared files/resources, use the existing Braid coordinate tool before the risky action.',
].join('\n');

export function roleContextText(state: OrchestrationState): string {
  const lines = [
    COMMON,
    '',
    `Role: ${roleLabel(state.role)}`,
    `Role contract: ${roleDescription(state.role)}`,
    `Run id: ${state.runId}`,
    `Stage: ${state.stage}`,
  ];
  if (state.planId) lines.push(`Plan id: ${state.planId}`);
  if (state.decision) {
    lines.push(`Decision route: ${decisionRouteLabel(state.decision.route)}`);
    if (state.decision.rationale) lines.push(`Decision rationale: ${state.decision.rationale}`);
  }
  if (state.packageId) lines.push(`Work package: ${state.packageId} - ${state.packageTitle ?? ''}`);
  if (state.packageScope) lines.push(`Package scope: ${state.packageScope}`);
  lines.push('', roleInstructions(state.role));
  return lines.join('\n');
}

export function architectPrompt(source: BoardLike, runId: string): string {
  return [
    COMMON,
    '',
    `Run id: ${runId}`,
    'Act as Architect. Clarify the user need if required, then create or update a Braid plan under `.braid/plans/<name>/`.',
    'Use the project plan contract format. The plan must make final target, done means, gates, and out-of-scope work explicit.',
    'Do not implement code in this role. End with a structured orchestration decision that names the next visible board route.',
    '',
    'The route must reflect the best next step for this task, not a fixed role chain.',
    'Use exactly this decision section:',
    '## Orchestration Decision',
    'Route: single-lead | parallel-workers | test-gate | review | blocked',
    'Plan: <plan-id or none>',
    'Rationale: <why this route fits the current task>',
    'Next: <visible role board(s) the plugin should create>',
    '',
    'If Route is parallel-workers, also include `## Work Packages` with bullets shaped `- WP1: <title> - <scope>`.',
    '',
    'Source request/context:',
    trimBlock(`Q: ${boardPrompt(source)}\n\nA: ${boardAnswer(source)}`),
  ].join('\n');
}

export function leadPrompt(architectBoard: BoardLike, state: OrchestrationState): string {
  const plan = safePlanId(state.planId) || '<plan-id-from-architect-report>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    'Act as Lead Engineer. Read the plan contract/current phase before changing files.',
    `Plan: .braid/plans/${plan}/`,
    'Execute the current phase when it is small enough for one board. If safe parallel work exists, produce a `## Work Packages` section with bullets shaped `- WP1: <title> - <scope>` and stop after the split brief.',
    'Each package must have non-overlapping ownership or must explicitly say it requires coordination.',
    '',
    'Architect report:',
    trimBlock(boardAnswer(architectBoard)),
  ].join('\n');
}

export function workerPrompt(leadBoard: BoardLike, state: OrchestrationState, pkg: WorkPackage): string {
  const plan = safePlanId(state.planId) || '<plan-id>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    `Act as Worker Engineer for ${pkg.id}: ${pkg.title}.`,
    `Plan: .braid/plans/${plan}/`,
    `Scope: ${pkg.scope}`,
    'Stay inside the package scope. If another board owns a needed resource, coordinate/wait instead of forcing the conflict.',
    'Finish with this report shape: Completed, Files changed, Verification, Remaining/blockers.',
    '',
    'Lead brief:',
    trimBlock(boardAnswer(leadBoard)),
  ].join('\n');
}

export function integrationPrompt(leadBoard: BoardLike, reports: WorkerReport[], state: OrchestrationState): string {
  const plan = safePlanId(state.planId) || '<plan-id>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    'Act as Lead Engineer / Integrator. Read the plan, inspect worker reports, resolve integration gaps, and update the current phase gates only when verified.',
    `Plan: .braid/plans/${plan}/`,
    'If a worker failed or left a blocker, create a repair brief instead of pretending the package passed.',
    '',
    'Lead source:',
    trimBlock(boardAnswer(leadBoard)),
    '',
    'Worker reports:',
    reports.map(reportBlock).join('\n\n'),
  ].join('\n');
}

export function testPrompt(integrationBoard: BoardLike, state: OrchestrationState): string {
  const plan = safePlanId(state.planId) || '<plan-id>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    'Act as Test Engineer. Read the plan acceptance criteria, inspect the integrated changes, add or update tests, and run the targeted gates.',
    `Plan: .braid/plans/${plan}/`,
    'If tests fail, report exact failures and a repair brief. Do not produce a passing report unless commands actually passed.',
    '',
    'Integration report:',
    trimBlock(boardAnswer(integrationBoard)),
  ].join('\n');
}

export function repairPrompt(testBoard: BoardLike, state: OrchestrationState): string {
  const plan = safePlanId(state.planId) || '<plan-id>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    'Act as Lead Engineer on a repair branch. Fix only the failures reported by the Test Engineer, then rerun the relevant gates.',
    `Plan: .braid/plans/${plan}/`,
    '',
    'Test report:',
    trimBlock(boardAnswer(testBoard)),
  ].join('\n');
}

export function reviewPrompt(testBoard: BoardLike, state: OrchestrationState): string {
  const plan = safePlanId(state.planId) || '<plan-id>';
  return [
    COMMON,
    '',
    `Run id: ${state.runId}`,
    'Act as Reviewer / Architect. Read the plan, test report, and final diff. Audit requirement coverage, architecture fit, verification evidence, and remaining risk.',
    `Plan: .braid/plans/${plan}/`,
    'If the work is not acceptable, write findings and a repair brief. If acceptable, produce the final user-facing report.',
    '',
    'Test report:',
    trimBlock(boardAnswer(testBoard)),
  ].join('\n');
}

function roleInstructions(role: OrchestrationRole): string {
  switch (role) {
    case 'architect':
      return 'Architect role: clarify requirements, create/update the plan, and do not implement code unless explicitly redirected.';
    case 'leadEngineer':
      return 'Lead Engineer role: execute the plan, split safe parallel packages, integrate worker reports, and preserve plan gates.';
    case 'workerEngineer':
      return 'Worker Engineer role: execute only your scoped package and report concrete changes and verification.';
    case 'testEngineer':
      return 'Test Engineer role: add/run tests and route failures to repair instead of treating them as completion.';
    case 'reviewer':
      return 'Reviewer role: audit final fit and produce the user report only after verification is adequate.';
  }
}

function reportBlock(report: WorkerReport): string {
  const title = [report.packageId, report.packageTitle].filter(Boolean).join(' - ') || report.boardId;
  return [
    `### ${title}`,
    `Board: ${report.boardId}`,
    `Status: ${report.status}`,
    trimBlock(report.answer || '(no report yet)'),
  ].join('\n');
}

function trimBlock(text: string, cap = 6000): string {
  const t = text.trim();
  return t.length > cap ? `${t.slice(0, cap)}\n...(truncated)` : t;
}
