import type { PluginManifest, WorkspaceBadgePlugin, WorkspacePanelPlugin } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';
import {
  emptyMemoryInspectionSnapshot,
  MEMORY_INSPECTION_STATE_KEY,
  type MemoryInspectionSnapshot,
} from './inspection';

const manifest = manifestJson as PluginManifest;

function snap(data: MemoryInspectionSnapshot | null | undefined): MemoryInspectionSnapshot {
  return data ?? emptyMemoryInspectionSnapshot();
}

function small(value: string): string {
  return value.length > 96 ? `${value.slice(0, 95).trim()}…` : value;
}

export const memoryInspectionPanel: WorkspacePanelPlugin<MemoryInspectionSnapshot | null> = {
  id: 'memory.inspectionPanel',
  label: 'Memory inspection',
  manifest,
  stateKey: MEMORY_INSPECTION_STATE_KEY,
  renderPanel: ({ data, onClose }) => {
    const s = snap(data);
    return (
      <div className="memory-inspection-panel" style={{ padding: 16, minWidth: 420, maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontWeight: 700, color: '#83a1ff' }}>Memory</span>
          <span style={{ color: '#a8a199', fontVariantNumeric: 'tabular-nums' }}>{s.total} records</span>
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
        <div style={{ color: '#8c857b', fontSize: 12, marginBottom: 10 }}>
          Usage counters are maintenance signals only; authority comes from evidence and endorsement.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#bdb6ac', fontSize: 12, marginBottom: 12 }}>
          <span>lesson {s.counts.lesson}</span>
          <span>locator {s.counts.locator}</span>
          <span>snapshot {s.counts.snapshot}</span>
          <span>transcript {s.counts.transcript}</span>
          <span>stale {s.counts.stale}</span>
          <span>disputed {s.counts.disputed}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '58vh', overflow: 'auto' }}>
          {s.records.map((record) => (
            <div key={record.id} style={{ borderTop: '1px solid #2a2724', paddingTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: '#e7dfd4', fontWeight: 700 }}>{record.title}</span>
                <span style={{ color: '#8c857b', fontSize: 12 }}>class {record.corpusClass} · {record.verb}</span>
                <span style={{ color: record.status === 'current' ? '#8c857b' : '#e3b341', fontSize: 12 }}>{record.status}</span>
                <span style={{ color: '#8c857b', fontSize: 12 }}>{record.freshness}</span>
              </div>
              <div style={{ color: '#8c857b', fontSize: 12, marginTop: 3 }}>{small(record.recallCue)}</div>
              <div style={{ color: '#6f6a62', fontSize: 12, marginTop: 3 }}>
                provenance {small(record.provenance)} · reads {record.readCount} · cited {record.citedByCount}
              </div>
              {record.evidenceLocators.length ? (
                <div style={{ color: '#6f6a62', fontSize: 12, marginTop: 3 }}>
                  evidence {small(record.evidenceLocators.join('; '))}
                </div>
              ) : null}
            </div>
          ))}
          {!s.records.length ? <div style={{ color: '#6f6a62', fontSize: 12 }}>No memory records.</div> : null}
        </div>
      </div>
    );
  },
};

export const memoryInspectionBadge: WorkspaceBadgePlugin<MemoryInspectionSnapshot | null> = {
  id: 'memory.inspectionBadge',
  label: 'Memory inspection',
  manifest,
  panelId: memoryInspectionPanel.id,
  stateKey: MEMORY_INSPECTION_STATE_KEY,
  icon: <span className="tb-ico">M</span>,
  count: ({ data }) => snap(data).total,
  title: ({ data }) => {
    const s = snap(data);
    return `Memory — ${s.total} records, ${s.counts.disputed} disputed, ${s.counts.stale} stale`;
  },
};
