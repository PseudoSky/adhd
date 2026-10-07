/**
 * 50e8c966 regression — hook-exported `GIT_DIR` must not let a git-spawning spec touch the repo
 * it was pointed at.
 *
 * git exports GIT_DIR into every hook; it outranks `cwd`, so an unscrubbed spec that runs
 * `git init` / `git config` / `git commit` inside an mkdtemp dir silently mutates the REAL repo
 * (and still exits 0). This spec reproduces the leak SAFELY: GIT_DIR is pointed at a DECOY repo
 * created under os.tmpdir() — never the real one — and the subject spec
 * (release-reset.exit.spec.mjs, which git-inits / configs / commits in a temp dir) is run as a
 * child with that env. The decoy's config, refs, HEAD, worktree list and core.bare must not move.
 *
 * NEGATIVE CONTROL: the same subject with BOTH scrubs (`cleanGitEnv()` + `scrubProcessGitEnv()`) removed (a copy written
 * beside it, deleted in `finally`) MUST move the decoy, and `assertDecoyUntouched` MUST throw.
 *
 * Run: env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_PREFIX \
 *        node --test tools/nx-plugins/build/git-env-regression.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../lib/git-env.js');
const here = dirname(fileURLToPath(import.meta.url));
const SUBJECT = join(here, 'executors/release-reset/release-reset.exit.spec.mjs');
const SCRUB = 'env: cleanGitEnv()';
const PROC_SCRUB = '\nscrubProcessGitEnv();\n';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A second, throwaway repo standing in for "the repo a hook's GIT_DIR points at". */
function makeDecoy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-env-decoy-')));
  git(root, 'init', '-q', '-b', 'decoy-main');
  git(root, 'config', 'user.email', 'decoy@example.com');
  git(root, 'config', 'user.name', 'Decoy');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, 'add', 'seed.txt');
  git(root, 'commit', '-q', '-m', 'decoy seed');
  return root;
}

function snapshot(decoy) {
  return {
    config: readFileSync(join(decoy, '.git/config'), 'utf8'),
    bare: git(decoy, 'config', '--get', 'core.bare').trim(),
    branches: git(decoy, 'branch', '-a', '--format=%(refname) %(objectname)'),
    head: git(decoy, 'rev-parse', 'HEAD').trim(),
    log: git(decoy, 'log', '--all', '--format=%H %s'),
    worktrees: git(decoy, 'worktree', 'list'),
  };
}

function assertDecoyUntouched(before, after) {
  assert.deepEqual(after, before, 'the decoy repo (GIT_DIR target) must be byte-for-byte unchanged');
}

/** Run `subject` as a child with GIT_DIR deliberately aimed at the decoy. */
function runSubject(subject, decoy) {
  const env = { ...process.env, GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git/index') };
  delete env.NODE_TEST_CONTEXT; // run as a standalone test process, not a subtest of this one
  return spawnSync(process.execPath, ['--test', subject], { encoding: 'utf8', env });
}

test('50e8c966 regression: a scrubbed spec run with GIT_DIR aimed at a decoy repo leaves the decoy untouched', () => {
  const subjectSrc = readFileSync(SUBJECT, 'utf8');
  assert.ok(subjectSrc.includes(SCRUB) && subjectSrc.includes(PROC_SCRUB), 'subject must keep both scrubs');
  const decoy = makeDecoy();
  try {
    const before = snapshot(decoy);
    const r = runSubject(SUBJECT, decoy);
    assert.equal(r.status, 0, `subject spec must pass under a hostile GIT_DIR:\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-800)}`);
    assertDecoyUntouched(before, snapshot(decoy));
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('50e8c966 regression NEGATIVE CONTROL: with the scrub removed the decoy IS mutated and the assertion throws', () => {
  const broken = join(dirname(SUBJECT), 'release-reset.exit.negctl.spec.mjs');
  const decoy = makeDecoy();
  try {
    const src = readFileSync(SUBJECT, 'utf8');
    assert.ok(src.includes(SCRUB) && src.includes(PROC_SCRUB), 'scrubs must be locatable to remove them');
    writeFileSync(broken, src.replaceAll(SCRUB, 'env: process.env').replace(PROC_SCRUB, '\n'));
    const before = snapshot(decoy);
    runSubject(broken, decoy); // exit status irrelevant: the damage is the point
    assert.throws(() => assertDecoyUntouched(before, snapshot(decoy)), /unchanged/);
  } finally {
    rmSync(broken, { force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

// Every other git-spawning C+D spec must hold the same guarantee: a hostile hook GIT_DIR never
// reaches the repo it points at. (ci-hygiene.spec.mjs is excluded: it drives real `nx` runs and is
// covered by the e2e/test gate itself; it scrubs through the same cleanGitEnv helper.)
for (const rel of ['executors/publish/release-commit.spec.mjs', '../../evidence/evidence.spec.mjs']) {
  test(`50e8c966 regression: ${rel} run with GIT_DIR aimed at a decoy repo leaves the decoy untouched`, () => {
    const subject = join(here, rel);
    const decoy = makeDecoy();
    try {
      const before = snapshot(decoy);
      const r = runSubject(subject, decoy);
      assert.equal(r.status, 0, `${rel} must pass under a hostile GIT_DIR:\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-800)}`);
      assertDecoyUntouched(before, snapshot(decoy));
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
}
