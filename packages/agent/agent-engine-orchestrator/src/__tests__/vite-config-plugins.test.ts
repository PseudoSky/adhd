import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Backlog 50b77657 — `vite.config.ts` declared `plugins:` TWICE in the same
 * object literal. JavaScript keeps only the LAST value for a duplicate object
 * key, so the first array (`importMetaUrlCjs()` + `nxViteTsPaths()`) was
 * silently discarded and `import.meta.url` was never restored in the CJS
 * output. The sibling packages (`agent-base-types/vite.config.ts`) use ONE
 * array; the two-line form was an editing accident.
 *
 * This asserts the SINGLE-array shape directly. It fails if the duplicate key
 * is reintroduced (two matches) or if any of the three intended plugins is
 * dropped from the array.
 */
const viteConfigSource = readFileSync(
  fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  'utf8'
);

describe('vite.config.ts — single plugins array (50b77657)', () => {
  it('declares exactly ONE `plugins:` property (a duplicate key silently drops all but the last)', () => {
    const pluginsKeys = viteConfigSource.match(/^\s*plugins\s*:/gm) ?? [];
    expect(pluginsKeys).toHaveLength(1);
  });

  it('keeps all three plugins in that one array: importMetaUrlCjs + nxViteTsPaths + nxViteTsPathsPre', () => {
    const arrayLine = viteConfigSource.match(/^\s*plugins\s*:.*$/m)?.[0] ?? '';
    expect(arrayLine).toContain('importMetaUrlCjs()');
    expect(arrayLine).toContain('nxViteTsPaths()');
    expect(arrayLine).toContain('nxViteTsPathsPre()');
  });
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Repo-wide sweep (dispatch-2026-10-04-9c4e).                                *
 *                                                                            *
 * `6b6458d2` fixed the duplicate-`plugins:` class in `agent-engine-           *
 * orchestrator`, but the SAME class survived in two sibling configs           *
 * (`entrypoint/agent-mcp`, `packages/agent/agent-store-runtime`) — both       *
 * silently dropped `importMetaUrlCjs()`. A per-package test only guards one   *
 * config, so this walks EVERY `vite.config.ts` in the workspace and enforces  *
 * the class-level invariant: exactly one `plugins:` key, and every imported   *
 * vite-plugin factory actually present in that array.                         *
 *                                                                            *
 * It also sweeps the generators' `vite.config.ts__tmpl__` templates, which    *
 * manufacture every future package's config — the same bug copied into a      *
 * template would recur in every generated package.                           *
 * ────────────────────────────────────────────────────────────────────────── */

const VITE_PLUGIN_FACTORIES = ['importMetaUrlCjs', 'nxViteTsPathsPre', 'nxViteTsPaths'] as const;

/** The plugin factories a config imports (an imported factory that never appears in the array is the bug). */
function importedPluginFactories(source: string): string[] {
  return VITE_PLUGIN_FACTORIES.filter(
    (name) => new RegExp(`import\\b[^;]*\\b${name}\\b`).test(source)
  );
}

function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'nx.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find the workspace root (nx.json) above ${startDir}`);
    }
    dir = parent;
  }
}

// Skips build output, installed deps, scratch dirs, and every dotted dir
// (.git, .nx, .claude, .worktrees, …) so a run in the main checkout is not
// polluted by sibling worktrees or installed packages.
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tmp', '.adhd']);

function collectViteConfigs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (
        entry.isFile() &&
        (entry.name === 'vite.config.ts' || entry.name === 'vite.config.ts__tmpl__')
      ) {
        found.push(join(dir, entry.name));
      }
    }
  };
  visit(root);
  return found.sort();
}

// Extract the value of the (single) `plugins:` key by scanning to its matching
// `]`, skipping strings/comments so brackets inside them don't unbalance the
// scan. Returns the raw array slice, or null when no array is found.
function extractPluginsArray(source: string): string | null {
  const key = /^[ \t]*plugins[ \t]*:/m.exec(source);
  if (!key) return null;
  const start = source.indexOf('[', key.index + key[0].length);
  if (start === -1) return null;

  let i = start;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        i += source[i] === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
const viteConfigs = collectViteConfigs(workspaceRoot).map((abs) => ({
  abs,
  rel: relative(workspaceRoot, abs),
}));

describe('vite.config.ts — repo-wide sweep (50b77657)', () => {
  it('discovers the workspace vite.config.ts files and generator templates', () => {
    expect(viteConfigs.length).toBeGreaterThan(50);
    const rels = viteConfigs.map((c) => c.rel);
    expect(rels).toContain('entrypoint/agent-mcp/vite.config.ts');
    expect(rels).toContain('packages/agent/agent-store-runtime/vite.config.ts');
    // Future-config manufacturers must be covered too.
    expect(
      rels.some((r) => r.endsWith('vite.config.ts__tmpl__'))
    ).toBe(true);
  });

  it('every vite.config.ts declares exactly ONE `plugins:` key (a duplicate silently drops all but the last)', () => {
    const offenders: string[] = [];
    for (const { abs, rel } of viteConfigs) {
      const keys = readFileSync(abs, 'utf8').match(/^[ \t]*plugins[ \t]*:/gm) ?? [];
      if (keys.length !== 1) offenders.push(`${rel} -> ${keys.length} keys`);
    }
    expect(offenders).toEqual([]);
  });

  it('every imported vite-plugin factory is present in that config single plugins array', () => {
    const offenders: string[] = [];
    for (const { abs, rel } of viteConfigs) {
      const source = readFileSync(abs, 'utf8');
      const array = extractPluginsArray(source);
      if (array === null) {
        offenders.push(`${rel} -> could not locate a plugins array`);
        continue;
      }
      const missing = importedPluginFactories(source).filter(
        (name) => !array.includes(`${name}(`)
      );
      if (missing.length > 0) offenders.push(`${rel} -> missing ${missing.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
