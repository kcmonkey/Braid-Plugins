import * as nodePath from 'path';
import { normalizeWorkspacePath } from './model';

const hasWindowsPathSyntax = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p) || p.includes('\\');

const pathOpsFor = (cwd: string, filePath: string): typeof nodePath.win32 | typeof nodePath.posix =>
  hasWindowsPathSyntax(cwd) || hasWindowsPathSyntax(filePath) ? nodePath.win32 : nodePath.posix;

const isInsideRelative = (ops: typeof nodePath.win32 | typeof nodePath.posix, rel: string): boolean =>
  !!rel && rel !== '..' && !rel.startsWith(`..${ops.sep}`) && !ops.isAbsolute(rel);

export function coordinationPath(cwd: string, filePath: string): string {
  const raw = filePath.trim();
  if (!raw) return '';
  const rootCwd = cwd.trim();
  if (!rootCwd) return '';
  const ops = pathOpsFor(rootCwd, raw);
  const root = ops.resolve(rootCwd);
  const resolved = ops.resolve(root, raw);
  const rel = ops.relative(root, resolved);
  if (rel && !isInsideRelative(ops, rel)) return '';
  const canonical = rel || '.';
  const normalized = normalizeWorkspacePath(canonical);
  return ops === nodePath.win32 ? normalized.toLowerCase() : normalized;
}

export function coordinationPathList(cwd: string, paths: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths ?? []) {
    const p = coordinationPath(cwd, raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
