import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

export interface ComputerUseToolHandlers {
  discover(ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolResult>;
  execute(ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolResult>;
  requiresApproval(input: Record<string, unknown>): Promise<boolean>;
}

export function createComputerUseAgentTools(handlers: ComputerUseToolHandlers): AgentToolPlugin[] {
  return [{
    id: 'computer-use.tools',
    label: 'Computer Use Tools',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'computer_use_tools',
      description: [
        'Discover the installed native computer-use actions. Omit name to list actions; pass an exact name for its complete current description and JSON schema.',
        'Read the action schema before calling computer_use. Actions vary by platform and Driver version.',
        'The host binds computer-use sessions to the exact Agent; omit the action arguments.session field.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', description: 'Exact Driver action name to describe. Omit to list available actions.' } },
      },
    },
    call: (ctx, input) => handlers.discover(ctx, input),
  }, {
    id: 'computer-use.call',
    label: 'Computer Use',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'computer_use',
      description: [
        'Invoke one action with action and arguments, or multiple ordered actions with actions:[{action,arguments},...], through the native Cua Driver SDK. Do not combine these forms.',
        'Use computer_use_tools to read each action schema, then pass its name and arguments unchanged. All names are checked before execution; actions run sequentially and stop on failure, cancellation or plugin disablement. No automatic retries.',
        'The host evaluates permission once for the whole call under the current permission mode; any action with write risk makes the batch approval-sensitive (bypassPermissions does not prompt).',
        'Batch results include total, completed (successful steps), and results with zero-based index, action, ok, result and imageIndices into the returned images; stoppedAt identifies the failing step. Input or catalog preflight failures return an error without executing any step.',
        'Screenshots return as images. Ground input in a fresh observation of the exact target and verify the resulting state.',
        'Include an explicit observation action at the end when needed; no screenshot is added automatically. If an action needs parameters learned from a new screenshot or result, put it in a later call after inspecting that observation.',
        'Use background input first; escalate only after the Driver refuses it or a fresh observation proves it ineffective.',
        'Omit arguments.session: Braid binds a private session to this Agent. Never repeat a non-idempotent action when cancellation or failure leaves its outcome unknown.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        oneOf: [
          { required: ['action', 'arguments'], not: { required: ['actions'] } },
          { required: ['actions'], not: { anyOf: [{ required: ['action'] }, { required: ['arguments'] }] } },
        ],
        properties: {
          action: { type: 'string', description: 'Exact action name returned by computer_use_tools.' },
          arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the discovered action inputSchema.' },
          actions: {
            type: 'array', minItems: 1,
            description: 'Ordered explicit actions. Use this instead of top-level action and arguments. Stops at the first failure; later actions are not attempted.',
            items: {
              type: 'object', additionalProperties: false, required: ['action', 'arguments'],
              properties: {
                action: { type: 'string', description: 'Exact action name returned by computer_use_tools.' },
                arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching this action inputSchema.' },
              },
            },
          },
        },
      },
    },
    requiresApproval: (input) => handlers.requiresApproval(input),
    call: (ctx, input) => handlers.execute(ctx, input),
  }];
}
