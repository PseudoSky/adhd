/**
 * df9de4da C-AC2 — `release-reset` must FAIL (non-zero) instead of reporting
 * `success: true` when it leaves work undone, and must be a publish-graph
 * precondition.
 *
 * REAL components: a genuine throwaway git repo, the REAL executor `run()` fed
 * a real nx-shaped context (nx turns `{ success: false }` into a non-zero exit),
 * and the REAL plugin `createNodes` for the wiring assertion.
 *
 * Negative control (df9de4da C-AC2): the same assertions are run against a
 * deliberately-wrong copy of the executor whose verdict always succeeds; the
 * assertion helper MUST throw for it. The copy lives under os.tmpdir() and is
 * removed in a `finally`, so nothing is left in the tree.
 *
 * Run: node --test tools/nx-plugins/build/executors/release-reset/release-reset.exit.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cleanGitEnv, scrubProcessGitEnv } = require('../../../lib/git-env.js');
// The REAL executor runs in-process and its own git spawns inherit process.env (50e8c966).
scrubProcessGitEnv();
const here = dirname(fileURLToPath(import.meta.url));
const implPath = join(here, 'impl.js');
const pluginPath = join(here, '..', '..', 'plugin.js');

const PROJECT = 'packages/demo/demo-core-x';
const NAME = 'demo-core-x';
const PKG = '{\n  "name": "@adhd/demo-core-x",\n  "version": "0.1.0"\n}\n';
const CHANGELOG = '## 0.1.0 (2026-07-20)\n\ninitial\n';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-reset-exit-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  mkdirSync(join(root, PROJECT), { recursive: true });
  writeFileSync(join(root, PROJECT, 'package.json'), PKG);
  writeFileSync(join(root, PROJECT, 'CHANGELOG.md'), CHANGELOG);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

const ctxFor = (root) => ({
  root,
  projectName: NAME,
  projectsConfigurations: { projects: { [NAME]: { root: PROJECT } } },
});

/** Seeds a phantom entry. `dirty` adds a second, non-prepend edit so the revert is refused (manual review). */
function seedPhantom(root, { dirty }) {
  const phantom = '## 0.1.1 (2026-08-07)\n\nphantom\n\n' + CHANGELOG;
  writeFileSync(join(root, PROJECT, 'CHANGELOG.md'), dirty ? phantom.replace('initial', 'initial (hand edited)') : phantom);
}

/** The C-AC2 assertions, parameterised over the executor under test so a wrong variant can be proven red. */
async function assertC2(run, label) {
  const silence = (fn) => {
    const o = [console.log, console.error];
    console.log = console.error = () => {};
    return fn().finally(() => ([console.log, console.error] = o));
  };

  // (1) a revert that cannot be applied safely => skipped (manual review) => must fail.
  let root = makeRepo();
  try {
    seedPhantom(root, { dirty: true });
    const res = await silence(() => run({ live: true }, ctxFor(root)));
    assert.equal(res.success, false, `${label}: --live with a skipped (manual review) action must NOT report success`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // (2) a clean, safely-revertable phantom => reverted => success, tree clean afterwards.
  root = makeRepo();
  try {
    seedPhantom(root, { dirty: false });
    const res = await silence(() => run({ live: true }, ctxFor(root)));
    assert.equal(res.success, true, `${label}: a fully-reverted phantom entry is success`);
    assert.equal(readFileSync(join(root, PROJECT, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // (3) the precondition form: non-mutating, fails on a phantom entry...
  root = makeRepo();
  try {
    seedPhantom(root, { dirty: false });
    const before = readFileSync(join(root, PROJECT, 'CHANGELOG.md'), 'utf8');
    const res = await silence(() => run({ check: true }, ctxFor(root)));
    assert.equal(res.success, false, `${label}: --check with a phantom entry must fail`);
    assert.equal(readFileSync(join(root, PROJECT, 'CHANGELOG.md'), 'utf8'), before, `${label}: --check must never mutate`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // (4) ...and passes on a clean tree.
  root = makeRepo();
  try {
    const res = await silence(() => run({ check: true }, ctxFor(root)));
    assert.equal(res.success, true, `${label}: --check on a clean project passes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('df9de4da C-AC2: release-reset --live exits non-zero on skipped/remaining phantom; --check is a non-mutating precondition', async () => {
  const run = require(implPath);
  await assertC2(run, 'real executor');
});

test('df9de4da C-AC2 NEGATIVE CONTROL: an executor that always reports success is caught by the same assertions', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'release-reset-wrong-'));
  try {
    // Wrong variant: every verdict is success (the pre-fix behaviour).
    let src = readFileSync(implPath, 'utf8');
    src = src.replace(/require\('\.\.\/\.\.\/lib\/release-reset'\)/, `require(${JSON.stringify(join(here, '..', '..', 'lib', 'release-reset'))})`);
    src = src.replace(/require\('\.\.\/\.\.\/\.\.\/lib\/metrics'\)/, `require(${JSON.stringify(join(here, '..', '..', '..', 'lib', 'metrics'))})`);
    src = src.replace(/return \{ success: v\.success \};/, 'return { success: true };');
    src = src.replace(/return \{ success: false \};/, 'return { success: true };');
    assert.notEqual(src, readFileSync(implPath, 'utf8'), 'the mutation must actually change the executor');
    const wrongPath = join(scratch, 'impl-wrong.js');
    writeFileSync(wrongPath, src);
    const wrong = require(wrongPath);
    await assert.rejects(() => assertC2(wrong, 'wrong executor'), /wrong executor/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('df9de4da C-AC2: release-reset-check is wired into publish dependsOn ONLY (publish-graph precondition; version does not need it)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'release-reset-wiring-'));
  try {
    const root = 'packages/demo/demo-core-w';
    mkdirSync(join(ws, root), { recursive: true });
    writeFileSync(join(ws, root, 'package.json'), JSON.stringify({ name: '@adhd/demo-core-w', version: '1.0.0', main: './dist/index.js' }));
    writeFileSync(join(ws, root, 'project.json'), JSON.stringify({ name: '@adhd/demo-core-w', targets: { build: { executor: 'nx:noop' } } }));
    const plugin = require(pluginPath);
    const [, result] = plugin.createNodes[1]([`${root}/package.json`], {}, { workspaceRoot: ws })[0];
    const targets = result.projects[root].targets;
    assert.ok(targets['release-reset-check'], 'release-reset-check target must exist');
    assert.equal(targets['release-reset-check'].options.check, true);
    assert.ok(targets.publish.dependsOn.includes('release-reset-check'), 'publish must depend on release-reset-check');
    assert.ok(!targets.version.dependsOn.includes('release-reset-check'), 'version must NOT depend on release-reset-check (it never reads the verdict; the check runs once per project, in publish)');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
