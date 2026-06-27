// Pure parsing + validation for the knowledge vault. The plugin accepts a rich Markdown-table index while
// keeping backward compatibility with the original `- <title> - <path>` bullet format.

export const KNOWLEDGE_TYPES = ['semantic', 'episodic', 'procedural'] as const;
export const KNOWLEDGE_STATUSES = ['current', 'stale', 'superseded', 'disputed'] as const;

export type KnowledgeMemoryType = (typeof KNOWLEDGE_TYPES)[number] | string;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number] | string;

export interface KnowledgeNote {
  title: string;
  path: string;
  scope: string;
  keywords: string[];
  type: KnowledgeMemoryType;
  status: KnowledgeStatus;
  updated: string;
}

export interface KnowledgeNoteFile {
  path: string;
  text: string;
}

export interface KnowledgeVaultValidation {
  errors: string[];
  warnings: string[];
}

function cleanCell(s: string): string {
  return s.trim().replace(/^`|`$/g, '').replace(/\*\*/g, '').trim();
}

function normalizeHeader(s: string): string {
  return cleanCell(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed.slice(1, -1).split('|').map(cleanCell);
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

function markdownLink(cell: string): { label: string; href: string } | undefined {
  const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(cell.trim());
  return m ? { label: cleanCell(m[1]), href: cleanCell(m[2]) } : undefined;
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

function titleFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

function pathFromCell(cell: string): string {
  const link = markdownLink(cell);
  const raw = link?.href || cell;
  return basename(raw);
}

function labelFromCell(cell: string): string {
  const link = markdownLink(cell);
  return cleanCell(link?.label || cell).replace(/\.md$/i, '');
}

function keywordsFromCell(cell: string): string[] {
  return cleanCell(cell)
    .split(/[,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function entryFromMap(map: Record<string, string>): KnowledgeNote | undefined {
  const fileCell = map.path || map.file || '';
  const titleCell = map.title || map.name || '';
  const path = pathFromCell(fileCell || titleCell);
  const title = cleanCell(titleCell || labelFromCell(fileCell) || titleFromPath(path));
  if (!title && !path) return undefined;
  return {
    title,
    path,
    scope: cleanCell(map.scope || ''),
    keywords: keywordsFromCell(map.keywords || map.keyword || ''),
    type: cleanCell(map.type || 'semantic') || 'semantic',
    status: cleanCell(map.status || 'current') || 'current',
    updated: cleanCell(map.updated || map.date || ''),
  };
}

function parseTableAt(lines: string[], start: number): { entries: KnowledgeNote[]; next: number } | undefined {
  const headers = splitTableRow(lines[start]);
  const separator = splitTableRow(lines[start + 1] ?? '');
  if (!headers.length || !isSeparatorRow(separator)) return undefined;
  const normalized = headers.map(normalizeHeader);
  const hasKnowledgeColumns =
    normalized.includes('title') ||
    normalized.includes('path') ||
    normalized.includes('file') ||
    (normalized.includes('scope') && normalized.includes('keywords'));
  if (!hasKnowledgeColumns) return undefined;

  const entries: KnowledgeNote[] = [];
  let i = start + 2;
  while (i < lines.length) {
    const cells = splitTableRow(lines[i]);
    if (!cells.length || isSeparatorRow(cells)) break;
    const map: Record<string, string> = {};
    headers.forEach((h, idx) => {
      map[normalizeHeader(h)] = cells[idx] ?? '';
    });
    const entry = entryFromMap(map);
    if (entry?.title) entries.push(entry);
    i++;
  }
  return { entries, next: i };
}

function parseBullet(line: string): KnowledgeNote | undefined {
  const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
  if (!bullet) return undefined;
  const body = bullet[1].trim();
  if (!body) return undefined;
  const parts = body.split(/\s+(?:—|–|-)\s+/);
  const title = cleanCell(parts[0]);
  if (!title) return undefined;
  return {
    title,
    path: cleanCell(parts.slice(1).join(' - ')),
    scope: '',
    keywords: [],
    type: 'semantic',
    status: 'current',
    updated: '',
  };
}

export function parseKnowledgeIndex(md: string): KnowledgeNote[] {
  const out: KnowledgeNote[] = [];
  const lines = (md ?? '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const table = parseTableAt(lines, i);
    if (table) {
      out.push(...table.entries);
      i = table.next;
      continue;
    }
    const bullet = parseBullet(lines[i]);
    if (bullet) out.push(bullet);
    i++;
  }
  return out;
}

// Fallback when there is no `_index.md`: map a directory listing to note entries (filename -> title),
// skipping directories and `_`-prefixed bookkeeping files (`_index.md`, `_README.md`).
export function notesFromEntries(entries: { name: string; isDir: boolean }[]): KnowledgeNote[] {
  return entries
    .filter((e) => !e.isDir && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => ({
      title: e.name.replace(/\.md$/, ''),
      path: e.name,
      scope: '',
      keywords: [],
      type: 'semantic',
      status: 'current',
      updated: '',
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function routableKnowledgeEntries(entries: readonly KnowledgeNote[]): KnowledgeNote[] {
  return entries.filter((e) => e.status === 'current');
}

function validType(type: string): boolean {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(type);
}

function validStatus(status: string): boolean {
  return (KNOWLEDGE_STATUSES as readonly string[]).includes(status);
}

function hasEvidence(text: string): boolean {
  return /^##\s+Evidence\b/im.test(text) || /^-\s*(verified_by|migrated_from|source):/im.test(text);
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.braid\/knowledge\//, '').replace(/^\.\//, '');
}

export function validateKnowledgeVault(index: readonly KnowledgeNote[], files: readonly KnowledgeNoteFile[]): KnowledgeVaultValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileMap = new Map(files.map((f) => [normalizedPath(f.path).toLowerCase(), f.text]));
  const indexedPaths = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of index) {
    const path = normalizedPath(entry.path);
    const key = path.toLowerCase();
    if (!entry.title.trim()) errors.push('index entry is missing title');
    if (!validType(entry.type)) errors.push(`${entry.title}: invalid type '${entry.type}'`);
    if (!validStatus(entry.status)) errors.push(`${entry.title}: invalid status '${entry.status}'`);
    if (path) {
      if (seenPaths.has(key)) errors.push(`${entry.title}: duplicate index path '${path}'`);
      seenPaths.add(key);
      indexedPaths.add(key);
    }
    if (entry.status === 'current') {
      if (!path) {
        errors.push(`${entry.title}: current entry is missing path`);
      } else if (!fileMap.has(key)) {
        errors.push(`${entry.title}: current entry path does not exist '${path}'`);
      } else if (!hasEvidence(fileMap.get(key) ?? '')) {
        errors.push(`${entry.title}: current note is missing Evidence section`);
      }
    }
    if (entry.status !== 'current' && fileMap.has(key) && !entry.updated) {
      warnings.push(`${entry.title}: non-current entry should record updated date`);
    }
  }

  for (const file of files) {
    const path = normalizedPath(file.path);
    const key = path.toLowerCase();
    const base = basename(path);
    if (!base.endsWith('.md') || base.startsWith('_')) continue;
    if (!indexedPaths.has(key)) errors.push(`orphan current note '${path}'`);
  }

  return { errors, warnings };
}
