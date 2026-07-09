import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export interface MemoryRecordToolRequest {
  action?: string;
  verb?: string;
  id?: string;
  title?: string;
  content?: string;
  locator?: string;
  source?: string;
  capturedAt?: string;
  quote?: string;
  quoteSource?: string;
  recallCue?: string;
  provenance?: string;
  evidenceLocators?: string;
  status?: string;
  freshness?: string;
  lastVerifiedLocator?: string;
  supersedes?: string;
  scope?: string;
  tags?: string;
  evidence?: string;
  class?: string;
  type?: string;
}

export interface MemoryRecallToolRequest {
  query?: string;
  scope?: string;
  limit?: string;
}

export interface MemoryGetToolRequest {
  id?: string;
}

export interface MemoryCatalogToolRequest {
  scope?: string;
  tag?: string;
  status?: string;
  class?: string;
  page?: string;
  pageSize?: string;
}

export interface MemoryToolHandlers {
  record(ctx: AgentToolContext, req: MemoryRecordToolRequest): Promise<AgentToolResult>;
  recall(ctx: AgentToolContext, req: MemoryRecallToolRequest): Promise<AgentToolResult>;
  get(ctx: AgentToolContext, req: MemoryGetToolRequest): Promise<AgentToolResult>;
  catalog(ctx: AgentToolContext, req: MemoryCatalogToolRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function normalizeMemoryRecordArgs(input: Record<string, unknown>): MemoryRecordToolRequest {
  return {
    action: stringValue(input.action),
    verb: stringValue(input.verb),
    id: stringValue(input.id),
    title: stringValue(input.title),
    content: stringValue(input.content),
    locator: stringValue(input.locator),
    source: stringValue(input.source),
    capturedAt: stringValue(input.capturedAt),
    quote: stringValue(input.quote),
    quoteSource: stringValue(input.quoteSource),
    recallCue: stringValue(input.recallCue),
    provenance: stringValue(input.provenance),
    evidenceLocators: stringValue(input.evidenceLocators),
    status: stringValue(input.status),
    freshness: stringValue(input.freshness),
    lastVerifiedLocator: stringValue(input.lastVerifiedLocator),
    supersedes: stringValue(input.supersedes),
    scope: stringValue(input.scope),
    tags: stringValue(input.tags),
    evidence: stringValue(input.evidence),
    class: stringValue(input.class),
    type: stringValue(input.type),
  };
}

export function normalizeMemoryRecallArgs(input: Record<string, unknown>): MemoryRecallToolRequest {
  return {
    query: stringValue(input.query),
    scope: stringValue(input.scope),
    limit: stringValue(input.limit),
  };
}

export function normalizeMemoryGetArgs(input: Record<string, unknown>): MemoryGetToolRequest {
  return {
    id: stringValue(input.id),
  };
}

export function normalizeMemoryCatalogArgs(input: Record<string, unknown>): MemoryCatalogToolRequest {
  return {
    scope: stringValue(input.scope),
    tag: stringValue(input.tag),
    status: stringValue(input.status),
    class: stringValue(input.class),
    page: stringValue(input.page),
    pageSize: stringValue(input.pageSize),
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
        description: 'Record or update one durable project-local Braid memory through class-bound verbs. Use locator, snapshot, lesson, or transcript; class is derived from the verb. For status changes use action=status with id and status.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {
            action: { type: 'string', description: 'Optional action. Use "status" to change routing status.' },
            verb: { type: 'string', description: 'Write verb: locator, snapshot, lesson, or transcript.' },
            id: { type: 'string', description: 'Existing memory id for status transitions.' },
            title: { type: 'string', description: 'Short stable memory title.' },
            content: { type: 'string', description: 'Durable memory body for snapshot or lesson records.' },
            locator: { type: 'string', description: 'Locator target for locator memories.' },
            source: { type: 'string', description: 'Source locator for snapshot memories.' },
            capturedAt: { type: 'string', description: 'Snapshot capture time.' },
            quote: { type: 'string', description: 'Verbatim quote for transcript memories.' },
            quoteSource: { type: 'string', description: 'Source of the verbatim transcript quote.' },
            recallCue: { type: 'string', description: 'Future reader query/situation that should find this memory.' },
            provenance: { type: 'string', description: 'Who/what produced or endorsed this memory.' },
            evidenceLocators: { type: 'string', description: 'Evidence locator list, separated by newlines or semicolons.' },
            status: { type: 'string', description: 'Routing status: current, stale, superseded, or disputed.' },
            freshness: { type: 'string', description: 'Freshness label: verified or unverified.' },
            lastVerifiedLocator: { type: 'string', description: 'Locator used for the latest verification.' },
            supersedes: { type: 'string', description: 'Prior memory id this record supersedes.' },
            scope: { type: 'string', description: 'Project area or feature this memory applies to.' },
            tags: { type: 'string', description: 'Comma-separated tags.' },
            evidence: { type: 'string', description: 'Legacy evidence text; prefer evidenceLocators.' },
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
    {
      id: 'memory.get',
      label: 'Get Memory',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'memory_get',
        description: 'Read one full Braid memory record by exact memory id. Use before relying on a recalled memory detail.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Exact memory id, without fallback search.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.get(ctx, normalizeMemoryGetArgs(input));
      },
    },
    {
      id: 'memory.catalog',
      label: 'Browse Memory Catalog',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'memory_catalog',
        description: 'Browse a bounded mechanical page of Braid memory records by optional scope, tag, status, or class.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {
            scope: { type: 'string', description: 'Optional exact scope filter.' },
            tag: { type: 'string', description: 'Optional exact tag filter.' },
            status: { type: 'string', description: 'Optional routing status filter: current, stale, superseded, or disputed.' },
            class: { type: 'string', description: 'Optional corpus class filter: 2, 3, 4, or 5.' },
            page: { type: 'string', description: 'Optional 1-based page number. Defaults to 1.' },
            pageSize: { type: 'string', description: 'Optional page size, 1 to 50. Defaults to 20.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.catalog(ctx, normalizeMemoryCatalogArgs(input));
      },
    },
  ];
}
