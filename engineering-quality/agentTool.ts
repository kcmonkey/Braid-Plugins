import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export type EngineeringStatus = 'ready' | 'not-ready' | 'not-applicable';
export type EngineeringChangeKind = 'bugfix' | 'feature' | 'refactor' | 'config' | 'test' | 'other';
export type EngineeringRisk = 'low' | 'medium' | 'high';
export type EngineeringReviewKind = 'self' | 'independent' | 'not-needed';

export interface EngineeringExpectRequest {
  status?: string;
  changeKind?: string;
  risk?: string;
  impact?: string;
  regression?: string;
  reviewKind?: string;
  review?: string;
  verification?: string;
  reason?: string;
}

export interface EngineeringToolHandlers {
  expect(ctx: AgentToolContext, req: EngineeringExpectRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
    reason: stringValue(input.reason),
  };
}

export function createEngineeringAgentTools(handlers: EngineeringToolHandlers): AgentToolPlugin<Record<string, unknown>>[] {
  return [{
    id: 'engineering-quality.expect',
    label: 'Expect Engineering Readiness',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'engineering_expect',
      description: [
        'Declare the latest engineering-readiness stance for a source-changing turn.',
        'Call status:"ready" only after checking related surfaces and regression risk, reviewing the final diff, and observing a successful verification command result in this turn.',
        'Bug fixes require a successful related-surface search. Independent review is optional and requires a delivered Reviewer report only when reviewKind:"independent" is selected.',
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
            required: ['status', 'changeKind', 'risk', 'impact', 'regression', 'reviewKind', 'review', 'verification'],
            properties: { status: { type: 'string', enum: ['ready'] } },
          },
          {
            required: ['status', 'reason'],
            properties: { status: { type: 'string', enum: ['not-ready'] } },
          },
          {
            required: ['status', 'reason'],
            properties: { status: { type: 'string', enum: ['not-applicable'] } },
          },
        ],
        properties: {
          status: { type: 'string', enum: ['ready', 'not-ready', 'not-applicable'], description: 'Current engineering-readiness stance.' },
          changeKind: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'config', 'test', 'other'], description: 'Primary kind of source change.' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Explicit blast-radius judgment. Braid does not infer risk from paths or changed-file count.' },
          impact: { type: 'string', description: 'Related implementations, callers, contracts, provider/host counterparts, and state transitions inspected.' },
          regression: { type: 'string', description: 'Concrete regression risks and how tests protect them; for bug fixes, include RED→GREEN evidence or the explicit limitation.' },
          reviewKind: { type: 'string', enum: ['self', 'independent', 'not-needed'], description: 'Review mode. Source-changing ready cannot use not-needed. Self is valid at every risk; independent requires a delivered Reviewer report.' },
          review: { type: 'string', description: 'Final-diff review findings and repairs, or the independent review report reference.' },
          verification: { type: 'string', description: 'Exact successful commands/results plus any remaining manual or provider checks.' },
          reason: { type: 'string', description: 'Required reason for not-ready or not-applicable.' },
        },
      },
    },
    call(ctx, input) {
      return handlers.expect(ctx, normalizeEngineeringExpectArgs(input));
    },
  }];
}
