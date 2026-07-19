import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentToolPlugin, HostServiceContext, ToolMiddlewarePlugin } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import type { ObligationBinding, ObligationLedgerEvent } from '../../../src/obligations';
import type { HostStructuredChangeReceipt } from '../../../src/changeEvidence/types';
import { ChangeEvidenceCoordinator } from '../../../src/app/changeEvidenceCoordinator';
import { engineeringQualityHostServicePlugin } from './service';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const strategy = {
  status: 'strategy', changeKind: 'feature', risk: 'low', problem: 'Owner misses an invariant.',
  rootCause: 'The current owner lacks the check.', owner: 'src/domain/value.ts', architectureSignals: ['none'],
  approach: 'localized', evidence: ['src/domain/value.ts:1'], scopePaths: ['src/domain'],
  targetInvariants: ['The owner preserves the value invariant.'], verificationPlan: 'Run focused checks.',
  containment: 'The existing owner remains authoritative.',
};
const ready = {
  status: 'ready', changeKind: 'feature', risk: 'low', reviewKind: 'self', strategyRevision: 1,
  impact: 'Checked direct consumers.', regression: 'Checked nearby states.', review: 'Reviewed implementation.',
  verification: 'Focused verification passed.', changeReview: 'Reviewed the current final change evidence.',
};

function harness(observer = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-quality-'));
  roots.push(root);
  const bindings: ObligationBinding[] = []; const events: ObligationLedgerEvent[] = [];
  const evidence = new ChangeEvidenceCoordinator({ cwd: () => root, ...(observer ? { workspaceObserver: { recover: (_scope, ids) => ids.map((receiptId) => ({ receiptId, coverage: 'complete' as const, operations: [{ surfaceId: 'src/recovered.ts', operation: 'update' as const }], contentEvidence: [{ kind: 'neutral-patch' as const, surfaceId: 'src/recovered.ts', reference: '@@ recovered @@' }] })) } } : {}) });
  const host = {
    cwd: () => root,
    attachBinding: (binding: ObligationBinding) => { bindings.push(binding); return { obligationId: binding.bindingId, bindingId: binding.bindingId, recipeId: binding.recipeId }; },
    recordObligationEvent: (event: ObligationLedgerEvent) => events.push(event),
  } as HostServiceContext;
  const service = engineeringQualityHostServicePlugin.create(host);
  const middleware = service.toolMiddleware?.()[0] as ToolMiddlewarePlugin;
  const tool = service.agentTools?.().find((entry) => entry.tool.name === 'engineering_expect') as AgentToolPlugin<Record<string, unknown>>;
  const base = { canvasId: 'c', boardId: 'b', turnIndex: 1, provider: 'codex' as const };
  const call = (input: Record<string, unknown>): Promise<AgentToolResult> => tool.call({ ...base, signal: new AbortController().signal }, input);
  const use = async (id: string, name: string, input: unknown) => {
    const projection = evidence.observeToolUse({ ...base, toolUseId: id, toolName: name, toolInput: input });
    await middleware.observeToolUse?.({ ...base, source: 'observed', toolUseId: id, toolName: name, input, changeEvidence: projection });
  };
  const result = async (id: string, content = 'ok', isError = false, receipt?: HostStructuredChangeReceipt) => {
    const projection = evidence.observeToolResult({ ...base, toolUseId: id, isError, ...(receipt ? { structuredChangeReceipt: receipt } : {}) });
    await middleware.observeToolResult?.({ ...base, toolUseId: id, content, isError, changeEvidence: projection });
  };
  const mutate = async (id = 'edit', surface = 'src/domain/value.ts', options: Partial<HostStructuredChangeReceipt> = {}) => {
    await use(id, 'FileChange', { changes: [{ path: surface, kind: 'update' }] });
    await result(id, 'updated', false, { schemaVersion: 1, effect: 'changed', boundary: 'closed', operations: [{ surfaceId: surface, operation: 'update' }], contentEvidence: [{ kind: 'final-content', surfaceId: surface, reference: 'export const value = 1;' }], ...options });
  };
  const search = async (id = 'search') => {
    await use(id, 'Grep', { pattern: 'value', path: 'src' });
    await result(id, 'found', false, { schemaVersion: 1, effect: 'none', boundary: 'closed', operations: [] });
  };
  const verify = async (id = 'verify', hostAttested = true) => {
    await use(id, 'Bash', { command: 'npx vitest run value.test.ts' });
    await result(id, 'passed', false, hostAttested ? { schemaVersion: 1, effect: 'none', boundary: 'closed', operations: [] } : undefined);
  };
  const declare = async (overrides: Record<string, unknown> = {}) => { const out = await call({ ...strategy, ...overrides }); expect(out.ok).toBe(true); return JSON.parse(String(out.result)).strategyRevision as number; };
  const reassess = async () => {
    const out = await call({ ...strategy, status: 'reassess', disposition: 'revise', reassessment: 'Observed source mutation requires a current strategy.' });
    expect(out.ok, String(out.result)).toBe(true); return JSON.parse(String(out.result)).strategyRevision as number;
  };
  const gate = (name: string, input: unknown) => middleware.gateToolUse?.({ ...base, source: 'preToolUse', toolName: name, input });
  return { bindings, call, declare, evidence, events, gate, mutate, reassess, result, search, service, tool, use, verify };
}

describe('engineering quality neutral evidence consumer', () => {
  it('keeps green verification distinct from the required final change review', async () => {
    const h = harness(); const revision = await h.declare(); await h.mutate(); await h.verify();
    await expect(h.call({ ...ready, strategyRevision: revision, changeReview: '' })).resolves.toMatchObject({ ok: false, result: expect.stringMatching(/changeReview|final-change-review/i) });
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
    expect(h.events.some((event) => event.type === 'expect-stance-process-evidence-observed' && event.items.some((item) => item.type === 'final-change-review'))).toBe(true);
  });

  it('does not let opaque evidence-gathering receipts self-lock an otherwise reviewed change', async () => {
    const h = harness(); const revision = await h.declare(); await h.mutate();
    await h.use('opaque-search', 'Bash', { command: 'rg -n "value" src/domain' });
    await h.result('opaque-search', 'src/domain/value.ts:1');
    await h.verify('opaque-verify', false);
    expect(h.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence.unresolvedReceiptIds).not.toHaveLength(0);
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('keeps a scoped strategy current across in-scope source mutations', async () => {
    const h = harness();
    const revision = await h.declare();
    await h.mutate('first'); await h.mutate('second'); await h.verify('verify');
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it.each(['path-only', 'hash-only', 'failed', 'aborted', 'opaque', 'incomplete'])('fails closed for %s evidence without legacy terminology', async (kind) => {
    const h = harness();
    if (kind === 'aborted') { await h.use('x', 'FileChange', { changes: [{ path: 'src/domain/value.ts', kind: 'update' }] }); h.evidence.observeAbortedTool({ canvasId: 'c', boardId: 'b', turnIndex: 1, toolUseId: 'x' }); }
    else if (kind === 'opaque' || kind === 'incomplete') { await h.use('x', 'UnknownTool', {}); await h.result('x', 'unknown', false); }
    else if (kind === 'failed') { await h.use('x', 'FileChange', { changes: [{ path: 'src/domain/value.ts', kind: 'update' }] }); await h.result('x', 'failed', true); }
    else await h.mutate('x', 'src/domain/value.ts', { contentEvidence: kind === 'hash-only' ? [{ kind: 'hash', surfaceId: 'src/domain/value.ts', reference: 'abc' }] : [] });
    const out = await h.call({ ...ready, strategyRevision: 1 }); expect(out.ok).toBe(false);
  });

  
  it('receipt-less engineering_expect empty-ops opaque stays local; none/closed does not advance workspace currentness', async () => {
    const stale = harness();
    const revision = await stale.declare();
    await stale.mutate(); await stale.search(); await stale.verify();
    await expect(stale.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
    const before = stale.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence;
    await stale.use('ready-self', 'braid__engineering_expect', { status: 'ready' });
    await stale.result('ready-self', 'ok', false);
    const afterOpaque = stale.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence;
    // Empty-ops opaque must not fan out workspace currentness (multi-board freeze / settle loop).
    expect(afterOpaque.currentnessToken).toBe(before.currentnessToken);

    const stable = harness();
    const rev2 = await stable.declare();
    await stable.mutate(); await stable.search(); await stable.verify();
    await expect(stable.call({ ...ready, strategyRevision: rev2 })).resolves.toMatchObject({ ok: true });
    const before2 = stable.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence.currentnessToken;
    await stable.use('ready-self', 'braid__engineering_expect', { status: 'ready' });
    await stable.result('ready-self', 'ok', false, { schemaVersion: 1, effect: 'none', boundary: 'closed', operations: [] });
    const afterNone = stable.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence.currentnessToken;
    expect(afterNone).toBe(before2);
  });

it('keeps effect-none observations from staling a completed identity', async () => {
    const h = harness(); await h.declare(); await h.mutate(); const revision = await h.reassess(); await h.search(); await h.verify();
    const before = h.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence.currentnessToken;
    await h.use('stance', 'braid__engineering_expect', { status: 'not-ready', reason: 'separate stance' });
    await h.result('stance', 'ok', false, { schemaVersion: 1, effect: 'none', boundary: 'closed', operations: [] });
    const after = h.evidence.projectionFor({ canvasId: 'c', boardId: 'b', turnIndex: 1 }).finalEvidence.currentnessToken;
    expect(after).toBe(before); await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('denies obvious preflight scope escapes and accepts a recovery strategy after an observed mutation', async () => {
    const h = harness(); await h.declare({ scopePaths: ['src/domain'] });
    expect(h.gate('FileChange', { changes: [{ path: 'src/elsewhere.ts', kind: 'update' }] })).toMatchObject({ deny: true });
    const late = harness(); await late.mutate();
    await expect(late.call({ ...strategy, status: 'strategy' })).resolves.toMatchObject({ ok: true });
  });

  it('does not let a verification receipt itself create a deadlocked opaque mutation', async () => {
    const h = harness(); await h.declare(); await h.mutate(); const revision = await h.reassess(); await h.search(); await h.verify();
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('accepts receipt-less verification attestation only when a separate final review is present', async () => {
    const h = harness(); const revision = await h.declare(); await h.mutate(); await h.search(); await h.verify('receiptless-verify', false);
    await expect(h.call({ ...ready, strategyRevision: revision, changeReview: '' })).resolves.toMatchObject({ ok: false, result: expect.stringMatching(/changeReview|final-change-review/i) });
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('allows known closed documentation work to be not-applicable but rejects opaque applicability', async () => {
    const docs = harness(); await docs.mutate('docs', 'README.md');
    await expect(docs.call({ status: 'not-applicable', reason: 'Documentation only.' })).resolves.toMatchObject({ ok: true });
    const opaque = harness(); await opaque.use('unknown', 'UnknownTool', {}); await opaque.result('unknown');
    await expect(opaque.call({ status: 'not-applicable', reason: 'Assumed prose.' })).resolves.toMatchObject({ ok: false });
  });

  it('reopens after a new identity and remains completable after explicit not-ready', async () => {
    const h = harness(); let revision = await h.declare(); await h.mutate(); await h.search(); await h.verify(); await h.call({ ...ready, strategyRevision: revision });
    await h.mutate('next'); await h.search('next-search');
    await expect(h.call({ ...strategy, status: 'reassess', disposition: 'revise', reassessment: 'New mutation has fresh evidence.' })).resolves.toMatchObject({ ok: true });
    await h.search('reassessed-search'); await h.verify('reassessed-verify');
    await expect(h.call({ status: 'not-ready', reason: 'Need another check.' })).resolves.toMatchObject({ ok: true });
  });

  it('does not reopen closeout after ready when only opaque verification/search advances identity', async () => {
    const h = harness();
    const revision = await h.declare();
    await h.mutate();
    await h.search();
    await h.verify();
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
    const bindingCount = h.bindings.length;
    // Production settle path re-runs vitest/rg without host-attested none receipts.
    await h.verify('post-ready-verify', false);
    await h.use('post-ready-rg', 'Bash', { command: 'rg -n "value" src/domain' });
    await h.result('post-ready-rg', 'src/domain/value.ts:1');
    expect(h.bindings.some((binding) => String(binding.bindingId).includes('recheck'))).toBe(false);
    expect(h.bindings.length).toBe(bindingCount);
    // Ready stance remains usable under the advanced identity without a fresh recheck obligation.
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('still reopens closeout after ready when a real engineering-surface mutation arrives', async () => {
    const h = harness();
    const revision = await h.declare();
    await h.mutate();
    await h.search();
    await h.verify();
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
    await h.mutate('after-ready');
    expect(h.bindings.some((binding) => String(binding.bindingId).includes('recheck'))).toBe(true);
  });

  it('requires current independent Reviewer identity while allowing self review', async () => {
    const h = harness(); await h.declare(); await h.mutate(); const revision = await h.reassess(); await h.search(); await h.verify();
    await expect(h.call({ ...ready, strategyRevision: revision, reviewKind: 'independent' })).resolves.toMatchObject({ ok: false, result: expect.stringMatching(/independent-review/i) });
    await expect(h.call({ ...ready, strategyRevision: revision })).resolves.toMatchObject({ ok: true });
  });

  it('exposes only changeReview and final-change-review in the agent contract', () => {
    const h = harness(); const schema = JSON.stringify(h.tool.tool.inputSchema);
    expect(schema).toContain('changeReview'); expect(schema).not.toContain(['diff', 'Review'].join(''));
  });
});
