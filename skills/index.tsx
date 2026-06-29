import { useEffect } from 'react';
import type {
  BoardElementPlugin,
  BoardPluginApi,
  ContextProviderPlugin,
  PluginManifest,
  SeedArtifact,
} from '../../../src/plugin-api/types';
import { type BoardLike as BoardData } from '../shared/board';
import { VAULT_DIR, cachedSkillEntries, skillSlashCommands, skillsContextText, skillsSeedArtifacts } from './methodology';
import { skillBody, skillEntryFromFile, sortSkillEntries, type SkillEntry } from './parse';
// The usage doc ships IN this plugin (esbuild `.md` text loader inlines it). seedArtifacts drops a copy at
// `.braid/skills/_README.md` so the agent reads the skill format on demand.
import USAGE_DOC from './skills-usage.md';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

type SkillsConfig = Record<string, never>;

// Re-scan the vault only when the focused board is SETTLED (so a skill the agent just authored is picked up),
// keyed by turn count + answer length; 'live' during streaming keeps the last snapshot (no read storm).
function vaultVersion(board: BoardData): string {
  const turns = board.turns && board.turns.length ? board.turns.length : 1;
  return board.status === 'done' ? `d${turns}:${(board.answer ?? '').length}` : 'live';
}

// Discover skills by scanning `.braid/skills/<name>/SKILL.md` and reading each one's frontmatter. Confined to the
// focused board (mirrors knowledge ADR-6) so a big canvas does not read the vault from every card.
async function loadSkills(api: BoardPluginApi): Promise<SkillEntry[]> {
  const dir = await api.listArtifacts(VAULT_DIR);
  const out: SkillEntry[] = [];
  for (const e of dir.entries ?? []) {
    if (!e.isDir || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const mdPath = `${VAULT_DIR}/${e.name}/SKILL.md`;
    const file = await api.readArtifact(mdPath);
    if (!file.text) continue;
    const entry = skillEntryFromFile(e.name, file.text, mdPath);
    if (entry) out.push(entry);
  }
  return sortSkillEntries(out);
}

function sameEntries(a: readonly SkillEntry[], b: readonly SkillEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Headless loader (focused board only): scans the vault and caches the entries into THIS board's namespaced
// state so the context provider injects them and the `/` menu offers them. Renders NOTHING — skills are surfaced
// via the `/` command menu, not a ChatView panel (ADR-8). Confined to the focused board (knowledge ADR-6 parity)
// so a big canvas does not read the vault from every card.
function SkillsLoader({ boardId, board, api }: { boardId: string; board: BoardData; api: BoardPluginApi }) {
  const version = vaultVersion(board);
  useEffect(() => {
    let alive = true;
    (async () => {
      const ss = await loadSkills(api);
      if (!alive) return;
      // Equality-guarded so the write converges (no render loop, no persistence churn for a stable vault).
      if (!sameEntries(ss, cachedSkillEntries(board.elements?.skills))) {
        api.patchBoard(boardId, { elements: { ...(board.elements ?? {}), skills: { index: ss } } });
      }
    })();
    return () => {
      alive = false;
    };
    // Re-read once per settled turn; the post-write board change does not bump `version`, so this cannot loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, api, boardId]);
  return null;
}

// Skills board element. NO visible UI — it mounts a headless loader in the focused ChatView (chatview-aside) that
// caches the board's skill index for the provider's injection + the `/` menu (ADR-8). It also contributes the
// `/`-command entries + manual-invoke resolution below.
export const skillsElementPlugin: BoardElementPlugin<SkillsConfig> = {
  id: 'skills',
  label: 'Skills',
  manifest,
  defaultConfig: {},
  render({ slot, boardId, board, api }) {
    if (slot === 'chatview-aside') return <SkillsLoader boardId={boardId} board={board} api={api} />;
    return null;
  },
  // Manual `/` invoke (ADR-5/7): contribute each cached skill as a `/<name>` command, and resolve a pick to the
  // skill's instruction body (frontmatter stripped) read on demand — provider-neutral, never via token interpretation.
  slashCommands(state) {
    return skillSlashCommands(cachedSkillEntries(state));
  },
  async resolveSlashInsert(name, state, api) {
    const entry = cachedSkillEntries(state).find((e) => e.name === name);
    if (!entry) return null;
    const file = await api.readArtifact(entry.path);
    return `${skillBody(file.text ?? '')}\n\n`;
  },
};

// Skills context provider. DORMANT + provider-neutral: injects the skill-discovery protocol + the cached skill
// names/descriptions on every board THAT HAS SKILLS (empty vault → null → zero injected tokens, ADR-4). Bodies
// are never injected — the agent reads the chosen SKILL.md on demand. Pure text ⇒ no LLM call.
export const skillsContextProvider: ContextProviderPlugin<SkillsConfig> = {
  id: 'skills',
  label: 'Skills',
  manifest,
  defaultConfig: {},
  provide({ board }) {
    const text = skillsContextText(cachedSkillEntries(board.elements?.skills));
    return text ? { text } : null;
  },
  seedArtifacts(): SeedArtifact[] {
    return skillsSeedArtifacts(USAGE_DOC);
  },
};
