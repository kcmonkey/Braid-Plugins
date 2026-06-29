import { describe, expect, it } from 'vitest';
import {
  claimFile,
  compatibleClaims,
  compatibleResourceClaims,
  emptyCoordinationState,
  findClaimConflict,
  isLiveOwner,
  markStaleClaims,
  ownerKey,
  pruneRetiredCoordination,
  RETIRED_PRUNE_AGE_MS,
  type CoordinationState,
  type FileClaim,
  type NegotiationThread,
  type ResourceClaim,
} from './model';

// Unit coverage for the LIVE runtime coordination model (the host imports `./model`). The historical
// `src/coordination/model.test.ts` exercises a SEPARATE, host-dead copy; these tests pin the copy that
// actually runs. (D21 — file-claim liveness parity)

const fileClaim = (over: Partial<FileClaim> = {}): FileClaim => ({
  id: 'claim-1',
  canvasId: 'c1',
  boardId: 'holder',
  path: 'src/shared.ts',
  access: 'edit',
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 10_000,
  ...over,
});

const writerReq = { canvasId: 'c1', boardId: 'writer', path: 'src/shared.ts', access: 'edit' as const, now: 1 };

describe('coordination model — file-claim liveness (D21)', () => {
  it('a non-live owner\'s file claim does not block another board when liveOwners is supplied', () => {
    const existing = fileClaim();
    // No liveOwners → legacy TTL-only behavior: blocks.
    expect(compatibleClaims(existing, writerReq, 1)).toBe(false);
    // liveOwners WITHOUT the holder → holder settled → compatible (does not block).
    expect(compatibleClaims(existing, writerReq, 1, new Set())).toBe(true);
    // liveOwners WITH the holder → still blocks.
    expect(compatibleClaims(existing, writerReq, 1, new Set(['c1::holder']))).toBe(false);
  });

  it('findClaimConflict / claimFile thread liveOwners so a settled holder yields the lock', () => {
    const state: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim()], seq: 1 };
    expect(findClaimConflict(state, writerReq)).not.toBeNull(); // legacy: conflict
    expect(findClaimConflict(state, writerReq, new Set(['c1::holder']))).not.toBeNull(); // holder live: conflict
    expect(findClaimConflict(state, writerReq, new Set())).toBeNull(); // holder not live: no conflict
    // claimFile grants the writer when the holder is non-live.
    const granted = claimFile(state, writerReq, new Set());
    expect(granted.conflict).toBeUndefined();
    expect(granted.claim?.boardId).toBe('writer');
  });

  it('markStaleClaims exempts a LIVE owner\'s expired file lock from the TTL but stales a non-live owner\'s', () => {
    const state: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim({ expiresAt: 5 })], seq: 1 };
    expect(markStaleClaims(state, 10, new Set(['c1::holder'])).claims[0].status).toBe('active'); // live owner kept
    expect(markStaleClaims(state, 10, new Set()).claims[0].status).toBe('stale'); // non-live + expired → stale
    expect(markStaleClaims(state, 10).claims[0].status).toBe('stale'); // legacy (no liveOwners): expired → stale
  });
});

describe('coordination model — memory-footprint Phase 4 (markStaleClaims short-circuit / pruneRetiredCoordination)', () => {
  const neg = (id: string, status: NegotiationThread['status'], updatedAt: number): NegotiationThread => ({
    id, canvasId: 'c1', topic: 't', status, boardIds: ['b1'],
    relatedPaths: [], relatedResources: [], relatedIntentIds: [], turns: [], createdAt: 0, updatedAt,
  });

  it('markStaleClaims returns the SAME state ref when nothing transitions (no hot-path allocation)', () => {
    const s: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim({ expiresAt: 10_000 })], seq: 1 };
    expect(markStaleClaims(s, 5)).toBe(s); // not yet expired → identity, zero allocation
    const expd: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim({ expiresAt: 5 })], seq: 1 };
    const r = markStaleClaims(expd, 10, new Set()); // non-live + expired → transitions
    expect(r).not.toBe(expd);
    expect(r.claims[0].status).toBe('stale');
  });

  it('pruneRetiredCoordination drops aged released claims + resolved/rejected negotiations, keeps active/recent', () => {
    const nowT = RETIRED_PRUNE_AGE_MS + 1000;
    const s: CoordinationState = {
      ...emptyCoordinationState(),
      claims: [
        fileClaim({ id: 'rel-old', status: 'released', updatedAt: 0 }),      // aged tombstone → dropped
        fileClaim({ id: 'rel-fresh', status: 'released', updatedAt: nowT }), // just released → kept
        fileClaim({ id: 'active', status: 'active', updatedAt: nowT }),      // active → kept
      ],
      negotiations: [neg('n-old', 'resolved', 0), neg('n-rej', 'rejected', 0), neg('n-open', 'proposed', 0)],
      seq: 3,
    };
    const p = pruneRetiredCoordination(s, nowT);
    expect(p.claims.map((c) => c.id).sort()).toEqual(['active', 'rel-fresh']);
    expect(p.negotiations.map((n) => n.id)).toEqual(['n-open']); // open thread kept; aged resolved/rejected dropped
  });

  it('pruneRetiredCoordination returns the SAME state ref when nothing is old enough', () => {
    const nowT = RETIRED_PRUNE_AGE_MS + 1000;
    const s: CoordinationState = {
      ...emptyCoordinationState(),
      claims: [fileClaim({ status: 'released', updatedAt: nowT })], // released but within maxAge
      negotiations: [neg('n-open', 'proposed', nowT)],
      seq: 1,
    };
    expect(pruneRetiredCoordination(s, nowT + 500)).toBe(s);
  });
});

// The single owner-liveness chokepoint (ADR-10): every read path that gates on liveness routes through these,
// so the `${canvasId}::${boardId}` owner key + membership test exist in exactly one place.
describe('coordination model — owner-liveness chokepoint (ADR-10)', () => {
  it('ownerKey builds the host live-owner key shape', () => {
    expect(ownerKey({ canvasId: 'c1', boardId: 'b7' })).toBe('c1::b7');
  });

  it('isLiveOwner: untracked liveness is false (legacy fallback), otherwise set membership by (canvas, board)', () => {
    expect(isLiveOwner({ canvasId: 'c1', boardId: 'b7' })).toBe(false); // no set → untracked → false
    expect(isLiveOwner({ canvasId: 'c1', boardId: 'b7' }, new Set())).toBe(false);
    expect(isLiveOwner({ canvasId: 'c1', boardId: 'b7' }, new Set(['c1::b7']))).toBe(true);
    expect(isLiveOwner({ canvasId: 'c2', boardId: 'b7' }, new Set(['c1::b7']))).toBe(false); // board ids are per-canvas
  });
});

// Pin the deliberate file-vs-resource divergence the chokepoint must preserve (ADR-8/ADR-10): a file claim gives a
// non-live owner no TTL grace, but a resource claim keeps the TTL grace (D14 orphan backstop).
const resClaim = (over: Partial<ResourceClaim> = {}): ResourceClaim => ({
  id: 'res-1',
  canvasId: 'c1',
  boardId: 'holder',
  resource: 'editor',
  mode: 'exclusive',
  priority: 'normal',
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 10_000,
  ...over,
});

const resReq = { canvasId: 'c1', boardId: 'writer', resource: 'editor', mode: 'exclusive' as const, now: 1 };

describe('coordination model — resource enforcement keeps TTL grace for a non-live owner', () => {
  it('within TTL a non-live owner still blocks (a FILE claim would yield)', () => {
    // File parity check: same situation, a file claim yields when the holder is non-live.
    expect(compatibleClaims(fileClaim(), writerReq, 1, new Set())).toBe(true);
    // Resource: still blocks within TTL even though the owner is non-live.
    expect(compatibleResourceClaims(resClaim(), resReq, 1, new Set())).toBe(false);
  });

  it('expired + non-live → TTL backstop frees it; expired + LIVE owner → liveness-true keeps the block (D14)', () => {
    expect(compatibleResourceClaims(resClaim({ expiresAt: 5 }), resReq, 10, new Set())).toBe(true);
    expect(compatibleResourceClaims(resClaim({ expiresAt: 5 }), resReq, 10, new Set(['c1::holder']))).toBe(false);
  });
});
