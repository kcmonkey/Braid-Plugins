import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MEMORY_COMPLETE_CATALOG_THRESHOLD, memoryHostServicePlugin } from './service';
import { memoryPaths, readMemoryStore, writeArtifactMemoryStore } from './storage';
import type { AgentToolPlugin, HostServiceContext } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { ArtifactStore, setArtifactStoreIndexWriteForTest } from '../../../src/persistence/artifactStore';
import { auditObligation, type Obligation } from '../../../src/obligations';
import { birthMemoryEnvelope, emptyMemoryStore, recordMemoryEnvelope, type MemoryStore } from './model';

function makeHarness(project: string) {
  const attachedObligations: Obligation[] = [];
  const snapshots = new Map<string, any>();
  let publishes = 0;
  const ctx: HostServiceContext = {
    cwd: () => project,
    readSecret: async (pluginId, key) => ({ pluginId, key, stored: false }),
    writeSecret: async (pluginId, key) => ({ pluginId, key, stored: true }),
    clearSecret: async (pluginId, key) => ({ pluginId, key, cleared: true }),
    liveOwnerKeys: () => new Set(),
    openCanvasIds: () => ['c1'],
    liveBoardKeys: () => [],
    hasLiveBoardKey: () => false,
    deliverLiveBoardMessage: () => false,
    captureFileSnapshot: () => undefined,
    publishWorkspaceState: ({ canvasIds, snapshotForCanvas }) => {
      publishes += 1;
      for (const canvasId of canvasIds) snapshots.set(canvasId, snapshotForCanvas(canvasId));
    },
    publishWorkspaceEvent: () => undefined,
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
  return { service, call, tools, turnContext, attachedObligations, snapshots, publishCount: () => publishes };
}

describe('memory host service', () => {
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
        status: 'stale',
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
      expect((await readMemoryStore(project)).records).toHaveLength(0);
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
        const written = await writeArtifactMemoryStore(project, store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
        expect(indexWrites).toBe(1);
        const refs = await ArtifactStore.forWorkspace(project).latestRefsByDataType('memory-record');
        expect(refs).toHaveLength(5);
        expect(refs.every((ref) => ref.version === 1)).toBe(true);

        indexWrites = 0;
        const rewritten = await writeArtifactMemoryStore(project, written, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
        expect(indexWrites).toBe(0);
        expect(rewritten.records.map((record) => record.id)).toEqual(written.records.map((record) => record.id));
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
      const written = await writeArtifactMemoryStore(project, store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });

      const changedStore: MemoryStore = {
        version: 1,
        records: written.records.map((record) => record.title === 'Batch Changed'
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
        await writeArtifactMemoryStore(project, changedStore, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });
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
      await writeArtifactMemoryStore(project, store, { canvasId: 'c1', boardId: 'b1', pluginId: 'memory' });

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
});
