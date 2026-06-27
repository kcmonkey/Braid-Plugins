import * as fs from 'fs';
import * as nodePath from 'path';
import * as crypto from 'crypto';
import {
  normalizeWorkspaceResources,
  type ResourceClaimMode,
  type ResourcePriority,
  type WorkspaceResource,
  type WorkspaceResourceRequirement,
} from './model';

const RESOURCE_MODES: ResourceClaimMode[] = ['shared', 'exclusive', 'state'];
const RESOURCE_PRIORITIES: ResourcePriority[] = ['low', 'normal', 'high'];

export interface WorkspaceResourceCatalog {
  file: string;
  signature: string | null;
  resources: WorkspaceResource[];
}

export function workspaceResourceFile(cwd: string): string {
  return nodePath.join(cwd, '.braid', 'resources.json');
}

const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === 'string' && record[key].trim() ? record[key] as string : undefined;

const resourceMode = (value: unknown): ResourceClaimMode | undefined =>
  typeof value === 'string' && RESOURCE_MODES.includes(value as ResourceClaimMode) ? value as ResourceClaimMode : undefined;

const resourcePriority = (value: unknown): ResourcePriority | undefined =>
  typeof value === 'string' && RESOURCE_PRIORITIES.includes(value as ResourcePriority) ? value as ResourcePriority : undefined;

function parseRequirements(value: unknown): WorkspaceResourceRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkspaceResourceRequirement[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const resource = stringField(row, 'resource');
    if (!resource) continue;
    out.push({
      resource,
      mode: resourceMode(row.mode),
      desiredState: stringField(row, 'desiredState'),
      priority: resourcePriority(row.priority),
      summary: stringField(row, 'summary'),
    });
  }
  return out.length ? out : undefined;
}

export function parseWorkspaceResources(raw: unknown): WorkspaceResource[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as any).resources)
    ? (raw as any).resources
    : [];
  const candidates: WorkspaceResource[] = [];
  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    const row = rawRow as Record<string, unknown>;
    const id = stringField(row, 'id');
    if (!id) continue;
    candidates.push({
      id,
      kind: resourceMode(row.kind) ?? 'shared',
      label: stringField(row, 'label'),
      states: Array.isArray(row.states) ? row.states.filter((s): s is string => typeof s === 'string') : undefined,
      priority: resourcePriority(row.priority),
      requires: parseRequirements(row.requires),
      description: stringField(row, 'description'),
      claimOn: Array.isArray(row.claimOn) ? row.claimOn as WorkspaceResource['claimOn'] : undefined,
    });
  }
  return normalizeWorkspaceResources(candidates);
}

export function loadWorkspaceResourceCatalog(cwd: string): WorkspaceResourceCatalog {
  const file = workspaceResourceFile(cwd);
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const resources = parseWorkspaceResources(JSON.parse(text));
    return { file, signature: `${stat.mtimeMs}:${stat.size}:${hash}`, resources };
  } catch (e: any) {
    if (e?.code !== 'ENOENT') console.error('[Braid] workspace resource detection failed:', e?.message ?? e);
    return { file, signature: null, resources: [] };
  }
}
