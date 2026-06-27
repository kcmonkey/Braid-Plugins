// The Knowledge Vault plugin OWNS this protocol (plans/knowledge-vault-plugin). It is injected (DORMANT) on
// every board so the agent records and recalls durable, project-specific knowledge under `.braid/knowledge/`
// with NO manual UI. Everything here is PURE (no React, no `.md` import) so it is unit-testable.

import type { SeedArtifact } from '../../../src/plugin-api/types';
import type { KnowledgeNote } from './parse';
import { routableKnowledgeEntries } from './parse';

export const VAULT_DIR = '.braid/knowledge';
export const VAULT_INDEX = '.braid/knowledge/_index.md';
export const README_PATH = '.braid/knowledge/_README.md';
const README_HEADER = '<!-- Managed by the Braid Knowledge plugin - edits are overwritten on plugin update. -->';

export type KnowledgeRoutingEntry = Pick<KnowledgeNote, 'title' | 'path' | 'scope' | 'keywords' | 'type' | 'status' | 'updated'>;

export const KNOWLEDGE_PROTOCOL =
  'This project keeps a durable, project-local agent memory vault under `.braid/knowledge/`. ' +
  'The routing index is `.braid/knowledge/_index.md`; note bodies live in `.braid/knowledge/*.md` and are ' +
  'read on demand. Store durable, reusable, verified knowledge only: stable facts, gotchas and root causes, ' +
  'workflow lessons, and locked conventions. Do not store transient task status or implementation snapshots.\n' +
  'RECORD: when you confirm durable knowledge, write or update a typed note with Claim, Scope, Evidence, ' +
  'Metadata, and Keywords. Set lifecycle status (`current`, `stale`, `superseded`, or `disputed`) and update ' +
  '`.braid/knowledge/_index.md`. Update or supersede existing notes instead of duplicating them.\n' +
  'RECALL: before relying on memory for project-specific facts, use the routing metadata to choose relevant ' +
  'notes, then read only those note bodies. Ignore non-current notes unless the user asks for history.\n' +
  'The full schema and context-budget rules are in `.braid/knowledge/_README.md` - read it on demand.';

function asRoutingEntry(value: unknown): KnowledgeRoutingEntry | undefined {
  if (typeof value === 'string') {
    const title = value.trim();
    return title ? { title, path: '', scope: '', keywords: [], type: 'semantic', status: 'current', updated: '' } : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<KnowledgeRoutingEntry>;
  const title = typeof v.title === 'string' ? v.title.trim() : '';
  if (!title) return undefined;
  return {
    title,
    path: typeof v.path === 'string' ? v.path.trim() : '',
    scope: typeof v.scope === 'string' ? v.scope.trim() : '',
    keywords: Array.isArray(v.keywords) ? v.keywords.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean) : [],
    type: typeof v.type === 'string' && v.type.trim() ? v.type.trim() : 'semantic',
    status: typeof v.status === 'string' && v.status.trim() ? v.status.trim() : 'current',
    updated: typeof v.updated === 'string' ? v.updated.trim() : '',
  };
}

function normalizeRoutingEntries(entries?: readonly (KnowledgeRoutingEntry | string)[]): KnowledgeRoutingEntry[] {
  const raw = (entries ?? []).map(asRoutingEntry).filter((e): e is KnowledgeRoutingEntry => Boolean(e));
  return routableKnowledgeEntries(raw as KnowledgeNote[]).map((e) => ({
    title: e.title,
    path: e.path,
    scope: e.scope,
    keywords: e.keywords,
    type: e.type,
    status: e.status,
    updated: e.updated,
  }));
}

function routingLine(e: KnowledgeRoutingEntry): string {
  const meta = [
    e.path ? `path=${e.path}` : '',
    e.scope ? `scope=${e.scope}` : '',
    e.keywords.length ? `keywords=${e.keywords.slice(0, 8).join(', ')}` : '',
    e.type ? `type=${e.type}` : '',
    e.updated ? `updated=${e.updated}` : '',
  ].filter(Boolean).join('; ');
  return `- ${e.title}${meta ? ` (${meta})` : ''}`;
}

export function knowledgeContextText(indexEntries?: readonly (KnowledgeRoutingEntry | string)[]): string {
  const entries = normalizeRoutingEntries(indexEntries);
  if (!entries.length) return KNOWLEDGE_PROTOCOL;
  const listed = entries.slice(0, 40);
  const list = listed.map(routingLine).join('\n');
  const omitted = entries.length > listed.length ? `\n- ... ${entries.length - listed.length} more current notes in ${VAULT_INDEX}` : '';
  return `${KNOWLEDGE_PROTOCOL}\nCurrent vault routing (${entries.length} note${entries.length === 1 ? '' : 's'}; bodies not injected):\n${list}${omitted}`;
}

export function cachedRoutingEntries(elementState: unknown): KnowledgeRoutingEntry[] {
  const idx = (elementState as { index?: unknown } | undefined)?.index;
  if (!Array.isArray(idx)) return [];
  return normalizeRoutingEntries(idx as (KnowledgeRoutingEntry | string)[]);
}

export function cachedIndexTitles(elementState: unknown): string[] {
  return cachedRoutingEntries(elementState).map((e) => e.title);
}

export function knowledgeSeedArtifacts(usageDoc: string): SeedArtifact[] {
  return [{ path: README_PATH, text: `${README_HEADER}\n\n${usageDoc}` }];
}
