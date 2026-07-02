// Pure usage accumulator for the knowledge plugin's agent-usage stats (ADR-14). Counts vault RECALLs (reads),
// RECORDs (writes), and recording GAPs (a settled turn whose answer claims a lesson but wrote nothing to the
// vault). No side effects ⇒ unit-tested; the host `service.ts` is a thin stateful shell around these functions.

import { mentionsLessonRecording, vaultToolAccess } from './detect';

export interface KnowledgeUsageSnapshot {
  recalls: number;
  records: number;
  gaps: number;
}

export function emptyUsage(): KnowledgeUsageSnapshot {
  return { recalls: 0, records: 0, gaps: 0 };
}

// Fold one observed tool call into the tally. Returns the (possibly unchanged) tally and whether this call wrote
// the vault (so the caller can mark the turn for GAP correlation). Returns the SAME reference when nothing changed.
export function applyToolObservation(
  tally: KnowledgeUsageSnapshot,
  toolName: string,
  input: unknown,
): { tally: KnowledgeUsageSnapshot; wroteVault: boolean } {
  const access = vaultToolAccess(toolName, input);
  if (access === 'read') return { tally: { ...tally, recalls: tally.recalls + 1 }, wroteVault: false };
  if (access === 'write') return { tally: { ...tally, records: tally.records + 1 }, wroteVault: true };
  return { tally, wroteVault: false };
}

// Fold a settled turn into the tally: a recording GAP is an answer that claims a durable lesson while nothing was
// written to the vault during that turn. Returns the SAME reference when there is no gap.
export function applyTurnSettled(
  tally: KnowledgeUsageSnapshot,
  answer: string,
  wroteVaultThisTurn: boolean,
): KnowledgeUsageSnapshot {
  if (!wroteVaultThisTurn && mentionsLessonRecording(answer)) return { ...tally, gaps: tally.gaps + 1 };
  return tally;
}

export function knowledgeUsageTotal(tally: KnowledgeUsageSnapshot): number {
  return tally.recalls + tally.records + tally.gaps;
}
