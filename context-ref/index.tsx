import type { ContextProviderPlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

// Reference context-provider plugin (plans/Plan-Plugin P1). DISABLED by default; when enabled it injects a
// fixed marker block into EVERY turn (fresh / resume / fork / follow-up) — the host-observable proof that the
// contextProviders seam works, and the delete gate (remove this plugin ⇒ injection gone, core domain-blind).
// NOT the real Plan plugin. Pure text ⇒ no LLM call (contract D4).
export const CONTEXT_REF_MARKER = '[context-ref] Braid contextProviders seam is live for this board.';

interface ContextRefConfig { marker: string }

export const manifest = manifestJson as PluginManifest;

export const contextRefPlugin: ContextProviderPlugin<ContextRefConfig> = {
  id: 'context-ref',
  label: 'Context provider (reference)',
  manifest,
  defaultConfig: { marker: CONTEXT_REF_MARKER },
  provide({ boardId, config }) {
    const marker = config.marker?.trim() || CONTEXT_REF_MARKER;
    return { text: `${marker} (board ${boardId})` };
  },
};
