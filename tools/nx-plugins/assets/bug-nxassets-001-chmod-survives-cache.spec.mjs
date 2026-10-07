/**
 * tools/nx-plugins/assets/bug-nxassets-001-chmod-survives-cache.spec.mjs
 *
 * Regression pin for BUG-NXASSETS-001: the `assets` copy executor did the
 * `bin` chmod as part of its own body, but `assets` is `cache: true` — an
 * nx cached target's executor body never runs at all on a cache hit, only
 * its declared `outputs` are restored, and nx compares restored output CONTENT,
 * never file mode ("existing outputs match the cache, left as is"). So a
 * cached/restored bin that lost its executable bit stayed non-executable and
 * `npm install -g` registered no runnable command.
 *
 * CURRENT WIRING (cache-dag AC9): the bit is no longer guaranteed by a standing
 * `chmod-bin` task in every `assets` consumer's graph (an uncacheable task
 * there made every `nx build`/`nx test` run miss). It is guaranteed by
 * `writeDistManifest` (build/executors/manifest/generate-manifest.js), the
 * re-stamp that every dist-trusting release task (dist-manifest, version,
 * verify-dist-load, publish-hygiene, publish) runs last. This pin proves:
 *
 *   1. `chmod-bin` stays `cache: false` (still runnable by hand; a cached
 *      chmod would reintroduce the bug).
 *   2. `assets` depends on `build` ONLY — NOT on `chmod-bin` — so no uncacheable
 *      task sits in the build/test graph.
 *   3. `assets` does not claim the bin path as its output (BUG-026).
 *   4. BEHAVIOUR: a dist whose bin lost its executable bit (the cache-restore
 *      shape) is repaired by `writeDistManifest`, on a real temp fs.
 *
 * Run: node --test tools/nx-plugins/assets/bug-nxassets-001-chmod-survives-cache.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createNodes } = require('./plugin.js');
const [, createNodesFn] = createNodes;

/** Build a throwaway workspace containing one buildable, bin-having project. */
function fixture() {
  const ws = mkdtempSync(join(tmpdir(), 'adhd-bugnxassets001-'));
  const projectRoot = 'entrypoint/demo-cli';
  const abs = join(ws, projectRoot);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'project.json'), JSON.stringify({ name: 'demo-cli', targets: { build: {} } }));
  writeFileSync(join(abs, 'package.json'), JSON.stringify({ name: '@adhd/demo-cli', bin: { 'demo-cli': './dist/index.js' } }));
  writeFileSync(join(abs, 'README.md'), '# demo');
  return { ws, projectRoot, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

function targetsFor(ws, projectRoot) {
  // Nx 23 plugin API: createNodes[1] takes the ARRAY of matched config files and
  // returns [configFile, result] tuples.
  const [[, res]] = createNodesFn([join(projectRoot, 'package.json')], {}, { workspaceRoot: ws });
  return res.projects?.[projectRoot]?.targets ?? {};
}

test('chmod-bin is declared uncacheable — its body must run on EVERY invocation', () => {
  const f = fixture();
  try {
    const targets = targetsFor(f.ws, f.projectRoot);
    assert.ok(targets['chmod-bin'], 'a bin-having project must get an inferred chmod-bin target');
    assert.equal(targets['chmod-bin'].cache, false, 'chmod-bin must be uncacheable, or the fix regresses to the original bug');
    assert.equal(targets['chmod-bin'].executor, '@adhd/nx-assets:chmod-bin');
  } finally { f.cleanup(); }
});

test('assets depends on build ONLY — chmod-bin is NOT in any assets consumer\'s graph (cache-dag AC9)', () => {
  const f = fixture();
  try {
    const targets = targetsFor(f.ws, f.projectRoot);
    assert.deepEqual(targets.assets.dependsOn, ['build']);
    assert.ok(!targets.assets.dependsOn.includes('chmod-bin'),
      'an uncacheable chmod-bin in assets\' dependsOn makes every build/test graph miss');
  } finally { f.cleanup(); }
});

test('assets does NOT claim the bin path as its own output (would reintroduce BUG-026)', () => {
  const f = fixture();
  try {
    const targets = targetsFor(f.ws, f.projectRoot);
    assert.ok(!targets.assets.outputs.includes('{projectRoot}/dist/index.js'));
  } finally { f.cleanup(); }
});

test('the real plugin, applied to a real bin-having project, keeps chmod-bin uncached and out of assets\' deps', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(HERE, '..', '..', '..');
  const targets = targetsFor(repoRoot, 'entrypoint/backlog');
  assert.ok(targets['chmod-bin'], 'backlog has a bin entry and must get an inferred chmod-bin target');
  assert.equal(targets['chmod-bin'].cache, false);
  assert.ok(!targets.assets.dependsOn.includes('chmod-bin'));
});

test('BEHAVIOUR: a cache-restored dist whose bin lost its executable bit is repaired by writeDistManifest', async () => {
  const { writeDistManifest } = require('../build/executors/manifest/generate-manifest.js');
  const rootDir = mkdtempSync(join(tmpdir(), 'adhd-bugnxassets001-wdm-'));
  try {
    const projectRoot = 'entrypoint/demo-cli';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adhd/demo-cli', version: '1.0.0', main: './dist/index.js', bin: { 'demo-cli': './dist/index.js' } }));
    writeFileSync(join(pkgRoot, 'project.json'), JSON.stringify({ name: '@adhd/demo-cli', targets: { build: {} } }));
    writeFileSync(join(pkgRoot, 'README.md'), '# demo');
    const bin = join(distDir, 'index.js');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o644); // what a cache restore leaves behind
    assert.equal(statSync(bin).mode & 0o111, 0, 'precondition: bin is not executable');
    const context = { root: rootDir, projectName: '@adhd/demo-cli', projectsConfigurations: { projects: { '@adhd/demo-cli': { root: projectRoot } } } };
    await writeDistManifest(context, pkgRoot, distDir);
    assert.equal(statSync(bin).mode & 0o111, 0o111, 'writeDistManifest must leave the bin executable');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
