import type { EngineId } from '../../../src/protocol';
import type { BoardLike } from '../shared/board';

export interface TagDef { name: string; color: string; description: string }
export interface TagConfig {
  engine?: EngineId;
  model?: string;
  tags: TagDef[];
  classifyPromptOverride?: string;
}

export interface TagState { tags: string[]; revision: string }

const TAG_CODE_VERSION = 1;
const MAX_TAGS = 2;

export const BUILTIN_TAGS: TagDef[] = [
  { name: 'coding', color: '#5aa1ff', description: 'writing or changing code' },
  { name: 'plan', color: '#b78cff', description: 'planning, strategy, architecture' },
  { name: 'design', color: '#ff8ad1', description: 'API, UI, data model design' },
  { name: 'review', color: '#e0b341', description: 'critiquing code or a design' },
  { name: 'debug', color: '#ff6b6b', description: 'diagnosing or fixing a bug' },
  { name: 'refactor', color: '#36c5b0', description: 'restructuring without behavior change' },
  { name: 'test', color: '#6cd06c', description: 'tests and verification' },
  { name: 'research', color: '#3fb8d4', description: 'investigating, comparing, learning' },
  { name: 'docs', color: '#9aa6b2', description: 'writing documentation' },
  { name: 'commit', color: '#f0883e', description: 'version control actions' },
  { name: 'build', color: '#a8c93a', description: 'building, compiling, packaging' },
  { name: 'deploy', color: '#8a86f5', description: 'releasing, publishing, shipping' },
  { name: 'config', color: '#7f9cb0', description: 'configuration, settings, tooling' },
  { name: 'deps', color: '#c98a5e', description: 'dependency or package management' },
];

export const defaultTagConfig: TagConfig = { tags: BUILTIN_TAGS };

export function asTagState(value: unknown): TagState | undefined {
  return value && typeof value === 'object' && Array.isArray((value as TagState).tags)
    ? value as TagState
    : undefined;
}

export function normalizeTagName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Malformed hand-edited config remains bounded and falls back to the built-in vocabulary. */
export function tagDefs(config: TagConfig): TagDef[] {
  return Array.isArray(config.tags) ? config.tags : BUILTIN_TAGS;
}

export function tagConfigRevision(config: TagConfig): string {
  return `tags:${TAG_CODE_VERSION}:${hashText(JSON.stringify({
    tags: tagDefs(config).map((tag) => [normalizeTagName(tag.name), tag.description]),
    prompt: config.classifyPromptOverride ?? '',
  }))}`;
}

export function tagDeriveKey(board: BoardLike, config: TagConfig): string {
  return `${tagConfigRevision(config)}:${hashText(`${board.prompt}\n${board.answer}`)}`;
}

function classifyPrompt(config: TagConfig): string {
  if (config.classifyPromptOverride?.trim()) return config.classifyPromptOverride.trim();
  const vocabulary = tagDefs(config)
    .map((tag) => `${normalizeTagName(tag.name)} = ${tag.description}`)
    .join('; ');
  return `You are a conversation tagger for a canvas. Choose 1-${MAX_TAGS} tags from this exact vocabulary and output only comma-separated tag names, lowercase, no prose. Vocabulary: ${vocabulary}.`;
}

export function parseTags(text: string, config: TagConfig): string[] {
  const allowed = new Set(tagDefs(config).map((tag) => normalizeTagName(tag.name)).filter(Boolean));
  const tags: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const tag = normalizeTagName(raw);
    if (!tag || !allowed.has(tag) || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

export function deriveTagRequest(board: BoardLike, config: TagConfig, state: unknown) {
  if (board.status !== 'done' || !board.answer || board.compact || board.collapsedGraph) return null;
  const key = tagDeriveKey(board, config);
  if (asTagState(state)?.revision === key) return null;
  return {
    key,
    system: classifyPrompt(config),
    content: `Q: ${board.prompt}\n\nA: ${board.answer}`,
  };
}

export function hasCustomTagLlmRoute(config: TagConfig): boolean {
  return !!config.engine || !!config.model?.trim();
}

export function applyTagDerivation(text: string, config: TagConfig, key: string): TagState {
  return { tags: parseTags(text, config), revision: key };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
