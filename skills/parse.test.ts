import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, skillBody, skillEntryFromFile, sortSkillEntries } from './parse';

describe('skill frontmatter parse', () => {
  it('extracts name + description from YAML frontmatter', () => {
    const md = ['---', 'name: commit-helper', 'description: Stage and commit with a tidy message.', '---', '', '# Body'].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'commit-helper', description: 'Stage and commit with a tidy message.' });
  });

  it('strips surrounding quotes', () => {
    const md = ['---', 'name: "x"', "description: 'does y'", '---'].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'x', description: 'does y' });
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a heading\nno frontmatter')).toBeNull();
  });

  it('falls back to the folder name when frontmatter omits name', () => {
    const e = skillEntryFromFile('my-skill', '# no frontmatter', '.braid/skills/my-skill/SKILL.md');
    expect(e).toEqual({ name: 'my-skill', description: '', path: '.braid/skills/my-skill/SKILL.md' });
  });

  it('prefers the frontmatter name over the folder name', () => {
    const md = ['---', 'name: real-name', 'description: d', '---'].join('\n');
    const e = skillEntryFromFile('folder', md, '.braid/skills/folder/SKILL.md');
    expect(e).toEqual({ name: 'real-name', description: 'd', path: '.braid/skills/folder/SKILL.md' });
  });

  it('sorts entries by name', () => {
    const entries = [
      { name: 'b', description: '', path: 'b' },
      { name: 'a', description: '', path: 'a' },
    ];
    expect(sortSkillEntries(entries).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('returns the body after the frontmatter block', () => {
    const md = ['---', 'name: x', 'description: d', '---', '', '# Do the thing', 'step 1'].join('\n');
    expect(skillBody(md)).toBe('# Do the thing\nstep 1');
  });

  it('returns the whole text when there is no frontmatter', () => {
    expect(skillBody('# Just instructions\nstep 1')).toBe('# Just instructions\nstep 1');
  });
});
