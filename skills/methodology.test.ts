import { describe, expect, it } from 'vitest';
import { README_PATH, SKILLS_PROTOCOL, cachedSkillEntries, skillSlashCommands, skillsContextText, skillsSeedBraidFiles } from './methodology';

describe('skills context injection', () => {
  it('returns null for an empty vault (no injection)', () => {
    expect(skillsContextText([])).toBeNull();
    expect(skillsContextText(undefined)).toBeNull();
  });

  it('lists skill name + description + read pointer, never a body', () => {
    const text = skillsContextText([
      { name: 'commit-helper', description: 'Stage and commit.', path: '.braid/skills/commit-helper/SKILL.md' },
    ]);
    expect(text).toContain('commit-helper');
    expect(text).toContain('Stage and commit.');
    expect(text).toContain('.braid/skills/commit-helper/SKILL.md');
    expect(text).toContain(SKILLS_PROTOCOL);
  });

  it('instructs lazy skill selection instead of plan-run pre-reading', () => {
    const text = skillsContextText([
      { name: 'code-review', description: 'Use when reviewing code.', path: '.braid/skills/code-review/SKILL.md' },
      { name: 'ui-design', description: 'Use when polishing UI.', path: '.braid/skills/ui-design/SKILL.md' },
    ]) ?? '';
    expect(SKILLS_PROTOCOL.length).toBeLessThanOrEqual(450);
    expect(text).toContain('choose the smallest matching set');
    expect(text).toContain('do not pre-read all skills');
    expect(text).toContain('including during plan runs');
    expect(text).toContain('primary `SKILL.md` before acting');
    expect(text).toContain('Reuse an unchanged body already read');
  });

  it('dedupes by name and sorts', () => {
    const text = skillsContextText([
      { name: 'b', description: '', path: 'b' },
      { name: 'a', description: '', path: 'a' },
      { name: 'a', description: 'dup', path: 'a' },
    ]) ?? '';
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('- a ')).length).toBe(1);
    expect(text.indexOf('- a ')).toBeGreaterThan(-1);
    expect(text.indexOf('- b ')).toBeGreaterThan(text.indexOf('- a '));
  });

  it('caps the list and notes omitted skills', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `s${String(i).padStart(2, '0')}`, description: '', path: `p${i}` }));
    const text = skillsContextText(many) ?? '';
    expect(text).toContain('45');
    expect(text).toContain('more skills');
  });

  it('reads cached entries from element state', () => {
    expect(cachedSkillEntries({ index: [{ name: 'x', description: 'd', path: 'p' }] })).toEqual([
      { name: 'x', description: 'd', path: 'p' },
    ]);
    expect(cachedSkillEntries(undefined)).toEqual([]);
  });

  it('seeds the README spec', () => {
    expect(skillsSeedBraidFiles('DOC').some((a) => a.path === README_PATH)).toBe(true);
  });

  it('maps skill entries to slash-command specs (deduped + sorted)', () => {
    const cmds = skillSlashCommands([
      { name: 'b', description: 'Bee', path: 'b' },
      { name: 'a', description: '', path: 'a' },
      { name: 'a', description: 'dup', path: 'a' },
    ]);
    expect(cmds).toEqual([
      { name: 'a', description: undefined },
      { name: 'b', description: 'Bee' },
    ]);
  });
});
