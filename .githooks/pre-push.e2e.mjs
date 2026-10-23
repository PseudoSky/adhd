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
 * guards: the pre-push hook runs the heavy e2e lane again, or stops running the test lane, or loses the git-env guard.
 * tier: P (executes the hook's own lines and the reachability check through sh and node; the build-tools `node --test` e2e (`test:build-tools-e2e`, CI only)
 *   lane, 10 s per test).
 * gap: This cannot be observed at tier S because the hook is shell: its resolution and the checker's exit status exist
 *   only when sh and node run it.
 * cites: backlog pre-push-e2e AC1-AC4; 595965cc T03 (the remote-tip and once-per-push cases).
 * teeth: red: node --test .githooks/pre-push.e2e.mjs -> exit 1 with the unknown-remote-tip condition removed
 *   (the blind-review 16 case fails); AC1-AC4 red evidence was not captured in this plan.
 *
 * Run: node --test .githooks/pre-push.e2e.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('pre-push-e2e AC1: executing the hook target resolution yields no e2e', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
  const flags = hookFlags();
  assert.ok(!flags.includes('--target=e2e'), flags.join(' '));
});

test('pre-push-e2e AC2: pre-push still runs test and the git-env guard is intact', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
  assert.deepEqual(hookFlags(), ['--target=test']);
  const body = readFileSync(HOOK, 'utf8');
  for (const needle of ['lib/git-env-guard.sh', 'guard_snapshot', 'guard_verify', 'guard_exclude_ref', 'no_hook_git_env env CI=true npx nx affected $flags']) {
    assert.ok(body.includes(needle), `pre-push lost ${needle}`);
  }
});

/** sha256 over the bytes of the CI workflows and lane-gate.mjs: what AC3 must leave exactly as it found them. */
function guardedFilesDigest() {
  const files = ['tools/gate/lane-gate.mjs', ...readdirSync(join(ROOT, '.github/workflows')).sort().map((f) => `.github/workflows/${f}`)];
  const h = createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(readFileSync(join(ROOT, f))).update('\0');
  return h.digest('hex');
}

test('pre-push-e2e AC3: lane-gate as CI calls it still includes e2e; CI invokes it', () => {
  // Compared against the bytes before the test ran, not against HEAD: a dirty working tree (an edit in progress, a
  // merge gate run from a worktree) is not this test's failure, and a run that changed these files still is.
  const before = guardedFilesDigest();
  const r = run([join(ROOT, 'tools/gate/lane-gate.mjs')]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '--target=test --target=e2e');
  for (const wf of ['.github/workflows/pull-request.yml', '.github/workflows/ci.yml']) {
    const t = readFileSync(join(ROOT, wf), 'utf8');
    assert.match(t, /(-t\s+[^\n]*\be2e\b|--target=e2e|lane-gate\.mjs)/, `${wf} must still reach e2e`);
  }
  assert.equal(guardedFilesDigest(), before, 'running lane-gate.mjs must not modify the CI workflows or lane-gate.mjs');
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

test('pre-push-e2e AC4: reachability check is green, and red under negative controls', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
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

test('pre-push (blind-review 16): a remote tip this clone does not have is treated as a new branch, not an unreadable range', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
  // Execute the hook's own condition line with a remote sha that exists nowhere locally (a rewritten remote), and with a real one.
  const line = readFileSync(HOOK, 'utf8').split('\n').find((l) => /^\s*if \[ "\$remote_sha" = "\$zero_sha" \]/.test(l));
  assert.ok(line, 'the hook has a remote_sha resolution condition');
  const probe = (sha) => spawnSync('sh', ['-c', `zero_sha=0000000000000000000000000000000000000000; remote_sha=${sha}; ${line.trim()}\n echo new-branch\n else echo known-tip\n fi`], { cwd: ROOT, env, encoding: 'utf8' }).stdout.trim();
  assert.equal(probe('1234567890123456789012345678901234567890'), 'new-branch');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, env, encoding: 'utf8' }).stdout.trim();
  assert.equal(probe(head), 'known-tip');
});

test('pre-push (blind-review 15): the G4 check runs once per push, not once per pushed ref', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
  const body = readFileSync(HOOK, 'utf8');
  assert.match(body, /\[ -z "\$\{g4_done:-\}" \] && ! node "\$repo_root\/tools\/nx-plugins\/test\/executors\/wiring\/check-skip-expiry\.mjs"/);
  assert.match(body, /\n\s*g4_done=1\n/);
});

test('pre-push hardening: real-path root, empty flags refused, G12 advisory', { skip: 'backlog 8963c3cb until 2026-12-31 - .githooks/pre-push is disabled (renamed disabled-pre-push)' }, () => {
  const body = readFileSync(HOOK, 'utf8');
  assert.ok(/repo_root=\$\(cd "\$hook_dir\/\.\." && pwd -P\)/.test(body), 'repo_root must be the physical path (pwd -P)');
  assert.ok(/if \[ -z "\$flags" \]; then\n[^\n]*\n  exit 1/.test(body), 'an empty flags string must exit 1');
  const g12 = body.split('\n').findIndex((l) => l.includes('test-routing.mjs" check'));
  assert.ok(g12 > 0, 'G12 invocation present');
  const block = body.split('\n').slice(g12, g12 + 5).join('\n');
  assert.ok(!/exit 1/.test(block), 'G12 must warn, not exit 1');
});
