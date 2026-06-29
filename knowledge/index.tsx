import { useEffect, useState } from 'react';
import type {
  BoardElementPlugin,
  BoardPluginApi,
  ContextProviderPlugin,
  PluginManifest,
  SeedArtifact,
} from '../../../src/plugin-api/types';
import { boardTurns, type BoardLike as BoardData } from '../shared/board';
import {
  VAULT_DIR,
  VAULT_INDEX,
  cachedRoutingEntries,
  knowledgeContextText,
  knowledgeSeedArtifacts,
} from './methodology';
import { notesFromEntries, parseKnowledgeIndex, routableKnowledgeEntries, type KnowledgeNote } from './parse';
import { lessonRecordingGap } from './detect';
// The full usage doc, shipped IN this plugin (esbuild `.md` text loader inlines it). This is the SSOT;
// seedArtifacts drops a copy at `.braid/knowledge/_README.md` so the agent reads the convention on demand.
import USAGE_DOC from './knowledge-usage.md';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

type KnowledgeConfig = Record<string, never>;

// Refetch the vault only when the focused board is SETTLED (so the agent's note edits after a turn are picked
// up), keyed by turn count + answer length; 'live' during streaming keeps the last snapshot (no read storm).
function vaultVersion(board: BoardData): string {
  return board.status === 'done' ? `d${boardTurns(board).length}:${(board.answer ?? '').length}` : 'live';
}

// Read the vault notes: prefer the agent-maintained `_index.md`, else list the `.md` files in the vault dir.
async function loadNotes(api: BoardPluginApi): Promise<KnowledgeNote[]> {
  const idx = await api.readArtifact(VAULT_INDEX);
  const fromIndex = idx.text ? parseKnowledgeIndex(idx.text) : [];
  if (fromIndex.length) return fromIndex;
  const dir = await api.listArtifacts(VAULT_DIR);
  return notesFromEntries(dir.entries ?? []);
}

function sameRouting(a: readonly KnowledgeNote[], b: readonly KnowledgeNote[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ChatView panel (focused board only): a read-only view of the project knowledge vault (count + note titles).
// It also caches the index titles into THIS board's namespaced state so the context provider injects them inline
// on the next turn. Confined to the focused board (ADR-6) so a big canvas does not read the vault from every card.
function KnowledgePanel({ boardId, board, api }: { boardId: string; board: BoardData; api: BoardPluginApi }) {
  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
  const [open, setOpen] = useState(false);
  const version = vaultVersion(board);
  useEffect(() => {
    let alive = true;
    (async () => {
      const ns = await loadNotes(api);
      if (!alive) return;
      setNotes(ns);
      const routing = routableKnowledgeEntries(ns);
      // Equality-guarded so the write converges (no render loop, no persistence churn for a stable vault).
      if (!sameRouting(routing, cachedRoutingEntries(board.elements?.knowledge) as KnowledgeNote[])) {
        api.patchBoard(boardId, { elements: { ...(board.elements ?? {}), knowledge: { index: routing } } });
      }
    })();
    return () => {
      alive = false;
    };
    // Re-read once per settled turn; the post-write board change does not bump `version`, so this cannot loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, api, boardId]);

  const count = notes?.length ?? 0;
  return (
    <div
      className="knowledge-panel nodrag nopan"
      style={{ flexShrink: 0, padding: '8px 14px', borderBottom: '1px solid #2a2724', background: '#1d1c1a', fontSize: 12 }}
    >
      <div
        className="knowledge-panel__head"
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: count ? 'pointer' : 'default' }}
        onClick={() => count && setOpen((o) => !o)}
        title={count ? (open ? 'Collapse vault' : 'Expand vault') : undefined}
      >
        <span style={{ color: '#83a1ff', fontWeight: 700 }}>📚 Knowledge vault</span>
        <span style={{ color: '#a8a199', fontWeight: 600 }}>
          {notes == null ? '…' : `${count} note${count === 1 ? '' : 's'}`}
        </span>
        <span style={{ flex: 1 }} />
        {count ? <span className="knowledge-panel__toggle" style={{ color: '#8c857b' }}>{open ? '▾ hide' : '▸ list'}</span> : null}
      </div>
      {lessonRecordingGap(board) ? (
        <div className="knowledge-panel__nudge" style={{ marginTop: 6, color: '#e3b341', display: 'flex', gap: 6, lineHeight: 1.4 }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span>This turn described lessons but recorded nothing to the vault — if they are durable, RECORD them.</span>
        </div>
      ) : null}
      {open && notes && count ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: '32vh', overflow: 'auto' }}>
          {notes.slice(0, 60).map((n, i) => (
            <div key={i} style={{ color: '#bdb6ac', display: 'flex', gap: 6, lineHeight: 1.4 }}>
              <span style={{ color: '#6f6a62', flexShrink: 0 }}>·</span>
              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                {n.title}
                {n.scope ? <span style={{ color: '#8c857b' }}> - {n.scope}</span> : null}
              </span>
            </div>
          ))}
          {count > 60 ? <div style={{ color: '#6f6a62' }}>+{count - 60} more</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// Knowledge Vault board element. Read-only visualization, rendered ONLY in the focused ChatView (chatview-aside)
// — no per-card chip (ADR-6). It surfaces what the vault holds and caches the focused board's index titles for
// the provider's inline injection.
export const knowledgeElementPlugin: BoardElementPlugin<KnowledgeConfig> = {
  id: 'knowledge',
  label: 'Knowledge vault',
  manifest,
  defaultConfig: {},
  render({ slot, boardId, board, api }) {
    if (slot === 'chatview-aside') return <KnowledgePanel boardId={boardId} board={board} api={api} />;
    return null;
  },
};

// Knowledge Vault context provider. Always-on + DORMANT: injects the record/recall protocol + the `_index.md`
// pointer on EVERY board (the vault is project-global), plus the focused board's cached index titles inline when
// present (ADR-4). The agent ignores it unless durable, project-specific knowledge is in play. Pure text ⇒ no
// LLM call (no auto-memory/language gotcha). Capture is agent-driven (ADR-3); recall is index + on-demand read.
export const knowledgeContextProvider: ContextProviderPlugin<KnowledgeConfig> = {
  id: 'knowledge',
  label: 'Knowledge vault',
  manifest,
  defaultConfig: {},
  provide({ board }) {
    return {
      text: knowledgeContextText(cachedRoutingEntries(board.elements?.knowledge), {
        recordingGap: lessonRecordingGap(board),
      }),
    };
  },
  seedArtifacts(): SeedArtifact[] {
    return knowledgeSeedArtifacts(USAGE_DOC);
  },
};
