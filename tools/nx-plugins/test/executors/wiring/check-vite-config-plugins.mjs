#!/usr/bin/env node
/**
 * check-vite-config-plugins — the REPO-WIDE, affected-independent guard for
 * backlog 50b77657 / 47557842.
 *
 * THE CLASS (50b77657). A `vite.config.ts` declared `plugins:` TWICE in the
 * same object literal. JavaScript keeps only the LAST value for a duplicate
 * object key, so the first array (`importMetaUrlCjs()` + `nxViteTsPaths()`) was
 * silently discarded and `import.meta.url` was never restored in the CJS
 * output. The class survived in two sibling configs before a per-package test
 * caught one.
 *
 * WHY THIS LIVES HERE AND NOT IN A PACKAGE TEST (47557842). The sweep was
 * originally hosted in `agent-engine-orchestrator`'s vitest suite, so
 * `nx affected -t test` ran it ONLY when that project (or a dependency) changed.
 * A duplicate key reintroduced in an UNRELATED package's config affects THAT
 * package and its dependents — never the orchestrator — so the sweep did not
 * run and the regression was invisible until the exact project was touched.
 * Nx-affected membership is the wrong trigger for a whole-workspace invariant.
 *
 * This module is therefore invoked by `check-lane-reachability.mjs`, which the
 * pre-push hook and BOTH CI workflows run UNCONDITIONALLY, before the lanes and
 * independent of the affected graph. It is one implementation, consumed by the
 * unconditional gate (and importable by any test that wants the same logic).
 *
 * TWO ASSERTIONS, per config (and per generator template — the manufacturers of
 * every future package's config):
 *   1. exactly ONE `plugins:` key (a duplicate silently drops all but the last);
 *   2. every imported vite-plugin factory appears inside that single array.
 *
 * Exit code is the only signal (0 = clean, 1 = offense found), per the repo's
 * verification standard — never grep stdout for "passed".
 *
 * `--workspace-root <dir>` points the scan at a fixture workspace (used by the
 * checker's spec). Standalone CLI: `node check-vite-config-plugins.mjs`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// tools/nx-plugins/test/executors/wiring -> repo root
const REPO_ROOT = resolve(HERE, '../../../../..');

const VITE_PLUGIN_FACTORIES = ['importMetaUrlCjs', 'nxViteTsPathsPre', 'nxViteTsPaths'];

// Skips build output, installed deps, scratch dirs, and every dotted dir
// (.git, .nx, .claude, .worktrees, …) so a run in the main checkout is not
// polluted by sibling worktrees or installed packages.
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tmp', '.adhd']);

/** The plugin factories a config imports (an imported factory absent from the array is the bug). */
function importedPluginFactories(source) {
  return VITE_PLUGIN_FACTORIES.filter(
    (name) => new RegExp(`import\\b[^;]*\\b${name}\\b`).test(source),
  );
}

/** Walk `root` for every `vite.config.ts` and generator `vite.config.ts__tmpl__`. */
export function collectViteConfigs(root) {
  const found = [];
  const visit = (dir) => {
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

/**
 * Extract the value of the (single) `plugins:` key by scanning to its matching
 * `]`, skipping strings/comments so brackets inside them don't unbalance the
 * scan. Returns the raw array slice, or null when no array is found.
 */
export function extractPluginsArray(source) {
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

/**
 * Scan every config/template under `workspaceRoot`. Returns
 * `{ scanned, violations }`, each violation `{ rule, detail }`. Never throws on
 * a missing worktree — only a genuinely unreadable root would.
 */
export function collectViteConfigPluginViolations(workspaceRoot) {
  const violations = [];
  const configs = collectViteConfigs(workspaceRoot);
  for (const abs of configs) {
    const rel = relative(workspaceRoot, abs);
    const source = readFileSync(abs, 'utf8');

    const keys = source.match(/^[ \t]*plugins[ \t]*:/gm) ?? [];
    if (keys.length !== 1) {
      violations.push({
        rule: 'vite-duplicate-plugins-key',
        detail: `${rel} -> ${keys.length} \`plugins:\` keys (a duplicate silently drops all but the last)`,
      });
    }

    const array = extractPluginsArray(source);
    if (array === null) {
      violations.push({
        rule: 'vite-missing-plugins-array',
        detail: `${rel} -> could not locate a \`plugins\` array`,
      });
      continue;
    }
    const missing = importedPluginFactories(source).filter((name) => !array.includes(`${name}(`));
    if (missing.length > 0) {
      violations.push({
        rule: 'vite-imported-factory-missing',
        detail: `${rel} -> imported factory not present in the plugins array: ${missing.join(', ')}`,
      });
    }
  }
  return { scanned: configs.length, violations };
}

async function main() {
  const i = process.argv.indexOf('--workspace-root');
  const workspaceRoot = i >= 0 ? resolve(process.argv[i + 1]) : REPO_ROOT;
  const { scanned, violations } = collectViteConfigPluginViolations(workspaceRoot);
  if (violations.length > 0) {
    console.error('✖ vite-config-plugins check FAILED — duplicate `plugins:` key or a dropped plugin factory:');
    for (const v of violations) console.error(`   [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(`✓ vite-config-plugins OK — ${scanned} config(s)/template(s) scanned; every config has exactly ONE plugins array containing every imported factory.`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('✖ vite-config-plugins check crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
