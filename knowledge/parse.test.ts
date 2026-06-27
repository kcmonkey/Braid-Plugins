import { describe, expect, it } from 'vitest';
import { notesFromEntries, parseKnowledgeIndex, routableKnowledgeEntries, validateKnowledgeVault } from './parse';

describe('knowledge index parse', () => {
  it('parses rich table entries with routing metadata', () => {
    const md = [
      '| Title | Path | Type | Status | Updated | Scope | Keywords |',
      '|---|---|---|---|---|---|---|',
      '| Auth tokens | auth-tokens.md | semantic | current | 2026-06-28 | Auth flow | oauth, token |',
      '| Old fact | old.md | semantic | superseded | 2026-06-27 | Legacy | old |',
    ].join('\n');
    expect(parseKnowledgeIndex(md)).toEqual([
      {
        title: 'Auth tokens',
        path: 'auth-tokens.md',
        type: 'semantic',
        status: 'current',
        updated: '2026-06-28',
        scope: 'Auth flow',
        keywords: ['oauth', 'token'],
      },
      {
        title: 'Old fact',
        path: 'old.md',
        type: 'semantic',
        status: 'superseded',
        updated: '2026-06-27',
        scope: 'Legacy',
        keywords: ['old'],
      },
    ]);
  });

  it('parses CS legacy File/Scope/Keywords tables without losing routing fields', () => {
    const md = [
      '| File | Scope | Keywords |',
      '|------|-------|----------|',
      '| [mcp.md](../knowledge-vault/mcp.md) | MCP tool conventions | MCP, Remote Execution |',
    ].join('\n');
    expect(parseKnowledgeIndex(md)).toEqual([
      {
        title: 'mcp',
        path: 'mcp.md',
        type: 'semantic',
        status: 'current',
        updated: '',
        scope: 'MCP tool conventions',
        keywords: ['MCP', 'Remote Execution'],
      },
    ]);
  });

  it('keeps backward compatibility with simple bullet indexes', () => {
    const md = '# Index\n- Auth tokens - auth-tokens.md\n* Codex fork - codex-fork.md\n\nnot a bullet\n';
    expect(parseKnowledgeIndex(md)).toEqual([
      { title: 'Auth tokens', path: 'auth-tokens.md', scope: '', keywords: [], type: 'semantic', status: 'current', updated: '' },
      { title: 'Codex fork', path: 'codex-fork.md', scope: '', keywords: [], type: 'semantic', status: 'current', updated: '' },
    ]);
  });

  it('notesFromEntries lists .md files as current semantic notes, skipping `_`-prefixed files and dirs', () => {
    expect(
      notesFromEntries([
        { name: 'codex-fork.md', isDir: false },
        { name: '_index.md', isDir: false },
        { name: '_README.md', isDir: false },
        { name: 'sub', isDir: true },
        { name: 'auth-tokens.md', isDir: false },
        { name: 'notes.txt', isDir: false },
      ]),
    ).toEqual([
      { title: 'auth-tokens', path: 'auth-tokens.md', scope: '', keywords: [], type: 'semantic', status: 'current', updated: '' },
      { title: 'codex-fork', path: 'codex-fork.md', scope: '', keywords: [], type: 'semantic', status: 'current', updated: '' },
    ]);
  });
});

describe('knowledge vault validation', () => {
  const goodText = '# Auth\n\n## Evidence\n- verified_by: test\n';

  it('accepts a current note with evidence and an existing path', () => {
    const index = parseKnowledgeIndex('| Title | Path | Type | Status |\n|---|---|---|---|\n| Auth | auth.md | semantic | current |');
    expect(validateKnowledgeVault(index, [{ path: 'auth.md', text: goodText }])).toEqual({ errors: [], warnings: [] });
  });

  it('detects broken paths, orphan current notes, duplicate paths, missing evidence, and invalid lifecycle fields', () => {
    const index = parseKnowledgeIndex([
      '| Title | Path | Type | Status |',
      '|---|---|---|---|',
      '| Broken | missing.md | semantic | current |',
      '| No evidence | no-evidence.md | semantic | current |',
      '| Duplicate | no-evidence.md | semantic | current |',
      '| Bad status | bad.md | weird | alive |',
    ].join('\n'));
    const result = validateKnowledgeVault(index, [
      { path: 'no-evidence.md', text: '# Missing evidence\n' },
      { path: 'orphan.md', text: goodText },
      { path: 'bad.md', text: goodText },
    ]);
    expect(result.errors).toEqual(expect.arrayContaining([
      "Broken: current entry path does not exist 'missing.md'",
      'No evidence: current note is missing Evidence section',
      "Duplicate: duplicate index path 'no-evidence.md'",
      "Bad status: invalid type 'weird'",
      "Bad status: invalid status 'alive'",
      "orphan current note 'orphan.md'",
    ]));
  });

  it('excludes non-current entries from default routing', () => {
    const index = parseKnowledgeIndex([
      '| Title | Path | Type | Status |',
      '|---|---|---|---|',
      '| Current | current.md | semantic | current |',
      '| Stale | stale.md | semantic | stale |',
      '| Disputed | disputed.md | semantic | disputed |',
    ].join('\n'));
    expect(routableKnowledgeEntries(index).map((e) => e.title)).toEqual(['Current']);
  });
});
