/**
 * pre-push-e2e — the local pre-push hook no longer runs the `e2e` lane; CI still does.
 *
 * AC1: the hook's target resolution (executed, not grepped) excludes e2e.
 * AC2: it still resolves `test`, and the hook still sources the git-env guard.
 * AC3: `lane-gate.mjs` as CI calls it still includes e2e; CI workflows invoke it.
 * AC4: check-lane-reachability goes red when e2e is re-added to pre-push or `test`
 *      is removed. The negative controls patch a COPY of the hook in a temp workspace
 *      (`--workspace-root`), never the real file: a concurrent reader of the real hook
 *      (the gate engine's G2, the other wiring specs) must never see a mutated file.
 *
 * Run: node --test .githooks/pre-push-e2e.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, '.githooks/pre-push');
const CHECK = join(ROOT, 'tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX)$/.test(k)),
);
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' });

/** Execute the hook's own `flags=$(…)` line via sh, exactly as the hook does. */
function hookFlags() {
  const line = readFileSync(HOOK, 'utf8')
    .split('\n')
    .find((l) => /^flags=\$\(/.test(l));
  assert.ok(line, 'pre-push has a flags=$(…) resolution line');
  const r = spawnSync('sh', ['-c', `repo_root='${ROOT}'; ${line}; printf '%s' "$flags"`], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\s+/).filter(Boolean);
}

test('pre-push-e2e AC1: executing the hook target resolution yields no e2e', () => {
  const flags = hookFlags();
  assert.ok(!flags.includes('--target=e2e'), flags.join(' '));
});

test('pre-push-e2e AC2: pre-push still runs test and the git-env guard is intact', () => {
  assert.deepEqual(hookFlags(), ['--target=test']);
  const body = readFileSync(HOOK, 'utf8');
  for (const needle of ['lib/git-env-guard.sh', 'guard_snapshot', 'guard_verify', 'guard_exclude_ref', 'no_hook_git_env env CI=true npx nx affected $flags']) {
    assert.ok(body.includes(needle), `pre-push lost ${needle}`);
  }
});

test('pre-push-e2e AC3: lane-gate as CI calls it still includes e2e; CI invokes it', () => {
  const r = run([join(ROOT, 'tools/gate/lane-gate.mjs')]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '--target=test --target=e2e');
  for (const wf of ['.github/workflows/pull-request.yml', '.github/workflows/ci.yml']) {
    const t = readFileSync(join(ROOT, wf), 'utf8');
    assert.match(t, /(-t\s+[^\n]*\be2e\b|--target=e2e|lane-gate\.mjs)/, `${wf} must still reach e2e`);
  }
  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', '.github', 'tools/gate/lane-gate.mjs'], { cwd: ROOT, env });
  assert.equal(diff.status, 0, 'CI workflows and lane-gate.mjs are unchanged vs HEAD');
});

/** A temp workspace holding a copy of the hook (patched by the caller) and of both CI workflows. */
function workspaceWith(hookText) {
  const ws = mkdtempSync(join(tmpdir(), 'pre-push-e2e-'));
  mkdirSync(join(ws, '.githooks'), { recursive: true });
  writeFileSync(join(ws, '.githooks/pre-push'), hookText);
  cpSync(join(ROOT, '.github'), join(ws, '.github'), { recursive: true });
  return ws;
}
const checkAt = (ws) => run([CHECK, '--workspace-root', ws]);

test('pre-push-e2e AC4: reachability check is green, and red under negative controls', () => {
  assert.equal(run([CHECK]).status, 0);
  const original = readFileSync(HOOK, 'utf8');
  const cases = [
    // Re-add e2e to pre-push.
    [original + '\nnpx nx affected --target=e2e\n', /5-pre-push-runs-e2e/],
    // Read the full gate directly (includes e2e).
    [original.replace(/^flags=.*$/m, 'flags=$(node "$repo_root/tools/gate/lane-gate.mjs")'), null],
    // Remove test: hard-code only e2e instead of the resolver.
    [original.replace(/^flags=.*$/m, 'flags="--target=e2e"'), null],
  ];
  for (const [patched, expected] of cases) {
    const ws = workspaceWith(patched);
    try {
      const r = checkAt(ws);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      if (expected) assert.match(r.stderr, expected);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
  // The unpatched copy is green: the controls fail because of the patch, not because of the fixture.
  const clean = workspaceWith(original);
  try {
    const r = checkAt(clean);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  assert.equal(readFileSync(HOOK, 'utf8'), original, 'the real hook is untouched');
});
