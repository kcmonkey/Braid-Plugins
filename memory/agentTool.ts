import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export interface MemoryRecordToolRequest {
  title?: string;
  content?: string;
  scope?: string;
  tags?: string;
  evidence?: string;
}

export interface MemoryRecallToolRequest {
  query?: string;
  scope?: string;
  limit?: string;
}

export interface MemoryToolHandlers {
  record(ctx: AgentToolContext, req: MemoryRecordToolRequest): Promise<AgentToolResult>;
  recall(ctx: AgentToolContext, req: MemoryRecallToolRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function normalizeMemoryRecordArgs(input: Record<string, unknown>): MemoryRecordToolRequest {
  return {
    title: stringValue(input.title),
    content: stringValue(input.content),
    scope: stringValue(input.scope),
    tags: stringValue(input.tags),
    evidence: stringValue(input.evidence),
  };
}

export function normalizeMemoryRecallArgs(input: Record<string, unknown>): MemoryRecallToolRequest {
  return {
    query: stringValue(input.query),
    scope: stringValue(input.scope),
    limit: stringValue(input.limit),
  };
}

export function createMemoryAgentTools(handlers: MemoryToolHandlers): AgentToolPlugin<Record<string, unknown>>[] {
  return [
    {
      id: 'memory.record',
      label: 'Record Memory',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'memory_record',
        description: 'Record or update one durable project-local Braid memory. Use this only for stable, reusable facts, gotchas, root causes, conventions, or workflow lessons that should survive across boards. Do not record transient task status. Required: title and content. Optional: scope, tags, evidence.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'content'],
          properties: {
            title: { type: 'string', description: 'Short stable memory title.' },
            content: { type: 'string', description: 'Durable memory body. Keep it concise and reusable.' },
            scope: { type: 'string', description: 'Project area or feature this memory applies to.' },
            tags: { type: 'string', description: 'Comma-separated tags.' },
            evidence: { type: 'string', description: 'Optional source, command, file path, or proof.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.record(ctx, normalizeMemoryRecordArgs(input));
      },
    },
    {
      id: 'memory.recall',
      label: 'Recall Memory',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'memory_recall',
        description: 'Recall bounded relevant Braid memories for the current project. Use a focused query, optional scope, and optional string limit from 1 to 10. Results are summaries of project-local records only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Focused search query for relevant memories.' },
            scope: { type: 'string', description: 'Optional project area or feature scope filter.' },
            limit: { type: 'string', description: 'Optional result limit, 1 to 10. Defaults to 5.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.recall(ctx, normalizeMemoryRecallArgs(input));
      },
    },
  ];
}
