import type { AgentToolPlugin, AgentToolContext, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

const ACTIONS = ['status', 'claim', 'release', 'wait', 'wait-file', 'request'] as const;
const MODES = ['shared', 'exclusive', 'state'] as const;
const PRIORITIES = ['low', 'normal', 'high'] as const;

export type CoordinateAction = typeof ACTIONS[number];
export type CoordinateMode = typeof MODES[number];
export type CoordinatePriority = typeof PRIORITIES[number];

export interface CoordinateToolRequest {
  action: CoordinateAction;
  resource?: string;
  path?: string;
  desiredState?: string;
  mode?: CoordinateMode;
  priority?: CoordinatePriority;
  toBoardId?: string;
  toAgentId?: string;
  text?: string;
  summary?: string;
}

export type CoordinateToolHandler = (
  ctx: AgentToolContext,
  req: CoordinateToolRequest,
) => Promise<AgentToolResult>;

export const manifest = manifestJson as PluginManifest;

const isOneOf = <T extends readonly string[]>(values: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

export function normalizeCoordinateArgs(input: Record<string, unknown>): CoordinateToolRequest {
  return {
    action: isOneOf(ACTIONS, input.action) ? input.action : 'status',
    resource: typeof input.resource === 'string' ? input.resource : undefined,
    path: typeof input.path === 'string' ? input.path : undefined,
    desiredState: typeof input.desiredState === 'string' ? input.desiredState : undefined,
    mode: isOneOf(MODES, input.mode) ? input.mode : undefined,
    priority: isOneOf(PRIORITIES, input.priority) ? input.priority : undefined,
    toBoardId: typeof input.toBoardId === 'string' ? input.toBoardId : undefined,
    toAgentId: typeof input.toAgentId === 'string' ? input.toAgentId : undefined,
    text: typeof input.text === 'string' ? input.text : undefined,
    summary: typeof input.summary === 'string' ? input.summary : undefined,
  };
}

export function createCoordinatorAgentTool(handle: CoordinateToolHandler): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'coordinator.coordinate',
    label: 'Coordinate',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'coordinate',
      description: 'Coordinate shared workspace resources and file write claims between exact Braid Agents in the same project, with or without a Board. action="status": list resources and exact Agent owners. action="claim": claim a declared resource BEFORE an editor/build lifecycle action. action="wait": claim AND block until the resource is available. action="wait-file": wait on one file path after a write conflict; do not poll. Files need no resource declaration. action="release": release this Agent\'s claims. action="request": ask toAgentId to release/coordinate; toBoardId is optional explicit presentation addressing and cannot be combined with toAgentId. Only ACTIVE claims grant permission to the exact claimant. A parent\'s claim or message grants no resource to another Agent. Claims last until explicit release or this Agent\'s execution ends. A PENDING/BLOCKED result grants nothing; stop only the conflicting action and use its matching wait.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS, description: 'status | claim | release | wait | wait-file | request' },
          resource: { type: 'string', description: 'Resource id for claim/wait/release (e.g. "ubt-build", "unreal-editor").' },
          path: { type: 'string', description: 'Workspace-relative file path for action="wait-file".' },
          desiredState: { type: 'string', description: 'For state resources, the state you need (e.g. "open"/"closed").' },
          mode: { type: 'string', enum: MODES, description: "Claim mode (defaults to the resource's declared kind)." },
          priority: { type: 'string', enum: PRIORITIES, description: 'Claim priority.' },
          toBoardId: { type: 'string', description: 'For action="request": an explicit displayed Board in the current Canvas. Resolved to its exact Agent; cannot be combined with toAgentId.' },
          toAgentId: { type: 'string', description: 'For action="request": the exact Agent id to ask (from status / context), including headless Agents. Cannot be combined with toBoardId.' },
          text: { type: 'string', description: 'For action="request": what you are asking the other Agent.' },
          summary: { type: 'string', description: 'Short reason, shown to other Agents.' },
        },
      },
    },
    call(ctx, input) {
      return handle(ctx, normalizeCoordinateArgs(input));
    },
  };
}
