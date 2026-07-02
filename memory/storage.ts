import * as fs from 'fs';
import * as path from 'path';
import { emptyMemoryStore, normalizeMemoryStore, type MemoryStore } from './model';

export const MEMORY_DIR = path.join('.braid', 'memory');
export const MEMORY_FILE = 'memories.json';

export interface MemoryPaths {
  workspace: string;
  dir: string;
  file: string;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function memoryPaths(cwd: string): MemoryPaths {
  const workspace = path.resolve(cwd || process.cwd());
  const dir = path.resolve(workspace, MEMORY_DIR);
  const file = path.resolve(dir, MEMORY_FILE);
  if (!isContained(workspace, dir) || !isContained(dir, file)) {
    throw new Error('Memory storage path escaped the workspace.');
  }
  return { workspace, dir, file };
}

export function readMemoryStore(cwd: string): MemoryStore {
  const paths = memoryPaths(cwd);
  try {
    const raw = fs.readFileSync(paths.file, 'utf8');
    return normalizeMemoryStore(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return emptyMemoryStore();
    return emptyMemoryStore();
  }
}

export function writeMemoryStore(cwd: string, store: MemoryStore): void {
  const paths = memoryPaths(cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  const temp = path.join(paths.dir, `${MEMORY_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(normalizeMemoryStore(store), null, 2), 'utf8');
  fs.renameSync(temp, paths.file);
}
