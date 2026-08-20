/**
 * Guard: every file an Nx plugin points a target at must actually exist.
 *
 * WHY THIS EXISTS. `tools/nx-plugins/verify-dist-load/plugin.js` infers a
 * `verify-dist-load` target for every buildable project, whose command is
 * `node ./scripts/verify-dist-load.mjs <projectRoot>`. That script was never
 * committed — it lived only as untracked content inside a stale agent
 * worktree. So on main, every `nx run <project>:verify-dist-load` died with
 * `Error: Cannot find module .../scripts/verify-dist-load.mjs`, and because
 * nx.json lists `verify-dist-load` in `nx-release-publish.dependsOn`, the
 * whole workspace's release path was unrunnable.
 *
 * Nothing caught it: the plugin's own source is valid JavaScript, the target
 * is inferred lazily, and no test ever executed the command it builds. The
 * failure only appears when someone actually runs the target.
 *
 * This spec is deliberately GENERAL rather than a single assertion about one
 * path — the same silent break is available to every plugin that shells out
 * to a repo script. It statically scans every plugin for the concrete files
 * it references and asserts each one is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const PLUGIN_DIR = path.join(WORKSPACE_ROOT, 'tools', 'nx-plugins');

/** Every plugin.js under tools/nx-plugins/, recursively. */
function findPlugins(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findPlugins(full));
    else if (entry === 'plugin.js') out.push(full);
  }
  return out;
}

const PLUGINS = findPlugins(PLUGIN_DIR);

/**
 * Strip comments before scanning. These plugins document their own option
 * shapes in prose — verify-dist-load/plugin.js contains the literal text
 * "Relative, not `{workspaceRoot}/...`" — and matching those produces
 * phantom failures for paths no target ever uses.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the plugin scan finds the plugins it is meant to guard', () => {
  // If this ever goes to zero the rest of the suite becomes vacuously green,
  // which is exactly the failure mode this whole file exists to prevent.
  assert.ok(PLUGINS.length > 0, 'expected at least one plugin.js under tools/nx-plugins/');
  assert.ok(
    PLUGINS.some((p) => p.includes(`verify-dist-load${path.sep}plugin.js`)),
    'verify-dist-load/plugin.js must be among the scanned plugins',
  );
});

test('every script a plugin shells out to via `node ./<path>` exists', () => {
  const missing = [];
  for (const plugin of PLUGINS) {
    const src = stripComments(readFileSync(plugin, "utf8"));
    // Matches the command shape these plugins use: `node ./scripts/foo.mjs ...`
    for (const m of src.matchAll(/node\s+\.\/([\w./-]+\.(?:mjs|cjs|js))/g)) {
      const rel = m[1];
      if (!existsSync(path.join(WORKSPACE_ROOT, rel))) {
        missing.push(`${path.relative(WORKSPACE_ROOT, plugin)} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Nx plugin(s) reference script(s) that do not exist; every inferred target using them ` +
      `fails at run time with MODULE_NOT_FOUND:\n  ${missing.join('\n  ')}`,
  );
});

test('every concrete {workspaceRoot} input a plugin declares exists', () => {
  const missing = [];
  for (const plugin of PLUGINS) {
    const src = stripComments(readFileSync(plugin, "utf8"));
    for (const m of src.matchAll(/['"`]\{workspaceRoot\}\/([^'"`$]+)['"`]/g)) {
      const rel = m[1];
      // Globs and interpolated paths are not statically checkable.
      if (rel.includes('*')) continue;
      if (!existsSync(path.join(WORKSPACE_ROOT, rel))) {
        missing.push(`${path.relative(WORKSPACE_ROOT, plugin)} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Nx plugin(s) declare cache input(s) that do not exist — nx silently treats a missing ` +
      `input as empty, so the target can cache a result that never reflected the file:\n  ${missing.join('\n  ')}`,
  );
});
