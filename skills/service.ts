import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import type { AgentToolContext, HostService, HostServicePlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import { createSkillAgentTool, type SkillToolRequest } from './agentTool';
import { isSkillDirName, skillBody, skillEntryFromFile, sortSkillEntries, type SkillEntry } from './parse';
import { VAULT_DIR } from './methodology';
import manifestJson from './plugin.json';

const manifest = manifestJson as PluginManifest;

// The formatted result carries a metadata header + the SKILL.md body + a bundled-resource list. The host caps a
// tool result at ~30k chars for the packed session (the SESSION_TOOL_RESULT_CAP in src/webview/merge, applied by
// capSessionToolResult). Builtin plugins do not import that webview module, so we mirror the
// value here and keep the body cap conservative: it MUST leave headroom for the header + resource list, otherwise a
// near-max body pushes the total past the host cap and the resource pointers at the tail are silently dropped on the
// next tool round (OpenAI-compatible providers). If the host session cap changes materially, update this mirror.
export const HOST_SESSION_TOOL_RESULT_CAP = 30_000;
const SKILL_RESULT_HEADROOM = 8_000;
export const MAX_SKILL_BODY_CHARS = HOST_SESSION_TOOL_RESULT_CAP - SKILL_RESULT_HEADROOM;
export const MAX_RESOURCE_PATHS = 120;
// Discovery only needs each skill's frontmatter (a name + description block at the very top of SKILL.md), so read
// a bounded prefix per skill instead of every full body — a large vault is not fully read on every Skill call. The
// full body is read once, only for the matched skill.
const FRONTMATTER_PREFIX_BYTES = 16 * 1024;

interface DiscoveredSkill extends SkillEntry {
  dirName: string;
  root: string;
  mdPathAbs: string;
}

class SkillsHostService implements HostService {
  id = 'skills.hostService';
  label = 'Skills Host Service';
  manifest = manifest;

  constructor(private readonly host: Parameters<HostServicePlugin['create']>[0]) {}

  agentTools() {
    return [createSkillAgentTool({ use: (ctx, req) => this.handleSkill(ctx, req) })];
  }

  private async handleSkill(ctx: AgentToolContext, req: SkillToolRequest): Promise<AgentToolResult> {
    if (ctx.signal.aborted) return { ok: false, result: 'Skill load canceled.' };
    const requested = (req.name ?? '').trim();
    if (!requested) return { ok: false, result: 'Skill name is required.' };
    const skills = await loadSkills(this.host.cwd());
    const found = skills.find((s) => s.name === requested || s.dirName === requested);
    if (!found) return { ok: false, result: formatSkillNotFound(requested, skills) };
    let md: string;
    try {
      md = await fs.readFile(found.mdPathAbs, 'utf8');
    } catch {
      return { ok: false, result: `Skill "${found.name}" could not be read from ${found.path}.` };
    }
    if (ctx.signal.aborted) return { ok: false, result: 'Skill load canceled.' };
    const resources = await listSkillResources(found.root, found.mdPathAbs);
    return { ok: true, result: formatSkillResult(found, skillBody(md), resources, req.arguments) };
  }
}

// Read a bounded prefix of a file (frontmatter lives at the very top). Reads far fewer bytes than the whole body
// for a large SKILL.md; a small file simply returns its whole content. null when the file cannot be opened/read.
async function readFrontmatterPrefix(file: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(FRONTMATTER_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, FRONTMATTER_PREFIX_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadSkills(cwd: string): Promise<DiscoveredSkill[]> {
  const vault = path.join(cwd, VAULT_DIR);
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(vault, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSkillDirName(entry.name)) continue;
    const root = path.join(vault, entry.name);
    const mdPathAbs = path.join(root, 'SKILL.md');
    const prefix = await readFrontmatterPrefix(mdPathAbs);
    if (prefix === null) continue;
    const mdPath = `${VAULT_DIR}/${entry.name}/SKILL.md`;
    const skill = skillEntryFromFile(entry.name, prefix, mdPath);
    if (!skill) continue;
    discovered.push({ ...skill, dirName: entry.name, root, mdPathAbs });
  }
  // Sort THEN dedupe by name, keeping the first — mirrors the injected list's normalizeEntries so the Skill tool
  // resolves the SAME folder the model saw listed when two folders declare the same frontmatter name.
  const seen = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const skill of sortSkillEntries(discovered) as DiscoveredSkill[]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

async function listSkillResources(root: string, skillMdAbs: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      if (abs === skillMdAbs) continue;
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        // Only flag truncation when a real file is dropped BECAUSE of the cap (exactly MAX files is not truncated).
        if (paths.length >= MAX_RESOURCE_PATHS) { truncated = true; return; }
        paths.push(toPosix(path.relative(root, abs)));
      }
    }
  };
  await visit(root);
  return { paths, truncated };
}

function formatSkillNotFound(requested: string, skills: DiscoveredSkill[]): string {
  if (!skills.length) {
    return `Skill "${requested}" was not found. No skills are currently available under ${VAULT_DIR}.`;
  }
  return [
    `Skill "${requested}" was not found.`,
    'Available skills:',
    ...skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''} (${s.path})`),
  ].join('\n');
}

function formatSkillResult(
  skill: DiscoveredSkill,
  fullBody: string,
  resources: { paths: string[]; truncated: boolean },
  args?: string,
): string {
  const bodyTruncated = fullBody.length > MAX_SKILL_BODY_CHARS;
  const body = bodyTruncated ? fullBody.slice(0, MAX_SKILL_BODY_CHARS) : fullBody;
  const lines = [
    `Skill: ${skill.name}`,
    `Path: ${skill.path}`,
    skill.description ? `Description: ${skill.description}` : undefined,
    args?.trim() ? `Invocation arguments: ${args.trim()}` : undefined,
    '',
    'Instructions:',
    body || '(empty SKILL.md body)',
  ].filter((line): line is string => line !== undefined);
  if (bodyTruncated) lines.push('', `Skill body truncated at ${MAX_SKILL_BODY_CHARS} characters; read ${skill.path} if more detail is required.`);
  lines.push('', 'Bundled resources:', ...(resources.paths.length ? resources.paths.map((p) => `- ${VAULT_DIR}/${skill.dirName}/${p}`) : ['(none)']));
  if (resources.truncated) lines.push(`Resource list truncated at ${MAX_RESOURCE_PATHS} files.`);
  return lines.join('\n');
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export const skillsHostServicePlugin: HostServicePlugin = {
  id: 'skills.hostService',
  label: 'Skills Host Service',
  manifest,
  create(host) {
    return new SkillsHostService(host);
  },
};
