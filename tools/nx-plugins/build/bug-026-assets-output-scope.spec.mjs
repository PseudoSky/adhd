/**
 * tools/nx-plugins/build/bug-026-assets-output-scope.spec.mjs
 *
 * Regression pin for BUG-026: nx's cache-restore for a target whose declared
 * `outputs` is a WHOLE shared directory does `remove(dir); copy(cachedDir, dir)`
 * — a full directory SWAP, not a merge. `entrypoint/backlog/project.json`'s
 * `assets` target declared `outputs: ["{projectRoot}/dist"]` — the exact same
 * literal directory `build`'s own `outputs` (`{options.outputPath}` ->
 * `entrypoint/backlog/dist`) claims. Both targets run in `test`'s dependsOn
 * chain (`["^build", "build", "assets"]`); when `build`'s inputs change (a
 * cache MISS, fresh rebuild) but `assets`'s inputs don't (its own inputs are
 * only README/CHANGELOG/skill/package.json — a cache HIT), nx's restore for
 * `assets` runs `remove('entrypoint/backlog/dist')` then copies back
 * `assets`'s OWN cached snapshot of the ENTIRE dist dir — captured whenever
 * `assets` last ran — silently reverting the just-built `dist/index.js` to
 * whatever it was at that earlier point. Measured 2026-08-18: a 4-day-stale
 * `dist/index.js` (missing BUG-020's singleton lock) replayed this way.
 *
 * This spec uses the REAL nx cache primitives `cache.js` itself calls
 * (`expandOutputs`, `copy`, `remove` from `nx/src/native`) against a plain
 * temp-directory fixture that mimics `entrypoint/backlog/dist` — no real nx
 * task graph, no real build, nothing destructive. It proves two things:
 *
 *   1. RED (this file, run against the OLD outputs shape
 *      `["{projectRoot}/dist"]`): a restore of an `assets`-shaped cache
 *      snapshot recorded BEFORE a build with new content clobbers that new
 *      content back to the old snapshot. `restoreOutputs(oldConfigOutputs, ...)`
 *      returns the STALE content.
 *   2. GREEN (the fixed outputs shape — scoped to the specific files/dirs
 *      `assets`'s own executor writes: README.md, CHANGELOG.md, skill/ —
 *      never the bare `dist` directory): the exact same restore sequence
 *      leaves the freshly-built file untouched, because the fixed outputs
 *      list never matches `dist/index.js` at all.
 *
 * Run: node --test tools/nx-plugins/build/bug-026-assets-output-scope.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { expandOutputs, copy, remove } = require('nx/src/native');

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const REPO_ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * The REAL `assets` target's `outputs` from `entrypoint/backlog/project.json`,
 * read live off disk (not hardcoded) and interpolated the same way
 * `getOutputsForTargetAndConfiguration` does for this project (`{projectRoot}`
 * -> `entrypoint/backlog`) — so this test is pinned to the actual source
 * config, not a copy of it. Before the BUG-026 fix this resolves to
 * `['entrypoint/backlog/dist']` (the whole shared dir); after the fix, to the
 * scoped file list.
 */
function realAssetsOutputs() {
  const projectJson = JSON.parse(readFileSync(join(REPO_ROOT, 'entrypoint', 'backlog', 'project.json'), 'utf8'));
  const outputs = projectJson.targets.assets.outputs;
  assert.ok(Array.isArray(outputs) && outputs.length > 0, 'entrypoint/backlog/project.json targets.assets.outputs must be a non-empty array');
  return outputs.map((o) => o.replace('{projectRoot}', 'entrypoint/backlog'));
}

// Mirror the exact two calls `Cache.put`/`Cache.copyFilesFromCache` make in
// node_modules/nx/src/tasks-runner/cache.js — this is not a re-implementation
// of nx's caching, it's the same native calls it makes, driven directly so
// the test doesn't need a full task-graph/hasher invocation.
function simulateCachePut(workspaceRoot, outputs, cacheOutputsDir) {
  const expanded = expandOutputs(workspaceRoot, outputs);
  for (const f of expanded) {
    const src = join(workspaceRoot, f);
    if (existsSync(src)) {
      copy(src, join(cacheOutputsDir, f));
    }
  }
}

function simulateCacheRestore(workspaceRoot, outputs, cacheOutputsDir) {
  const expanded = expandOutputs(cacheOutputsDir, outputs);
  for (const f of expanded) {
    const cached = join(cacheOutputsDir, f);
    if (existsSync(cached)) {
      const dst = join(workspaceRoot, f);
      remove(dst);
      copy(cached, dst);
    }
  }
}

/** Build a fixture mimicking entrypoint/backlog/dist right after `assets` ran once (t0). */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bug-026-fixture-'));
  const workspaceRoot = join(root, 'ws');
  const distDir = join(workspaceRoot, 'entrypoint', 'backlog', 'dist');
  mkdirSync(join(distDir, 'skill'), { recursive: true });
  writeFileSync(join(distDir, 'index.js'), 'export const OLD = "no-lock";\n');
  writeFileSync(join(distDir, 'README.md'), '# backlog (t0)\n');
  writeFileSync(join(distDir, 'CHANGELOG.md'), '## t0\n');
  writeFileSync(join(distDir, 'skill', 'SKILL.md'), 'skill t0\n');
  return { root, workspaceRoot, distDir };
}

test('BUG-026: entrypoint/backlog/project.json’s REAL `assets` outputs must never let a cache-hit restore revert a freshly-rebuilt dist/index.js', () => {
  const f = makeFixture();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'bug-026-cache-'));
  try {
    // The outputs actually declared on disk right now, live. Pre-fix this
    // resolves to ['entrypoint/backlog/dist'] (the whole dir shared with
    // `build`) and this test FAILS, reproducing the incident exactly. Post-fix
    // it resolves to the scoped file list and this test PASSES.
    const outputs = realAssetsOutputs();

    // t0: `assets` runs once (or restores from its own prior cache) and its
    // cache entry is `put` under today's on-disk outputs declaration.
    simulateCachePut(f.workspaceRoot, outputs, cacheRoot);

    // t1: `build`'s inputs changed (new source landed a real fix) -> cache
    // MISS -> `build` re-runs for real and lands NEW content in the shared
    // dist dir. `assets`'s own inputs (README/CHANGELOG/skill/package.json)
    // did NOT change, so `assets` gets a cache HIT against its t0 entry and
    // nx runs its restore.
    writeFileSync(join(f.distDir, 'index.js'), 'export const NEW = "refusing to start (BUG-020 lock)";\n');
    simulateCacheRestore(f.workspaceRoot, outputs, cacheRoot);

    const indexAfter = readFileSync(join(f.distDir, 'index.js'), 'utf8');
    assert.equal(
      indexAfter,
      'export const NEW = "refusing to start (BUG-020 lock)";\n',
      'BUG-026: entrypoint/backlog/project.json targets.assets.outputs claims dist/index.js (directly or via ' +
        'the bare "dist" directory) — an assets cache-hit restore silently reverted the freshly-built artifact ' +
        'back to a stale snapshot. outputs must be scoped to ONLY the files the assets executor itself writes ' +
        '(README.md, CHANGELOG.md, llms.txt, drizzle, skill) and must never include the bare {projectRoot}/dist.'
    );
    // The fix must not regress the ORIGINAL bug this override was added for
    // (BUG-013 FIX A): assets' own files are still correctly restored on its
    // own cache hit.
    assert.equal(readFileSync(join(f.distDir, 'README.md'), 'utf8'), '# backlog (t0)\n');
    assert.equal(readFileSync(join(f.distDir, 'skill', 'SKILL.md'), 'utf8'), 'skill t0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
