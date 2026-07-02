// Knowledge usage workspace surfaces (ADR-14): a toolbar badge + panel showing per-canvas RECALL / RECORD / GAP
// counts observed from the real tool stream. Read-only; the host `service.ts` publishes the data. Counts are
// "this session" (reset on host reload). Mirrors the coordinator's workspace badge/panel wiring.

import type { PluginManifest, WorkspaceBadgePlugin, WorkspacePanelPlugin } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';
import { emptyUsage, knowledgeUsageTotal, type KnowledgeUsageSnapshot } from './usage';

const manifest = manifestJson as PluginManifest;

function snap(data: KnowledgeUsageSnapshot | null | undefined): KnowledgeUsageSnapshot {
  return data ?? emptyUsage();
}

function UsageRow({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0' }}>
      <span style={{ minWidth: 72, color: '#bdb6ac' }}>{label}</span>
      <span style={{ minWidth: 28, fontWeight: 700, color: value ? '#83a1ff' : '#6f6a62', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ color: '#8c857b', fontSize: 12 }}>{hint}</span>
    </div>
  );
}

export const knowledgeUsagePanel: WorkspacePanelPlugin<KnowledgeUsageSnapshot | null> = {
  id: 'knowledge.usagePanel',
  label: 'Knowledge usage',
  manifest,
  stateKey: 'knowledgeUsage',
  renderPanel: ({ data, onClose }) => {
    const s = snap(data);
    return (
      <div className="knowledge-usage-panel" style={{ padding: 16, minWidth: 320 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontWeight: 700, color: '#83a1ff' }}>📚 Knowledge vault usage</span>
          <span style={{ flex: 1 }} />
          <button
            className="nodrag"
            onClick={onClose}
            title="Close"
            style={{ background: 'none', border: 'none', color: '#8c857b', cursor: 'pointer', fontSize: 14 }}
          >
            ✕
          </button>
        </div>
        <div style={{ color: '#8c857b', fontSize: 12, marginBottom: 8 }}>This host session (resets on reload).</div>
        <UsageRow label="Recalls" value={s.recalls} hint="reads of .braid/knowledge/" />
        <UsageRow label="Records" value={s.records} hint="writes to .braid/knowledge/" />
        <UsageRow label="Gaps" value={s.gaps} hint="claimed a lesson but didn't record it" />
        {knowledgeUsageTotal(s) === 0 ? (
          <div style={{ marginTop: 10, color: '#6f6a62', fontSize: 12, lineHeight: 1.4 }}>
            No vault activity yet this session — the agent has not read or written the knowledge vault.
          </div>
        ) : null}
      </div>
    );
  },
};

export const knowledgeUsageBadge: WorkspaceBadgePlugin<KnowledgeUsageSnapshot | null> = {
  id: 'knowledge.usageBadge',
  label: 'Knowledge usage',
  manifest,
  panelId: knowledgeUsagePanel.id,
  stateKey: 'knowledgeUsage',
  icon: <span className="tb-ico">📚</span>,
  count: ({ data }) => knowledgeUsageTotal(snap(data)),
  title: ({ data }) => {
    const s = snap(data);
    return `Knowledge vault (this session) — ${s.recalls} recall / ${s.records} record / ${s.gaps} gap`;
  },
};
