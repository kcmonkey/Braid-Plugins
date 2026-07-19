import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export type EngineeringStatus = 'strategy' | 'reassess' | 'ready' | 'not-ready' | 'not-applicable';
export type EngineeringChangeKind = 'bugfix' | 'feature' | 'refactor' | 'config' | 'test' | 'other';
export type EngineeringRisk = 'low' | 'medium' | 'high';
export type EngineeringReviewKind = 'self' | 'independent' | 'not-needed';
export type EngineeringArchitectureSignal =
  | 'none'
  | 'ownership'
  | 'shared-state'
  | 'lifecycle'
  | 'concurrency'
  | 'public-contract'
  | 'permission'
  | 'extensibility';
export type EngineeringApproach = 'evidence-only' | 'localized' | 'narrow-refactor' | 'replacement';
export type EngineeringReassessmentDisposition = 'retain' | 'revise' | 'remove';

export interface EngineeringExpectRequest {
  status?: string;
  changeKind?: string;
  risk?: string;
  impact?: string;
  regression?: string;
  reviewKind?: string;
  review?: string;
  verification?: string;
  strategyRevision?: number;
  problem?: string;
  rootCause?: string;
  owner?: string;
  architectureSignals?: string[];
  approach?: string;
  evidence?: string[];
  scopePaths?: string[];
  targetInvariants?: string[];
  verificationPlan?: string;
  containment?: string;
  boundary?: string;
  consumers?: string[];
  alternatives?: string[];
  failureBehavior?: string;
  oldAuthority?: string;
  newAuthority?: string;
  migrationPlan?: string;
  positiveProofPlan?: string;
  negativeProofPlan?: string;
  rollback?: string;
  disposition?: string;
  reassessment?: string;
  changeReview?: string;
  migrationProof?: string;
  positiveProof?: string;
  negativeProof?: string;
  reason?: string;
}

export interface EngineeringToolHandlers {
  expect(ctx: AgentToolContext, req: EngineeringExpectRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeEngineeringExpectArgs(input: Record<string, unknown>): EngineeringExpectRequest {
  return {
    status: stringValue(input.status),
    changeKind: stringValue(input.changeKind),
    risk: stringValue(input.risk),
    impact: stringValue(input.impact),
    regression: stringValue(input.regression),
    reviewKind: stringValue(input.reviewKind),
    review: stringValue(input.review),
    verification: stringValue(input.verification),
    strategyRevision: numberValue(input.strategyRevision),
    problem: stringValue(input.problem),
    rootCause: stringValue(input.rootCause),
    owner: stringValue(input.owner),
    architectureSignals: stringArray(input.architectureSignals),
    approach: stringValue(input.approach),
    evidence: stringArray(input.evidence),
    scopePaths: stringArray(input.scopePaths),
    targetInvariants: stringArray(input.targetInvariants),
    verificationPlan: stringValue(input.verificationPlan),
    containment: stringValue(input.containment),
    boundary: stringValue(input.boundary),
    consumers: stringArray(input.consumers),
    alternatives: stringArray(input.alternatives),
    failureBehavior: stringValue(input.failureBehavior),
    oldAuthority: stringValue(input.oldAuthority),
    newAuthority: stringValue(input.newAuthority),
    migrationPlan: stringValue(input.migrationPlan),
    positiveProofPlan: stringValue(input.positiveProofPlan),
    negativeProofPlan: stringValue(input.negativeProofPlan),
    rollback: stringValue(input.rollback),
    disposition: stringValue(input.disposition),
    reassessment: stringValue(input.reassessment),
    changeReview: stringValue(input.changeReview),
    migrationProof: stringValue(input.migrationProof),
    positiveProof: stringValue(input.positiveProof),
    negativeProof: stringValue(input.negativeProof),
    reason: stringValue(input.reason),
  };
}

const engineeringExpectProperties = {
  status: { type: 'string', enum: ['strategy', 'reassess', 'ready', 'not-ready', 'not-applicable'], description: 'Current engineering strategy/readiness stance.' },
  changeKind: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'config', 'test', 'other'], description: 'Primary kind of source change.' },
  risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Explicit blast-radius judgment. Braid does not infer risk from paths or changed-file count.' },
  impact: { type: 'string', description: 'Related implementations, callers, contracts, provider/host counterparts, and state transitions inspected independently of test results.' },
  regression: { type: 'string', description: 'Concrete regression risks, including what the executed tests do and do not protect; for bug fixes, include RED→GREEN evidence or the explicit limitation.' },
  reviewKind: { type: 'string', enum: ['self', 'independent', 'not-needed'], description: 'Review mode. Source-changing ready cannot use not-needed. Self is valid at every risk; independent requires a delivered Reviewer report.' },
  review: { type: 'string', description: 'Final change review findings and repairs, or the independent review report reference.' },
  verification: { type: 'string', description: 'Exact successful commands/results plus any remaining manual or provider checks.' },
  strategyRevision: { type: 'integer', minimum: 1, description: 'Exact accepted Engineering Strategy revision returned by this tool.' },
  problem: { type: 'string', description: 'Observed problem or evidence-only hypothesis this change addresses.' },
  rootCause: { type: 'string', description: 'Evidence-backed root cause or an explicit currently-unknown cause for an evidence-only change.' },
  owner: { type: 'string', description: 'Current authoritative owner of the behavior/state being changed.' },
  architectureSignals: {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { type: 'string', enum: ['none', 'ownership', 'shared-state', 'lifecycle', 'concurrency', 'public-contract', 'permission', 'extensibility'] },
    description: 'Independent architecture signals. Use ["none"] only for a genuinely contained change.',
  },
  approach: { type: 'string', enum: ['evidence-only', 'localized', 'narrow-refactor', 'replacement'], description: 'Selected change shape.' },
  evidence: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Current source/log/test locators supporting the strategy.' },
  scopePaths: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Workspace-relative files or directory prefixes the strategy authorizes.' },
  targetInvariants: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Behavioral/ownership invariants the implementation must establish.' },
  verificationPlan: { type: 'string', description: 'Smallest machine evidence that can prove the target invariants.' },
  containment: { type: 'string', description: 'Why a localized/evidence-only approach does not create a second owner or cross an undeclared boundary.' },
  boundary: { type: 'string', description: 'Owner, inputs/outputs, state, lifecycle, and failure boundary for a structural change.' },
  consumers: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Known callers/consumers/contracts affected by a structural change.' },
  alternatives: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string' }, description: 'Plausible approaches considered, including the rejected patch/refactor/replacement alternative.' },
  failureBehavior: { type: 'string', description: 'Failure, cleanup, and recovery behavior for a structural change.' },
  oldAuthority: { type: 'string', description: 'Authority/source of truth to retire during refactor or replacement.' },
  newAuthority: { type: 'string', description: 'Authority/source of truth that must own the final behavior.' },
  migrationPlan: { type: 'string', description: 'Cutover and cleanup sequence from old authority to new authority.' },
  positiveProofPlan: { type: 'string', description: 'Planned proof that production consumers use the new authority.' },
  negativeProofPlan: { type: 'string', description: 'Planned proof that the old authority/path is no longer used.' },
  rollback: { type: 'string', description: 'Rollback or safe failure policy if the migration cannot complete.' },
  disposition: { type: 'string', enum: ['retain', 'revise', 'remove'], description: 'Disposition of a premature/out-of-scope mutation during reassessment.' },
  reassessment: { type: 'string', description: 'Current change-evidence finding explaining why the premature mutation is retained, revised, or removed.' },
  changeReview: { type: 'string', description: 'Final change review findings over the current host-observed change evidence.' },
  migrationProof: { type: 'string', description: 'Final structural cutover evidence across declared consumers.' },
  positiveProof: { type: 'string', description: 'Observed proof that production uses the new authority.' },
  negativeProof: { type: 'string', description: 'Observed proof that production no longer uses the old authority.' },
  reason: { type: 'string', description: 'Required reason for not-ready or not-applicable.' },
} as const;

export function createEngineeringAgentTools(handlers: EngineeringToolHandlers): AgentToolPlugin<Record<string, unknown>>[] {
  return [{
    id: 'engineering-quality.expect',
    label: 'Expect Engineering Readiness',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'engineering_expect',
      description: [
        'Declare the mutation-scoped Engineering Strategy and final engineering-readiness stance for a source-changing turn.',
        'Call status:"strategy" after current-source discovery and before source mutation. Localized/evidence-only work uses the compact owner/invariant/containment contract; architecture signals or refactor/replacement require boundary, consumers, alternatives, failure behavior, and migration fields.',
        'If a host observation leaves a potentially mutating receipt unresolved or incompletely covered, readiness remains blocked until the current change-evidence projection can attest the affected surfaces and reviewable content. Retroactive strategy prose cannot erase that limitation.',
        'Call status:"ready" only after checking related surfaces and regression risk, reviewing the final change evidence, and observing both a successful related-surface search and a successful verification command result bound to the current final-evidence identity.',
        'Every source change requires those two separate evidence classes; a green test or build satisfies verification only and cannot satisfy related-surface review. Independent review is optional and requires a delivered Reviewer report only when reviewKind:"independent" is selected.',
        'When ready is blocked, the tool returns one Missing checklist for all remaining gates; do every item then call ready once.',
        'Use status:"not-ready" with concrete remaining work when those conditions are not true; do not claim completion.',
        'Use status:"not-applicable" only when this turn did not modify source or executable configuration.',
        'If you edit source again after ready, reassess and call this tool again.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        oneOf: [
          {
            required: ['status', 'changeKind', 'risk', 'problem', 'rootCause', 'owner', 'architectureSignals', 'approach', 'evidence', 'scopePaths', 'targetInvariants', 'verificationPlan'],
            properties: {
              status: { ...engineeringExpectProperties.status, enum: ['strategy'] },
              changeKind: engineeringExpectProperties.changeKind,
              risk: engineeringExpectProperties.risk,
              problem: engineeringExpectProperties.problem,
              rootCause: engineeringExpectProperties.rootCause,
              owner: engineeringExpectProperties.owner,
              architectureSignals: engineeringExpectProperties.architectureSignals,
              approach: engineeringExpectProperties.approach,
              evidence: engineeringExpectProperties.evidence,
              scopePaths: engineeringExpectProperties.scopePaths,
              targetInvariants: engineeringExpectProperties.targetInvariants,
              verificationPlan: engineeringExpectProperties.verificationPlan,
              containment: engineeringExpectProperties.containment,
              boundary: engineeringExpectProperties.boundary,
              consumers: engineeringExpectProperties.consumers,
              alternatives: engineeringExpectProperties.alternatives,
              failureBehavior: engineeringExpectProperties.failureBehavior,
              oldAuthority: engineeringExpectProperties.oldAuthority,
              newAuthority: engineeringExpectProperties.newAuthority,
              migrationPlan: engineeringExpectProperties.migrationPlan,
              positiveProofPlan: engineeringExpectProperties.positiveProofPlan,
              negativeProofPlan: engineeringExpectProperties.negativeProofPlan,
              rollback: engineeringExpectProperties.rollback,
            },
          },
          {
            required: ['status', 'changeKind', 'risk', 'problem', 'rootCause', 'owner', 'architectureSignals', 'approach', 'evidence', 'scopePaths', 'targetInvariants', 'verificationPlan', 'disposition', 'reassessment'],
            properties: {
              status: { ...engineeringExpectProperties.status, enum: ['reassess'] },
              changeKind: engineeringExpectProperties.changeKind,
              risk: engineeringExpectProperties.risk,
              problem: engineeringExpectProperties.problem,
              rootCause: engineeringExpectProperties.rootCause,
              owner: engineeringExpectProperties.owner,
              architectureSignals: engineeringExpectProperties.architectureSignals,
              approach: engineeringExpectProperties.approach,
              evidence: engineeringExpectProperties.evidence,
              scopePaths: engineeringExpectProperties.scopePaths,
              targetInvariants: engineeringExpectProperties.targetInvariants,
              verificationPlan: engineeringExpectProperties.verificationPlan,
              containment: engineeringExpectProperties.containment,
              boundary: engineeringExpectProperties.boundary,
              consumers: engineeringExpectProperties.consumers,
              alternatives: engineeringExpectProperties.alternatives,
              failureBehavior: engineeringExpectProperties.failureBehavior,
              oldAuthority: engineeringExpectProperties.oldAuthority,
              newAuthority: engineeringExpectProperties.newAuthority,
              migrationPlan: engineeringExpectProperties.migrationPlan,
              positiveProofPlan: engineeringExpectProperties.positiveProofPlan,
              negativeProofPlan: engineeringExpectProperties.negativeProofPlan,
              rollback: engineeringExpectProperties.rollback,
              disposition: engineeringExpectProperties.disposition,
              reassessment: engineeringExpectProperties.reassessment,
            },
          },
          {
            required: ['status', 'changeKind', 'risk', 'strategyRevision', 'impact', 'regression', 'reviewKind', 'review', 'verification', 'changeReview'],
            properties: {
              status: { ...engineeringExpectProperties.status, enum: ['ready'] },
              changeKind: engineeringExpectProperties.changeKind,
              risk: engineeringExpectProperties.risk,
              strategyRevision: engineeringExpectProperties.strategyRevision,
              impact: engineeringExpectProperties.impact,
              regression: engineeringExpectProperties.regression,
              reviewKind: { ...engineeringExpectProperties.reviewKind, enum: ['self', 'independent'] },
              review: engineeringExpectProperties.review,
              verification: engineeringExpectProperties.verification,
              changeReview: engineeringExpectProperties.changeReview,
              migrationProof: engineeringExpectProperties.migrationProof,
              positiveProof: engineeringExpectProperties.positiveProof,
              negativeProof: engineeringExpectProperties.negativeProof,
            },
          },
          {
            required: ['status', 'reason'],
            properties: {
              status: { ...engineeringExpectProperties.status, enum: ['not-ready'] },
              reason: engineeringExpectProperties.reason,
            },
          },
          {
            required: ['status', 'reason'],
            properties: {
              status: { ...engineeringExpectProperties.status, enum: ['not-applicable'] },
              reason: engineeringExpectProperties.reason,
            },
          },
        ],
        properties: engineeringExpectProperties,
      },
    },
    call(ctx, input) {
      return handlers.expect(ctx, normalizeEngineeringExpectArgs(input));
    },
  }];
}
