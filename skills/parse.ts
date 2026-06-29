// Pure parsing for the Braid skills vault. Skills live as `.braid/skills/<name>/SKILL.md`; discovery scans those
// folders and reads each SKILL.md's frontmatter (name + description) — NO hand-maintained index is required
// (mirrors how native Agent Skills are found, so dropping a folder in "just works"). Everything here is PURE
// (no React, no `.md`/fs import) so it is unit-testable (vitest has no `.md` loader).

export interface SkillEntry {
  /** Skill identifier shown to the agent (and, in Phase 2, the `/`-trigger token). */
  name: string;
  /** One-line description from frontmatter (may be empty). */
  description: string;
  /** Workspace-relative path to the skill's SKILL.md — what the agent reads on demand. */
  path: string;
}

function stripScalar(raw: string): string {
  let v = raw.trim().replace(/^[>|][-+0-9]*\s*/, '');
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.trim();
}

// Pull `name` / `description` scalars from a leading `---` YAML frontmatter block. null when there is no
// frontmatter at all. Tolerant of quotes and a single-line block-scalar marker; a missing field reads as ''.
export function parseSkillFrontmatter(md: string): { name: string; description: string } | null {
  const text = (md ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const body = m[1];
  const field = (key: string): string => {
    const fm = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*\\S)?[ \\t]*$`, 'im').exec(body);
    return fm && fm[1] ? stripScalar(fm[1]) : '';
  };
  const name = field('name');
  const description = field('description');
  if (!name && !description) return null;
  return { name, description };
}

// Build a routing entry for one skill folder given its SKILL.md text. Falls back to the folder name when the
// frontmatter omits `name` (so a body-only SKILL.md still registers). null when there is no usable name.
export function skillEntryFromFile(dirName: string, skillMd: string, mdPath: string): SkillEntry | null {
  const fm = parseSkillFrontmatter(skillMd);
  const name = (fm?.name || dirName || '').trim();
  if (!name) return null;
  return { name, description: (fm?.description ?? '').trim(), path: mdPath };
}

export function sortSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

// Return the instruction body of a SKILL.md — everything after the leading `---` frontmatter block. When there is
// no frontmatter, the whole text is the body. Used by the manual `/` invoke to insert only the instructions.
export function skillBody(md: string): string {
  const text = (md ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}
