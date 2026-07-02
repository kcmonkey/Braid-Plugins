import type { BoardLike, TurnLike } from '../shared/board';

export const ORCHESTRATION_PLUGIN_ID = 'orchestration';

export const ORCHESTRATION_ROLES = [
  'architect',
  'leadEngineer',
  'workerEngineer',
  'testEngineer',
  'reviewer',
] as const;

export type OrchestrationRole = typeof ORCHESTRATION_ROLES[number];

export type OrchestrationStage =
  | 'intake'
  | 'planning'
  | 'execution'
  | 'worker'
  | 'integration'
  | 'test'
  | 'repair'
  | 'review'
  | 'complete'
  | 'blocked';

export interface WorkPackage {
  id: string;
  title: string;
  scope: string;
}

export const ORCHESTRATION_ROUTES = [
  'single-lead',
  'parallel-workers',
  'test-gate',
  'review',
  'blocked',
] as const;

export type OrchestrationRoute = typeof ORCHESTRATION_ROUTES[number];

export interface OrchestrationDecision {
  route: OrchestrationRoute;
  rationale?: string;
  planId?: string;
  nextRole?: OrchestrationRole;
  workPackages: WorkPackage[];
}

export interface WorkerReport {
  boardId: string;
  packageId?: string;
  packageTitle?: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'unknown';
  answer: string;
}

export interface OrchestrationState {
  runId: string;
  role: OrchestrationRole;
  stage: OrchestrationStage;
  planId?: string;
  sourceBoardId?: string;
  architectBoardId?: string;
  leadBoardId?: string;
  integrationBoardId?: string;
  testBoardId?: string;
  reviewerBoardId?: string;
  workerBoardIds?: string[];
  packageId?: string;
  packageTitle?: string;
  packageScope?: string;
  workPackages?: WorkPackage[];
  decision?: OrchestrationDecision;
  note?: string;
  completed?: boolean;
}

export function isOrchestrationRole(v: unknown): v is OrchestrationRole {
  return typeof v === 'string' && (ORCHESTRATION_ROLES as readonly string[]).includes(v);
}

export function roleLabel(role: OrchestrationRole): string {
  switch (role) {
    case 'architect': return 'Architect';
    case 'leadEngineer': return 'Lead Engineer';
    case 'workerEngineer': return 'Worker Engineer';
    case 'testEngineer': return 'Test Engineer';
    case 'reviewer': return 'Reviewer';
  }
}

export function roleDescription(role: OrchestrationRole): string {
  switch (role) {
    case 'architect': return 'Clarifies requirements, creates the plan, and reviews final fit.';
    case 'leadEngineer': return 'Executes the plan, splits safe parallel work, and integrates reports.';
    case 'workerEngineer': return 'Executes a scoped work package as a visible board.';
    case 'testEngineer': return 'Adds and runs tests against the plan acceptance criteria.';
    case 'reviewer': return 'Audits plan fit, diffs, tests, risks, and final user report.';
  }
}

export function stageLabel(stage: OrchestrationStage | undefined): string {
  switch (stage) {
    case 'intake': return 'Intake';
    case 'planning': return 'Planning';
    case 'execution': return 'Execution';
    case 'worker': return 'Worker';
    case 'integration': return 'Integration';
    case 'test': return 'Test';
    case 'repair': return 'Repair';
    case 'review': return 'Review';
    case 'complete': return 'Complete';
    case 'blocked': return 'Blocked';
    default: return 'Orchestration';
  }
}

export function decisionRouteLabel(route: OrchestrationRoute | undefined): string {
  switch (route) {
    case 'single-lead': return 'Single Lead';
    case 'parallel-workers': return 'Parallel Workers';
    case 'test-gate': return 'Test Gate';
    case 'review': return 'Review';
    case 'blocked': return 'Blocked';
    default: return 'Decision';
  }
}

export function asOrchestrationState(s: unknown): OrchestrationState | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const raw = s as Partial<OrchestrationState>;
  if (typeof raw.runId !== 'string' || !raw.runId.trim()) return undefined;
  if (!isOrchestrationRole(raw.role)) return undefined;
  const stage = typeof raw.stage === 'string' ? raw.stage as OrchestrationStage : defaultStageForRole(raw.role);
  const out: OrchestrationState = {
    ...raw,
    runId: raw.runId,
    role: raw.role,
    stage,
  };
  if (Array.isArray(raw.workerBoardIds)) out.workerBoardIds = raw.workerBoardIds.filter((id): id is string => typeof id === 'string' && !!id.trim());
  if (Array.isArray(raw.workPackages)) out.workPackages = raw.workPackages.filter(isWorkPackage);
  const decision = asOrchestrationDecision(raw.decision);
  if (decision) out.decision = decision;
  return out;
}

export function defaultStageForRole(role: OrchestrationRole): OrchestrationStage {
  switch (role) {
    case 'architect': return 'planning';
    case 'leadEngineer': return 'execution';
    case 'workerEngineer': return 'worker';
    case 'testEngineer': return 'test';
    case 'reviewer': return 'review';
  }
}

export function initialOrchestrationState(
  runId: string,
  role: OrchestrationRole,
  patch: Partial<OrchestrationState> = {},
): OrchestrationState {
  return {
    runId,
    role,
    stage: patch.stage ?? defaultStageForRole(role),
    ...patch,
  };
}

export function upsertRole(prev: unknown, role: OrchestrationRole, patch: Partial<OrchestrationState> = {}): OrchestrationState {
  const cur = asOrchestrationState(prev);
  const runId = cur?.runId ?? patch.runId ?? newRunId();
  return {
    ...(cur ?? {}),
    ...patch,
    runId,
    role,
    stage: patch.stage ?? cur?.stage ?? defaultStageForRole(role),
  };
}

export function newRunId(now = Date.now()): string {
  return `orch-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function safePlanId(id: string | undefined): string {
  return (id ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
}

export function extractPlanId(text: string | undefined): string {
  const t = text ?? '';
  const direct = /\.braid\/plans\/([a-zA-Z0-9._-]+)/.exec(t);
  if (direct) return safePlanId(direct[1]);
  const label = /\bplan(?:Id| id| name)?\s*[:=]\s*`?([a-zA-Z0-9._-]+)`?/i.exec(t);
  return safePlanId(label?.[1]);
}

export function parseOrchestrationDecision(text: string | undefined): OrchestrationDecision | undefined {
  const source = text ?? '';
  if (!source.trim()) return undefined;
  const block = decisionBlock(source);
  const route = normalizeRouteValue(labeledValue(block, ['Route']) ?? labeledValue(source, ['Route']));
  if (!route) return undefined;
  const planId = safePlanId(
    labeledValue(block, ['Plan', 'Plan id', 'PlanId', 'Plan name'])
    ?? extractPlanId(block)
    ?? extractPlanId(source),
  );
  const rationale = compact(labeledValue(block, ['Rationale', 'Why']) ?? '');
  const nextRole = normalizeRoleValue(labeledValue(block, ['Next', 'Next role', 'Next board']));
  return {
    route,
    ...(rationale ? { rationale } : {}),
    ...(planId ? { planId } : {}),
    ...(nextRole ? { nextRole } : {}),
    workPackages: parseDecisionWorkPackages(source),
  };
}

export function routeRolesForDecision(decision: OrchestrationDecision): OrchestrationRole[] {
  switch (decision.route) {
    case 'single-lead': return ['leadEngineer'];
    case 'parallel-workers': return ['workerEngineer'];
    case 'test-gate': return ['testEngineer'];
    case 'review': return ['reviewer'];
    case 'blocked': return [];
  }
}

export function boardAnswer(board: BoardLike | undefined): string {
  if (!board) return '';
  const turns = board.turns?.length ? board.turns : [{ answer: board.answer } as TurnLike];
  return turns[turns.length - 1]?.answer ?? board.answer ?? '';
}

export function boardPrompt(board: BoardLike | undefined): string {
  if (!board) return '';
  const turns = board.turns?.length ? board.turns : [{ prompt: board.prompt } as TurnLike];
  return turns[turns.length - 1]?.prompt ?? board.prompt ?? '';
}

export function boardStatus(board: BoardLike | undefined): WorkerReport['status'] {
  const s = board?.status;
  if (s === 'done' || s === 'error' || s === 'streaming' || s === 'waiting') {
    return s === 'streaming' || s === 'waiting' ? 'running' : s;
  }
  if (s === 'idle') return 'pending';
  return 'unknown';
}

export function parseExplicitWorkPackages(text: string | undefined): WorkPackage[] {
  const lines = (text ?? '').split(/\r?\n/);
  const out: WorkPackage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = /^[-*]\s*(?:\[[ xX]\]\s*)?(?:`?((?:WP|wp)?\d+[a-zA-Z]?)`?\s*[:.)-]\s*)?(.+?)(?:\s+-\s+|\s+--\s+|\s+::\s+)(.+)$/.exec(trimmed);
    if (!m) continue;
    const id = normalizePackageId(m[1] || `wp${out.length + 1}`);
    const title = compact(m[2]);
    const scope = compact(m[3]);
    if (!title || !scope) continue;
    out.push({ id, title, scope });
  }
  return uniquePackages(out);
}

export function parseWorkPackages(text: string | undefined): WorkPackage[] {
  const parsed = parseExplicitWorkPackages(text);
  return parsed.length ? parsed : [fallbackPackage()];
}

export function workerReports(
  boards: { boardId: string; board: BoardLike }[],
  state: OrchestrationState | undefined,
): WorkerReport[] {
  const ids = state?.workerBoardIds ?? [];
  const packages = new Map((state?.workPackages ?? []).map((p) => [p.id, p]));
  return ids.map((boardId) => {
    const hit = boards.find((b) => b.boardId === boardId);
    const workerState = asOrchestrationState(hit?.board.elements?.[ORCHESTRATION_PLUGIN_ID]);
    const pkg = workerState?.packageId ? packages.get(workerState.packageId) : undefined;
    return {
      boardId,
      packageId: workerState?.packageId,
      packageTitle: workerState?.packageTitle ?? pkg?.title,
      status: boardStatus(hit?.board),
      answer: boardAnswer(hit?.board),
    };
  });
}

function fallbackPackage(): WorkPackage {
  return {
    id: 'wp1',
    title: 'Current phase implementation',
    scope: 'Use the Lead Engineer report as the package brief. Stop and report if the scope is not safely parallelizable.',
  };
}

export function asOrchestrationDecision(v: unknown): OrchestrationDecision | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = v as Partial<OrchestrationDecision>;
  if (!isOrchestrationRoute(raw.route)) return undefined;
  const workPackages = Array.isArray(raw.workPackages) ? raw.workPackages.filter(isWorkPackage) : [];
  const decision: OrchestrationDecision = { route: raw.route, workPackages };
  if (typeof raw.rationale === 'string' && raw.rationale.trim()) decision.rationale = raw.rationale.trim();
  if (typeof raw.planId === 'string' && raw.planId.trim()) decision.planId = safePlanId(raw.planId);
  if (isOrchestrationRole(raw.nextRole)) decision.nextRole = raw.nextRole;
  return decision;
}

function isOrchestrationRoute(v: unknown): v is OrchestrationRoute {
  return typeof v === 'string' && (ORCHESTRATION_ROUTES as readonly string[]).includes(v);
}

function decisionBlock(text: string): string {
  return markdownSection(text, 'Orchestration Decision') ?? text;
}

function parseDecisionWorkPackages(text: string): WorkPackage[] {
  const block = markdownSection(text, 'Work Packages');
  return block ? parseExplicitWorkPackages(block) : [];
}

function markdownSection(text: string, title: string): string | undefined {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)#{1,6}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|\\s*$)`, 'i').exec(text);
  return m?.[1];
}

function labeledValue(text: string, labels: string[]): string | undefined {
  const wanted = new Set(labels.map(normalizeLabel));
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^[-*]\s*/, '').replace(/\*\*/g, '');
    const m = /^(.+?)\s*[:=]\s*(.+)$/.exec(cleaned);
    if (!m) continue;
    if (!wanted.has(normalizeLabel(m[1]))) continue;
    return m[2].trim().replace(/^`|`$/g, '');
  }
  return undefined;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRouteValue(raw: string | undefined): OrchestrationRoute | undefined {
  const value = (raw ?? '').toLowerCase().replace(/[`*_]/g, '').replace(/[–—]/g, '-');
  if (!value.trim()) return undefined;
  const hits = new Set<OrchestrationRoute>();
  if (/\b(blocked|no-op|noop|stop)\b/.test(value)) hits.add('blocked');
  if (/\b(parallel|fan-?out|workers?)\b/.test(value)) hits.add('parallel-workers');
  if (/\btest(?:\s|-)?gate\b|\btests?\b/.test(value)) hits.add('test-gate');
  if (/\breview(?:er)?\b/.test(value)) hits.add('review');
  if (/\bsingle(?:\s|-)?lead\b|\blead(?:\s|-)?engineer\b|\bsingle\b|\blead\b|\bplan(?:ning)?\b/.test(value)) hits.add('single-lead');
  return hits.size === 1 ? [...hits][0] : undefined;
}

function normalizeRoleValue(raw: string | undefined): OrchestrationRole | undefined {
  const value = (raw ?? '').toLowerCase().replace(/[`*_]/g, '');
  if (value.includes('architect')) return 'architect';
  if (value.includes('lead')) return 'leadEngineer';
  if (value.includes('worker')) return 'workerEngineer';
  if (value.includes('test')) return 'testEngineer';
  if (value.includes('review')) return 'reviewer';
  return undefined;
}

function normalizePackageId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  return trimmed.startsWith('wp') ? trimmed : `wp${trimmed}`;
}

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[.;]$/, '');
}

function uniquePackages(packages: WorkPackage[]): WorkPackage[] {
  const seen = new Set<string>();
  const out: WorkPackage[] = [];
  for (const pkg of packages) {
    let id = pkg.id;
    let n = 2;
    while (seen.has(id)) id = `${pkg.id}-${n++}`;
    seen.add(id);
    out.push({ ...pkg, id });
  }
  return out;
}

function isWorkPackage(v: unknown): v is WorkPackage {
  return !!v && typeof v === 'object'
    && typeof (v as WorkPackage).id === 'string'
    && typeof (v as WorkPackage).title === 'string'
    && typeof (v as WorkPackage).scope === 'string';
}
