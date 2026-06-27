import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import planManifest from './plan/plugin.json';

const BUILTIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const FORBIDDEN_IMPORTS = [
  '../../../src/webview/merge',
  '../../../src/coordination',
  '../../../src/plugin-api/ProviderModelPicker',
  '../../../src/plugin-runtime',
  '../../../src/webview/main',
  '../../../src/extension',
  '../../../src/app',
  '../../../src/host',
  'vscode',
];
const FORBIDDEN_GLOBALS = [
  'acquireVsCodeApi',
  'window.BraidPluginRuntime',
  'BraidCore',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.name === 'plugin-boundary.test.ts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe('builtin plugin boundary', () => {
  it('does not import core helper or host/bootstrap-only modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(BUILTIN_ROOT)) {
      const rel = path.relative(BUILTIN_ROOT, file).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_IMPORTS) {
        const quoted = [`'${pattern}'`, `"${pattern}"`];
        if (quoted.some((q) => text.includes(q))) offenders.push(`${rel} imports ${pattern}`);
      }
      for (const pattern of FORBIDDEN_GLOBALS) {
        if (text.includes(pattern)) offenders.push(`${rel} references ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares the plan run policy in manifest metadata', () => {
    expect(planManifest.contributes.runPolicies).toContain('plan');
  });
});
