import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MEMORY_COMPLETE_CATALOG_THRESHOLD, memoryHostServicePlugin } from './service';
import { memoryPaths, readCanonicalMemorySnapshot, readMemoryStore, recordMemoryUsage, writeArtifactMemoryStore } from './storage';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { ArtifactStore, setArtifactStoreIndexWriteForTest } from '../../../src/persistence/artifactStore';
import { auditObligation, type Obligation } from '../../../src/obligations';
import { applyDirectSupersession, birthMemoryEnvelope, emptyMemoryStore, recordMemoryEnvelope, type MemoryStore } from './model';

const semanticBackend = vi.hoisted(() => ({
  matches: [] as { id: string; score: number; modelFingerprint?: string }[],
  failure: undefined as unknown,
  failureAt: undefined as 'describe' | 'prepare' | 'query' | undefined,
  onPrepare: undefined as (() => void) | undefined,
  prepareGate: undefined as Promise<void> | undefined,
  prepareStarted: undefined as (() => void) | undefined,
  disposeGate: undefined as Promise<void> | undefined,
  disposeStarted: undefined as (() => void) | undefined,
  instances: [] as { fingerprint: string; dispose: ReturnType<typeof vi.fn> }[],
}));

vi.mock('./semantic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./semantic')>();
  class TestSemanticSource {
    private readonly fingerprint: string;
    readonly dispose = vi.fn(async () => {
      semanticBackend.disposeStarted?.();
      await semanticBackend.disposeGate;
    });

    constructor(options: { modelFingerprint?: string } = {}) {
      this.fingerprint = options.modelFingerprint?.trim() || 'deterministic-session-v1';
      semanticBackend.instances.push({ fingerprint: this.fingerprint, dispose: this.dispose });
    }

    describe() {
      if (semanticBackend.failure !== undefined && semanticBackend.failureAt === 'describe') throw semanticBackend.failure;
      return { kind: 'deterministic-session' as const, cache: 'session' as const, modelFingerprint: this.fingerprint, candidateNotTruth: true as const };
    }

    async prepare(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      semanticBackend.onPrepare?.();
      semanticBackend.prepareStarted?.();
      await semanticBackend.prepareGate;
      if (semanticBackend.failure !== undefined && (semanticBackend.failureAt === undefined || semanticBackend.failureAt === 'prepare')) throw semanticBackend.failure;
    }

    async query(): Promise<readonly { id: string; score: number; modelFingerprint?: string }[]> {
      if (semanticBackend.failure !== undefined && (semanticBackend.failureAt === undefined || semanticBackend.failureAt === 'query')) throw semanticBackend.failure;
      return semanticBackend.matches.map((match) => ({ ...match, modelFingerprint: match.modelFingerprint ?? this.fingerprint }));
    }
  }
  return { ...actual, DeterministicSessionSemanticCandidateSource: TestSemanticSource };
});

function makeHarness(project: string, readPluginConfig?: NonNullable<HostServiceContext['readPluginConfig']>) {
  const attachedObligations: Obligation[] = [];
  const snapshots = new Map<string, any>();
  const events: any[] = [];
  let publishes = 0;
  const ctx: HostServiceContext = {
    cwd: () => project,
    ...(readPluginConfig ? { readPluginConfig } : {}),
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    agentIdForBoard: () => undefined,
    deliverLiveAgentMessage: async () => false,
    publishWorkspaceState: ({ canvasIds, snapshotForCanvas }) => {
      publishes += 1;
      for (const canvasId of canvasIds) snapshots.set(canvasId, snapshotForCanvas(canvasId));
    },
    publishWorkspaceEvent: (event) => { events.push(event); },
    attachObligation: (obligation) => {
      attachedObligations.push(obligation);
      return { obligationId: obligation.id };
    },
  };
  const service = memoryHostServicePlugin.create(ctx);
  const tools = service.agentTools?.() ?? [];
  const byName = new Map(tools.map((tool) => [tool.tool.name, tool as AgentToolPlugin<Record<string, unknown>>]));
  const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<AgentToolResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.call({ canvasId: 'c1', boardId: 'b1', turnIndex: 0, provider: 'claude', signal }, args);
  };
  const turnContext = async (canvasId = 'c1', boardId = 'b1') =>
    await service.turnContext?.()[0]?.provideTurnContext({ canvasId, boardId, provider: 'claude' }) ?? null;
  const workspaceHandler = service.webviewMessages?.()[0];
  const workspaceAction = async (message: any) => {
    if (!workspaceHandler) throw new Error('missing memory inspection workspace handler');
    return workspaceHandler.handleMessage({ canvasId: 'c1', message });
  };
  return { service, call, tools, turnContext, attachedObligations, snapshots, events, workspaceAction, publishCount: () => publishes };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('memory host service', () => {
  it('makes configured project-cache unavailability visible while caller-off remains lexical-first', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-semantic-unavailable-'));
    try {
      const config = { mode: 'local-experimental', cache: 'project' };
      const harness = makeHarness(project, () => ({ enabled: true, config }));
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Unavailable semantic target', content: 'A lexical target remains available.',
        evidenceLocators: 'test:semantic-unavailable', recallCue: 'When project semantic cache is unavailable.', provenance: 'service.test',
      });

      await expect(harness.call('memory_recall', { query: 'lexical target', semantic: 'configured' }))
        .resolves.toMatchObject({ ok: true, result: expect.stringContaining('project-cache-unavailable') });
      await expect(harness.call('memory_recall', { query: 'lexical target', semantic: 'off' }))
        .resolves.toMatchObject({ ok: true, result: expect.stringContaining('Unavailable semantic target') });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('cancels an aborted recall queued behind semantic work even when semantic is explicitly off', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-semantic-queued-abort-'));
    const gate = deferred();
    const started = deferred();
    semanticBackend.prepareGate = gate.promise;
    semanticBackend.prepareStarted = started.resolve;
    semanticBackend.instances = [];
    try {
      const config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'queued-abort' };
      const harness = makeHarness(project, () => ({ enabled: true, config }));
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Queued abort target', content: 'A queued abort must never return a late lexical result.',
        evidenceLocators: 'test:semantic-queued-abort', recallCue: 'When recall is aborted while queued.', provenance: 'service.test',
      });
      const active = harness.call('memory_recall', { query: 'queued abort', semantic: 'configured' });
      await started.promise;
      const controller = new AbortController();
      const queued = harness.call('memory_recall', { query: 'queued abort', semantic: 'off' }, controller.signal);
      const abort = new Error('queued caller abort');
      controller.abort(abort);
      gate.resolve();

      await expect(active).resolves.toMatchObject({ ok: true });
      await expect(queued).rejects.toBe(abort);
    } finally {
      semanticBackend.prepareGate = undefined;
      semanticBackend.prepareStarted = undefined;
      semanticBackend.instances = [];
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not publish a semantic recall result once disposal races an in-flight source replacement', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-semantic-dispose-race-'));
    const gate = deferred();
    const started = deferred();
    semanticBackend.instances = [];
    try {
      let config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'old-source' };
      const harness = makeHarness(project, () => ({ enabled: true, config }));
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Dispose race target', content: 'No semantic result may arrive after disposal starts.',
        evidenceLocators: 'test:semantic-dispose-race', recallCue: 'When source replacement races disposal.', provenance: 'service.test',
      });
      await expect(harness.call('memory_recall', { query: 'dispose race', semantic: 'configured' })).resolves.toMatchObject({ ok: true });
      config = { ...config, modelFingerprint: 'replacement-source' };
      semanticBackend.prepareGate = gate.promise;
      semanticBackend.prepareStarted = started.resolve;
      const replacement = harness.call('memory_recall', { query: 'dispose race', semantic: 'configured' });
      await started.promise;
      const disposing = harness.service.dispose?.();
      gate.resolve();

      await expect(replacement).rejects.toThrow('disposed');
      await disposing;
      expect(semanticBackend.instances.map((instance) => instance.fingerprint)).toEqual(['old-source', 'replacement-source']);
      expect(semanticBackend.instances[0].dispose).toHaveBeenCalledOnce();
      expect(semanticBackend.instances[1].dispose).toHaveBeenCalledOnce();
    } finally {
      semanticBackend.prepareGate = undefined;
      semanticBackend.prepareStarted = undefined;
      semanticBackend.instances = [];
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('preserves the exact explicit-off lexical result for every backend-local semantic failure', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-semantic-backend-fallback-'));
    semanticBackend.instances = [];
    try {
      const config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'fallback-source' };
      const lexicalHarness = makeHarness(project, () => ({ enabled: true, config }));
      await lexicalHarness.call('memory_record', {
        verb: 'lesson', title: 'Backend lexical target', content: 'The lexical result must survive a local backend failure.',
        evidenceLocators: 'test:semantic-backend-fallback', recallCue: 'When a backend-local semantic stage fails.', provenance: 'service.test',
      });
      const baseline = await lexicalHarness.call('memory_recall', { query: 'backend lexical', semantic: 'off' });

      for (const failureAt of ['prepare', 'query', 'describe'] as const) {
        const configuredHarness = makeHarness(project, () => ({ enabled: true, config }));
        semanticBackend.failure = new Error(`backend-local-${failureAt}`);
        semanticBackend.failureAt = failureAt;
        await expect(configuredHarness.call('memory_recall', { query: 'backend lexical', semantic: 'configured' })).resolves.toEqual(baseline);
        expect(semanticBackend.instances.at(-1)?.dispose).not.toHaveBeenCalled();
        semanticBackend.failure = undefined;
        semanticBackend.failureAt = undefined;
        await configuredHarness.service.dispose?.();
        expect(semanticBackend.instances.at(-1)?.dispose).toHaveBeenCalledOnce();
      }
    } finally {
      semanticBackend.failure = undefined;
      semanticBackend.failureAt = undefined;
      semanticBackend.instances = [];
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps project-cache unavailability observable without discarding the lexical recall', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-project-cache-lexical-'));
    semanticBackend.instances = [];
    try {
      const harness = makeHarness(project, () => ({ enabled: true, config: { mode: 'local-experimental', cache: 'project' } }));
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Project cache lexical target', content: 'Unavailable project cache must retain this lexical body.',
        evidenceLocators: 'test:project-cache-lexical', recallCue: 'When project cache is unavailable.', provenance: 'service.test',
      });
      const baseline = await harness.call('memory_recall', { query: 'project cache lexical', semantic: 'off' });
      const unavailable = await harness.call('memory_recall', { query: 'project cache lexical', semantic: 'configured' });

      expect(unavailable).toMatchObject({ ok: true, result: expect.stringContaining('project-cache-unavailable') });
      expect(unavailable.result).toContain(baseline.result);
      expect(unavailable.result).not.toContain('source=semantic/');
      expect(unavailable.result).not.toContain('candidate-not-truth');
      expect(semanticBackend.instances).toEqual([]);
    } finally {
      semanticBackend.instances = [];
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('awaits a cleared previous source disposal before service disposal settles', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-replacement-dispose-settlement-'));
    const disposeGate = deferred();
    const disposeStarted = deferred();
    semanticBackend.instances = [];
    try {
      let config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'old-deferred-source' };
      const harness = makeHarness(project, () => ({ enabled: true, config }));
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Deferred disposal target', content: 'The replacement cleanup must complete before service disposal settles.',
        evidenceLocators: 'test:replacement-dispose-settlement', recallCue: 'When service disposal races source replacement cleanup.', provenance: 'service.test',
      });
      await expect(harness.call('memory_recall', { query: 'deferred disposal', semantic: 'configured' })).resolves.toMatchObject({ ok: true });

      semanticBackend.disposeGate = disposeGate.promise;
      semanticBackend.disposeStarted = disposeStarted.resolve;
      config = { ...config, modelFingerprint: 'replacement-after-clear' };
      const replacement = harness.call('memory_recall', { query: 'deferred disposal', semantic: 'configured' });
      await disposeStarted.promise;
      let serviceDisposeSettled = false;
      const serviceDisposal = harness.service.dispose?.().then(() => { serviceDisposeSettled = true; });
      await Promise.resolve();
      expect(serviceDisposeSettled).toBe(false);

      disposeGate.resolve();
      await expect(replacement).rejects.toThrow('disposed');
      await serviceDisposal;
      expect(serviceDisposeSettled).toBe(true);
      expect(semanticBackend.instances.map((instance) => instance.fingerprint)).toEqual(['old-deferred-source']);
      expect(semanticBackend.instances[0].dispose).toHaveBeenCalledOnce();
      expect(harness.publishCount()).toBe(1);
    } finally {
      semanticBackend.disposeGate = undefined;
      semanticBackend.disposeStarted = undefined;
      semanticBackend.instances = [];
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reads C0.2 semantic config at every recall, preserves lexical parity when not admitted, and owns session source lifecycle', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-semantic-service-'));
    semanticBackend.matches = [];
    semanticBackend.failure = undefined;
    semanticBackend.onPrepare = undefined;
    semanticBackend.instances = [];
    try {
      let config: unknown = { mode: 'off', cache: 'session' };
      const readPluginConfig = vi.fn((_pluginId: string, fallback: unknown) => ({ enabled: true, config: config ?? fallback }));
      const harness = makeHarness(project, readPluginConfig);
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Lexical query target', content: 'lexical query evidence', evidenceLocators: 'test:semantic-lexical',
        recallCue: 'When lexical query must remain first.', provenance: 'service.test',
      });
      await harness.call('memory_record', {
        verb: 'lesson', title: 'Semantic-only target', content: 'unrelated durable content', evidenceLocators: 'test:semantic-only',
        recallCue: 'When a local semantic candidate is appended.', provenance: 'service.test',
      });
      const records = (await readMemoryStore(project)).records;
      const lexicalId = records.find((record) => record.title === 'Lexical query target')!.id;
      const semanticId = records.find((record) => record.title === 'Semantic-only target')!.id;
      const lexical = await harness.call('memory_recall', { query: 'lexical query', limit: '5' });

      expect(lexical).toMatchObject({ ok: true });
      expect(semanticBackend.instances).toEqual([]);
      for (const invalidConfig of [undefined, { mode: 'wrong', cache: 'session' }, { mode: 'local-experimental', cache: 'project' }]) {
        config = invalidConfig;
        await expect(harness.call('memory_recall', { query: 'lexical query', limit: '5' })).resolves.toEqual(lexical);
      }
      config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'one' };
      await expect(harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'off' })).resolves.toEqual(lexical);
      expect(semanticBackend.instances).toEqual([]);

      semanticBackend.matches = [{ id: semanticId, score: 1 }];
      const configured = await harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'configured' });
      expect(configured).toMatchObject({ ok: true, result: expect.stringContaining('Semantic expansion is candidate-not-truth; modelFingerprint=one.') });
      expect(configured.result.indexOf('Lexical query target')).toBeLessThan(configured.result.indexOf('Semantic-only target'));
      expect(configured.result).toContain('source=semantic/session-local');
      expect(semanticBackend.instances.map((instance) => instance.fingerprint)).toEqual(['one']);

      await harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'configured' });
      expect(semanticBackend.instances).toHaveLength(1);
      config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'two' };
      await harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'configured' });
      expect(semanticBackend.instances.map((instance) => instance.fingerprint)).toEqual(['one', 'two']);
      expect(semanticBackend.instances[0].dispose).toHaveBeenCalledOnce();

      semanticBackend.failure = new Error('backend-local');
      await expect(harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'configured' }))
        .resolves.toEqual(lexical);
      semanticBackend.failure = undefined;
      config = { mode: 'local-experimental', cache: 'session', modelFingerprint: 'three' };
      const controller = new AbortController();
      const abort = new Error('caller-abort');
      semanticBackend.onPrepare = () => controller.abort(abort);
      await expect(harness.call('memory_recall', { query: 'lexical query', limit: '5', semantic: 'configured' }, controller.signal)).rejects.toBe(abort);
      semanticBackend.onPrepare = undefined;
      await harness.service.dispose?.();
      expect(semanticBackend.instances[1].dispose).toHaveBeenCalledOnce();
      expect(semanticBackend.instances[2].dispose).toHaveBeenCalledOnce();
      expect(readPluginConfig).toHaveBeenCalledTimes(10);

      const legacy = makeHarness(project);
      await expect(legacy.call('memory_recall', { query: 'lexical query', limit: '5' })).resolves.toEqual(lexical);
      expect(semanticBackend.instances).toHaveLength(3);
      expect(lexical.result).toContain(`memory:${lexicalId}`);
    } finally {
      semanticBackend.matches = [];
      semanticBackend.failure = undefined;
      semanticBackend.onPrepare = undefined;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records class-verb memories to project-local storage and recalls after service recreation', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-service-'));
    try {
      const first = makeHarness(project);
      await expect(first.call('memory_record', {
        verb: 'lesson',
        title: 'Memory persistence',
        content: 'Records survive host service recreation.',
        evidenceLocators: 'test:memory-service',
        recallCue: 'When checking memory persistence across host recreation.',
        provenance: 'service.test',
        scope: 'tests',
        tags: 'persistence',
      })).resolves.toMatchObject({ ok: true });

      const paths = memoryPaths(project);
      expect(fs.existsSync(paths.file)).toBe(false);
      const stored = await readMemoryStore(project);
      expect(stored.records[0]).toMatchObject({
        verb: 'lesson',
        corpusClass: 4,
        status: 'current',
        freshness: 'unverified',
        evidenceLocators: ['test:memory-service'],
      });
      expect(fs.existsSync(paths.dir) ? fs.readdirSync(paths.dir).some((name) => name.endsWith('.md')) : false).toBe(false);
      await expect(ArtifactStore.forWorkspace(project).readPayload({
        id: stored.records[0].id,
        class: 'declared',
        dataType: 'memory-record',
        version: 1,
        mime: 'application/json',
        producer: { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' },
        label: stored.records[0].title,
      })).resolves.toMatchObject({ text: expect.stringContaining('Records survive host service recreation.') });

      const second = makeHarness(project);
      await expect(second.call('memory_recall', {
        query: 'service recreation persistence',
        scope: 'tests',
        limit: '3',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Memory persistence'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('surfaces birth-gate rejections and rejects free class/type arguments', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-reject-'));
    try {
      const service = makeHarness(project);

      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Missing evidence',
        content: 'This should not be born.',
        recallCue: 'When a lesson lacks evidence.',
        provenance: 'service.test',
      })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('lesson.evidenceLocators.required'),
      });

      await expect(service.call('memory_record', {
        verb: 'locator',
        title: 'Class injection',
        locator: 'docs/example.md',
        recallCue: 'When a caller tries to set class.',
        provenance: 'service.test',
        class: '2',
        type: 'caller-picked',
      })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('class.forbidden'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('updates routing status without rewriting the memory body', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-status-'));
    try {
      const service = makeHarness(project);
      const created = await service.call('memory_record', {
        verb: 'lesson',
        title: 'Status transition target',
        content: 'Body should stay unchanged.',
        evidenceLocators: 'test:status',
        recallCue: 'When checking status transitions.',
        provenance: 'service.test',
      });
      expect(created.ok).toBe(true);
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();

      await expect(service.call('memory_record', {
        action: 'status',
        id,
        status: 'disputed',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('disputed'),
      });

      const raw = await readMemoryStore(project);
      expect(raw.records[0]).toMatchObject({
        id,
        status: 'disputed',
        content: 'Body should stay unchanged.',
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('accepts canonical memory references for get and status transitions', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-canonical-ref-'));
    try {
      const service = makeHarness(project);
      const created = await service.call('memory_record', {
        verb: 'lesson', title: 'Canonical reference target', content: 'Canonical ids work on service paths.',
        evidenceLocators: 'test:canonical-ref', recallCue: 'When a memory id uses its canonical prefix.', provenance: 'service.test',
      });
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();
      await expect(service.call('memory_get', { id: `memory:${id}` })).resolves.toMatchObject({
        ok: true, result: expect.stringContaining('Canonical reference target'),
      });
      await expect(service.call('memory_record', { action: 'status', id: `memory:${id}`, status: 'disputed' }))
        .resolves.toMatchObject({ ok: true, result: expect.stringContaining('disputed') });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('cascades a successor to its prior record in one write and rejects missing priors without persistence', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-supersession-'));
    try {
      const service = makeHarness(project);
      const prior = await service.call('memory_record', {
        verb: 'lesson', title: 'Superseded prior', content: 'Prior durable content.', evidenceLocators: 'test:prior',
        recallCue: 'When checking a superseding write.', provenance: 'service.test',
      });
      const priorId = /Braid memory ([^:]+):/.exec(String(prior.result))?.[1];
      expect(priorId).toBeTruthy();
      await expect(service.call('memory_record', {
        verb: 'lesson', title: 'Successor', content: 'Successor durable content.', evidenceLocators: 'test:successor',
        recallCue: 'When checking a superseding write.', provenance: 'service.test', supersedes: `memory:${priorId}`,
      })).resolves.toMatchObject({ ok: true });
      expect((await readMemoryStore(project)).records).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: priorId, status: 'superseded' }),
        expect.objectContaining({ title: 'Successor', supersedes: priorId }),
      ]));

      const count = (await readMemoryStore(project)).records.length;
      await expect(service.call('memory_record', {
        verb: 'lesson', title: 'Rejected successor', content: 'This must not persist.', evidenceLocators: 'test:missing-prior',
        recallCue: 'When a superseded prior is missing.', provenance: 'service.test', supersedes: 'memory:missing-prior',
      })).resolves.toMatchObject({ ok: false, result: expect.stringContaining('supersedes.not_found') });
      expect((await readMemoryStore(project)).records).toHaveLength(count);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('renders recall status, freshness, canonical ids, stale-verification and non-current markers, and demotes superseded records', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-recall-labels-'));
    try {
      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson', title: 'Current lexical target', content: 'shared recall needle', evidenceLocators: 'test:current',
        recallCue: 'When checking recall labels.', provenance: 'service.test', freshness: 'verified', lastVerifiedLocator: 'stale-source.ts',
      })).resolves.toMatchObject({ ok: true });
      const staleSource = path.join(project, 'stale-source.ts');
      fs.writeFileSync(staleSource, 'export {};', 'utf8');
      fs.utimesSync(staleSource, new Date('2030-01-01T00:00:00.000Z'), new Date('2030-01-01T00:00:00.000Z'));
      const older = await service.call('memory_record', {
        verb: 'lesson', title: 'Superseded lexical target', content: 'shared recall needle', evidenceLocators: 'test:superseded',
        recallCue: 'When checking recall labels.', provenance: 'service.test', status: 'superseded',
      });
      const olderId = /Braid memory ([^:]+):/.exec(String(older.result))?.[1];
      const recalled = await service.call('memory_recall', { query: 'shared recall needle', limit: '2' });
      expect(recalled).toMatchObject({ ok: true });
      expect(recalled.result).toContain('status: current');
      expect(recalled.result).toContain('freshness: verified');
      expect(recalled.result).toContain('memory:');
      expect(recalled.result).toContain('†');
      expect(recalled.result).toContain('⚠');
      expect(recalled.result.indexOf('Current lexical target')).toBeLessThan(recalled.result.indexOf(`memory:${olderId}`));
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('records recall usage without changing artifact registry bytes or memory versions', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-recall-readonly-'));
    try {
      const service = makeHarness(project);
      const created = await service.call('memory_record', {
        verb: 'lesson',
        title: 'Read only recall',
        content: 'Recall should not rewrite durable memory content.',
        evidenceLocators: 'test:recall-readonly',
        recallCue: 'When checking recall read-only behavior.',
        provenance: 'service.test',
      });
      expect(created.ok).toBe(true);
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();

      const indexPath = path.join(project, '.braid', 'artifacts', 'index.sqlite');
      const beforeIndex = fs.readFileSync(indexPath);
      const beforeRef = (await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record'))
        .find((ref) => ref.id === id);
      expect(beforeRef?.version).toBe(1);

      await expect(service.call('memory_recall', {
        query: 'read only recall durable content',
        limit: '3',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Read only recall'),
      });

      expect(fs.readFileSync(indexPath).equals(beforeIndex)).toBe(true);
      const afterRef = (await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record'))
        .find((ref) => ref.id === id);
      expect(afterRef?.version).toBe(1);
      const recalled = (await readMemoryStore(project)).records.find((record) => record.id === id);
      expect(recalled?.readCount).toBe(1);
      expect(recalled?.lastReadAt).toBeTruthy();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not treat legacy memories.json as the live memory store', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-v1-read-'));
    try {
      const paths = memoryPaths(project);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.file, JSON.stringify({
        version: 1,
        records: [{
          id: 'legacy-flat',
          title: 'Legacy flat memory',
          content: 'Old v1 records remain readable during the cutover.',
          scope: 'tests',
          tags: ['legacy'],
          evidence: '',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        }],
      }), 'utf8');

      const service = makeHarness(project);
      await expect(service.call('memory_recall', {
        query: 'legacy cutover',
        scope: 'tests',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('No matching Braid memories'),
      });

      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Trigger migration',
        content: 'A new v2 write migrates the old JSON store.',
        evidenceLocators: 'test:v1-migration',
        recallCue: 'When migrating v1 records.',
        provenance: 'service.test',
      })).resolves.toMatchObject({ ok: true });

      expect(fs.existsSync(paths.file)).toBe(true);
      const migrated = await readMemoryStore(project);
      expect(migrated.records.map((record) => record.title)).toEqual(['Trigger migration']);
      expect(fs.existsSync(path.join(paths.dir, 'legacy-flat.md'))).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('migrates legacy markdown memory records into artifact storage before removing markdown files', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-md-migration-'));
    try {
      const paths = memoryPaths(project);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(path.join(paths.dir, 'legacy-lesson.md'), [
        '---',
        'id: mem-legacy-lesson',
        'verb: lesson',
        'corpusClass: 4',
        'provisional: true',
        'status: current',
        'freshness: unverified',
        'scope: legacy-scope',
        'tags:',
        '  - migration',
        'recallCue: When migrating markdown memories.',
        'provenance: legacy-md',
        'evidenceLocators:',
        '  - test:legacy-md',
        'createdAt: 2026-07-01T00:00:00.000Z',
        'updatedAt: 2026-07-01T00:00:00.000Z',
        'readCount: 3',
        'lastReadAt: 2026-07-02T00:00:00.000Z',
        '---',
        '# Legacy Markdown Lesson',
        '',
        'Old markdown memory content must survive the artifact cutover.',
      ].join('\n'), 'utf8');

      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'New artifact memory',
        content: 'A new write triggers legacy markdown migration.',
        evidenceLocators: 'test:new-write',
        recallCue: 'When triggering markdown migration.',
        provenance: 'service.test',
      })).resolves.toMatchObject({ ok: true });

      const migrated = await readMemoryStore(project);
      expect(migrated.records.map((record) => record.title).sort()).toEqual([
        'Legacy Markdown Lesson',
        'New artifact memory',
      ]);
      const legacy = migrated.records.find((record) => record.id === 'mem-legacy-lesson');
      expect(legacy).toMatchObject({
        content: 'Old markdown memory content must survive the artifact cutover.',
        scope: 'legacy-scope',
        tags: ['migration'],
        readCount: 3,
        lastReadAt: '2026-07-02T00:00:00.000Z',
      });
      expect(fs.existsSync(path.join(paths.dir, 'legacy-lesson.md'))).toBe(false);
      await expect(service.call('memory_recall', {
        query: 'markdown cutover survive',
        scope: 'legacy-scope',
        limit: '1',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Legacy Markdown Lesson'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not delete unparsable legacy markdown memory files during cutover', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-md-bad-migration-'));
    try {
      const paths = memoryPaths(project);
      const badFile = path.join(paths.dir, 'bad-memory.md');
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(badFile, [
        '---',
        'id: mem-bad',
        '---',
        '',
      ].join('\n'), 'utf8');

      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Blocked write',
        content: 'This write must not erase an unparsable legacy markdown record.',
        evidenceLocators: 'test:bad-md',
        recallCue: 'When checking failed markdown migration safety.',
        provenance: 'service.test',
      })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('Unable to migrate legacy markdown memory'),
      });
      expect(fs.existsSync(badFile)).toBe(true);
      expect(await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record')).toHaveLength(0);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('versions repeated writes on the same memory artifact id and sweep keeps the GC-root record', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-artifact-version-'));
    try {
      const service = makeHarness(project);
      const input = {
        verb: 'lesson',
        title: 'Versioned memory',
        content: 'First body.',
        evidenceLocators: 'test:v1',
        recallCue: 'When checking memory artifact versions.',
        provenance: 'service.test',
      };
      await expect(service.call('memory_record', input)).resolves.toMatchObject({ ok: true });
      await expect(service.call('memory_record', { ...input, content: 'Second body.', evidenceLocators: 'test:v2' })).resolves.toMatchObject({ ok: true });

      const record = (await readMemoryStore(project)).records[0];
      const ref = {
        id: record.id,
        class: 'declared' as const,
        dataType: 'memory-record',
        version: 2,
        mime: 'application/json',
        producer: { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' },
        label: record.title,
      };
      const paths = memoryPaths(project);
      await expect(ArtifactStore.forWorkspace(project).readPayload(ref)).resolves.toMatchObject({
        text: expect.stringContaining('Second body.'),
      });
      await expect(ArtifactStore.forWorkspace(project).sweepUnreachable([])).resolves.toEqual({ deleted: [], kept: 1 });
      expect(fs.existsSync(paths.dir) ? fs.readdirSync(paths.dir).some((name) => name.endsWith('.md')) : false).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not create a new artifact version for an unchanged memory write', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-unchanged-write-'));
    try {
      const service = makeHarness(project);
      const input = {
        verb: 'lesson',
        title: 'Unchanged memory',
        content: 'The second write is identical.',
        evidenceLocators: 'test:unchanged-write',
        recallCue: 'When checking idempotent memory writes.',
        provenance: 'service.test',
      };
      await expect(service.call('memory_record', input)).resolves.toMatchObject({ ok: true });
      await expect(service.call('memory_record', input)).resolves.toMatchObject({ ok: true });

      const record = (await readMemoryStore(project)).records[0];
      const ref = (await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record'))
        .find((candidate) => candidate.id === record.id);
      expect(ref?.version).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('updates only the changed memory artifact when one record changes', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-incremental-write-'));
    try {
      const service = makeHarness(project);
      const first = {
        verb: 'lesson',
        title: 'Changed memory',
        content: 'First body.',
        evidenceLocators: 'test:first',
        recallCue: 'When checking changed memory versions.',
        provenance: 'service.test',
      };
      const second = {
        verb: 'lesson',
        title: 'Unrelated memory',
        content: 'This body should not be rewritten.',
        evidenceLocators: 'test:second',
        recallCue: 'When checking unrelated memory versions.',
        provenance: 'service.test',
      };
      await expect(service.call('memory_record', first)).resolves.toMatchObject({ ok: true });
      await expect(service.call('memory_record', second)).resolves.toMatchObject({ ok: true });
      const before = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
      expect(before).toHaveLength(2);

      await expect(service.call('memory_record', { ...first, content: 'Second body.', evidenceLocators: 'test:first-updated' }))
        .resolves.toMatchObject({ ok: true });

      const after = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
      const changed = after.find((ref) => ref.label === 'Changed memory');
      const unrelated = after.find((ref) => ref.label === 'Unrelated memory');
      expect(changed?.version).toBe(2);
      expect(unrelated?.version).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('bulk-writes new memory artifacts with one index persist and skips unchanged rewrites', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-batch-new-'));
    try {
      let store: MemoryStore = emptyMemoryStore();
      for (let i = 0; i < 5; i += 1) {
        const born = birthMemoryEnvelope({
          verb: 'lesson',
          title: `Batch New ${i}`,
          content: `Bulk write body ${i}`,
          evidenceLocators: `test:batch-new-${i}`,
          recallCue: `When checking bulk write ${i}.`,
          provenance: `service.test:${i}`,
          status: 'current',
        }, `2026-07-08T00:00:0${i}.000Z`);
        if (!born.ok) throw new Error('unexpected birth failure');
        store = recordMemoryEnvelope(store, born.record, {
          scope: 'batch',
          tags: 'batch-write',
        }, `2026-07-08T00:00:0${i}.000Z`).store;
      }

      let indexWrites = 0;
      const restore = setArtifactStoreIndexWriteForTest(() => { indexWrites += 1; });
      try {
        const written = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
        expect(written.status).toBe('committed');
        if (written.status !== 'committed') throw new Error('unexpected batch write conflict');
        expect(indexWrites).toBe(1);
        const refs = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
        expect(refs).toHaveLength(5);
        expect(refs.every((ref) => ref.version === 1)).toBe(true);

        indexWrites = 0;
        const rewritten = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), written.store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
        expect(rewritten.status).toBe('committed');
        if (rewritten.status !== 'committed') throw new Error('unexpected unchanged rewrite conflict');
        expect(indexWrites).toBe(0);
        expect(rewritten.store.records.map((record) => record.id)).toEqual(written.store.records.map((record) => record.id));
        const after = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
        expect(after.every((ref) => ref.version === 1)).toBe(true);
      } finally {
        restore();
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('bulk-writes mixed changed and unchanged memory artifacts with one persist', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-batch-mixed-'));
    try {
      let store: MemoryStore = emptyMemoryStore();
      for (const title of ['Batch Changed', 'Batch Unchanged']) {
        const born = birthMemoryEnvelope({
          verb: 'lesson',
          title,
          content: `${title} first body.`,
          evidenceLocators: `test:${title.toLowerCase().replace(/\s+/g, '-')}:v1`,
          recallCue: `When checking ${title}.`,
          provenance: 'service.test',
          status: 'current',
        }, '2026-07-08T00:00:00.000Z');
        if (!born.ok) throw new Error('unexpected birth failure');
        store = recordMemoryEnvelope(store, born.record, {
          scope: 'batch',
          tags: 'batch-write',
        }, '2026-07-08T00:00:00.000Z').store;
      }
      const written = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
      expect(written.status).toBe('committed');
      if (written.status !== 'committed') throw new Error('unexpected seed conflict');

      const changedStore: MemoryStore = {
        version: 1,
        records: written.store.records.map((record) => record.title === 'Batch Changed'
          ? {
            ...record,
            content: 'Batch Changed second body.',
            evidence: 'test:batch-changed:v2',
            evidenceLocators: ['test:batch-changed:v2'],
            updatedAt: '2026-07-08T00:01:00.000Z',
          }
          : record),
      };

      let indexWrites = 0;
      const restore = setArtifactStoreIndexWriteForTest(() => { indexWrites += 1; });
      try {
        const changed = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), changedStore, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
        expect(changed.status).toBe('committed');
        expect(indexWrites).toBe(1);
      } finally {
        restore();
      }

      const refs = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
      const changed = refs.find((ref) => ref.label === 'Batch Changed');
      const unchanged = refs.find((ref) => ref.label === 'Batch Unchanged');
      expect(changed?.version).toBe(2);
      expect(unchanged?.version).toBe(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('treats missing or corrupt stores as empty and repairs on the next record', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-corrupt-'));
    try {
      const paths = memoryPaths(project);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.file, '{ not json');

      const service = makeHarness(project);
      await expect(service.call('memory_recall', { query: 'anything' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('No matching Braid memories'),
      });

      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Repair corrupt store',
        content: 'Writing a new memory replaces invalid JSON with a valid store.',
        evidenceLocators: 'test:corrupt-store',
        recallCue: 'When repairing a corrupt memory store.',
        provenance: 'service.test',
      })).resolves.toMatchObject({ ok: true });

      const raw = await readMemoryStore(project);
      expect(raw.records.map((record: any) => record.title)).toEqual(['Repair corrupt store']);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps all memory paths contained under the workspace .braid/memory directory', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-paths-'));
    try {
      const paths = memoryPaths(project);
      const relativeDir = path.relative(project, paths.dir).replace(/\\/g, '/');
      const relativeFile = path.relative(project, paths.file).replace(/\\/g, '/');

      expect(relativeDir).toBe('.braid/memory');
      expect(relativeFile).toBe('.braid/memory/memories.json');
      expect(relativeDir.startsWith('..')).toBe(false);
      expect(relativeFile.startsWith('..')).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('injects a complete compact catalog instead of only protocol text', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-catalog-'));
    try {
      const service = makeHarness(project);
      for (let i = 0; i < 12; i += 1) {
        await expect(service.call('memory_record', {
          verb: 'lesson',
          title: `Catalog Memory ${i}`,
          content: `Body ${i}`,
          evidenceLocators: `test:catalog-${i}`,
          recallCue: `When checking catalog memory ${i}.`,
          provenance: `service.test:${i}`,
          status: 'current',
        })).resolves.toMatchObject({ ok: true });
      }

      const context = await service.turnContext();
      expect(context).toContain('[Braid memory]');
      expect((context?.match(/Catalog Memory \d/g) ?? [])).toHaveLength(12);
      const protocol = context?.split('\n\n', 1)[0] ?? '';
      expect(protocol.length).toBeLessThanOrEqual(360);
      expect(protocol).toContain('memory_recall');
      expect(protocol).toContain('class-bound verbs');
      expect(protocol).toContain('successful memory_record result');
      expect(context).toContain('深读:memory_recall 或 memory id');
      expect(context).not.toContain('type=');
      expect(context).not.toContain('readCount');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('injects bounded overview above the threshold while pull tools reach the needle', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-overview-'));
    try {
      expect(MEMORY_COMPLETE_CATALOG_THRESHOLD).toBe(24);
      let store: MemoryStore = emptyMemoryStore();
      let needleId = '';
      for (let i = 0; i < MEMORY_COMPLETE_CATALOG_THRESHOLD + 5; i += 1) {
        const isNeedle = i === MEMORY_COMPLETE_CATALOG_THRESHOLD + 2;
        const born = birthMemoryEnvelope({
          verb: 'lesson',
          title: isNeedle ? 'Overview Needle Hidden Title' : `Large Hidden ${String(i).padStart(3, '0')}`,
          content: isNeedle
            ? 'The overview-only path must use memory_recall and memory_get to reach this exact record.'
            : `Large overview filler ${i}`,
          evidenceLocators: `test:overview-${i}`,
          recallCue: isNeedle ? 'overview-only needle recall pull get path' : `overview filler ${i}`,
          provenance: `service.test:${i}`,
          status: 'current',
        }, `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`);
        if (!born.ok) throw new Error('unexpected birth failure');
        if (isNeedle) needleId = born.record.id;
        store = recordMemoryEnvelope(store, born.record, {
          scope: isNeedle ? 'needle-scope' : 'bulk-scope',
          tags: isNeedle ? 'needle-tag, overview' : 'bulk-tag, overview',
        }, `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`).store;
      }
      const seeded = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
      expect(seeded.status).toBe('committed');

      const service = makeHarness(project);
      const context = await service.turnContext();
      expect(context).toContain('Braid memory overview');
      expect(context).toContain(`Total: ${MEMORY_COMPLETE_CATALOG_THRESHOLD + 5}`);
      expect(context).toContain('needle-scope');
      expect(context).toContain('needle-tag');
      expect(context).toContain('memory_recall');
      expect(context).toContain('memory_get');
      expect(context).toContain('memory_catalog');
      expect(context).not.toContain('Overview Needle Hidden Title');
      expect(context).not.toContain('Large Hidden 000');
      expect(Buffer.byteLength(context ?? '', 'utf8')).toBeLessThan(20_000);

      await expect(service.call('memory_recall', {
        query: 'overview-only needle recall pull get exact record',
        scope: 'needle-scope',
        limit: '3',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Overview Needle Hidden Title'),
      });
      await expect(service.call('memory_get', { id: needleId })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('overview-only path must use memory_recall'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);

  it('records recall reads privately without surfacing read counts in the catalog', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-read-count-'));
    try {
      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Private read counter',
        content: 'Recall hits should increment read count.',
        evidenceLocators: 'test:read-count',
        recallCue: 'When checking private read counters.',
        provenance: 'service.test',
        status: 'current',
      })).resolves.toMatchObject({ ok: true });

      await expect(service.call('memory_recall', { query: 'private read counter' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Private read counter'),
      });

      const record = (await readMemoryStore(project)).records[0];
      expect(record.readCount).toBe(1);
      await expect(service.turnContext()).resolves.not.toContain('readCount');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('labels weak recall fallback results as candidates with catalog guidance', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-fallback-wording-'));
    try {
      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Fallback wording target',
        content: 'This record is only a weak fallback for unrelated queries.',
        evidenceLocators: 'test:fallback-wording',
        recallCue: 'When checking fallback wording.',
        provenance: 'service.test',
        status: 'current',
      })).resolves.toMatchObject({ ok: true });

      const result = await service.call('memory_recall', { query: 'zzzzqqqq', scope: 'project', limit: '1' });

      expect(result.ok).toBe(true);
      expect(result.result).toContain('candidate');
      expect(result.result).toContain('memory_catalog');
      expect(result.result).not.toContain('No matching Braid memories');
      expect(result.result).not.toContain('match for "zzzzqqqq"');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reads one full memory record by exact id through memory_get', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-get-'));
    try {
      const service = makeHarness(project);
      const created = await service.call('memory_record', {
        verb: 'lesson',
        title: 'Gettable memory',
        content: 'Full memory_get output should include durable content.',
        evidenceLocators: 'test:gettable-memory',
        recallCue: 'When checking memory_get full record reads.',
        provenance: 'service.test',
        status: 'current',
        freshness: 'unverified',
        scope: 'tools',
        tags: 'get, pull',
      });
      expect(created.ok).toBe(true);
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();

      await expect(service.call('memory_get', { id })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Full memory_get output should include durable content.'),
      });
      const got = await service.call('memory_get', { id });
      expect(got.result).toContain('provenance: service.test');
      expect(got.result).toContain('status: current');
      expect(got.result).toContain('freshness: unverified');
      expect(got.result).toContain('evidenceLocators:');
      expect(got.result).toContain('test:gettable-memory');

      await expect(service.call('memory_get', {})).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('memory_get needs a memory id'),
      });
      await expect(service.call('memory_get', { id: 'missing-memory-id' })).resolves.toMatchObject({
        ok: false,
        result: expect.stringContaining('memory record not found: missing-memory-id'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('browses bounded mechanical memory catalog slices and advertises pull tools', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-catalog-tool-'));
    try {
      const harness = makeHarness(project);
      expect(harness.tools.map((tool) => tool.tool.name)).toEqual(expect.arrayContaining([
        'memory_record',
        'memory_recall',
        'memory_get',
        'memory_catalog',
      ]));

      for (let i = 0; i < 4; i += 1) {
        await expect(harness.call('memory_record', {
          verb: 'lesson',
          title: `Catalog Pull ${i}`,
          content: `Catalog pull body ${i}`,
          evidenceLocators: `test:catalog-pull-${i}`,
          recallCue: `When checking catalog pull ${i}.`,
          provenance: `service.test:${i}`,
          status: i === 3 ? 'stale' : 'current',
          scope: i === 0 ? 'engine' : 'webview',
          tags: i === 2 ? 'pull, other' : 'pull, ui',
        })).resolves.toMatchObject({ ok: true });
      }

      await expect(harness.call('memory_recall', { query: 'catalog pull body', scope: 'webview', limit: '1' }))
        .resolves.toMatchObject({ ok: true });

      const firstPage = await harness.call('memory_catalog', {
        scope: 'webview',
        tag: 'pull',
        status: 'current',
        class: '4',
        page: '1',
        pageSize: '2',
      });
      expect(firstPage.ok).toBe(true);
      expect(firstPage.result).toContain('Braid memory catalog: 2 of 2');
      expect(firstPage.result).toContain('Catalog Pull 2');
      expect(firstPage.result).toContain('Catalog Pull 1');
      expect(firstPage.result).not.toContain('Catalog Pull 0');
      expect(firstPage.result).not.toContain('Catalog Pull 3');
      expect(firstPage.result).not.toContain('readCount');

      await expect(harness.call('memory_catalog', {
        scope: 'webview',
        tag: 'pull',
        status: 'current',
        class: '4',
        page: '2',
        pageSize: '1',
      })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Catalog Pull 1'),
      });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('attaches recording-gap reminders as non-blocking advisory obligations', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-advisory-'));
    try {
      const harness = makeHarness(project);
      await harness.service.onTurnSettled?.({
        canvasId: 'c1',
        boardId: 'b1',
        turnIndex: 3,
        provider: 'claude',
        answer: '我已经记下这个教训。',
      });

      expect(harness.attachedObligations).toHaveLength(1);
      expect(harness.attachedObligations[0]).toMatchObject({
        enforcement: {
          mode: 'advisory',
        },
      });
      const audit = auditObligation({
        obligation: harness.attachedObligations[0],
        ledger: { events: [] },
      });
      expect(audit.action).toMatchObject({
        type: 'inject-prompt',
        blocking: false,
      });
      expect(audit.action.type).not.toBe('drive-repair');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('publishes memory inspection state after writes and status transitions', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-inspection-state-'));
    try {
      const harness = makeHarness(project);
      await expect(harness.call('memory_record', {
        verb: 'lesson',
        title: 'Inspectable memory',
        content: 'Workspace panel should see this record.',
        evidenceLocators: 'test:inspection-state',
        recallCue: 'When checking memory inspection state.',
        provenance: 'service.test',
        status: 'current',
      })).resolves.toMatchObject({ ok: true });

      const first = harness.snapshots.get('c1');
      expect(first).toMatchObject({
        total: 1,
        records: [{
          title: 'Inspectable memory',
          corpusClass: 4,
          status: 'current',
          freshness: 'unverified',
          provenance: 'service.test',
        }],
      });

      const id = (await readMemoryStore(project)).records[0].id;
      await expect(harness.call('memory_record', { action: 'status', id, status: 'disputed' }))
        .resolves.toMatchObject({ ok: true });
      expect(harness.snapshots.get('c1').records[0]).toMatchObject({ status: 'disputed' });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not rebuild inspection state on the recall hot path', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-recall-nopublish-'));
    try {
      const harness = makeHarness(project);
      await expect(harness.call('memory_record', {
        verb: 'lesson',
        title: 'Recall publish guard',
        content: 'Recall must not re-read the whole store to refresh inspection.',
        evidenceLocators: 'test:recall-publish',
        recallCue: 'When checking recall does not republish inspection.',
        provenance: 'service.test',
        status: 'current',
      })).resolves.toMatchObject({ ok: true });

      const publishesBefore = harness.publishCount();
      await expect(harness.call('memory_recall', { query: 'recall publish guard' })).resolves.toMatchObject({
        ok: true,
        result: expect.stringContaining('Recall publish guard'),
      });
      // Recall stays off the O(N) full-store-reload + inspection-rebuild path; usage is persisted separately.
      expect(harness.publishCount()).toBe(publishesBefore);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('never dead-ends memory_recall when the scope filter matches nothing', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-scope-miss-'));
    try {
      const service = makeHarness(project);
      await expect(service.call('memory_record', {
        verb: 'lesson',
        title: 'Has a home scope',
        content: 'This record lives in the engine scope.',
        evidenceLocators: 'test:scope-miss',
        recallCue: 'When checking scope-miss fallback.',
        provenance: 'service.test',
        status: 'current',
        scope: 'engine',
      })).resolves.toMatchObject({ ok: true });

      const result = await service.call('memory_recall', { query: 'anything', scope: 'nonexistent-scope', limit: '2' });
      expect(result.ok).toBe(true);
      expect(result.result).not.toContain('No matching Braid memories');
      expect(result.result).toContain('Has a home scope');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('correlates only allowlisted inspection actions, returns list-safe detail, and refreshes without canonical mutation', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-inspection-actions-'));
    try {
      const harness = makeHarness(project);
      await expect(harness.call('memory_record', {
        verb: 'lesson', title: 'Inspectable action target', content: 'SECRET BODY MUST NOT LEAK',
        evidenceLocators: 'raw://private-evidence', recallCue: 'When inspecting action results.', provenance: 'service.test',
      })).resolves.toMatchObject({ ok: true });
      const id = (await readMemoryStore(project)).records[0].id;
      const indexPath = path.join(project, '.braid', 'artifacts', 'index.sqlite');
      const beforeRefresh = fs.readFileSync(indexPath);

      await expect(harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'detail-1', pluginId: 'memory', action: 'inspectDetail', payload: { id } }))
        .resolves.toEqual({ handled: true });
      expect(harness.events.pop()).toMatchObject({
        pluginId: 'memory', eventKey: 'inspectionAction', requestId: 'detail-1',
        data: { ok: true, action: 'inspectDetail', record: { id, title: 'Inspectable action target' } },
      });
      expect(JSON.stringify(harness.events)).not.toContain('SECRET BODY');
      expect(JSON.stringify(harness.events)).not.toContain('raw://private-evidence');

      await expect(harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'refresh-1', pluginId: 'memory', action: 'refreshInspection' }))
        .resolves.toEqual({ handled: true });
      expect(harness.events.pop()).toMatchObject({ requestId: 'refresh-1', data: { ok: true, action: 'refreshInspection' } });
      expect(fs.readFileSync(indexPath).equals(beforeRefresh)).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed, unknown, and foreign inspection action messages with correlated errors', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-inspection-reject-'));
    try {
      const harness = makeHarness(project);
      await harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'unknown-1', pluginId: 'memory', action: 'deleteMemory' });
      await harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'malformed-1', pluginId: 'memory', action: 'inspectDetail', payload: { id: 'a', extra: true } });
      await expect(harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'foreign-1', pluginId: 'other', action: 'inspectDetail', payload: { id: 'a' } }))
        .resolves.toBeNull();

      expect(harness.events).toEqual([
        expect.objectContaining({ requestId: 'unknown-1', data: { ok: false, error: 'Unsupported memory inspection action.' } }),
        expect.objectContaining({ requestId: 'malformed-1', data: { ok: false, error: 'inspectDetail requires a non-empty memory id.' } }),
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reports an unavailable refresh rather than leaving its correlated inspection request unsettled', async () => {
    const projectFile = path.join(os.tmpdir(), `braid-memory-inspection-unavailable-${Date.now()}`);
    fs.writeFileSync(projectFile, 'not a workspace directory', 'utf8');
    try {
      const harness = makeHarness(projectFile);
      await expect(harness.workspaceAction({ type: 'workspacePluginAction', requestId: 'offline-1', pluginId: 'memory', action: 'refreshInspection' }))
        .resolves.toEqual({ handled: true });
      expect(harness.events).toEqual([
        expect.objectContaining({ requestId: 'offline-1', data: { ok: false, error: expect.any(String) } }),
      ]);
    } finally {
      fs.rmSync(projectFile, { force: true });
    }
  });

  it('requires one canonical snapshot to bind the normalized store, latest artifact payloads, and a usage-independent corpus revision', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-canonical-snapshot-'));
    try {
      let store = emptyMemoryStore();
      for (const [title, content] of [['Snapshot Alpha', 'alpha canonical body'], ['Snapshot Beta', 'beta canonical body']] as const) {
        const born = birthMemoryEnvelope({
          verb: 'lesson', title, content, evidenceLocators: `test:${title}`, recallCue: title, provenance: 'wave-2-red',
        }, '2026-07-18T00:00:00.000Z');
        if (!born.ok) throw new Error('unexpected fixture birth failure');
        store = recordMemoryEnvelope(store, born.record, {}, '2026-07-18T00:00:00.000Z').store;
      }
      const seeded = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
      expect(seeded.status).toBe('committed');

      const first = await readCanonicalMemorySnapshot(project);
      const expectedRevision = crypto.createHash('sha256')
        .update([...first.latestById.values()].map(({ ref }) => `${ref.id}@${ref.version}`).sort().join('\n'))
        .digest('hex');
      expect(first.store.records.map((record) => record.id).sort()).toEqual([...first.latestById.keys()].sort());
      expect([...first.latestById.values()].every(({ ref, text }) => ref.version === 1 && text.includes('canonical body'))).toBe(true);
      expect(first.corpusRevision).toBe(expectedRevision);

      recordMemoryUsage(project, first.store.records, '2026-07-18T00:01:00.000Z');
      const afterUsage = await readCanonicalMemorySnapshot(project);
      expect(afterUsage.corpusRevision).toBe(first.corpusRevision);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not let a second independent writer replay a v1 memory snapshot over the committed winner', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-cas-stale-writer-'));
    try {
      const born = birthMemoryEnvelope({
        verb: 'lesson', title: 'CAS winner', content: 'v1 body', evidenceLocators: 'test:cas:v1', recallCue: 'CAS winner', provenance: 'wave-2-red',
      }, '2026-07-18T00:00:00.000Z');
      if (!born.ok) throw new Error('unexpected fixture birth failure');
      const seed = recordMemoryEnvelope(emptyMemoryStore(), born.record, {}, '2026-07-18T00:00:00.000Z').store;
      const seeded = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), seed, { canvasId: 'c1', boardId: 'seed', pluginId: 'memory' });
      expect(seeded.status).toBe('committed');

      const firstWriterSnapshot = await readCanonicalMemorySnapshot(project);
      const staleWriterSnapshot = await readCanonicalMemorySnapshot(project);
      const winner = {
        version: 1 as const,
        records: firstWriterSnapshot.store.records.map((record) => record.id === born.record.id
          ? { ...record, content: 'winner v2 body', evidence: 'test:cas:winner', evidenceLocators: ['test:cas:winner'], updatedAt: '2026-07-18T00:01:00.000Z' }
          : record),
      };
      const stale = {
        version: 1 as const,
        records: staleWriterSnapshot.store.records.map((record) => record.id === born.record.id
          ? { ...record, content: 'stale loser body', evidence: 'test:cas:stale', evidenceLocators: ['test:cas:stale'], updatedAt: '2026-07-18T00:02:00.000Z' }
          : record),
      };

      const winnerResult = await writeArtifactMemoryStore(project, firstWriterSnapshot, winner, { canvasId: 'c1', boardId: 'winner', pluginId: 'memory' });
      expect(winnerResult.status).toBe('committed');
      const staleResult = await writeArtifactMemoryStore(project, staleWriterSnapshot, stale, { canvasId: 'c1', boardId: 'stale', pluginId: 'memory' });
      expect(staleResult).toMatchObject({ status: 'conflict', corpusRevision: staleWriterSnapshot.corpusRevision });

      const latest = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
      expect(latest).toEqual([expect.objectContaining({ id: born.record.id, version: 2 })]);
      await expect(ArtifactStore.forWorkspace(project).readPayload(latest[0])).resolves.toMatchObject({ text: expect.stringContaining('winner v2 body') });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps both a successor and its prior unchanged when one supersession precondition is stale', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-cas-supersession-'));
    try {
      const priorBirth = birthMemoryEnvelope({
        verb: 'lesson', title: 'Prior for guarded supersession', content: 'prior v1', evidenceLocators: 'test:prior:v1', recallCue: 'prior', provenance: 'wave-2-red',
      }, '2026-07-18T00:00:00.000Z');
      if (!priorBirth.ok) throw new Error('unexpected prior fixture birth failure');
      const seed = recordMemoryEnvelope(emptyMemoryStore(), priorBirth.record, {}, '2026-07-18T00:00:00.000Z').store;
      const seeded = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), seed, { canvasId: 'c1', boardId: 'seed', pluginId: 'memory' });
      expect(seeded.status).toBe('committed');

      const staleSnapshot = await readCanonicalMemorySnapshot(project);
      const successorBirth = birthMemoryEnvelope({
        verb: 'lesson', title: 'Guarded successor', content: 'successor body', evidenceLocators: 'test:successor', recallCue: 'successor', provenance: 'wave-2-red',
        supersedes: priorBirth.record.id,
      }, '2026-07-18T00:01:00.000Z');
      if (!successorBirth.ok) throw new Error('unexpected successor fixture birth failure');
      const successor = recordMemoryEnvelope(staleSnapshot.store, successorBirth.record, {}, '2026-07-18T00:01:00.000Z');
      const guarded = applyDirectSupersession(successor.store, successor.record);
      if (!guarded.ok) throw new Error(`unexpected supersession fixture failure: ${guarded.error}`);

      const concurrentWinner: MemoryStore = {
        version: 1,
        records: staleSnapshot.store.records.map((record) => ({
          ...record, content: 'prior v2 by another writer', evidence: 'test:prior:v2', evidenceLocators: ['test:prior:v2'], updatedAt: '2026-07-18T00:02:00.000Z',
        })),
      };
      const winnerResult = await writeArtifactMemoryStore(project, await readCanonicalMemorySnapshot(project), concurrentWinner, { canvasId: 'c1', boardId: 'winner', pluginId: 'memory' });
      expect(winnerResult.status).toBe('committed');
      const revisionBeforeConflict = (await readCanonicalMemorySnapshot(project)).corpusRevision;
      const staleResult = await writeArtifactMemoryStore(project, staleSnapshot, guarded.store, { canvasId: 'c1', boardId: 'stale-successor', pluginId: 'memory' });
      expect(staleResult).toMatchObject({ status: 'conflict', corpusRevision: staleSnapshot.corpusRevision });
      expect((await readCanonicalMemorySnapshot(project)).corpusRevision).toBe(revisionBeforeConflict);

      const latest = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
      expect(latest).toEqual([expect.objectContaining({ id: priorBirth.record.id, version: 2 })]);
      await expect(ArtifactStore.forWorkspace(project).readPayload(latest[0])).resolves.toMatchObject({ text: expect.stringContaining('prior v2 by another writer') });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('re-evaluates a canonical mutation once after a conflict and preserves the concurrent winner', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-cas-one-retry-'));
    try {
      const harness = makeHarness(project);
      const created = await harness.call('memory_record', {
        verb: 'lesson', title: 'Retry preserves winner', content: 'initial body', evidenceLocators: 'test:retry-initial',
        recallCue: 'When checking one canonical retry.', provenance: 'service.test',
      });
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();

      const original = ArtifactStore.prototype.applyInlinePayloadBatchCas;
      let mutationAttempts = 0;
      const cas = vi.spyOn(ArtifactStore.prototype, 'applyInlinePayloadBatchCas').mockImplementation(async (inputs) => {
        mutationAttempts += 1;
        if (mutationAttempts === 1) {
          const winnerInputs = inputs.map((input) => ({
            ...input,
            bytes: JSON.stringify({ ...JSON.parse(input.bytes), content: 'concurrent winner body', status: 'current' }, null, 2),
          }));
          await original.call(ArtifactStore.forWorkspace(project), winnerInputs);
        }
        return original.call(ArtifactStore.forWorkspace(project), inputs);
      });
      try {
        await expect(harness.call('memory_record', { action: 'status', id, status: 'stale' })).resolves.toMatchObject({ ok: true });
      } finally {
        cas.mockRestore();
      }

      expect(mutationAttempts).toBe(2);
      expect((await readMemoryStore(project)).records).toEqual([
        expect.objectContaining({ id, content: 'concurrent winner body', status: 'stale' }),
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('returns an explicit retry outcome after a second canonical CAS conflict', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-memory-cas-second-conflict-'));
    try {
      const harness = makeHarness(project);
      const created = await harness.call('memory_record', {
        verb: 'lesson', title: 'Second conflict retry', content: 'initial body', evidenceLocators: 'test:second-conflict-initial',
        recallCue: 'When checking retry after a second conflict.', provenance: 'service.test',
      });
      const id = /Braid memory ([^:]+):/.exec(String(created.result))?.[1];
      expect(id).toBeTruthy();

      const original = ArtifactStore.prototype.applyInlinePayloadBatchCas;
      let mutationAttempts = 0;
      const cas = vi.spyOn(ArtifactStore.prototype, 'applyInlinePayloadBatchCas').mockImplementation(async (inputs) => {
        mutationAttempts += 1;
        const winnerInputs = inputs.map((input) => ({
          ...input,
          bytes: JSON.stringify({ ...JSON.parse(input.bytes), content: `concurrent winner ${mutationAttempts}`, status: 'current' }, null, 2),
        }));
        await original.call(ArtifactStore.forWorkspace(project), winnerInputs);
        return original.call(ArtifactStore.forWorkspace(project), inputs);
      });
      try {
        await expect(harness.call('memory_record', { action: 'status', id, status: 'stale' })).resolves.toMatchObject({
          ok: false,
          result: expect.stringContaining('retry the operation'),
        });
      } finally {
        cas.mockRestore();
      }

      expect(mutationAttempts).toBe(2);
      expect((await readMemoryStore(project)).records).toEqual([
        expect.objectContaining({ id, content: 'concurrent winner 2', status: 'current' }),
      ]);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
