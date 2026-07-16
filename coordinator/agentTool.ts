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
      description: 'Coordinate shared workspace resources and file write claims with OTHER Braid boards in the same project. action="status": list declared resources + who holds/wants what. action="claim": claim a declared resource BEFORE an editor/build lifecycle action. action="wait": claim AND block until a declared resource frees. action="wait-file": block on an existing file claim using `path`; call it ONCE after a write is denied instead of polling or ending the turn merely because that file is busy. Files remain file claims and do not need entries in .braid/resources.json. action="release": release your claims when done. action="request": ask a specific board (toBoardId) to release/coordinate, passing `text`. IMPORTANT: only an ACTIVE claim grants a resource or file. A PENDING/BLOCKED result grants NOTHING. Stop only the gated conflicting action, then use the matching wait action once; never claim progress until the wait result says you HOLD it / ACTIVE.',
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
          toBoardId: { type: 'string', description: 'For action="request": the board id to ask (from status / context).' },
          text: { type: 'string', description: 'For action="request": what you are asking the other board.' },
          summary: { type: 'string', description: 'Short reason, shown to other boards.' },
        },
      },
    },
    call(ctx, input) {
      return handle(ctx, normalizeCoordinateArgs(input));
    },
  };
}
