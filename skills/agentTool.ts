import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export interface SkillToolRequest {
  name?: string;
  arguments?: string;
}

export interface SkillToolHandlers {
  use(ctx: AgentToolContext, req: SkillToolRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function normalizeSkillArgs(input: Record<string, unknown>): SkillToolRequest {
  return {
    name: stringValue(input.name),
    arguments: stringValue(input.arguments),
  };
}

export function createSkillAgentTool(handlers: SkillToolHandlers): AgentToolPlugin<Record<string, unknown>> {
  return {
    id: 'skills.skill',
    label: 'Skill',
    manifest,
    tool: {
      namespace: 'braid',
      name: 'Skill',
      description: [
        'Load and use one project-local Braid skill by name, matching Claude Code Skill tool behavior.',
        'Call this when the task matches a skill from the injected skills list or when the user asks to use a skill.',
        'The tool returns the skill metadata, SKILL.md body, skill root path, and bundled resource pointers.',
        'Read referenced files only when needed after this tool returns. Do not pre-load unrelated skills.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Exact skill name from the available skills list.' },
          arguments: { type: 'string', description: 'Optional user request or arguments that caused this skill to be selected.' },
        },
      },
    },
    call(ctx, input) {
      return handlers.use(ctx, normalizeSkillArgs(input));
    },
  };
}
