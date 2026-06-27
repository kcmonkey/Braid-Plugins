import React from 'react';
import type { BoardActionPlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

interface Macro { label: string; prompt: string }
interface PromptMacroConfig { macros: Macro[] }

const defaultMacros: Macro[] = [
  { label: 'Continue', prompt: '继续' },
  { label: 'Verify', prompt: '验证吧' },
  { label: 'Root Cause', prompt: '调查根因的修复方案' },
];

export const manifest = manifestJson as PluginManifest;

export const promptMacroPlugin: BoardActionPlugin<PromptMacroConfig> = {
  id: 'prompt-macros',
  label: 'Prompt macros',
  manifest,
  defaultConfig: { macros: defaultMacros },
  render({ boardId, board, config, api }) {
    if (board.status !== 'done' && board.status !== 'error') return null;
    const macros = config.macros?.length ? config.macros : defaultMacros;
    return (
      <div className="plugin-actions plugin-actions--macros nodrag nopan">
        {macros.map((m, idx) => (
          <button key={`${m.label}-${idx}`} className="soft-btn" type="button" title={m.prompt} onClick={() => api.sendTurn(boardId, m.prompt)}>
            {m.label}
          </button>
        ))}
      </div>
    );
  },
  renderConfig({ config, onChange }) {
    const macros = config.macros?.length ? config.macros : defaultMacros;
    const update = (idx: number, patch: Partial<Macro>) => {
      onChange({ macros: macros.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
    };
    return (
      <div className="plugin-config plugin-config--macros">
        {macros.map((m, idx) => (
          <div className="plugin-macro-row" key={`${m.label}-${idx}`}>
            <input value={m.label} aria-label="Macro label" onChange={(e) => update(idx, { label: e.target.value })} />
            <input value={m.prompt} aria-label="Macro prompt" onChange={(e) => update(idx, { prompt: e.target.value })} />
            <button className="ghost-btn" type="button" onClick={() => onChange({ macros: macros.filter((_, i) => i !== idx) })}>Remove</button>
          </div>
        ))}
        <button className="soft-btn" type="button" onClick={() => onChange({ macros: [...macros, { label: 'New', prompt: '' }] })}>Add macro</button>
      </div>
    );
  },
};
