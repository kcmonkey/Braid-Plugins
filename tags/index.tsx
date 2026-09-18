import React from 'react';
import type { BoardElementPlugin, PluginManifest } from '../../../src/plugin-api/types';
import { ProviderModelPicker, type ProviderModelPickerProps } from '../shared/ProviderModelPicker';
import manifestJson from './plugin.json';
import {
  BUILTIN_TAGS,
  applyTagDerivation,
  asTagState,
  defaultTagConfig,
  deriveTagRequest,
  hasCustomTagLlmRoute,
  normalizeTagName,
  tagDefs,
  tagDeriveKey,
  type TagConfig,
  type TagDef,
  type TagState,
} from './derivation';

export { defaultTagConfig, tagDeriveKey } from './derivation';

export const manifest = manifestJson as PluginManifest;

function TagConfigPanel({ config, onChange, activeProvider, providerCaps }: {
  config: TagConfig;
  onChange(config: TagConfig): void;
  activeProvider: string;
  providerCaps: ProviderModelPickerProps['providerCaps'];
}) {
  const updateTag = (idx: number, patch: Partial<TagDef>) => {
    const tags = tagDefs(config).map((t, i) => (i === idx ? { ...t, ...patch, name: patch.name != null ? normalizeTagName(patch.name) : t.name } : t));
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
    const req = deriveTagRequest(board, config, state);
    // Re-derive ONLY when the content/config key changes — NOT when the result happened to be empty.
    // `applyDerived` stamps `revision` for every reply (including a zero-tag classification or a oneShot
    // failure that returns ''), so keying the guard on `revision === key` alone stops an unclassifiable
    // board (or a transient failure) from re-requesting the LLM one-shot forever. (the effect re-fires on
    // every nodes change, so a `tags.length`-gated guard would loop indefinitely for empty results.)
    if (!req) return null;
    return {
      ...req,
      engine: config.engine,
      model: config.model,
      route: config.engine ? 'active' : 'summary',
    };
  },
  contributeSummaryDerivation({ board, config, state }) {
    // Bundled board-summary derivation always runs on the summary route. If the user configured this plugin
    // with its own provider/model, leave it to the standalone derive path so that routing contract is preserved.
    if (hasCustomTagLlmRoute(config)) return null;
    return deriveTagRequest(board, config, state);
  },
  applyDerived(_prevState, text, config, key): TagState {
    return applyTagDerivation(text, config, key);
  },
  applySummaryDerivation(_prevState, text, config, key): TagState {
    return applyTagDerivation(text, config, key);
  },
  render({ slot, config, state }) {
    // Tags belong on the board card only (top / far-far head). Explicitly opt OUT of any non-card slot (e.g. the
    // ChatView 'chatview-aside' panel) instead of nulling just card-detail, so new slots never leak tag chips.
    if (slot !== 'card-top' && slot !== 'card-head-inline') return null;
    const tags = asTagState(state)?.tags ?? [];
    if (!tags.length) return null;
    const defs = new Map(tagDefs(config).map((t) => [normalizeTagName(t.name), t]));
    return (
      <div className="board__tags">
        {tags.map((raw) => {
          const tag = normalizeTagName(String(raw));
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
