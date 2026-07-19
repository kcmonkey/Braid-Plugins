import React from 'react';
import type { PluginManifest, WorkspaceBadgePlugin, WorkspacePanelContext, WorkspacePanelPlugin } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';
import {
  MEMORY_INSPECTION_STATE_KEY,
  isMemoryInspectionActionResult,
  normalizeMemoryInspectionPanelSnapshot,
  type MemoryInspectionActionResult,
  type MemoryInspectionPanelSnapshot,
  type MemoryInspectionRecord,
  type MemoryInspectionSnapshot,
} from './inspection';

const manifest = manifestJson as PluginManifest;

type FilterValue = 'all' | 'current' | 'stale' | 'superseded' | 'disputed' | 'verified' | 'unverified' | 'provisional' | 'final' | 'not-checked' | 'locator-present' | 'locator-missing';
type SortValue = 'updated' | 'title' | 'review';

const statusOptions: FilterValue[] = ['all', 'current', 'stale', 'superseded', 'disputed'];
const freshnessOptions: FilterValue[] = ['all', 'verified', 'unverified'];
const provisionalOptions: FilterValue[] = ['all', 'provisional', 'final'];
const sourceOptions: FilterValue[] = ['all', 'not-checked', 'locator-present', 'locator-missing'];

function text(value: string): string {
  return value.length > 96 ? `${value.slice(0, 95).trim()}…` : value;
}

function reviewPriority(record: MemoryInspectionRecord): number {
  if (record.status === 'disputed') return 0;
  if (record.status === 'stale' || record.status === 'superseded') return 1;
  if (record.freshness === 'unverified' || record.provisional || record.sourceCheck === 'locator-missing') return 2;
  return 3;
}

function filteredRecords(
  records: MemoryInspectionRecord[],
  query: string,
  status: FilterValue,
  freshness: FilterValue,
  provisional: FilterValue,
  source: FilterValue,
  sort: SortValue,
): MemoryInspectionRecord[] {
  const term = query.trim().toLocaleLowerCase();
  const filtered = records.filter((record) => {
    const haystack = [record.id, record.title, record.verb, record.scope, record.tags.join(' '), record.recallCue, record.provenance]
      .join(' ')
      .toLocaleLowerCase();
    return (!term || haystack.includes(term)) &&
      (status === 'all' || record.status === status) &&
      (freshness === 'all' || record.freshness === freshness) &&
      (provisional === 'all' || (provisional === 'provisional' ? record.provisional : !record.provisional)) &&
      (source === 'all' || record.sourceCheck === source);
  });
  return filtered
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      if (sort === 'title') return a.record.title.localeCompare(b.record.title) || a.record.id.localeCompare(b.record.id) || a.index - b.index;
      if (sort === 'review') return reviewPriority(a.record) - reviewPriority(b.record) || b.record.updatedAt.localeCompare(a.record.updatedAt) || a.record.title.localeCompare(b.record.title) || a.index - b.index;
      return b.record.updatedAt.localeCompare(a.record.updatedAt) || a.record.title.localeCompare(b.record.title) || a.record.id.localeCompare(b.record.id) || a.index - b.index;
    })
    .map(({ record }) => record);
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: FilterValue; options: FilterValue[]; onChange: (value: FilterValue) => void }) {
  return <label style={{ display: 'grid', gap: 4, minWidth: 0, color: 'var(--muted)', fontSize: 11 }}>
    <span>{label}</span>
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as FilterValue)} style={selectStyle}>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>;
}

function InspectionPanel({ snapshot, onClose, requestAction }: {
  snapshot: MemoryInspectionSnapshot | null;
  onClose: () => void;
  requestAction: WorkspacePanelContext['requestAction'];
}) {
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<FilterValue>('all');
  const [freshness, setFreshness] = React.useState<FilterValue>('all');
  const [provisional, setProvisional] = React.useState<FilterValue>('all');
  const [source, setSource] = React.useState<FilterValue>('all');
  const [sort, setSort] = React.useState<SortValue>('updated');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<'detail' | 'refresh' | null>(null);
  const [actionError, setActionError] = React.useState('');
  const [detail, setDetail] = React.useState<MemoryInspectionRecord | null>(null);
  const actionInFlightRef = React.useRef(false);

  const runAction = (kind: 'detail' | 'refresh', action: 'inspectDetail' | 'refreshInspection', payload?: unknown) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionLoading(kind);
    setActionError('');
    const showActionError = (error: unknown) => {
      setActionError(error instanceof Error ? error.message : 'Inspection action failed.');
    };
    const releaseAction = () => {
      actionInFlightRef.current = false;
      setActionLoading(null);
    };
    try {
      void requestAction(action, payload).then(({ data: result }) => {
        if (!isMemoryInspectionActionResult(result)) throw new Error('Malformed inspection action reply.');
        if (!result.ok) throw new Error(result.error);
        if (result.action === 'inspectDetail') setDetail(result.record);
      }).catch(showActionError).finally(releaseAction);
    } catch (error) {
      showActionError(error);
      releaseAction();
    }
  };

  if (snapshot === null) {
    return <PanelShell onClose={onClose} total={0}>
      <StateMessage title="Loading inspection" detail="Waiting for a list-safe memory metadata snapshot." />
    </PanelShell>;
  }
  if (snapshot.kind === 'error') {
    return <PanelShell onClose={onClose} total={0} onRefresh={() => runAction('refresh', 'refreshInspection')} refreshing={actionLoading === 'refresh'} refreshDisabled={actionLoading !== null}>
      <StateMessage title="Inspection unavailable" detail={snapshot.error || 'The host could not provide a memory inspection snapshot.'} />
    </PanelShell>;
  }

  const results = filteredRecords(snapshot.records, query, status, freshness, provisional, source, sort);
  const selected = results.find((record) => record.id === selectedId) ?? null;
  return <PanelShell onClose={onClose} total={snapshot.total} onRefresh={() => runAction('refresh', 'refreshInspection')} refreshing={actionLoading === 'refresh'} refreshDisabled={actionLoading !== null}>
    <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, marginBottom: 10 }}>
      Usage counters are maintenance signals only; routing, freshness, provisional state, and source checks remain separate.
    </div>
    {snapshot.availability === 'stale' ? <StateMessage title="Older snapshot" detail="This panel is displaying a compatible legacy snapshot; refresh reloads list-safe metadata only." compact /> : null}
    {actionError ? <StateMessage title="Inspection action failed" detail={actionError} compact /> : null}
    <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
      <label style={{ display: 'grid', gap: 4, minWidth: 0, color: 'var(--muted)', fontSize: 11 }}>
        <span>Search metadata</span>
        <input aria-label="Search metadata" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, scope, tag, cue…" style={inputStyle} />
      </label>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))' }}>
        <FilterSelect label="Routing" value={status} options={statusOptions} onChange={setStatus} />
        <FilterSelect label="Freshness" value={freshness} options={freshnessOptions} onChange={setFreshness} />
        <FilterSelect label="Provisional" value={provisional} options={provisionalOptions} onChange={setProvisional} />
        <FilterSelect label="Source check" value={source} options={sourceOptions} onChange={setSource} />
      </div>
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
      <span style={{ color: 'var(--text-2)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{results.length} results / {snapshot.total} total</span>
      <span style={{ color: 'var(--muted-2)', fontSize: 12 }}>·</span>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--muted)', fontSize: 12 }}>
        Sort
        <select aria-label="Sort results" value={sort} onChange={(event) => setSort(event.target.value as SortValue)} style={selectStyle}>
          <option value="updated">Recently updated</option>
          <option value="title">Title</option>
          <option value="review">Review priority</option>
        </select>
      </label>
      <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>Review priority is only a routing queue.</span>
    </div>
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', marginBottom: 12, color: 'var(--muted)', fontSize: 11 }}>
      <span>lesson {snapshot.counts.lesson}</span><span>locator {snapshot.counts.locator}</span><span>snapshot {snapshot.counts.snapshot}</span><span>transcript {snapshot.counts.transcript}</span>
      <span>disputed {snapshot.counts.disputed}</span><span>unverified {snapshot.counts.unverified}</span><span>provisional {snapshot.counts.provisional}</span><span>source locator missing {snapshot.counts.sourceLocatorMissing}</span>
    </div>
    {snapshot.total === 0 ? <StateMessage title="No memory records" detail="The project memory store is empty." /> : null}
    {snapshot.total > 0 && results.length === 0 ? <StateMessage title="No matching metadata" detail="Change or clear the local filters to see the full inspection list." /> : null}
    <div aria-label="Memory inspection results" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2 }}>
      {results.map((record) => {
        const selectedRow = record.id === selectedId;
        const focusedRow = record.id === focusedId;
        return <button
          key={record.id}
          type="button"
          className="nodrag"
          aria-pressed={selectedRow}
          onClick={() => setSelectedId(record.id)}
          onFocus={() => setFocusedId(record.id)}
          onBlur={() => setFocusedId(null)}
          style={{
            ...rowStyle,
            borderColor: selectedRow ? 'var(--accent)' : 'var(--border-sub)',
            background: selectedRow ? 'var(--accent-soft)' : 'var(--panel-2)',
            boxShadow: focusedRow ? '0 0 0 2px var(--accent-soft)' : 'none',
          }}
        >
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
            <strong style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.title}</strong>
            <span style={metaStyle}>class {record.corpusClass} · {record.verb}</span>
            <span style={metaStyle}>{record.status}</span>
            <span style={metaStyle}>{record.freshness}</span>
            <span style={metaStyle}>{record.provisional ? 'provisional' : 'final'}</span>
            <span style={metaStyle}>{record.sourceCheck}</span>
          </span>
          {record.scope || record.tags.length ? <span style={metaStyle}>scope {text(record.scope || '—')}{record.tags.length ? ` · tags ${text(record.tags.join(', '))}` : ''}</span> : null}
          {record.recallCue ? <span style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.35 }}>{text(record.recallCue)}</span> : null}
          <span style={metaStyle}>provenance {text(record.provenance || '—')} · evidence {record.evidenceLocatorCount} · reads {record.readCount} · cited {record.citedByCount}</span>
        </button>;
      })}
    </div>
    {selected ? <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', borderTop: '1px solid var(--border-sub)', color: 'var(--muted)', fontSize: 12, marginTop: 10, paddingTop: 10 }}>
      <span>Selected: {selected.title}</span>
      <button className="ghost-btn nodrag" type="button" disabled={actionLoading !== null} onClick={() => runAction('detail', 'inspectDetail', { id: selected.id })} title="Read list-safe metadata for the selected memory">
        {actionLoading === 'detail' ? 'Loading details…' : 'View details'}
      </button>
    </div> : null}
    {detail ? <div role="status" style={{ background: 'var(--panel-2)', border: '1px solid var(--border-sub)', color: 'var(--muted)', display: 'grid', fontSize: 12, gap: 4, marginTop: 10, padding: 10 }}>
      <strong style={{ color: 'var(--text-2)' }}>Read-only metadata detail</strong>
      <span>id {detail.id} · updated {detail.updatedAt || '—'}</span>
      <span>scope {detail.scope || '—'} · tags {detail.tags.join(', ') || '—'}</span>
      <span>cue {detail.recallCue || '—'}</span>
      <span>provenance {detail.provenance || '—'} · evidence locators {detail.evidenceLocatorCount}</span>
    </div> : null}
  </PanelShell>;
}

function PanelShell({ children, onClose, onRefresh, refreshing, refreshDisabled, total }: { children: React.ReactNode; onClose: () => void; onRefresh?: () => void; refreshing?: boolean; refreshDisabled?: boolean; total: number }) {
  const dialogRef = React.useRef<HTMLDivElement>(null);

  const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  };
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div
    className="memory-inspection-modal nodrag nopan nowheel"
    style={{
      alignItems: 'center',
      backdropFilter: 'blur(2px)',
      background: 'rgba(7, 9, 16, .72)',
      boxSizing: 'border-box',
      display: 'flex',
      inset: 0,
      justifyContent: 'center',
      padding: 12,
      pointerEvents: 'auto',
      position: 'fixed',
      zIndex: 70,
    }}
    onClick={handleBackdropClick}
    onContextMenu={stopPropagation}
    onPointerDown={stopPropagation}
    onWheel={stopPropagation}
  >
    <div
      ref={dialogRef}
      className="memory-inspection-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-inspection-title"
      autoFocus
      tabIndex={-1}
      onClick={stopPropagation}
      onKeyDown={handleDialogKeyDown}
      onKeyUp={stopPropagation}
      onPointerDown={stopPropagation}
      onWheel={stopPropagation}
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        boxShadow: '0 28px 80px rgba(0, 0, 0, .62)',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100vh - 24px)',
        maxWidth: 880,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        width: 'min(880px, calc(100vw - 24px))',
      }}
    >
      <div style={{ alignItems: 'center', borderBottom: '1px solid var(--border-sub)', display: 'flex', flexShrink: 0, gap: 8, padding: '12px 16px' }}>
        <span id="memory-inspection-title" style={{ color: 'var(--accent)', fontWeight: 700 }}>Memory inspection</span>
        <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{total} records</span>
        <span style={{ flex: 1 }} />
        {onRefresh ? <button className="ghost-btn nodrag" type="button" onClick={onRefresh} disabled={refreshDisabled ?? refreshing} title="Refresh list-safe inspection metadata">{refreshing ? 'Refreshing…' : 'Refresh'}</button> : null}
        <button className="ghost-btn nodrag" type="button" onClick={onClose} title="Close inspection" aria-label="Close memory inspection">Close</button>
      </div>
      <div style={{ minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', padding: 16 }}>
        {children}
      </div>
    </div>
  </div>;
}

function StateMessage({ title, detail, compact = false }: { title: string; detail: string; compact?: boolean }) {
  return <div role="status" style={{ background: 'var(--panel-2)', border: '1px solid var(--border-sub)', color: 'var(--muted)', fontSize: 12, lineHeight: 1.45, marginBottom: compact ? 10 : 0, padding: compact ? 8 : 12 }}>
    <strong style={{ color: 'var(--text-2)' }}>{title}</strong><div>{detail}</div>
  </div>;
}

const inputStyle: React.CSSProperties = { background: 'var(--bg-deep)', border: '1px solid var(--border-sub)', color: 'var(--text)', font: 'inherit', minWidth: 0, padding: '6px 8px' };
const selectStyle: React.CSSProperties = { background: 'var(--bg-deep)', border: '1px solid var(--border-sub)', color: 'var(--text-2)', font: 'inherit', minWidth: 0, padding: '5px 6px' };
const rowStyle: React.CSSProperties = { border: '1px solid var(--border-sub)', color: 'var(--text-2)', cursor: 'pointer', display: 'grid', gap: 4, minWidth: 0, padding: 9, textAlign: 'left' };
const metaStyle: React.CSSProperties = { color: 'var(--muted)', fontSize: 11, lineHeight: 1.35 };

export const memoryInspectionPanel: WorkspacePanelPlugin<MemoryInspectionPanelSnapshot | null> = {
  id: 'memory.inspectionPanel',
  label: 'Memory inspection',
  manifest,
  stateKey: MEMORY_INSPECTION_STATE_KEY,
  renderPanel: ({ data, onClose, requestAction }) => <InspectionPanel snapshot={normalizeMemoryInspectionPanelSnapshot(data)} onClose={onClose} requestAction={requestAction} />,
};

export const memoryInspectionBadge: WorkspaceBadgePlugin<MemoryInspectionPanelSnapshot | null> = {
  id: 'memory.inspectionBadge',
  label: 'Memory inspection',
  manifest,
  panelId: memoryInspectionPanel.id,
  stateKey: MEMORY_INSPECTION_STATE_KEY,
  icon: <span className="tb-ico">M</span>,
  count: ({ data }) => normalizeMemoryInspectionPanelSnapshot(data)?.total ?? 0,
  title: ({ data }) => {
    const snapshot = normalizeMemoryInspectionPanelSnapshot(data);
    if (!snapshot) return 'Memory — loading inspection';
    if (snapshot.kind === 'error') return 'Memory — inspection unavailable';
    return `Memory — ${snapshot.total} records, ${snapshot.counts.disputed} disputed, ${snapshot.counts.stale} stale`;
  },
};
