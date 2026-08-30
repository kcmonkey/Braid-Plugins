import { describe, expect, it } from 'vitest';
import {
  compatibleResourceClaims,
  emptyCoordinationState,
  markStaleClaims,
  ownerKey,
  pruneRetiredCoordination,
  RETIRED_PRUNE_AGE_MS,
  type CoordinationState,
  type FileClaim,
  type NegotiationThread,
  type ResourceClaim,
} from './model';

// Deterministic coordination-record algorithms. Runtime Agent identity is resolved only at
// live-message ingress and is intentionally not inferred by this model.

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

describe('coordination model — memory-footprint Phase 4 (markStaleClaims short-circuit / pruneRetiredCoordination)', () => {
  const neg = (id: string, status: NegotiationThread['status'], updatedAt: number): NegotiationThread => ({
    id, canvasId: 'c1', topic: 't', status, boardIds: ['b1'],
    relatedPaths: [], relatedResources: [], relatedIntentIds: [], turns: [], createdAt: 0, updatedAt,
  });

  it('markStaleClaims returns the SAME state ref when nothing transitions (no hot-path allocation)', () => {
    const s: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim({ expiresAt: 10_000 })], seq: 1 };
    expect(markStaleClaims(s, 5)).toBe(s); // not yet expired → identity, zero allocation
    const expd: CoordinationState = { ...emptyCoordinationState(), claims: [fileClaim({ expiresAt: 5 })], seq: 1 };
    const r = markStaleClaims(expd, 10); // expired → transitions
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

describe('coordination model — record-key formatting', () => {
  it('ownerKey builds a coordination-record key, never an execution selector', () => {
    expect(ownerKey({ canvasId: 'c1', boardId: 'b7' })).toBe('c1::b7');
  });
});

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

describe('coordination model — resource enforcement honors TTL', () => {
  it('within TTL an active resource claim blocks', () => {
    expect(compatibleResourceClaims(resClaim(), resReq, 1)).toBe(false);
  });

  it('an expired resource claim is freed by TTL', () => {
    expect(compatibleResourceClaims(resClaim({ expiresAt: 5 }), resReq, 10)).toBe(true);
  });
});
