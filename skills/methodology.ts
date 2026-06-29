// The Braid Skills plugin OWNS this protocol (plans/skills-plugin). It is injected (DORMANT) on every board that
// has skills, so the agent can discover and follow reusable, project-local SKILLS under `.braid/skills/` on ANY
// engine. Everything here is PURE (no React, no `.md` import) so it is unit-testable.

import type { SeedArtifact } from '../../../src/plugin-api/types';
import type { SkillEntry } from './parse';
import { sortSkillEntries } from './parse';

export const VAULT_DIR = '.braid/skills';
export const README_PATH = '.braid/skills/_README.md';
const README_HEADER = '<!-- Managed by the Braid Skills plugin - edits are overwritten on plugin update. -->';

export const SKILLS_PROTOCOL =
  'This project has reusable agent SKILLS under `.braid/skills/`. Each skill is a folder ' +
  '`.braid/skills/<name>/SKILL.md`: its frontmatter has a name + description, its body holds the instructions, ' +
  'and it may ship helper scripts/resources alongside it. Only skill names + descriptions are listed here — ' +
  'NOT the bodies. When a task matches a skill, READ that skill\'s SKILL.md on demand BEFORE acting, then ' +
  'follow it and run any bundled scripts with your own tools. Ignore skills that do not apply.';

function asEntry(value: unknown): SkillEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<SkillEntry>;
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) return undefined;
  return {
    name,
    description: typeof v.description === 'string' ? v.description.trim() : '',
    path: typeof v.path === 'string' ? v.path.trim() : '',
  };
}

function normalizeEntries(entries?: readonly unknown[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const raw of entries ?? []) {
    const e = asEntry(raw);
    if (!e || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return sortSkillEntries(out);
}

function entryLine(e: SkillEntry): string {
  const desc = e.description ? ` — ${e.description}` : '';
  const where = e.path ? ` (read: ${e.path})` : '';
  return `- ${e.name}${desc}${where}`;
}

// Empty/absent vault → null (no injection, ADR-4). Otherwise the protocol + the available skills (names +
// descriptions + read pointer only; capped so a huge vault stays within the host's per-block budget).
export function skillsContextText(entries?: readonly unknown[]): string | null {
  const list = normalizeEntries(entries);
  if (!list.length) return null;
  const listed = list.slice(0, 40);
  const lines = listed.map(entryLine).join('\n');
  const omitted = list.length > listed.length ? `\n- … ${list.length - listed.length} more skills in ${VAULT_DIR}` : '';
  return `${SKILLS_PROTOCOL}\nAvailable skills (${list.length}; bodies not injected):\n${lines}${omitted}`;
}

export function cachedSkillEntries(elementState: unknown): SkillEntry[] {
  const idx = (elementState as { index?: unknown } | undefined)?.index;
  return Array.isArray(idx) ? normalizeEntries(idx) : [];
}

export interface SkillSlashCommand {
  name: string;
  description?: string;
}

// Map skill entries to composer `/` slash-command specs (deduped + sorted, frontmatter description as the hint),
// for the autofill menu. (plans/skills-plugin ADR-5/7)
export function skillSlashCommands(entries?: readonly unknown[]): SkillSlashCommand[] {
  return normalizeEntries(entries).map((e) => ({ name: e.name, description: e.description || undefined }));
}

export function skillsSeedArtifacts(usageDoc: string): SeedArtifact[] {
  return [{ path: README_PATH, text: `${README_HEADER}\n\n${usageDoc}` }];
}
