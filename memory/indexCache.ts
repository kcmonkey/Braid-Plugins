import * as fs from 'fs';
import * as path from 'path';
import {
  createMemoryRecallIndex,
  type MemoryFacetStats,
  type MemoryRecallIndex,
  type MemoryStore,
} from './model';

const ARTIFACT_INDEX = path.join('.braid', 'artifacts', 'index.sqlite');
const MEMORY_REVISION_FILE = path.join('.braid', 'artifacts', 'memory-index.rev');

export interface MemoryIndexSnapshot {
  token: string;
  /** Present only when the index was built from this exact canonical snapshot. */
  corpusRevision?: string;
  store: MemoryStore;
  index: MemoryRecallIndex;
  facets: MemoryFacetStats;
  builtAt: number;
}

type MemoryStoreLoader = () => Promise<MemoryStore>;
type CanonicalMemoryLoader = () => Promise<{ store: MemoryStore; corpusRevision: string }>;
type RevisionTokenProvider = (cwd: string) => string;

export function memoryRevisionToken(cwd: string): string {
  const workspace = path.resolve(cwd || process.cwd());
  const artifactIndex = path.resolve(workspace, ARTIFACT_INDEX);
  const revFile = path.resolve(workspace, MEMORY_REVISION_FILE);
  const indexToken = statToken(artifactIndex);
  let revToken = 'missing';
  try {
    revToken = fs.readFileSync(revFile, 'utf8').trim() || 'empty';
  } catch {
    revToken = 'missing';
  }
  return `${indexToken}|${revToken}`;
}

export function bumpMemoryRevisionToken(cwd: string): void {
  const workspace = path.resolve(cwd || process.cwd());
  const revFile = path.resolve(workspace, MEMORY_REVISION_FILE);
  fs.mkdirSync(path.dirname(revFile), { recursive: true });
  fs.writeFileSync(revFile, `${Date.now()}:${process.hrtime.bigint().toString()}`, 'utf8');
}

function statToken(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

export class MemoryIndexCache {
  private snapshot: MemoryIndexSnapshot | undefined;
  private inFlight: { token: string; promise: Promise<MemoryIndexSnapshot> } | undefined;

  constructor(private readonly tokenProvider: RevisionTokenProvider = memoryRevisionToken) {}

  get(cwd: string, loadStore: MemoryStoreLoader): Promise<MemoryIndexSnapshot> {
    const workspace = path.resolve(cwd || process.cwd());
    const token = this.tokenProvider(workspace);
    if (this.snapshot?.token === token) return Promise.resolve(this.snapshot);
    if (this.inFlight?.token === token) return this.inFlight.promise;

    const promise = (async () => {
      // createMemoryRecallIndex normalizes internally; reuse its normalized records for the snapshot store
      // instead of normalizing a second time.
      const index = createMemoryRecallIndex(await loadStore());
      const snapshot: MemoryIndexSnapshot = {
        token,
        store: { version: 1, records: index.records },
        index,
        facets: index.facets,
        builtAt: Date.now(),
      };
      this.snapshot = snapshot;
      return snapshot;
    })();
    this.inFlight = { token, promise };
    promise.finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    });
    return promise;
  }

  async getCanonical(cwd: string, load: CanonicalMemoryLoader): Promise<MemoryIndexSnapshot & { corpusRevision: string }> {
    // Capture BEFORE the read. If B commits while A is read/indexed, publishing
    // A may never attach B's token and fool a later ordinary lexical cache hit.
    const token = this.tokenProvider(path.resolve(cwd || process.cwd()));
    const canonical = await load();
    const index = this.snapshot?.corpusRevision === canonical.corpusRevision
      ? this.snapshot.index : createMemoryRecallIndex(canonical.store);
    const snapshot = {
      token, corpusRevision: canonical.corpusRevision,
      store: { version: 1 as const, records: index.records }, index, facets: index.facets,
      builtAt: index === this.snapshot?.index ? this.snapshot.builtAt : Date.now(),
    };
    this.snapshot = snapshot;
    return snapshot;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.inFlight = undefined;
  }
}

// Bound retained per-workspace caches so a long-lived host that opens many workspaces does not keep an
// unbounded number of full in-memory indexes alive.
const MAX_WORKSPACE_CACHES = 8;
const workspaceCaches = new Map<string, MemoryIndexCache>();

function memoryCacheForWorkspace(cwd: string): MemoryIndexCache {
  const workspace = path.resolve(cwd || process.cwd());
  let cache = workspaceCaches.get(workspace);
  if (!cache) {
    cache = new MemoryIndexCache();
    workspaceCaches.set(workspace, cache);
    while (workspaceCaches.size > MAX_WORKSPACE_CACHES) {
      const oldest = workspaceCaches.keys().next().value;
      if (oldest === undefined || oldest === workspace) break;
      workspaceCaches.delete(oldest);
    }
  }
  return cache;
}

export function getMemoryIndexSnapshot(cwd: string, loadStore: MemoryStoreLoader): Promise<MemoryIndexSnapshot> {
  return memoryCacheForWorkspace(cwd).get(cwd, loadStore);
}

export function getCanonicalMemoryIndexSnapshot(cwd: string, load: CanonicalMemoryLoader): Promise<MemoryIndexSnapshot & { corpusRevision: string }> {
  return memoryCacheForWorkspace(cwd).getCanonical(cwd, load);
}

export function resetMemoryIndexCachesForTest(): void {
  workspaceCaches.clear();
}
