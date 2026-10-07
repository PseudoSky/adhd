/**
 * 50e8c966 AC2 + AC3 — regression for the hook-exported `GIT_*` leak that let
 * test specs write into the REAL repo.
 *
 * MECHANISM (proven, reproduced here, not assumed): git hooks run from a
 * linked worktree export GIT_DIR=<repo>/.git/worktrees/<name> and
 * GIT_INDEX_FILE. Those outrank `cwd`, so a spec that spawns `git init` /
 * `git config` in an mkdtemp dir without scrubbing GIT_* rewrites the
 * ENCLOSING repo: core.bare=true, a repo-local user.email, and so on — while
 * exiting 0.
 *
 * AC2: for a throwaway repo R with a linked worktree W, each proven spec is run
 *      as a child under the exact hook env. R's .git/config must be
 *      byte-identical afterwards, core.bare false, `git -C R status` exit 0,
 *      and R's refs unchanged. A LEAKY fixture proves the harness has teeth
 *      (it MUST corrupt R, or the assertions above prove nothing).
 * AC3: the hook guard (`.githooks/lib/git-env-guard.sh`) exits non-zero with a
 *      named message (GIT-ENV-LEAK) when something flips core.bare / sets a
 *      repo-local identity, and `no_hook_git_env` stops the leak at the source.
 *
 * Every repro lives in an os.tmpdir() throwaway — never the real repo.
 * Run: node --test .githooks/git-env-leak.spec.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../tools/nx-plugins/lib/git-env.js');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const GUARD = join(here, 'lib', 'git-env-guard.sh');

/** The four specs proven to spawn git without a scrub (50e8c966). */
const PROVEN_SPECS = [
  'tools/nx-plugins/build/lib/release-reset.spec.mjs',
  'tools/nx-plugins/build/executors/publish/release-commit.spec.mjs',
  '.githooks/detect-mass-deletion.spec.mjs',
  '.githooks/check-no-credentials.spec.mjs',
];

const IDENT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

let base;
let R; // the "real" repo under protection
let W; // its linked worktree (where the hook "runs")
let hookEnv;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'git-env-leak-')));
  R = join(base, 'R');
  W = join(base, 'W');
  mkdirSync(R);
  git(R, ['init', '-q']);
  git(R, [...IDENT, 'commit', '-q', '--allow-empty', '-m', 'base']);
  git(R, ['branch', 'side']);
  git(R, ['worktree', 'add', '-q', W, '-b', 'wbranch']);
  const gitdir = join(R, '.git', 'worktrees', 'W');
  assert.ok(existsSync(gitdir), 'fixture precondition: linked worktree gitdir exists');
  hookEnv = { GIT_DIR: gitdir, GIT_INDEX_FILE: join(gitdir, 'index') };
});

after(() => rmSync(base, { recursive: true, force: true }));

function snapshot() {
  return {
    config: readFileSync(join(R, '.git', 'config')),
    refs: git(R, ['for-each-ref', '--format=%(refname) %(objectname)']),
    worktrees: git(R, ['worktree', 'list', '--porcelain']),
  };
}

function assertPristine(before, label) {
  const after = snapshot();
  assert.ok(before.config.equals(after.config), `${label}: R/.git/config must be byte-identical`);
  assert.equal(git(R, ['config', '--bool', 'core.bare']).trim(), 'false', `${label}: core.bare must stay false`);
  const st = spawnSync('git', ['-C', R, 'status'], { encoding: 'utf8', env: cleanGitEnv() });
  assert.equal(st.status, 0, `${label}: git -C R status must exit 0 (${st.stderr})`);
  assert.equal(after.refs, before.refs, `${label}: R's branch tips must be unchanged`);
  assert.equal(after.worktrees, before.worktrees, `${label}: R's worktree list must be unchanged`);
}

/** Run `node <args>` from W under the hook environment. */
function runUnderHookEnv(args, extraEnv = {}) {
  // NODE_TEST_CONTEXT marks us as a node:test child; inherited, it would make a
  // nested `node --test` skip actually running the spec (a silent green).
  const env = { ...cleanGitEnv(), ...hookEnv, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('node', args, { cwd: W, encoding: 'utf8', env, timeout: 240_000 });
}

/** The child must have REALLY executed its tests (not a vacuous exit 0). */
function assertRan(r, spec) {
  const m = /ℹ tests (\d+)/.exec(r.stdout) || /# tests (\d+)/.exec(r.stdout);
  assert.ok(m && Number(m[1]) > 0, `${spec}: child must report >0 executed tests\n${r.stdout}\n${r.stderr}`);
}

// A fixture that does exactly what the 4 culprits used to do: git init/config
// in an mkdtemp dir with the ambient (hook) environment.
function writeLeakyScript() {
  const p = join(base, 'leaky.mjs');
  writeFileSync(
    p,
    `import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const d = mkdtempSync(join(tmpdir(), 'leaky-'));
execFileSync('git', ['init', '-q'], { cwd: d });
execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: d });
`
  );
  return p;
}

test('50e8c966 AC2 (negative control): an UNSCRUBBED spawn under the hook env DOES corrupt R — the harness has teeth', () => {
  const before = snapshot();
  const r = runUnderHookEnv([writeLeakyScript()]);
  assert.equal(r.status, 0, 'the leaky fixture exits 0 — that silence is the bug');
  const after = snapshot();
  assert.ok(!before.config.equals(after.config), 'harness must detect the leak (R/.git/config changed)');
  assert.equal(git(R, ['config', '--file', join(R, '.git', 'config'), '--bool', 'core.bare']).trim(), 'true');
  // Repair R for the remaining tests.
  git(R, ['config', '--file', join(R, '.git', 'config'), '--bool', 'core.bare', 'false']);
  git(R, ['config', '--file', join(R, '.git', 'config'), '--remove-section', 'user']);
});

for (const spec of PROVEN_SPECS) {
  test(`50e8c966 AC2: ${spec} leaves R pristine under the hook env`, () => {
    const before = snapshot();
    try {
      const r = runUnderHookEnv(['--test', join(repoRoot, spec)]);
      assert.equal(r.status, 0, `${spec} must pass under the hook env\n${r.stdout}\n${r.stderr}`);
      assertRan(r, spec);
      assertPristine(before, spec);
    } finally {
      repair(); // a leaking spec must not cascade failures into the next test
    }
  });
}

// ─── AC3: the hook guard ───────────────────────────────────────────────────

/** Run `sh -c <script>` from W under the hook env with the guard sourced. */
function runGuard(script) {
  return spawnSync('sh', ['-c', `. "${GUARD}"\n${script}`], {
    cwd: W,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...hookEnv },
  });
}

function repair() {
  const cfg = join(R, '.git', 'config');
  git(R, ['config', '--file', cfg, '--bool', 'core.bare', 'false']);
  spawnSync('git', ['config', '--file', cfg, '--remove-section', 'user'], { env: cleanGitEnv() });
}

test('50e8c966 AC3: guard_verify exits non-zero with a named GIT-ENV-LEAK message when a spec flips core.bare', () => {
  const r = runGuard(`guard_snapshot\nnode "${writeLeakyScript()}"\nguard_verify`);
  try {
    assert.notEqual(r.status, 0, 'hook must fail when core.bare flips');
    assert.match(r.stderr, /GIT-ENV-LEAK/);
    assert.match(r.stderr, /core\.bare flipped to true/);
    assert.match(r.stderr, /user\.email set to 't@example\.com'/);
  } finally {
    repair();
  }
});

test('50e8c966 AC3: guard_verify passes (exit 0) when nothing leaked', () => {
  const before = snapshot();
  const r = runGuard('guard_snapshot\ntrue\nguard_verify');
  assert.equal(r.status, 0, r.stderr);
  assertPristine(before, 'clean guard run');
});

test('50e8c966 AC3: no_hook_git_env stops the leak at the source (a leaky spec run through it cannot touch R)', () => {
  const before = snapshot();
  const r = runGuard(`guard_snapshot\nno_hook_git_env node "${writeLeakyScript()}"\nguard_verify`);
  assert.equal(r.status, 0, r.stderr);
  assertPristine(before, 'no_hook_git_env');
});

test('50e8c966 AC3: guard_verify does not blame a user.email that pre-existed the run', () => {
  const cfg = join(R, '.git', 'config');
  git(R, ['config', '--file', cfg, 'user.email', 'owner@example.invalid']);
  try {
    const r = runGuard('guard_snapshot\nguard_verify');
    assert.equal(r.status, 0, r.stderr);
  } finally {
    spawnSync('git', ['config', '--file', cfg, '--remove-section', 'user'], { env: cleanGitEnv() });
  }
});

test('50e8c966 AC3: pre-commit and pre-push are wired to the guard (source it, scrub the test run, verify after)', () => {
  for (const hook of ['pre-commit', 'pre-push']) {
    const text = readFileSync(join(here, hook), 'utf8');
    assert.match(text, /\.\s+"\$hook_dir\/lib\/git-env-guard\.sh"/, `${hook} must source the guard`);
    assert.match(text, /no_hook_git_env\s/, `${hook} must run its test/nx invocation under no_hook_git_env`);
    assert.match(text, /guard_snapshot/, `${hook} must snapshot before the tests`);
    assert.match(text, /guard_verify/, `${hook} must verify after the tests`);
  }
});
