import React from 'react';
import type { EngineId } from '../../../src/protocol';
import type { BoardElementPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { BoardLike } from '../shared/board';
import { ProviderModelPicker, type ProviderModelPickerProps } from '../shared/ProviderModelPicker';
import manifestJson from './plugin.json';

interface TagDef { name: string; color: string; description: string }
interface TagConfig {
  engine?: EngineId;
  model?: string;
  tags: TagDef[];
  classifyPromptOverride?: string;
}

// The plugin's OWN per-board persisted state, stored opaquely by core at board.elements['tags'].
interface TagState { tags: string[]; revision: string }
function asTagState(s: unknown): TagState | undefined {
  return s && typeof s === 'object' && Array.isArray((s as TagState).tags) ? (s as TagState) : undefined;
}

const TAG_CODE_VERSION = 1;
const MAX_TAGS = 2;

const BUILTIN_TAGS: TagDef[] = [
  { name: 'coding', color: '#5aa1ff', description: 'writing or changing code' },
  { name: 'plan', color: '#b78cff', description: 'planning, strategy, architecture' },
  { name: 'design', color: '#ff8ad1', description: 'API, UI, data model design' },
  { name: 'review', color: '#e0b341', description: 'critiquing code or a design' },
  { name: 'debug', color: '#ff6b6b', description: 'diagnosing or fixing a bug' },
  { name: 'refactor', color: '#36c5b0', description: 'restructuring without behavior change' },
  { name: 'test', color: '#6cd06c', description: 'tests and verification' },
  { name: 'research', color: '#3fb8d4', description: 'investigating, comparing, learning' },
  { name: 'docs', color: '#9aa6b2', description: 'writing documentation' },
  { name: 'commit', color: '#f0883e', description: 'version control actions' },
  { name: 'build', color: '#a8c93a', description: 'building, compiling, packaging' },
  { name: 'deploy', color: '#8a86f5', description: 'releasing, publishing, shipping' },
  { name: 'config', color: '#7f9cb0', description: 'configuration, settings, tooling' },
  { name: 'deps', color: '#c98a5e', description: 'dependency or package management' },
];

export const defaultTagConfig: TagConfig = { tags: BUILTIN_TAGS };

export const manifest = manifestJson as PluginManifest;

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Tolerate a malformed/hand-edited config whose `tags` is missing or not an array (pluginEntry shallow-merges
// the persisted config over the default, so `{ tags: null }` would otherwise crash every `.map`/`.filter`).
function tagDefs(cfg: TagConfig): TagDef[] {
  return Array.isArray(cfg.tags) ? cfg.tags : BUILTIN_TAGS;
}

function revision(cfg: TagConfig): string {
  return `tags:${TAG_CODE_VERSION}:${hashText(JSON.stringify({
    tags: tagDefs(cfg).map((t) => [normalizeName(t.name), t.description]),
    prompt: cfg.classifyPromptOverride ?? '',
  }))}`;
}

function deriveKey(board: BoardLike, cfg: TagConfig): string {
  return `${revision(cfg)}:${hashText(`${board.prompt}\n${board.answer}`)}`;
}

function classifyPrompt(cfg: TagConfig): string {
  if (cfg.classifyPromptOverride?.trim()) return cfg.classifyPromptOverride.trim();
  const vocab = tagDefs(cfg).map((t) => `${normalizeName(t.name)} = ${t.description}`).join('; ');
  return `You are a conversation tagger for a canvas. Choose 1-${MAX_TAGS} tags from this exact vocabulary and output only comma-separated tag names, lowercase, no prose. Vocabulary: ${vocab}.`;
}

function parseTags(text: string, cfg: TagConfig): string[] {
  const allowed = new Set(tagDefs(cfg).map((t) => normalizeName(t.name)).filter(Boolean));
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const tag = normalizeName(raw);
    if (!tag || !allowed.has(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function TagConfigPanel({ config, onChange, activeProvider, providerCaps }: {
  config: TagConfig;
  onChange(config: TagConfig): void;
  activeProvider: string;
  providerCaps: ProviderModelPickerProps['providerCaps'];
}) {
  const updateTag = (idx: number, patch: Partial<TagDef>) => {
    const tags = tagDefs(config).map((t, i) => (i === idx ? { ...t, ...patch, name: patch.name != null ? normalizeName(patch.name) : t.name } : t));
    onChange({ ...config, tags });
  };
  return (
    <div className="plugin-config plugin-config--tags">
      <ProviderModelPicker
        engine={config.engine}
        model={config.model}
        activeProvider={activeProvider}
        providerCaps={providerCaps}
        onChange={(next) => onChange({ ...config, ...next })}
      />
      <div className="plugin-tag-list">
        {tagDefs(config).map((t, idx) => (
          <div className="plugin-tag-row" key={`${t.name}-${idx}`}>
            <input value={t.name} aria-label="Tag name" onChange={(e) => updateTag(idx, { name: e.target.value })} />
            <input type="color" value={t.color} aria-label="Tag color" onChange={(e) => updateTag(idx, { color: e.target.value })} />
            <input value={t.description} aria-label="Tag description" onChange={(e) => updateTag(idx, { description: e.target.value })} />
            <button className="ghost-btn" type="button" onClick={() => onChange({ ...config, tags: tagDefs(config).filter((_, i) => i !== idx) })}>Remove</button>
          </div>
        ))}
      </div>
      <button className="soft-btn" type="button" onClick={() => onChange({ ...config, tags: [...tagDefs(config), { name: 'custom', color: '#8c857b', description: 'custom topic' }] })}>Add tag</button>
    </div>
  );
}

export const tagPlugin: BoardElementPlugin<TagConfig> = {
  id: 'tags',
  label: 'Tags',
  manifest,
  defaultConfig: defaultTagConfig,
  derive({ board, config, state }) {
    if (board.status !== 'done' || !board.answer || board.compact || board.collapsedGraph) return null;
    const key = deriveKey(board, config);
    // Re-derive ONLY when the content/config key changes — NOT when the result happened to be empty.
    // `applyDerived` stamps `revision` for every reply (including a zero-tag classification or a oneShot
    // failure that returns ''), so keying the guard on `revision === key` alone stops an unclassifiable
    // board (or a transient failure) from re-requesting the LLM one-shot forever. (the effect re-fires on
    // every nodes change, so a `tags.length`-gated guard would loop indefinitely for empty results.)
    if (asTagState(state)?.revision === key) return null;
    return {
      key,
      system: classifyPrompt(config),
      content: `Q: ${board.prompt}\n\nA: ${board.answer}`,
      engine: config.engine,
      model: config.model,
    };
  },
  applyDerived(_prevState, text, config, key): TagState {
    return { tags: parseTags(text, config), revision: key };
  },
  render({ slot, config, state }) {
    // Tags belong on the board card only (top / far-far head). Explicitly opt OUT of any non-card slot (e.g. the
    // ChatView 'chatview-aside' panel) instead of nulling just card-detail, so new slots never leak tag chips.
    if (slot !== 'card-top' && slot !== 'card-head-inline') return null;
    const tags = asTagState(state)?.tags ?? [];
    if (!tags.length) return null;
    const defs = new Map(tagDefs(config).map((t) => [normalizeName(t.name), t]));
    return (
      <div className="board__tags">
        {tags.map((raw) => {
          const tag = normalizeName(String(raw));
          const def = defs.get(tag);
          const builtin = BUILTIN_TAGS.some((t) => t.name === tag);
          const style = !builtin && def ? { color: def.color, borderColor: def.color, background: `${def.color}22` } : undefined;
          return <span key={tag} className={`tag${builtin ? ` tag--${tag}` : ''}`} style={style} title={def?.description ?? `Topic: ${tag}`}>{tag}</span>;
        })}
      </div>
    );
  },
  searchText(state) {
    const tags = asTagState(state)?.tags;
    return tags && tags.length ? tags.join(' ') : undefined;
  },
  renderConfig({ config, onChange, activeProvider, providerCaps }) {
    return <TagConfigPanel config={config} onChange={onChange} activeProvider={activeProvider} providerCaps={providerCaps} />;
  },
};

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
