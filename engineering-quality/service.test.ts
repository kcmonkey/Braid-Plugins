import { describe, expect, it } from 'vitest';
import type {
  AgentToolPlugin,
  HostServiceContext,
  NestedToolObservation,
  ToolMiddlewarePlugin,
  ToolResultMiddlewareContext,
} from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ObligationBinding, ObligationLedgerEvent } from '../../../src/obligations';
import { engineeringQualityHostServicePlugin } from './service';

function harness() {
  const bindings: ObligationBinding[] = [];
  const events: ObligationLedgerEvent[] = [];
  const host = {
    cwd: () => 'D:/project',
    attachBinding: (binding: ObligationBinding) => {
      bindings.push(binding);
      return {
        obligationId: String(binding.params?.id ?? binding.bindingId),
        bindingId: String(binding.bindingId),
        recipeId: binding.recipeId,
      };
    },
    recordObligationEvent: (event: ObligationLedgerEvent) => events.push(event),
  } as HostServiceContext;
  const service = engineeringQualityHostServicePlugin.create(host);
  const middleware = (service.toolMiddleware?.() ?? [])[0] as ToolMiddlewarePlugin;
  const tool = (service.agentTools?.() ?? []).find((candidate) => candidate.tool.name === 'engineering_expect') as AgentToolPlugin<Record<string, unknown>>;

  const observe = async (id: string, name: string, input: unknown, turnIndex = 2) => {
    await middleware.observeToolUse?.({
      canvasId: 'c1',
      boardId: 'b1',
      turnIndex,
      provider: 'codex',
      source: 'observed',
      toolUseId: id,
      toolName: name,
      input,
    });
  };
  const result = async (
    id: string,
    content = 'ok',
    isError = false,
    turnIndex = 2,
    nestedToolObservations?: readonly NestedToolObservation[],
  ) => {
    // functions.exec is the provider-visible top-level tool. Its nested tool observations must arrive
    // as host-authored result metadata; JavaScript source and model-visible text are not trusted evidence.
    const ctx: ToolResultMiddlewareContext = {
      canvasId: 'c1',
      boardId: 'b1',
      turnIndex,
      provider: 'codex',
      toolUseId: id,
      content,
      isError,
      ...(nestedToolObservations ? { nestedToolObservations } : {}),
    };
    await middleware.observeToolResult?.(ctx);
  };
  const call = (args: Record<string, unknown>, turnIndex = 2): Promise<AgentToolResult> => tool.call({
    canvasId: 'c1',
    boardId: 'b1',
    turnIndex,
    provider: 'codex',
    signal: new AbortController().signal,
  }, args);

  return { bindings, call, events, observe, result, service, tool };
}

const ready = {
  status: 'ready',
  changeKind: 'feature',
  risk: 'low',
  impact: 'Checked direct consumers and the neighboring implementation.',
  regression: 'Reviewed state transitions and existing coverage.',
  reviewKind: 'self',
  review: 'Reviewed the final diff for correctness and accidental changes.',
  verification: 'Targeted tests passed.',
};

describe('engineering quality host service', () => {
  it('arms one concrete engineering-closeout binding for source edits but ignores docs-only edits', async () => {
    const h = harness();
    await h.observe('docs', 'Write', { file_path: 'README.md', content: 'docs' });
    expect(h.bindings).toEqual([]);

    await h.observe('failed-edit', 'Edit', { file_path: 'src/domain/failed.ts' });
    expect(h.bindings).toEqual([]);
    await h.result('failed-edit', 'edit failed', true);
    expect(h.bindings).toEqual([]);

    await h.observe('edit', 'FileChange', {
      changes: [{ path: 'src/domain/value.ts', kind: 'update' }],
    });
    expect(h.bindings).toEqual([]);
    await h.result('edit', 'updated', false);
    expect(h.bindings).toHaveLength(1);
    expect(h.bindings[0]).toMatchObject({
      recipeId: 'engineering-closeout',
      target: { canvasId: 'c1', boardId: 'b1', turnIndex: 2 },
      source: { pluginId: 'engineering-quality', kind: 'engineering-quality' },
    });

    await h.observe('edit-2', 'Edit', { file_path: 'src/domain/other.ts' });
    await h.result('edit-2', 'updated', false);
    expect(h.bindings).toHaveLength(1);
  });

  it('rejects a ready stance until a real verification tool result succeeds', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);

    await expect(h.call(ready)).resolves.toMatchObject({
      ok: false,
      result: expect.stringContaining('successful verification'),
    });

    await h.observe('test', 'Bash', { command: 'npm test -- --run src/domain/value.test.ts', action: 'run' });
    await h.result('test', '1 passed', false);
    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });

    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'expect-stance-decided',
        toolId: 'braid.engineering_expect',
        decision: expect.objectContaining({ kind: 'positive', option: 'ready' }),
      }),
      expect.objectContaining({
        type: 'expect-stance-process-evidence-observed',
        source: 'engineering-closeout',
        items: expect.arrayContaining([
          { type: 'source-change', count: 1 },
          { type: 'verification-pass', count: 1 },
        ]),
      }),
    ]));
  });

  it('accepts successful search and verification nested by functions.exec only from trusted result observations', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);

    const execSource = [
      'const [search, verification] = await Promise.all([',
      '  tools.shell_command({ command: "rg -n sameInvariant src" }),',
      '  tools.shell_command({ command: "npx vitest run src/domain/value.test.ts" }),',
      ']);',
      'text(search);',
      'text(verification);',
    ].join('\n');
    const execOutput = [
      'Script completed',
      'Output:',
      'Exit code: 0',
      'src/domain/value.ts:4:sameInvariant',
      'Exit code: 0',
      '1 test passed',
    ].join('\n');

    // The model controls both the freeform JavaScript input and any prose it repeats later. Neither can
    // satisfy an evidence gate without host-observed nested tool results.
    await h.observe('exec-untrusted', 'functions.exec', execSource);
    await h.result('exec-untrusted', execOutput, false);
    const untrusted = await h.call({ ...ready, changeKind: 'bugfix' });
    expect(untrusted).toMatchObject({ ok: false });
    expect(String(untrusted.result)).toMatch(/verification/i);
    expect(String(untrusted.result)).toMatch(/related-surface/i);

    const nestedToolObservations: NestedToolObservation[] = [
      {
        use: {
          toolUseId: 'nested-search',
          toolName: 'shell_command',
          input: { command: 'rg -n sameInvariant src' },
        },
        result: {
          toolUseId: 'nested-search',
          content: 'Exit code: 0\nsrc/domain/value.ts:4:sameInvariant',
          isError: false,
        },
      },
      {
        use: {
          toolUseId: 'nested-verification',
          toolName: 'shell_command',
          input: { command: 'npx vitest run src/domain/value.test.ts' },
        },
        result: {
          toolUseId: 'nested-verification',
          content: 'Exit code: 0\n1 test passed',
          isError: false,
        },
      },
    ];
    await h.observe('exec-mismatched', 'functions.exec', execSource);
    await h.result('exec-mismatched', execOutput, false, 2, [{
      use: nestedToolObservations[0]!.use,
      result: { ...nestedToolObservations[0]!.result, toolUseId: 'different-child' },
    }]);
    await expect(h.call({ ...ready, changeKind: 'bugfix' })).resolves.toMatchObject({ ok: false });

    await h.observe('exec-trusted', 'functions.exec', execSource);
    await h.result('exec-trusted', execOutput, false, 2, nestedToolObservations);

    const trusted = await h.call({ ...ready, changeKind: 'bugfix' });
    expect(trusted, String(trusted.result)).toMatchObject({ ok: true });
  });

  it('exposes every oneOf branch required field to schema consumers through that branch properties', () => {
    const schema = harness().tool.tool.inputSchema;
    expect(schema.oneOf).toHaveLength(3);

    for (const branch of schema.oneOf ?? []) {
      expect(branch.required?.length).toBeGreaterThan(0);
      for (const field of branch.required ?? []) {
        expect(schema.properties, `${field} must have a canonical top-level schema`).toHaveProperty(field);
        expect(branch.properties, `${field} must be visible in its oneOf branch`).toHaveProperty(field);
        expect(branch.properties?.[field]).toEqual(expect.any(Object));
      }
    }

    const readyBranch = schema.oneOf?.find((branch) => branch.properties?.status?.enum?.includes('ready'));
    expect(readyBranch?.properties?.reviewKind?.enum).toEqual(['self', 'independent']);
  });

  it('requires a successful related-surface search before a bugfix can be ready', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call({ ...ready, changeKind: 'bugfix' })).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/related-surface/i),
    });

    await h.observe('search', 'Grep', { pattern: 'sameInvariant', path: 'src' });
    await h.result('search', 'src/domain/value.ts', false);
    await expect(h.call({ ...ready, changeKind: 'bugfix' })).resolves.toMatchObject({ ok: true });
  });

  it('does not reuse a related-surface search from before the latest source change', async () => {
    const h = harness();
    await h.observe('edit-1', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit-1', 'updated', false);
    await h.observe('search', 'Grep', { pattern: 'sameInvariant', path: 'src' });
    await h.result('search', 'src/domain/value.ts', false);
    await h.observe('edit-2', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit-2', 'updated again', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call({ ...ready, changeKind: 'bugfix' })).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/related-surface/i),
    });
  });

  it('requires a reported Reviewer result only when independent review is selected', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('search', 'Grep', { pattern: 'session', path: 'src/engine' });
    await h.result('search', 'matches', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    const highRiskReady = { ...ready, risk: 'high', reviewKind: 'independent' };
    await expect(h.call(highRiskReady)).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/independent-review/i),
    });

    await h.observe('spawn', 'spawn_agent', { profile: 'Reviewer', task: 'Review the implementation.', reportType: 'review' });
    await h.result('spawn', JSON.stringify({ handle: 'reviewer-1' }), false);
    await h.observe('reports', 'agent_reports', {});
    await h.result('reports', JSON.stringify({
      children: [{ handle: 'reviewer-1', profile: { name: 'Reviewer' }, status: 'reported', reportRef: { id: 'review-1' } }],
    }), false);

    await expect(h.call(highRiskReady)).resolves.toMatchObject({ ok: true });
  });

  it('does not reuse an independent review gathered before the latest source change', async () => {
    const h = harness();
    await h.observe('edit-1', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit-1', 'updated', false);
    await h.observe('spawn', 'spawn_agent', { profile: 'Reviewer', task: 'Review the implementation.', reportType: 'review' });
    await h.result('spawn', JSON.stringify({ handle: 'reviewer-1' }), false);
    await h.observe('reports', 'agent_reports', {});
    await h.result('reports', JSON.stringify({
      children: [{ handle: 'reviewer-1', profile: { name: 'Reviewer' }, status: 'reported', reportRef: { id: 'review-1' } }],
    }), false);

    await h.observe('edit-2', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit-2', 'updated again', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call({ ...ready, risk: 'high', reviewKind: 'independent' })).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/independent-review/i),
    });
  });

  it('does not accept a report collected after a new edit when the Reviewer was spawned before that edit', async () => {
    const h = harness();
    await h.observe('edit-1', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit-1', 'updated', false);
    await h.observe('spawn', 'spawn_agent', { profile: 'Reviewer', task: 'Review the implementation.', reportType: 'review' });
    await h.result('spawn', JSON.stringify({ handle: 'reviewer-1' }), false);

    await h.observe('edit-2', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit-2', 'updated again', false);
    await h.observe('reports', 'agent_reports', {});
    await h.result('reports', JSON.stringify({
      children: [{ handle: 'reviewer-1', profile: { name: 'Reviewer' }, status: 'reported', reportRef: { id: 'review-1' } }],
    }), false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call({ ...ready, risk: 'high', reviewKind: 'independent' })).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/independent-review/i),
    });
  });

  it('accepts only the report for a Reviewer spawned against the latest mutation', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('spawn', 'spawn_agent', { profile: 'Reviewer', task: 'Review the implementation.', reportType: 'review' });
    await h.result('spawn', JSON.stringify({ handle: 'reviewer-new' }), false);
    await h.observe('reports-old', 'agent_reports', {});
    await h.result('reports-old', JSON.stringify({
      children: [
        { handle: 'reviewer-old', profile: { name: 'Reviewer' }, status: 'reported', reportRef: { id: 'review-old' } },
        { handle: 'reviewer-new', profile: { name: 'Reviewer' }, status: 'active' },
      ],
    }), false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    const highRiskReady = { ...ready, risk: 'high', reviewKind: 'independent' };
    await expect(h.call(highRiskReady)).resolves.toMatchObject({
      ok: false,
      result: expect.stringMatching(/independent-review/i),
    });

    await h.observe('reports-new', 'agent_reports', {});
    await h.result('reports-new', JSON.stringify({
      children: [{ handle: 'reviewer-new', profile: { name: 'Reviewer' }, status: 'reported', reportRef: { id: 'review-new' } }],
    }), false);
    await expect(h.call(highRiskReady)).resolves.toMatchObject({ ok: true });
  });

  it('allows an honest not-ready stance without fabricated verification evidence', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);

    await expect(h.call({ status: 'not-ready', reason: 'The regression test is still failing.' })).resolves.toMatchObject({ ok: true });
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'expect-stance-decided',
      decision: expect.objectContaining({ kind: 'not-yet', option: 'not-ready' }),
    }));
  });

  it('keeps an unresolved source-change assessment active across a repair turn', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);

    await expect(h.call({ status: 'not-applicable', reason: 'This is a later repair turn.' }, 3)).resolves.toMatchObject({
      ok: false,
      result: expect.stringContaining('cannot be not-applicable'),
    });
  });

  it('preserves successful source-change evidence across an interrupted run', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);
    h.service.onBoardAbort?.({ canvasId: 'c1', boardId: 'b1' });

    await h.observe('test', 'Bash', { command: 'npm test -- --run value', action: 'run' }, 3);
    await h.result('test', 'passed', false, 3);
    await expect(h.call(ready, 3)).resolves.toMatchObject({ ok: true });
  });

  it('re-arms after a successful ready stance when source changes again', async () => {
    const h = harness();
    await h.observe('edit-1', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit-1', 'updated', false);
    await h.observe('test-1', 'Bash', { command: 'npm test -- --run value', action: 'run' });
    await h.result('test-1', 'passed', false);
    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });

    await h.observe('edit-2', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit-2', 'updated again', false);
    expect(h.bindings).toHaveLength(2);
    expect(h.bindings[1]?.bindingId).toContain('recheck-2');
    await expect(h.call(ready)).resolves.toMatchObject({
      ok: false,
      result: expect.stringContaining('successful verification'),
    });

    await h.observe('test-2', 'Bash', { command: 'npm test -- --run value', action: 'run' });
    await h.result('test-2', 'passed', false);
    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });
    await expect(h.call({ status: 'not-applicable', reason: 'A later turn made no source changes.' }, 3)).resolves.toMatchObject({ ok: true });
  });

  it('returns one batched missing checklist instead of only the first gate', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit', 'updated', false);

    const blocked = await h.call({ ...ready, changeKind: 'bugfix', risk: 'high', reviewKind: 'independent' });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.result)).toContain('Missing:');
    expect(String(blocked.result)).toMatch(/verification/i);
    expect(String(blocked.result)).toMatch(/related-surface/i);
    expect(String(blocked.result)).toMatch(/independent-review/i);
    expect(String(blocked.result)).toMatch(/Do every missing item/i);
  });

  it('allows explicitly high-risk work to close with self review without spawning a Reviewer', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    const result = await h.call({
      ...ready,
      risk: 'high',
      reviewKind: 'self',
      review: 'Checked the final diff directly; no separate Reviewer was needed.',
    });
    expect(result).toMatchObject({ ok: true });
    const payload = JSON.parse(String(result.result));
    expect(payload.degraded).toBe(false);
    expect(payload.limitations).toEqual([]);
  });

  it('does not infer risk from sensitive-looking path names', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/engine/session.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });
  });

  it('does not infer risk from the number of changed files', async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      const id = `edit-${index}`;
      await h.observe(id, 'Edit', { file_path: `src/domain/value-${index}.ts` });
      await h.result(id, 'updated', false);
    }
    await h.observe('test', 'Bash', { command: 'npm test', action: 'run' });
    await h.result('test', 'passed', false);

    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });
  });

    it('opens a fresh evidence contract when an adversarial pass revises an earlier ready stance', async () => {
    const h = harness();
    await h.observe('edit', 'Edit', { file_path: 'src/domain/value.ts' });
    await h.result('edit', 'updated', false);
    await h.observe('test', 'Bash', { command: 'npm test -- --run value', action: 'run' });
    await h.result('test', 'passed', false);
    await expect(h.call(ready)).resolves.toMatchObject({ ok: true });

    await expect(h.call({
      status: 'not-ready',
      reason: 'The adversarial pass showed this is a bugfix and needs a related-surface search.',
    }, 3)).resolves.toMatchObject({ ok: true });
    expect(h.bindings).toHaveLength(2);
    expect(h.bindings[1]?.bindingId).toContain('recheck-2');

    await h.observe('search', 'Grep', { pattern: 'sameInvariant', path: 'src' }, 3);
    await h.result('search', 'src/domain/value.ts', false, 3);
    await expect(h.call({ ...ready, changeKind: 'bugfix' }, 3)).resolves.toMatchObject({ ok: true });
  });
});
