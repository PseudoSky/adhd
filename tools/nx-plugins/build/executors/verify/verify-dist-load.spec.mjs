/**
 * Teeth tests for verify-dist-load.mjs — BUG-007: the gate used to read the
 * SOURCE root's package.json (unrebased `./dist/...` paths, resolved against
 * the source root) instead of the SHIPPED dist manifest (rebased paths,
 * resolved against dist as the package root). That coincidentally still
 * found the right file in the common case (source's `./dist/index.js`
 * joined against the source root happens to equal dist's `./index.js`
 * joined against dist), which is exactly why the bug went unnoticed — but it
 * means the gate never actually proves the SHIPPED manifest is correct: a
 * bad rebase in `dist/package.json` (wrong `exports`/`bin`/`main` target)
 * sailed straight through.
 *
 * These tests spawn the REAL script as a real child process (no mocking —
 * `verify-dist-load.mjs` is a CLI script, not an importable module with a
 * seam) against fixture `projectRoot`s planted under this repo's own `tmp/`
 * (ephemeral, cleaned up in `finally`) — the script's own `findRoot` walks up
 * from ITS OWN file location to find `nx.json`, so it always resolves to
 * this real repo's root regardless of the fixture's location, matching how
 * the real `verify-dist-load` nx target actually invokes it (see
 * `verify/impl.js`: `spawnSync('node', [script, projectRoot], { cwd:
 * context.root })`).
 *
 * Run: node --test tools/nx-plugins/build/executors/verify/verify-dist-load.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'verify-dist-load.mjs');

function findRepoRoot(d) {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  throw new Error('could not locate workspace root (nx.json) walking up from ' + __dirname);
}
const REPO_ROOT = findRepoRoot(__dirname);

/** Plant a fixture project under `tmp/` (this repo's canonical ephemeral root) and return its workspace-relative projectRoot. */
function plantFixture(label) {
  const rel = join('tmp', 'nx-build-verify-dist-load-spec', `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(REPO_ROOT, rel), { recursive: true });
  return rel;
}

function runScript(projectRoot) {
  return spawnSync('node', [SCRIPT, projectRoot], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test('exit 2: no dist/ directory at all (unchanged setup-error behavior)', () => {
  const rel = plantFixture('no-dist');
  try {
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './dist/index.js' }));
    const res = runScript(rel);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no built output at/);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});

test('BUG-007: exit 2 with a clear message when dist/ exists but has NO dist/package.json (the dist-manifest step never ran) — no longer silently falls back to the source manifest', () => {
  const rel = plantFixture('no-dist-manifest');
  try {
    // A real source manifest DOES exist — the old code would have happily
    // read THIS instead. The fixed code must refuse: the shipped artifact's
    // own manifest is what must be proven, and it's missing.
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './dist/index.js' }));
    mkdirSync(join(REPO_ROOT, rel, 'dist'), { recursive: true });
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'index.js'), 'module.exports = {};\n');
    const res = runScript(rel);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no .*dist.*package\.json/i);
    assert.match(res.stderr, /dist-manifest/);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});

test('BUG-007 REGRESSION: a WRONG dist manifest entry now correctly FAILS, even though the coincidentally-correct SOURCE manifest would have masked it', () => {
  const rel = plantFixture('wrong-dist-entry');
  try {
    // Source manifest: perfectly normal, correctly-authored main pointing at
    // "./dist/index.js" — resolved against the SOURCE root, this join lands
    // on a real, existing file. This is exactly the coincidence that let the
    // old (buggy) code pass regardless of what the dist manifest said.
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './dist/index.js' }));
    mkdirSync(join(REPO_ROOT, rel, 'dist'), { recursive: true });
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'index.js'), 'module.exports = {};\n');
    // The DIST manifest (what dist-manifest actually stamped) is WRONG —
    // main points at a file that does not exist in dist. This simulates a
    // bad rebase (e.g. `dist-manifest` stamping the wrong target).
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './wrong-name.js' }));
    const res = runScript(rel);
    assert.equal(res.status, 1, `must FAIL (exit 1) — got status ${res.status}, stdout: ${res.stdout}, stderr: ${res.stderr}`);
    assert.match(res.stdout + res.stderr, /wrong-name\.js/);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});

test('a CORRECT dist manifest with a real entry point loads cleanly (exit 0)', () => {
  const rel = plantFixture('correct-dist-entry');
  try {
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './dist/index.js' }));
    mkdirSync(join(REPO_ROOT, rel, 'dist'), { recursive: true });
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'index.js'), 'module.exports = { ok: true };\n');
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'package.json'), JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './index.js' }));
    const res = runScript(rel);
    assert.equal(res.status, 0, `expected a clean load; stdout: ${res.stdout}, stderr: ${res.stderr}`);
    assert.match(res.stdout, /loaded cleanly/);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});

test('a dist manifest with a "bin" entry is existence-checked (not executed), resolved against dist root', () => {
  const rel = plantFixture('bin-entry');
  try {
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/cli', version: '1.0.0', bin: { 'adhd-cli': './dist/cli.js' } }));
    mkdirSync(join(REPO_ROOT, rel, 'dist'), { recursive: true });
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'cli.js'), '#!/usr/bin/env node\nprocess.exit(1);\n'); // would hang/crash if actually executed
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'package.json'), JSON.stringify({ name: '@adhd/cli', version: '1.0.0', bin: { 'adhd-cli': 'cli.js' } }));
    const res = runScript(rel);
    assert.equal(res.status, 0, `expected the bin entry to pass an existence-only check; stdout: ${res.stdout}, stderr: ${res.stderr}`);
    assert.match(res.stdout, /present \(CLI\/server entry — not executed\)/);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});

test('a dist manifest with a WRONG bin path (rebased incorrectly) fails the existence check', () => {
  const rel = plantFixture('wrong-bin-entry');
  try {
    writeFileSync(join(REPO_ROOT, rel, 'package.json'), JSON.stringify({ name: '@adhd/cli', version: '1.0.0', bin: { 'adhd-cli': './dist/cli.js' } }));
    mkdirSync(join(REPO_ROOT, rel, 'dist'), { recursive: true });
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    // Dist manifest's bin was rebased WRONG (missing the leading strip, or a
    // typo) and now points at a file that doesn't exist in dist.
    writeFileSync(join(REPO_ROOT, rel, 'dist', 'package.json'), JSON.stringify({ name: '@adhd/cli', version: '1.0.0', bin: { 'adhd-cli': 'dist/cli.js' } }));
    const res = runScript(rel);
    assert.equal(res.status, 1);
  } finally {
    rmSync(join(REPO_ROOT, rel), { recursive: true, force: true });
  }
});
