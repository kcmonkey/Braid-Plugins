import type {
  AgentToolContext,
  HostService,
  HostServicePlugin,
  PluginManifest,
  TurnContextPlugin,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import {
  recallMemories,
  recordMemory,
  type MemoryRecallInput,
  type MemoryRecord,
  type MemoryRecordInput,
} from './model';
import { createMemoryAgentTools, type MemoryRecallToolRequest, type MemoryRecordToolRequest } from './agentTool';
import manifestJson from './plugin.json';
import { readMemoryStore, writeMemoryStore } from './storage';

const manifest = manifestJson as PluginManifest;
const MAX_RESULT_CHARS = 4000;
const MAX_CONTENT_CHARS = 700;

const compactLine = (value: string, max = MAX_CONTENT_CHARS): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, max).trim();

function formatRecordResult(record: MemoryRecord, created: boolean): string {
  return `${created ? 'Recorded' : 'Updated'} Braid memory ${record.id}: ${record.title}. Stored in .braid/memory/.`;
}

function formatRecallResult(records: MemoryRecord[], input: MemoryRecallInput): string {
  const query = (input.query ?? '').trim();
  if (!records.length) return `No matching Braid memories for query "${query}".`;
  const lines = [`Braid memory recall: ${records.length} match${records.length === 1 ? '' : 'es'} for "${query}".`];
  for (const record of records) {
    const tags = record.tags.length ? ` tags=${record.tags.join(',')}` : '';
    const scope = record.scope ? ` [${record.scope}]` : '';
    lines.push(`- ${record.title}${scope}${tags} updated=${record.updatedAt}`);
    lines.push(`  ${compactLine(record.content)}`);
    if (record.evidence) lines.push(`  evidence: ${compactLine(record.evidence, 240)}`);
    if (lines.join('\n').length >= MAX_RESULT_CHARS) break;
  }
  return lines.join('\n').slice(0, MAX_RESULT_CHARS);
}

class MemoryHostService implements HostService {
  id = 'memory.hostService';
  label = 'Memory Host Service';
  manifest = manifest;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly cwd: () => string) {}

  agentTools() {
    return createMemoryAgentTools({
      record: (ctx, req) => this.handleRecord(ctx, req),
      recall: (ctx, req) => this.handleRecall(ctx, req),
    });
  }

  turnContext(): TurnContextPlugin[] {
    return [{
      id: 'memory.turnContext',
      label: 'Memory Turn Context',
      manifest,
      provideTurnContext: () => this.memoryTurnContext(),
    }];
  }

  private memoryTurnContext(): string | null {
    const store = readMemoryStore(this.cwd());
    if (!store.records.length) return null;
    return [
      '[Braid memory]',
      'Project-local memories are available. Use braid.memory_recall with a focused query before relying on prior project facts.',
      'Use braid.memory_record only for durable, reusable facts, root causes, conventions, or workflow lessons. Do not record transient task status.',
    ].join('\n');
  }

  private async handleRecord(ctx: AgentToolContext, req: MemoryRecordToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory record canceled.' };
    const run = this.writeQueue.then(async () => {
      try {
        const store = readMemoryStore(this.cwd());
        const result = recordMemory(store, req as MemoryRecordInput);
        writeMemoryStore(this.cwd(), result.store);
        return { ok: true, result: formatRecordResult(result.record, result.created) };
      } catch (error: any) {
        return { ok: false, result: error?.message ?? 'memory_record failed.' };
      }
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleRecall(ctx: AgentToolContext, req: MemoryRecallToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Memory recall canceled.' };
    if (!req.query?.trim()) return { ok: false, result: 'memory_recall needs a non-empty query.' };
    await this.writeQueue;
    const store = readMemoryStore(this.cwd());
    const records = recallMemories(store, req as MemoryRecallInput);
    return { ok: true, result: formatRecallResult(records, req) };
  }
}

export const memoryHostServicePlugin: HostServicePlugin = {
  id: 'memory.hostService',
  label: 'Memory Host Service',
  manifest,
  create(ctx) {
    return new MemoryHostService(ctx.cwd);
  },
};
