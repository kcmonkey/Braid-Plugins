import {
  tokenizeMemoryText,
  type MemoryRecallCandidateOptions,
  type MemoryRecallInput,
  type MemorySemanticConfig,
  type MemoryRecord,
  type SemanticRecallMatch,
} from './model';

export interface SemanticCandidateSourceDescription {
  kind: 'deterministic-session';
  cache: 'session';
  modelFingerprint: string;
  candidateNotTruth: true;
}

export interface SemanticCandidateQuery {
  query: string;
  records: readonly MemoryRecord[];
  signal?: AbortSignal;
}

/**
 * Pure admission decision for a future recall integration. Project cache is
 * intentionally unavailable in C0: callers receive that explicit outcome
 * rather than silently treating it as a session-cache request.
 */
export type SemanticRecallExecution =
  | { status: 'off'; reason: 'not-requested' | 'caller-off' | 'config-off' | 'invalid-request' }
  | { status: 'unavailable'; reason: 'project-cache-unavailable' }
  | { status: 'enabled'; config: Readonly<MemorySemanticConfig & { mode: 'local-experimental'; cache: 'session' }> };

export function resolveSemanticRecallExecution(
  input: MemoryRecallInput,
  config: MemorySemanticConfig,
): SemanticRecallExecution {
  const requested = (input as { semantic?: unknown }).semantic;
  if (requested === 'off') return { status: 'off', reason: 'caller-off' };
  if (requested !== undefined && requested !== 'configured') return { status: 'off', reason: 'invalid-request' };
  if (requested !== 'configured') return { status: 'off', reason: 'not-requested' };
  if (config.mode !== 'local-experimental') return { status: 'off', reason: 'config-off' };
  if (config.cache === 'project') return { status: 'unavailable', reason: 'project-cache-unavailable' };
  return {
    status: 'enabled',
    config: Object.freeze({
      mode: 'local-experimental',
      cache: 'session',
      ...(config.modelFingerprint ? { modelFingerprint: config.modelFingerprint } : {}),
    }),
  };
}

/**
 * Memory-local semantic seam. Implementations own their session resources and
 * must never perform durable cache, provider, network, download, or billing work.
 */
export interface SemanticCandidateSource {
  describe(): SemanticCandidateSourceDescription;
  prepare(signal?: AbortSignal): Promise<void>;
  query(input: SemanticCandidateQuery): Promise<readonly SemanticRecallMatch[]>;
  dispose(): Promise<void> | void;
}

export type SemanticCandidateQueryOutcome =
  | { status: 'ready'; description: SemanticCandidateSourceDescription; matches: readonly SemanticRecallMatch[] }
  | { status: 'backend-failure'; error: unknown };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason !== undefined) throw reason;
  const error = new Error('Memory semantic recall was cancelled.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Backend failures become an explicit lexical-fallback result. A caller-owned
 * abort is deliberately rethrown so it cannot be mistaken for a weak recall.
 */
export async function querySemanticCandidates(
  source: SemanticCandidateSource,
  input: SemanticCandidateQuery,
): Promise<SemanticCandidateQueryOutcome> {
  try {
    throwIfAborted(input.signal);
    await source.prepare(input.signal);
    throwIfAborted(input.signal);
    const matches = await source.query(input);
    throwIfAborted(input.signal);
    return { status: 'ready', description: source.describe(), matches };
  } catch (error) {
    if (input.signal?.aborted) throwIfAborted(input.signal);
    return { status: 'backend-failure', error };
  }
}

/** Pure bridge for callers: failure means omit semantic input and preserve lexical parity. */
export function semanticOptionsForOutcome(outcome: SemanticCandidateQueryOutcome): MemoryRecallCandidateOptions | undefined {
  if (outcome.status !== 'ready') return undefined;
  return {
    semantic: outcome.matches,
    semanticModelFingerprint: outcome.description.modelFingerprint,
  };
}

export interface DeterministicSessionSemanticCandidateSourceOptions {
  modelFingerprint?: string;
  /** Test-controlled token expansions; no model, download, or external state. */
  expansions?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A test-friendly, session-owned fake semantic source. It expands configured
 * query tokens and scores set overlap deterministically; it does not embed text.
 */
export class DeterministicSessionSemanticCandidateSource implements SemanticCandidateSource {
  private prepared = false;
  private disposed = false;
  private readonly fingerprint: string;
  private readonly expansions: ReadonlyMap<string, readonly string[]>;

  constructor(options: DeterministicSessionSemanticCandidateSourceOptions = {}) {
    this.fingerprint = options.modelFingerprint?.trim() || 'deterministic-session-v1';
    this.expansions = new Map(Object.entries(options.expansions ?? {})
      .map(([token, values]) => [token.toLowerCase(), Object.freeze([...values].map((value) => value.toLowerCase()))] as const));
  }

  describe(): SemanticCandidateSourceDescription {
    return Object.freeze({
      kind: 'deterministic-session', cache: 'session', modelFingerprint: this.fingerprint, candidateNotTruth: true,
    });
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.disposed) throw new Error('Memory semantic source is disposed.');
    this.prepared = true;
  }

  async query(input: SemanticCandidateQuery): Promise<readonly SemanticRecallMatch[]> {
    throwIfAborted(input.signal);
    if (!this.prepared) throw new Error('Memory semantic source must be prepared before query.');
    if (this.disposed) throw new Error('Memory semantic source is disposed.');

    const queryTokens = new Set(tokenizeMemoryText(input.query));
    for (const token of [...queryTokens]) {
      for (const expansion of this.expansions.get(token) ?? []) queryTokens.add(expansion);
    }
    if (!queryTokens.size) return Object.freeze([]);

    const matches: SemanticRecallMatch[] = [];
    for (const record of input.records) {
      throwIfAborted(input.signal);
      const documentTokens = new Set(tokenizeMemoryText([
        record.title, record.scope, record.tags.join(' '), record.recallCue ?? '', record.content,
      ].join(' ')));
      let overlap = 0;
      for (const token of queryTokens) if (documentTokens.has(token)) overlap += 1;
      if (!overlap) continue;
      matches.push(Object.freeze({ id: record.id, score: overlap / queryTokens.size, modelFingerprint: this.fingerprint }));
    }
    return Object.freeze(matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)));
  }

  dispose(): void {
    this.prepared = false;
    this.disposed = true;
  }
}
