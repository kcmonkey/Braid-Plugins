import type { AgentToolPlugin, AgentToolContext, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

const ACTIONS = ['status', 'claim', 'release', 'wait', 'request'] as const;
const MODES = ['shared', 'exclusive', 'state'] as const;
const PRIORITIES = ['low', 'normal', 'high'] as const;

export type CoordinateAction = typeof ACTIONS[number];
export type CoordinateMode = typeof MODES[number];
export type CoordinatePriority = typeof PRIORITIES[number];

export interface CoordinateToolRequest {
  action: CoordinateAction;
  resource?: string;
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
      description: 'Coordinate shared workspace resources (e.g. an editor, a build) with OTHER Braid boards in the same project. action="status": list declared resources + who holds/wants what. action="claim": claim a resource BEFORE an editor/build lifecycle action (others are notified; tells you if you must wait). action="wait": claim AND block until the resource frees, then continue - call this ONCE instead of polling status/claim in a loop; it returns the instant the resource is free and spends no tokens while waiting (a resource held only by a finished/idle board is handed to you immediately). action="release": release your claims when done - and if another board is waiting on a resource you hold, SAVE first then release it at your NEXT safe tool step (you need not finish your whole turn). If you will still NEED that resource afterwards (e.g. you will keep editing after the other board\'s build), call action:"wait" on the SAME resource right after releasing: you auto-resume the instant it frees, then reopen/reload (e.g. relaunch the editor) and continue. action="request": ask a specific board (toBoardId) to release/coordinate, passing `text`. Resource ids and board ids come from status / the [Braid coordination] context. IMPORTANT: only an ACTIVE claim grants a resource - a PENDING claim (or an unanswered request) grants NOTHING. Never start a build, close the editor, or say another board "yielded", unless your OWN claim is ACTIVE (a claim/wait result saying you HOLD it / ACTIVE - not PENDING/BLOCKED). When a result says pending or blocked, treat it as pending and STOP; do not narrate progress on a window you were never granted.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS, description: 'status | claim | release | wait | request' },
          resource: { type: 'string', description: 'Resource id for claim/wait/release (e.g. "ubt-build", "unreal-editor").' },
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
