/**
 * tools/nx-plugins/assets/bug-017-assets-outputs.spec.mjs
 *
 * Regression pin for BUG-017: the INFERRED `assets` target (created by
 * `tools/nx-plugins/assets/plugin.js` for every buildable project) declared
 * `cache: true` with NO `outputs` at all.
 *
 * An nx target with `cache: true` and no declared outputs still reports
 * success on a cache hit ("Nx read the output from the cache instead of
 * running the command") while restoring NOTHING — because there is nothing
 * declared to restore. So the first `assets` run populates `dist/README.md`
 * and `dist/CHANGELOG.md` and records a cache entry; from then on, any state
 * in which those files are absent from `dist/` is never repaired. That
 * includes a fresh checkout, a CI machine warmed from a shared cache, and —
 * most commonly — a `build` that re-ran with vite's `emptyOutDir: true` and
 * wiped `dist/` clean. `nx release publish` then ships a package whose
 * `dist/` has no README and no CHANGELOG.
 *
 * Reproduced live against a real project before the fix:
 *     rm packages/apigen/apigen-base-logical/dist/README.md
 *     npx nx run apigen-base-logical:assets
 *     -> "read the output from the cache", README still missing.
 * After the fix the same sequence restores the file.
 *
 * The outputs must be SCOPED PER FILE, never the bare `{projectRoot}/dist`
 * directory. That is the whole finding of the sibling pin
 * `../build/bug-026-assets-output-scope.spec.mjs`: nx restores a
 * whole-DIRECTORY output by `remove(dir)` + `copy(cachedDir, dir)` — a
 * destructive full swap that replays a stale `dist/index.js` over a fresh
 * build. BUG-026 fixed that for the one project that declared it explicitly
 * (`entrypoint/backlog/project.json`); this pin covers every OTHER project,
 * which gets its `assets` target inferred by the plugin and so never had any
 * outputs at all.
 *
 * Run: node --test tools/nx-plugins/assets/bug-017-assets-outputs.spec.mjs
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

const HERE = dirname(fileURLToPath(import.meta.url));

/** Build a throwaway workspace containing one buildable project. */
function fixture(build) {
  const ws = mkdtempSync(join(tmpdir(), 'adhd-bug017-'));
  const projectRoot = 'packages/demo/demo-core-thing';
  const abs = join(ws, projectRoot);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'project.json'), JSON.stringify({ name: 'demo-core-thing', targets: { build: {} } }));
  build(abs);
  return { ws, projectRoot, abs, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

function targetFor(ws, projectRoot) {
  const res = createNodesFn(join(projectRoot, 'package.json'), {}, { workspaceRoot: ws });
  return res.projects?.[projectRoot]?.targets?.assets;
}

test('a cacheable assets target declares the outputs it writes', () => {
  const f = fixture((abs) => {
    writeFileSync(join(abs, 'package.json'), JSON.stringify({ name: '@adhd/demo' }));
    writeFileSync(join(abs, 'README.md'), '# demo');
    writeFileSync(join(abs, 'CHANGELOG.md'), '# changes');
  });
  try {
    const t = targetFor(f.ws, f.projectRoot);
    assert.equal(t.cache, true, 'target is cacheable');
    // The defect: cache:true with no outputs restores nothing on a cache hit.
    assert.ok(Array.isArray(t.outputs), 'outputs must be declared');
    assert.ok(t.outputs.length > 0, 'a cacheable target with assets present must declare outputs');
    assert.deepEqual(
      [...t.outputs].sort(),
      ['{projectRoot}/dist/CHANGELOG.md', '{projectRoot}/dist/README.md'],
    );
  } finally { f.cleanup(); }
});

test('outputs are scoped per file and NEVER the bare dist directory (BUG-026)', () => {
  const f = fixture((abs) => {
    writeFileSync(join(abs, 'package.json'), JSON.stringify({ name: '@adhd/demo', assets: ['src/schema.json'] }));
    writeFileSync(join(abs, 'README.md'), '# demo');
    mkdirSync(join(abs, 'src'), { recursive: true });
    writeFileSync(join(abs, 'src', 'schema.json'), '{}');
  });
  try {
    const t = targetFor(f.ws, f.projectRoot);
    for (const o of t.outputs) {
      assert.notEqual(o, '{projectRoot}/dist', 'a whole-directory output causes a destructive restore swap');
      assert.notEqual(o, '{projectRoot}/dist/', 'a whole-directory output causes a destructive restore swap');
      assert.ok(o.startsWith('{projectRoot}/dist/'), `unexpected output scope: ${o}`);
    }
    // package.json "assets" entries are copied FLATTENED (basename only) by
    // executors/copy/impl.js, so the declared output must be the flattened
    // destination, not the source path.
    assert.ok(t.outputs.includes('{projectRoot}/dist/schema.json'), 'nested asset must be declared at its flattened dist path');
    assert.ok(!t.outputs.includes('{projectRoot}/dist/src/schema.json'));
  } finally { f.cleanup(); }
});

test('only assets that actually exist are declared', () => {
  const f = fixture((abs) => {
    writeFileSync(join(abs, 'package.json'), JSON.stringify({ name: '@adhd/demo' }));
    writeFileSync(join(abs, 'README.md'), '# demo');
    // no CHANGELOG.md, no llms.txt, no drizzle/
  });
  try {
    const t = targetFor(f.ws, f.projectRoot);
    assert.deepEqual(t.outputs, ['{projectRoot}/dist/README.md']);
  } finally { f.cleanup(); }
});

test('the files pkg.bin points at are NOT claimed as assets outputs', () => {
  const f = fixture((abs) => {
    writeFileSync(join(abs, 'package.json'), JSON.stringify({ name: '@adhd/demo', bin: { demo: './dist/index.js' } }));
    writeFileSync(join(abs, 'README.md'), '# demo');
  });
  try {
    const t = targetFor(f.ws, f.projectRoot);
    // The executor chmods bin targets, but those are BUILD's outputs. Claiming
    // them here would let a stale assets cache entry restore an outdated
    // dist/index.js over a fresh build — the BUG-026 failure mode.
    assert.ok(!t.outputs.includes('{projectRoot}/dist/index.js'), 'assets must not claim build outputs');
  } finally { f.cleanup(); }
});

test('the real plugin, applied to a real project, declares real outputs', () => {
  // Guards against the fix being correct only for synthetic fixtures.
  const repoRoot = join(HERE, '..', '..', '..');
  const t = targetFor(repoRoot, 'packages/apigen/apigen-base-logical');
  assert.ok(t, 'apigen-base-logical should get an inferred assets target');
  assert.ok(t.outputs.includes('{projectRoot}/dist/README.md'));
});
