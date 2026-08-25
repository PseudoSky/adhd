/**
 * tools/nx-plugins/assets/bug-nxassets-001-chmod-survives-cache.spec.mjs
 *
 * Regression pin for BUG-NXASSETS-001: the `assets` copy executor did the
 * `bin` chmod as part of its own body, but `assets` is `cache: true` — an
 * nx cached target's executor body never runs at all on a cache hit, only
 * its declared `outputs` are restored. `assets`'s outputs are (correctly,
 * per BUG-026) scoped to the files it copies (README/CHANGELOG/skill/etc),
 * never the bin path — so on an `assets` cache hit the chmod silently never
 * ran. A cached/restored bin file that lost its executable bit, or one a
 * build tool never set the bit on in the first place, stayed
 * non-executable indefinitely and `npm install -g` would install fine but
 * register no runnable command.
 *
 * This pin checks two things, both at the PLUGIN-CONFIG level (no real nx
 * task graph needed — same style as bug-017/bug-026's siblings):
 *
 *   1. The inferred `chmod-bin` target is `cache: false`. This is the
 *      actual fix: an uncacheable target's body runs on EVERY invocation,
 *      so there is no cache-hit window in which the chmod can be skipped.
 *   2. `assets` itself depends on `chmod-bin` (not just `build`), so nx's
 *      task graph pulls `chmod-bin` in transitively for every EXISTING
 *      consumer of `assets` (e.g. `entrypoint/backlog/project.json`'s
 *      `test` target, `dependsOn: ["^build", "build", "assets"]`) with no
 *      change needed to any individual project.json.
 *
 * A second, executable-level proof lives in `executors/chmod-bin/impl.spec.mjs`:
 * it runs the real `chmod-bin` executor against a real temp dist directory
 * and asserts the real chmod bit on disk. This file additionally proves the
 * WIRING — that the always-runs executor is actually reachable from every
 * `assets` consumer, which is the part of the fix that isn't visible from
 * `chmod-bin/impl.spec.mjs` alone.
 *
 * Run: node --test tools/nx-plugins/assets/bug-nxassets-001-chmod-survives-cache.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  const res = createNodesFn(join(projectRoot, 'package.json'), {}, { workspaceRoot: ws });
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

test('assets depends on chmod-bin, so every existing "assets" consumer pulls it in transitively', () => {
  const f = fixture();
  try {
    const targets = targetsFor(f.ws, f.projectRoot);
    assert.ok(targets.assets.dependsOn.includes('chmod-bin'),
      'assets must depend on chmod-bin so nx\'s task graph runs it for every consumer of assets, ' +
      'with no change needed to any individual project.json\'s own dependsOn list');
  } finally { f.cleanup(); }
});

test('assets does NOT claim the bin path as its own output (would reintroduce BUG-026)', () => {
  const f = fixture();
  try {
    const targets = targetsFor(f.ws, f.projectRoot);
    assert.ok(!targets.assets.outputs.includes('{projectRoot}/dist/index.js'));
  } finally { f.cleanup(); }
});

test('the real plugin, applied to a real bin-having project, wires chmod-bin in', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(HERE, '..', '..', '..');
  const targets = targetsFor(repoRoot, 'entrypoint/backlog');
  assert.ok(targets['chmod-bin'], 'backlog has a bin entry and must get an inferred chmod-bin target');
  assert.equal(targets['chmod-bin'].cache, false);
  assert.ok(targets.assets.dependsOn.includes('chmod-bin'));
});
