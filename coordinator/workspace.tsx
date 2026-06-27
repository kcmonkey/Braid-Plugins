import React from 'react';
import type { BoardPluginApi, PluginManifest, WorkspaceBadgePlugin, WorkspacePanelPlugin } from '../../../src/plugin-api/types';
import {
  normalizeResourceKey,
  normalizeWorkspaceResources,
  type CoordinationSnapshot,
  type ResourceClaimMode,
  type ResourcePriority,
  type ResourceTrigger,
  type WorkspaceResource,
  type WorkspaceResourceRequirement,
} from './model';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

const RESOURCE_FILE = '.braid/resources.json';
const RESOURCE_MODES: ResourceClaimMode[] = ['shared', 'exclusive', 'state'];
const RESOURCE_PRIORITIES: ResourcePriority[] = ['low', 'normal', 'high'];

type MaybePriority = ResourcePriority | '';
type MaybeMode = ResourceClaimMode | '';

interface EditableRequirement {
  resource: string;
  mode: MaybeMode;
  desiredState: string;
  priority: MaybePriority;
  summary: string;
}

interface EditableTrigger {
  tool: string;
  toolMatches: string;
  commandMatches: string;
  notMatches: string;
  desiredState: string;
  priority: MaybePriority;
  summary: string;
}

interface EditableResource {
  id: string;
  label: string;
  kind: ResourceClaimMode;
  statesText: string;
  priority: MaybePriority;
  description: string;
  requires: EditableRequirement[];
  claimOn: EditableTrigger[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === 'string' && record[key].trim() ? (record[key] as string).trim() : undefined;
const resourceMode = (value: unknown): ResourceClaimMode | undefined =>
  typeof value === 'string' && RESOURCE_MODES.includes(value as ResourceClaimMode) ? value as ResourceClaimMode : undefined;
const resourcePriority = (value: unknown): ResourcePriority | undefined =>
  typeof value === 'string' && RESOURCE_PRIORITIES.includes(value as ResourcePriority) ? value as ResourcePriority : undefined;
const splitList = (text: string): string[] =>
  text.split(',').map((s) => s.trim()).filter(Boolean);

function parseRequirements(value: unknown): WorkspaceResourceRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkspaceResourceRequirement[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const resource = stringField(raw, 'resource');
    if (!resource) continue;
    out.push({
      resource,
      mode: resourceMode(raw.mode),
      desiredState: stringField(raw, 'desiredState'),
      priority: resourcePriority(raw.priority),
      summary: stringField(raw, 'summary'),
    });
  }
  return out.length ? out : undefined;
}

function parseTriggers(value: unknown): ResourceTrigger[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ResourceTrigger[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    out.push({
      tool: stringField(raw, 'tool'),
      toolMatches: stringField(raw, 'toolMatches'),
      commandMatches: stringField(raw, 'commandMatches'),
      notMatches: stringField(raw, 'notMatches'),
      desiredState: stringField(raw, 'desiredState'),
      priority: resourcePriority(raw.priority),
      summary: stringField(raw, 'summary'),
    });
  }
  return out.length ? out : undefined;
}

function parseResourceDocument(text: string): WorkspaceResource[] {
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.resources)
    ? parsed.resources
    : null;
  if (!rows) throw new Error('Expected an object with a resources array.');
  const resources: WorkspaceResource[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = stringField(raw, 'id');
    if (!id) continue;
    resources.push({
      id,
      label: stringField(raw, 'label'),
      kind: resourceMode(raw.kind) ?? 'shared',
      states: Array.isArray(raw.states) ? raw.states.filter((s): s is string => typeof s === 'string') : undefined,
      priority: resourcePriority(raw.priority),
      requires: parseRequirements(raw.requires),
      description: stringField(raw, 'description'),
      claimOn: parseTriggers(raw.claimOn),
    });
  }
  return normalizeWorkspaceResources(resources);
}

function editableResources(resources: WorkspaceResource[]): EditableResource[] {
  return resources.map((resource) => ({
    id: resource.id,
    label: resource.label ?? '',
    kind: resource.kind,
    statesText: resource.states?.join(', ') ?? '',
    priority: resource.priority ?? '',
    description: resource.description ?? '',
    requires: (resource.requires ?? []).map((req) => ({
      resource: req.resource,
      mode: req.mode ?? '',
      desiredState: req.desiredState ?? '',
      priority: req.priority ?? '',
      summary: req.summary ?? '',
    })),
    claimOn: (resource.claimOn ?? []).map((trigger) => ({
      tool: trigger.tool ?? '',
      toolMatches: trigger.toolMatches ?? '',
      commandMatches: trigger.commandMatches ?? '',
      notMatches: trigger.notMatches ?? '',
      desiredState: trigger.desiredState ?? '',
      priority: trigger.priority ?? '',
      summary: trigger.summary ?? '',
    })),
  }));
}

function workspaceResources(resources: EditableResource[]): WorkspaceResource[] {
  return normalizeWorkspaceResources(resources.map((resource) => ({
    id: resource.id,
    label: resource.label,
    kind: resource.kind,
    states: resource.kind === 'state' ? splitList(resource.statesText) : undefined,
    priority: resource.priority || undefined,
    description: resource.description,
    requires: resource.requires
      .map((req) => ({
        resource: req.resource,
        mode: req.mode || undefined,
        desiredState: req.desiredState,
        priority: req.priority || undefined,
        summary: req.summary,
      }))
      .filter((req) => req.resource.trim()),
    claimOn: resource.claimOn
      .map((trigger) => ({
        tool: trigger.tool,
        toolMatches: trigger.toolMatches,
        commandMatches: trigger.commandMatches,
        notMatches: trigger.notMatches,
        desiredState: trigger.desiredState,
        priority: trigger.priority || undefined,
        summary: trigger.summary,
      }))
      .filter((trigger) => trigger.tool.trim() || trigger.toolMatches.trim() || trigger.commandMatches.trim()),
  })));
}

function cleanResource(resource: WorkspaceResource): WorkspaceResource {
  return {
    id: resource.id,
    ...(resource.label ? { label: resource.label } : {}),
    kind: resource.kind,
    ...(resource.states?.length ? { states: resource.states } : {}),
    ...(resource.priority ? { priority: resource.priority } : {}),
    ...(resource.requires?.length ? { requires: resource.requires.map((req) => ({
      resource: req.resource,
      ...(req.mode ? { mode: req.mode } : {}),
      ...(req.desiredState ? { desiredState: req.desiredState } : {}),
      ...(req.priority ? { priority: req.priority } : {}),
      ...(req.summary ? { summary: req.summary } : {}),
    })) } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.claimOn?.length ? { claimOn: resource.claimOn.map((trigger) => ({
      ...(trigger.tool ? { tool: trigger.tool } : {}),
      ...(trigger.toolMatches ? { toolMatches: trigger.toolMatches } : {}),
      ...(trigger.commandMatches ? { commandMatches: trigger.commandMatches } : {}),
      ...(trigger.notMatches ? { notMatches: trigger.notMatches } : {}),
      ...(trigger.desiredState ? { desiredState: trigger.desiredState } : {}),
      ...(trigger.priority ? { priority: trigger.priority } : {}),
      ...(trigger.summary ? { summary: trigger.summary } : {}),
    })) } : {}),
  };
}

function resourceDocumentText(resources: EditableResource[]): string {
  const clean = workspaceResources(resources).map(cleanResource);
  return `${JSON.stringify({ resources: clean }, null, 2)}\n`;
}

function nextResourceId(resources: EditableResource[]): string {
  const used = new Set(resources.map((r) => normalizeResourceKey(r.id)));
  let idx = 1;
  while (used.has(`new-resource-${idx}`)) idx++;
  return `new-resource-${idx}`;
}

function validateRegex(pattern: string, label: string, resource: string, triggerIndex: number): string | null {
  if (!pattern.trim()) return null;
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (e: any) {
    return `${resource} trigger ${triggerIndex + 1}: invalid ${label} regex (${e?.message ?? 'error'}).`;
  }
}

function resourceConfigErrors(resources: EditableResource[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const [index, resource] of resources.entries()) {
    const label = resource.id.trim() || `resource ${index + 1}`;
    const key = normalizeResourceKey(resource.id);
    if (!key) errors.push(`Resource ${index + 1}: id is required.`);
    else if (ids.has(key)) errors.push(`${label}: duplicate resource id.`);
    else ids.add(key);
    if (resource.kind === 'state' && splitList(resource.statesText).length === 0) {
      errors.push(`${label}: state resources need at least one state.`);
    }
    for (const [reqIndex, req] of resource.requires.entries()) {
      const reqKey = normalizeResourceKey(req.resource);
      if (!reqKey) errors.push(`${label} requirement ${reqIndex + 1}: resource is required.`);
      else if (!ids.has(reqKey) && !resources.some((r) => normalizeResourceKey(r.id) === reqKey)) {
        errors.push(`${label} requirement ${reqIndex + 1}: unknown resource ${req.resource}.`);
      }
    }
    for (const [triggerIndex, trigger] of resource.claimOn.entries()) {
      if (!trigger.tool.trim() && !trigger.toolMatches.trim() && !trigger.commandMatches.trim()) {
        errors.push(`${label} trigger ${triggerIndex + 1}: add a tool or regex match.`);
      }
      for (const err of [
        validateRegex(trigger.toolMatches, 'tool', label, triggerIndex),
        validateRegex(trigger.commandMatches, 'command', label, triggerIndex),
        validateRegex(trigger.notMatches, 'negative', label, triggerIndex),
      ]) {
        if (err) errors.push(err);
      }
    }
  }
  return errors;
}

export function coordinationBadgeCount(snapshot: CoordinationSnapshot | null): number {
  return snapshot
    ? snapshot.claims.length +
      snapshot.resourceClaims.length +
      snapshot.intents.filter((i) => i.status === 'active').length +
      snapshot.negotiations.filter((n) => n.status !== 'resolved' && n.status !== 'rejected').length
    : 0;
}

function CoordinatorResourcesConfigPanel({ api }: { api: BoardPluginApi }) {
  const [resources, setResources] = React.useState<EditableResource[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  const loadResources = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(null);
    const result = await api.readArtifact(RESOURCE_FILE);
    if (result.error) {
      setResources([]);
      setError(result.error);
      setDirty(false);
      setLoading(false);
      return;
    }
    try {
      setResources(editableResources(parseResourceDocument(result.text ?? '')));
      setDirty(false);
    } catch (e: any) {
      setResources([]);
      setError(e?.message ?? 'Could not parse resources.json.');
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void loadResources();
  }, [loadResources]);

  const errors = React.useMemo(() => resourceConfigErrors(resources), [resources]);
  const resourceIds = React.useMemo(() => resources.map((r) => normalizeResourceKey(r.id)).filter(Boolean), [resources]);

  const mutate = React.useCallback((fn: (prev: EditableResource[]) => EditableResource[]) => {
    setResources((prev) => fn(prev));
    setDirty(true);
    setSaved(null);
    setError(null);
  }, []);

  const save = React.useCallback(async () => {
    const currentErrors = resourceConfigErrors(resources);
    if (currentErrors.length) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    const result = await api.writeArtifact(RESOURCE_FILE, resourceDocumentText(resources));
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const normalized = editableResources(workspaceResources(resources));
    setResources(normalized);
    setDirty(false);
    setSaved('Saved');
  }, [api, resources]);

  const addResource = () => mutate((prev) => [...prev, {
    id: nextResourceId(prev),
    label: 'New resource',
    kind: 'shared',
    statesText: '',
    priority: 'normal',
    description: '',
    requires: [],
    claimOn: [],
  }]);

  return (
    <div className="plugin-config plugin-config--coordinator">
      <div className="plugin-resource-toolbar">
        <div className="plugin-resource-title">
          <span>Workspace resources</span>
          <small>{RESOURCE_FILE}</small>
        </div>
        <div className="plugin-resource-actions">
          <button className="ghost-btn" type="button" onClick={() => void loadResources()} disabled={loading || saving}>Reload</button>
          <button className="soft-btn" type="button" onClick={addResource} disabled={loading || saving}>Add resource</button>
        </div>
      </div>

      {loading ? <div className="settings__hint">Loading resources...</div> : null}
      {error ? <div className="plugin-resource-error">{error}</div> : null}
      {errors.length > 0 ? (
        <div className="plugin-resource-error">
          {errors.slice(0, 4).map((err) => <div key={err}>{err}</div>)}
          {errors.length > 4 ? <div>{errors.length - 4} more issues.</div> : null}
        </div>
      ) : null}

      {!loading && resources.length === 0 ? (
        <div className="plugin-resource-empty">No resources configured.</div>
      ) : null}

      {resources.map((resource, index) => {
        const optionList = `coord-resource-options-${index}`;
        return (
          <div className="plugin-resource-card" key={`${resource.id}-${index}`}>
            <datalist id={optionList}>
              {resourceIds.map((id) => <option key={id} value={id} />)}
            </datalist>
            <div className="plugin-resource-card__head">
              <input
                aria-label="Resource id"
                value={resource.id}
                spellCheck={false}
                onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, id: e.target.value } : r))}
              />
              <select
                aria-label="Resource kind"
                value={resource.kind}
                onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, kind: e.target.value as ResourceClaimMode } : r))}
              >
                {RESOURCE_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
              <button className="ghost-btn" type="button" onClick={() => mutate((prev) => prev.filter((_, i) => i !== index))}>Remove</button>
            </div>

            <div className="plugin-resource-grid">
              <label>
                <span>Label</span>
                <input
                  value={resource.label}
                  onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, label: e.target.value } : r))}
                />
              </label>
              <label>
                <span>Priority</span>
                <select
                  value={resource.priority}
                  onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, priority: e.target.value as MaybePriority } : r))}
                >
                  <option value="">Default</option>
                  {RESOURCE_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                </select>
              </label>
              {resource.kind === 'state' ? (
                <label>
                  <span>States</span>
                  <input
                    value={resource.statesText}
                    placeholder="open, closed"
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, statesText: e.target.value } : r))}
                  />
                </label>
              ) : null}
              <label className="plugin-resource-grid__wide">
                <span>Description</span>
                <input
                  value={resource.description}
                  onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, description: e.target.value } : r))}
                />
              </label>
            </div>

            <div className="plugin-resource-subsection">
              <div className="plugin-resource-subhead">
                <span>Requires</span>
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: [...r.requires, { resource: '', mode: '', desiredState: '', priority: '', summary: '' }] } : r))}
                >
                  Add
                </button>
              </div>
              {resource.requires.length === 0 ? <div className="plugin-resource-empty">None</div> : null}
              {resource.requires.map((req, reqIndex) => (
                <div className="plugin-resource-row plugin-resource-row--requirement" key={reqIndex}>
                  <input
                    aria-label="Required resource"
                    list={optionList}
                    value={req.resource}
                    placeholder="resource"
                    spellCheck={false}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.map((row, j) => j === reqIndex ? { ...row, resource: e.target.value } : row) } : r))}
                  />
                  <select
                    aria-label="Required mode"
                    value={req.mode}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.map((row, j) => j === reqIndex ? { ...row, mode: e.target.value as MaybeMode } : row) } : r))}
                  >
                    <option value="">Any</option>
                    {RESOURCE_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                  <input
                    aria-label="Required state"
                    value={req.desiredState}
                    placeholder="state"
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.map((row, j) => j === reqIndex ? { ...row, desiredState: e.target.value } : row) } : r))}
                  />
                  <select
                    aria-label="Required priority"
                    value={req.priority}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.map((row, j) => j === reqIndex ? { ...row, priority: e.target.value as MaybePriority } : row) } : r))}
                  >
                    <option value="">Priority</option>
                    {RESOURCE_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                  <input
                    className="plugin-resource-row__summary"
                    aria-label="Requirement summary"
                    value={req.summary}
                    placeholder="summary"
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.map((row, j) => j === reqIndex ? { ...row, summary: e.target.value } : row) } : r))}
                  />
                  <button
                    className="ghost-btn"
                    type="button"
                    onClick={() => mutate((prev) => prev.map((r, i) => i === index ? { ...r, requires: r.requires.filter((_, j) => j !== reqIndex) } : r))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="plugin-resource-subsection">
              <div className="plugin-resource-subhead">
                <span>Tool triggers</span>
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: [...r.claimOn, { tool: '', toolMatches: '', commandMatches: '', notMatches: '', desiredState: '', priority: '', summary: '' }] } : r))}
                >
                  Add
                </button>
              </div>
              {resource.claimOn.length === 0 ? <div className="plugin-resource-empty">None</div> : null}
              {resource.claimOn.map((trigger, triggerIndex) => (
                <div className="plugin-resource-trigger" key={triggerIndex}>
                  <input
                    aria-label="Tool"
                    value={trigger.tool}
                    placeholder="tool"
                    spellCheck={false}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, tool: e.target.value } : row) } : r))}
                  />
                  <input
                    aria-label="Tool regex"
                    value={trigger.toolMatches}
                    placeholder="tool regex"
                    spellCheck={false}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, toolMatches: e.target.value } : row) } : r))}
                  />
                  <input
                    aria-label="Command regex"
                    value={trigger.commandMatches}
                    placeholder="command regex"
                    spellCheck={false}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, commandMatches: e.target.value } : row) } : r))}
                  />
                  <input
                    aria-label="Negative regex"
                    value={trigger.notMatches}
                    placeholder="not regex"
                    spellCheck={false}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, notMatches: e.target.value } : row) } : r))}
                  />
                  <input
                    aria-label="Trigger state"
                    value={trigger.desiredState}
                    placeholder="state"
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, desiredState: e.target.value } : row) } : r))}
                  />
                  <select
                    aria-label="Trigger priority"
                    value={trigger.priority}
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, priority: e.target.value as MaybePriority } : row) } : r))}
                  >
                    <option value="">Priority</option>
                    {RESOURCE_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                  <input
                    className="plugin-resource-trigger__summary"
                    aria-label="Trigger summary"
                    value={trigger.summary}
                    placeholder="summary"
                    onChange={(e) => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.map((row, j) => j === triggerIndex ? { ...row, summary: e.target.value } : row) } : r))}
                  />
                  <button
                    className="ghost-btn"
                    type="button"
                    onClick={() => mutate((prev) => prev.map((r, i) => i === index ? { ...r, claimOn: r.claimOn.filter((_, j) => j !== triggerIndex) } : r))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="plugin-resource-footer">
        <button className="primary-btn" type="button" onClick={() => void save()} disabled={loading || saving || errors.length > 0 || !dirty}>
          {saving ? 'Saving...' : 'Save resources'}
        </button>
        {saved ? <span className="plugin-resource-status">{saved}</span> : null}
        {dirty && !saved ? <span className="plugin-resource-status">Unsaved changes</span> : null}
      </div>
    </div>
  );
}

function CoordinationWorkspacePanel({ snapshot, onClose }: { snapshot: CoordinationSnapshot | null; onClose: () => void }) {
  const claims = snapshot?.claims ?? [];
  const resourceClaims = snapshot?.resourceClaims ?? [];
  const intents = snapshot?.intents ?? [];
  const messages = snapshot?.messages ?? [];
  const negotiations = snapshot?.negotiations ?? [];
  const resources = snapshot?.resources ?? [];
  const caps = snapshot?.capabilities ?? {};
  const capRows = Object.entries(caps);
  const activeClaims = claims.filter((c) => c.status !== 'released');
  const activeResourceClaims = resourceClaims.filter((c) => c.status !== 'released');
  const openNegotiations = negotiations.filter((n) => n.status !== 'resolved' && n.status !== 'rejected');
  return (
    <>
      <div className="coord__backdrop" onClick={onClose} />
      <div className="coord-panel nodrag nopan" role="dialog" aria-label="Coordination" onClick={(e) => e.stopPropagation()}>
        <div className="coord-panel__head">
          <h2>Coordination <span className="coord-panel__sub">{activeClaims.length + activeResourceClaims.length} claims, {openNegotiations.length} open</span></h2>
          <button className="coord-panel__x" onClick={onClose} title="Close">x</button>
        </div>
        <div className="coord-panel__body">
          {!snapshot && <div className="coord-panel__empty">No coordination snapshot yet.</div>}
          {snapshot && activeClaims.length === 0 && activeResourceClaims.length === 0 && resources.length === 0 && intents.length === 0 && messages.length === 0 && negotiations.length === 0 && (
            <div className="coord-panel__empty">No active coordination state.</div>
          )}
          {resources.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Workspace Resources</div>
              {resources.slice(0, 8).map((resource) => {
                const requires = resource.requires?.map((r) => `${r.resource}${r.desiredState ? `=${r.desiredState}` : ''}`).join(', ');
                return (
                  <div className="coord-row" key={resource.id}>
                    <div className="coord-row__main">
                      <span className="coord-row__path" title={resource.description ?? resource.id}>{resource.label ?? resource.id}</span>
                      <span className="coord-row__meta">{resource.kind}{resource.priority && resource.priority !== 'normal' ? ` / ${resource.priority}` : ''}</span>
                    </div>
                    {(requires || resource.states?.length) && (
                      <div className="coord-row__actor">
                        {requires ? `requires ${requires}` : `states ${resource.states?.join(', ')}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}
          {activeClaims.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">File Claims</div>
              {activeClaims.slice(0, 8).map((claim) => (
                <div className={`coord-row coord-row--${claim.status}`} key={claim.id}>
                  <div className="coord-row__main">
                    <span className="coord-row__path" title={claim.path}>{claim.path}</span>
                    <span className="coord-row__meta">Board {claim.boardId} / {claim.access}</span>
                  </div>
                  {claim.actor && <div className="coord-row__actor">{claim.actor.label ?? claim.actor.kind}{claim.actor.provider ? ` / ${claim.actor.provider}` : ''}</div>}
                </div>
              ))}
            </section>
          )}
          {activeResourceClaims.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Resource Claims</div>
              {activeResourceClaims.slice(0, 8).map((claim) => (
                <div className={`coord-row coord-row--${claim.status}`} key={claim.id}>
                  <div className="coord-row__main">
                    <span className="coord-row__path" title={claim.resource}>{claim.resource}</span>
                    <span className="coord-row__meta">
                      Board {claim.boardId} / {claim.mode}{claim.desiredState ? `=${claim.desiredState}` : ''} / {claim.status}{claim.priority !== 'normal' ? ` / ${claim.priority}` : ''}
                    </span>
                  </div>
                  {(claim.summary || claim.actor || claim.requiredBy) && (
                    <div className="coord-row__actor">
                      {[
                        claim.summary ?? (claim.actor ? `${claim.actor.label ?? claim.actor.kind}${claim.actor.provider ? ` / ${claim.actor.provider}` : ''}` : ''),
                        claim.requiredBy ? `required by ${claim.requiredBy}` : '',
                      ].filter(Boolean).join(' / ')}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}
          {intents.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Work Intent</div>
              {intents.slice(0, 6).map((intent) => (
                <div className="coord-row" key={intent.id}>
                  <div className="coord-row__main">
                    <span className="coord-row__path" title={intent.title}>{intent.title}</span>
                    <span className="coord-row__meta">Board {intent.boardId} / {intent.status}</span>
                  </div>
                  {!!intent.topics.length && <div className="coord-row__actor">{intent.topics.join(', ')}</div>}
                </div>
              ))}
            </section>
          )}
          {openNegotiations.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Negotiation</div>
              {openNegotiations.slice(0, 6).map((thread) => (
                <div className="coord-row" key={thread.id}>
                  <div className="coord-row__main">
                    <span className="coord-row__path" title={thread.topic}>{thread.topic}</span>
                    <span className="coord-row__meta">{thread.status} / {thread.boardIds.join(' + ')}</span>
                  </div>
                  {thread.turns.at(-1)?.text && <div className="coord-row__actor">{thread.turns.at(-1)?.text}</div>}
                </div>
              ))}
            </section>
          )}
          {messages.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Inbox</div>
              {messages.slice(-8).reverse().map((message) => (
                <div className="coord-row" key={message.id}>
                  <div className="coord-row__main">
                    <span className="coord-row__path" title={message.text}>{message.text}</span>
                    <span className="coord-row__meta">{message.kind} / {message.fromBoardId}{message.toBoardId ? ` -> ${message.toBoardId}` : ''}</span>
                  </div>
                </div>
              ))}
            </section>
          )}
          {capRows.length > 0 && (
            <section className="coord-section">
              <div className="coord-section__head">Provider Capability</div>
              {capRows.map(([provider, cap]) => (
                <div className="coord-row" key={provider}>
                  <div className="coord-row__main">
                    <span className="coord-row__path">{provider}</span>
                    <span className="coord-row__meta">write gate {cap?.knownWriteGate ?? 'unknown'}</span>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export const coordinatorWorkspacePanel: WorkspacePanelPlugin<CoordinationSnapshot | null> = {
  id: 'coordinator.workspacePanel',
  label: 'Coordination',
  manifest,
  stateKey: 'coordination',
  renderPanel: ({ data, onClose }) => <CoordinationWorkspacePanel snapshot={data ?? null} onClose={onClose} />,
  renderConfig: ({ api }) => <CoordinatorResourcesConfigPanel api={api} />,
};

export const coordinatorWorkspaceBadge: WorkspaceBadgePlugin<CoordinationSnapshot | null> = {
  id: 'coordinator.workspaceBadge',
  label: 'Coordination',
  manifest,
  panelId: coordinatorWorkspacePanel.id,
  stateKey: 'coordination',
  icon: <span className="tb-ico">Co</span>,
  count: ({ data }) => coordinationBadgeCount(data ?? null),
  title: ({ data }) => {
    const count = coordinationBadgeCount(data ?? null);
    return count ? `Coordination (${count})` : 'Coordination';
  },
};
