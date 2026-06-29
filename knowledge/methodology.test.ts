import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_PROTOCOL,
  README_PATH,
  VAULT_DIR,
  VAULT_INDEX,
  cachedIndexTitles,
  cachedRoutingEntries,
  knowledgeContextText,
  knowledgeSeedArtifacts,
} from './methodology';
import manifest from './plugin.json';

describe('knowledge methodology', () => {
  it('injects the vault path, record + recall instructions, and the index pointer', () => {
    const text = knowledgeContextText();
    expect(text).toContain(`${VAULT_DIR}/`);
    expect(text).toContain(VAULT_INDEX);
    expect(text).toMatch(/RECORD/);
    expect(text).toMatch(/RECALL/);
  });

  it('returns just the pointer protocol when no routing entries are supplied', () => {
    expect(knowledgeContextText()).toBe(KNOWLEDGE_PROTOCOL);
    expect(knowledgeContextText([])).toBe(KNOWLEDGE_PROTOCOL);
    expect(knowledgeContextText(['   '])).toBe(KNOWLEDGE_PROTOCOL);
  });

  it('injects bounded current routing metadata without note body text', () => {
    const text = knowledgeContextText([
      {
        title: 'Auth tokens',
        path: 'auth-tokens.md',
        scope: 'OAuth auth flow',
        keywords: ['oauth', 'token'],
        type: 'semantic',
        status: 'current',
        updated: '2026-06-28',
      },
      {
        title: 'Old secret note',
        path: 'old.md',
        scope: 'legacy',
        keywords: ['old'],
        type: 'semantic',
        status: 'superseded',
        updated: '2026-06-27',
      },
    ]);
    expect(text.startsWith(KNOWLEDGE_PROTOCOL)).toBe(true);
    expect(text).toContain('Current vault routing (1 note; bodies not injected)');
    expect(text).toContain('Auth tokens');
    expect(text).toContain('scope=OAuth auth flow');
    expect(text).toContain('keywords=oauth, token');
    expect(text).not.toContain('Old secret note');
    expect(text).not.toContain('full body claim that should stay in the note');
  });

  it('caps injected routing entries at 40', () => {
    const entries = Array.from({ length: 45 }, (_, i) => ({
      title: `Note ${i}`,
      path: `note-${i}.md`,
      scope: '',
      keywords: [],
      type: 'semantic',
      status: 'current',
      updated: '',
    }));
    const text = knowledgeContextText(entries);
    expect(text).toContain('Note 39');
    expect(text).not.toContain('Note 40 (');
    expect(text).toContain('5 more current notes');
  });

  it('exports stable vault paths', () => {
    expect(VAULT_DIR).toBe('.braid/knowledge');
    expect(VAULT_INDEX).toBe('.braid/knowledge/_index.md');
    expect(README_PATH).toBe('.braid/knowledge/_README.md');
  });

  it('includes an honesty clause forbidding unverified recording claims', () => {
    expect(KNOWLEDGE_PROTOCOL).toMatch(/HONESTY/);
    expect(KNOWLEDGE_PROTOCOL).toMatch(/not yet recorded/);
  });

  it('appends a bounded recording-gap nudge only when requested, leaving no-gap output unchanged', () => {
    expect(knowledgeContextText()).toBe(KNOWLEDGE_PROTOCOL);
    const gap = knowledgeContextText([], { recordingGap: true });
    expect(gap.startsWith(KNOWLEDGE_PROTOCOL)).toBe(true);
    expect(gap).toContain('wrote nothing to `.braid/knowledge/`');
    // exactly one extra line appended
    expect(gap.split('\n').length).toBe(KNOWLEDGE_PROTOCOL.split('\n').length + 1);
  });
});

describe('knowledge seed + manifest', () => {
  it('seed builder returns exactly one artifact under .braid/knowledge/', () => {
    const arts = knowledgeSeedArtifacts('# usage doc body');
    expect(arts).toHaveLength(1);
    expect(arts[0].path.startsWith(`${VAULT_DIR}/`)).toBe(true);
    expect(arts[0].text).toContain('# usage doc body');
    expect(arts[0].text).toContain('Managed by the Braid Knowledge plugin');
  });

  it('ships enabled + disableable and contributes the knowledge context provider + board element', () => {
    expect(manifest.id).toBe('knowledge');
    expect(manifest.defaultEnabled).toBe(true);
    expect(manifest.canDisable).toBe(true);
    expect(manifest.contributes?.contextProviders).toContain('knowledge');
    expect(manifest.contributes?.boardElements).toContain('knowledge');
  });
});

describe('knowledge cached routing entries', () => {
  it('reads rich routing entries from element state and filters malformed/non-current values', () => {
    expect(cachedRoutingEntries({
      index: [
        { title: 'Auth tokens', path: 'auth.md', scope: 'Auth', keywords: ['oauth'], type: 'semantic', status: 'current', updated: '2026-06-28' },
        { title: 'Old', path: 'old.md', scope: '', keywords: [], type: 'semantic', status: 'stale', updated: '2026-06-27' },
        { nope: true },
      ],
    })).toEqual([
      { title: 'Auth tokens', path: 'auth.md', scope: 'Auth', keywords: ['oauth'], type: 'semantic', status: 'current', updated: '2026-06-28' },
    ]);
  });

  it('keeps string[] cache backward-compatible', () => {
    expect(cachedIndexTitles({ index: ['Auth tokens', 'Codex fork'] })).toEqual(['Auth tokens', 'Codex fork']);
  });

  it('returns [] for missing / malformed state', () => {
    expect(cachedRoutingEntries(undefined)).toEqual([]);
    expect(cachedRoutingEntries({})).toEqual([]);
    expect(cachedRoutingEntries({ index: 'nope' })).toEqual([]);
  });
});
