import { describe, expect, it, vi } from 'vitest';
import { createMemoryAgentTools, normalizeMemoryRecallArgs } from './agentTool';

describe('memory agent tools', () => {
  it('exposes only configured/off semantic recall choices and omits every other caller value', () => {
    expect(normalizeMemoryRecallArgs({ query: 'q', semantic: 'configured' })).toEqual({ query: 'q', scope: undefined, limit: undefined, semantic: 'configured' });
    expect(normalizeMemoryRecallArgs({ query: 'q', semantic: 'off' })).toEqual({ query: 'q', scope: undefined, limit: undefined, semantic: 'off' });
    expect(normalizeMemoryRecallArgs({ query: 'q', semantic: 'local-experimental' })).toEqual({ query: 'q', scope: undefined, limit: undefined, semantic: undefined });
    expect(normalizeMemoryRecallArgs({ query: 'q' })).toEqual({ query: 'q', scope: undefined, limit: undefined, semantic: undefined });

    const recall = vi.fn(async () => ({ ok: true, result: 'ok' }));
    const tool = createMemoryAgentTools({ record: vi.fn(), recall, get: vi.fn(), catalog: vi.fn() })
      .find((candidate) => candidate.tool.name === 'memory_recall')!;
    expect(tool.tool.inputSchema.properties.semantic).toMatchObject({ type: 'string', enum: ['configured', 'off'] });
    expect(tool.tool.inputSchema.additionalProperties).toBe(false);
  });
});
