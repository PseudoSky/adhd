/**
 * Teeth tests for release-commit.mjs — the opt-in final-release commit step
 * (DEBT-BUILD-VERSION-NO-AUTOCOMMIT-001, closed via this script).
 *
 * REAL components throughout: a genuine temporary git repository (git init +
 * real commits), the REAL script invoked as a real child process (not
 * imported/called in-process) — this is a CLI tool, so it's proven the way a
 * human/CI would actually run it. Never touches this repository's own git
 * history.
 *
 * Run: node --test tools/nx-plugins/build/executors/publish/release-commit.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 50e8c966: hook-exported GIT_DIR/GIT_INDEX_FILE must never reach a fixture git spawn
// (nor the release-commit.mjs child, whose own git calls would inherit them).
const { cleanGitEnv } = createRequire(import.meta.url)('../../../lib/git-env.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, 'release-commit.mjs');

function sh(cmd, args, opts = {}) {
  // Scrub ambient GIT_* (hook GIT_DIR/GIT_INDEX_FILE), but let a caller's EXPLICIT
  // GIT_AUTHOR_*/GIT_COMMITTER_* pins survive: they are deliberate identity/date
  // settings for the fixture, layered back on via cleanGitEnv's `extra` argument.
  // Only an explicitly-passed opts.env counts as deliberate (ambient process.env never does).
  const deliberate = Object.fromEntries(
    Object.entries(opts.env ?? {}).filter(([k]) => /^GIT_(AUTHOR|COMMITTER)_/.test(k))
  );
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: cleanGitEnv(opts.env, deliberate) });
  if (res.error) throw res.error;
  return res;
}

/** A real, throwaway git repo with a `nx.json` marker (so the script's findRoot locates it) and a couple of "release-shaped" files. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-commit-'));
  writeFileSync(join(root, 'nx.json'), '{}');
  writeFileSync(join(root, 'published-state.json'), '{}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '6.0'\n");
  mkdirSync(join(root, 'packages/foo/foo-base-a'), { recursive: true });
  writeFileSync(join(root, 'packages/foo/foo-base-a/package.json'), JSON.stringify({ name: '@x/foo-base-a', version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(join(root, 'packages/foo/foo-base-a/CHANGELOG.md'), '# foo-base-a\n\n## 1.0.0\n');
  mkdirSync(join(root, 'entrypoint/cli-a'), { recursive: true });
  writeFileSync(join(root, 'entrypoint/cli-a/package.json'), JSON.stringify({ name: '@x/cli-a', version: '1.0.0' }, null, 2) + '\n');
  // An unrelated file that must NEVER be swept into a release commit.
  mkdirSync(join(root, 'packages/foo/foo-base-a/src'), { recursive: true });
  writeFileSync(join(root, 'packages/foo/foo-base-a/src/index.ts'), 'export const x = 1;\n');

  sh('git', ['init', '-q'], { cwd: root });
  sh('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  sh('git', ['config', 'user.name', 'Test'], { cwd: root });
  sh('git', ['add', '-A'], { cwd: root });
  sh('git', ['commit', '-q', '-m', 'initial'], { cwd: root });
  return root;
}

function bump(root, relPath, mutate) {
  const abs = join(root, relPath);
  writeFileSync(abs, mutate(readFileSync(abs, 'utf8')));
}

function run(root, args = []) {
  return sh('node', [scriptPath, ...args], { cwd: root });
}

function gitLogSubjects(root) {
  const res = sh('git', ['log', '--format=%s'], { cwd: root });
  return res.stdout.trim().split('\n').filter(Boolean);
}

function porcelainStatus(root) {
  return sh('git', ['status', '--porcelain'], { cwd: root }).stdout;
}

test('--dry-run: previews exactly the release-shaped files, commits NOTHING', () => {
  const root = makeRepo();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    writeFileSync(join(root, 'published-state.json'), JSON.stringify({ '@x/foo-base-a': { version: '1.0.1' } }));
    // Unrelated concurrent work — must be left completely untouched.
    writeFileSync(join(root, 'packages/foo/foo-base-a/src/index.ts'), 'export const x = 2; // someone else\'s edit\n');

    const before = porcelainStatus(root);
    const res = run(root, ['--dry-run']);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /would stage 2 file/); // package.json + published-state.json (CHANGELOG.md untouched here)
    assert.match(res.stderr, /packages\/foo\/foo-base-a\/package\.json/);
    assert.match(res.stderr, /published-state\.json/);
    assert.doesNotMatch(res.stderr, /src\/index\.ts/, 'must never even MENTION staging an unrelated file');

    const after = porcelainStatus(root);
    assert.equal(after, before, 'a dry run must leave the working tree/index byte-for-byte untouched');
    assert.equal(gitLogSubjects(root).length, 1, 'a dry run must never create a commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real run: commits ONLY the release-shaped files (package.json + CHANGELOG.md + published-state.json), leaves unrelated dirty files staged=NO / working-tree UNCHANGED', () => {
  const root = makeRepo();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    bump(root, 'packages/foo/foo-base-a/CHANGELOG.md', (s) => s + '\n## 1.0.1\n\nreal change.\n');
    bump(root, 'entrypoint/cli-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    writeFileSync(join(root, 'published-state.json'), JSON.stringify({ '@x/foo-base-a': { version: '1.0.1' } }));
    // Unrelated, concurrent, NOT-a-release-artifact change.
    writeFileSync(join(root, 'packages/foo/foo-base-a/src/index.ts'), 'export const x = 2; // concurrent unrelated work\n');

    const res = run(root);
    assert.equal(res.status, 0, res.stderr);

    const subjects = gitLogSubjects(root);
    assert.equal(subjects.length, 2, 'must create exactly one new commit');
    assert.match(subjects[0], /^chore\(release\): version bumps \+ published-state\.json \(2 packages\)$/);

    // The unrelated file must remain modified-but-UNCOMMITTED — proves no `-A`/`.` sweep.
    const status = porcelainStatus(root);
    assert.match(status, /M {1,2}packages\/foo\/foo-base-a\/src\/index\.ts/, 'the unrelated concurrent edit must still show as dirty — NEVER committed');

    // The release-shaped files must be clean (committed) now.
    assert.doesNotMatch(status, /package\.json/, 'both bumped package.json files must be committed, not left dirty');
    assert.doesNotMatch(status, /CHANGELOG\.md/);
    assert.doesNotMatch(status, /published-state\.json/);

    const committedFiles = sh('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.match(committedFiles, /foo-base-a\/package\.json/);
    assert.match(committedFiles, /foo-base-a\/CHANGELOG\.md/);
    assert.match(committedFiles, /cli-a\/package\.json/);
    assert.match(committedFiles, /published-state\.json/);
    assert.doesNotMatch(committedFiles, /src\/index\.ts/, 'the unrelated file must NEVER appear in the release commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nothing to commit: exits 0 without creating a commit or touching git state', () => {
  const root = makeRepo();
  try {
    const res = run(root);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /nothing to commit/);
    assert.equal(gitLogSubjects(root).length, 1, 'must not create an empty commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package.json OUTSIDE packages/*/*/ or entrypoint/*/ is never swept in (e.g. the workspace root package.json)', () => {
  const root = makeRepo();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '9.9.9' }, null, 2)); // new, untracked — irrelevant here
    // Make an existing root-level tracked file dirty to test the "outside" boundary properly.
    writeFileSync(join(root, 'nx.json'), '{"changed": true}');

    const res = run(root, ['--dry-run']);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /(?<!foo-base-a\/)(?<!cli-a\/)package\.json.*would stage|nx\.json/s);
    assert.match(res.stderr, /packages\/foo\/foo-base-a\/package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defect 9de522a4: a pre-staged FOREIGN file is NOT swept into the release commit and is left staged', () => {
  const root = makeRepo();
  try {
    // ONE release-shaped change: a package.json version bump.
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));

    // A FOREIGN file that another agent had ALREADY staged before the release
    // commit ran — the exact real-world shape of this defect (mirrors
    // task-report.mjs being staged in this repo for a whole session). Staged
    // with an EXPLICIT pathspec, inside the test's own throwaway repo.
    const foreignRel = 'packages/foo/foo-base-a/src/foreign-notes.txt';
    writeFileSync(join(root, foreignRel), 'another agent\'s in-flight work\n');
    sh('git', ['add', '--', foreignRel], { cwd: root });

    // Sanity: it really is staged BEFORE the release commit runs.
    assert.match(
      porcelainStatus(root),
      /A {1,2}packages\/foo\/foo-base-a\/src\/foreign-notes\.txt/,
      'fixture precondition: the foreign file must be staged before release-commit runs'
    );

    const res = run(root);
    assert.equal(res.status, 0, res.stderr);

    // The release commit must contain ONLY the release path(s).
    const committedFiles = sh('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.doesNotMatch(committedFiles, /foreign-notes\.txt/, 'a pre-staged foreign file must NEVER be swept into the release commit');
    assert.match(committedFiles, /foo-base-a\/package\.json/);

    // And it must STILL be staged, untouched — the commit did not consume it.
    assert.match(
      porcelainStatus(root),
      /A {1,2}packages\/foo\/foo-base-a\/src\/foreign-notes\.txt/,
      'the foreign file must remain staged after the release commit — the pathspec commit left it alone'
    );

    // Defense-in-depth: the NOTE surfaces the unrelated staged path.
    assert.match(res.stderr, /unrelated staged path/, 'the tool must visibly NOTE the unrelated staged path it deliberately left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * a4d346ae C-AC1: after the release-commit step the tree must be clean and
 * `pnpm-lock.yaml` must be IN the release commit whenever it changed.
 * Parameterised over the script so the negative control can run the SAME
 * assertions against a wrong variant and prove them red.
 */
function assertLockfileReleased(script) {
  const root = makeRepo();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    bump(root, 'pnpm-lock.yaml', (s) => s + "importers:\n  packages/foo/foo-base-a: {}\n");
    const res = sh('node', [script], { cwd: root });
    assert.equal(res.status, 0, res.stderr);
    const committedFiles = sh('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.match(committedFiles, /pnpm-lock\.yaml/, 'pnpm-lock.yaml must be in the release commit');
    assert.equal(porcelainStatus(root), '', 'git status --porcelain must be empty after the release commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a4d346ae C-AC1: a changed pnpm-lock.yaml rides the release commit and the tree is clean afterwards', () => {
  assertLockfileReleased(scriptPath);
});

test('a4d346ae C-AC1: a lockfile-only change is still a release (nothing-to-commit must not hide it)', () => {
  const root = makeRepo();
  try {
    bump(root, 'pnpm-lock.yaml', (s) => s + 'x: 1\n');
    const res = run(root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(gitLogSubjects(root)[0], /^chore\(release\)/);
    assert.equal(porcelainStatus(root), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a4d346ae C-AC1 NEGATIVE CONTROL: with the lockfile removed from the stage list the same assertions go red', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'release-commit-wrong-'));
  try {
    const src = readFileSync(scriptPath, 'utf8');
    const wrong = src
      .replace(/if \(dirty\.includes\('pnpm-lock\.yaml'\) \|\| sync\.action === 'would-regenerate'\) paths\.push\('pnpm-lock\.yaml'\);/, '')
      // the mutated copy lives in a scratch dir: make its relative lib require absolute
      .replace("'../../lib/lockfile-sync.js'", JSON.stringify(join(__dirname, '..', '..', 'lib', 'lockfile-sync.js')));
    assert.notEqual(wrong, src, 'the mutation must actually remove the lockfile staging line');
    assert.doesNotMatch(wrong, /paths\.push\('pnpm-lock\.yaml'\)/, 'the lockfile staging line must be gone');
    const wrongPath = join(scratch, 'release-commit-wrong.mjs');
    writeFileSync(wrongPath, wrong);
    assert.throws(() => assertLockfileReleased(wrongPath), /pnpm-lock\.yaml must be in the release commit|git status --porcelain must be empty|nothing to commit/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// e98bb455 AC1 — release:commit regenerates the lockfile and stages it.
// The ONLY mocked boundary is the `corepack pnpm` process spawn: a shell shim
// earlier on PATH plays pnpm (stale until a `--no-frozen-lockfile` call relocks
// it). git, the script, and the staging/commit logic are all real.
// ---------------------------------------------------------------------------
function makePnpmShim() {
  const dir = mkdtempSync(join(tmpdir(), 'release-commit-shim-'));
  const log = join(dir, 'calls.log');
  const relocked = join(dir, 'relocked.marker');
  const shim = join(dir, 'corepack');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'echo "$*" >> "$SHIM_LOG"',
      'case "$*" in',
      '  *--no-frozen-lockfile*) [ -n "$SHIM_RELOCK_FAILS" ] && { echo "boom" >&2; exit 7; }; echo "relocked: true" >> pnpm-lock.yaml; : > "$SHIM_MARKER"; exit 0;;',
      '  *--frozen-lockfile*) [ -f "$SHIM_MARKER" ] && exit 0; [ -n "$SHIM_ALREADY_FRESH" ] && exit 0;',
      '     echo " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with packages/foo/foo-base-a/package.json" >&2',
      `     echo "specifiers in the lockfile ({\"@x/dep\":\"^1.0.0\"}) don't match specs in package.json ({\"@x/dep\":\"^1.0.1\"})" >&2; exit 1;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHIM_LOG: log, SHIM_MARKER: relocked };
  return { dir, log, env };
}

/** makeRepo() plus the pnpm-workspace.yaml marker that arms the relock step. */
function makeWorkspaceRepo() {
  const root = makeRepo();
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*/*'\n");
  sh('git', ['add', 'pnpm-workspace.yaml'], { cwd: root });
  sh('git', ['commit', '-q', '-m', 'workspace marker'], { cwd: root });
  return root;
}

const shimCalls = (shim) => (existsSync(shim.log) ? readFileSync(shim.log, 'utf8').trim().split('\n') : []);

test('e98bb455 AC1: a real run regenerates a stale lockfile and commits it with the version bump', () => {
  const root = makeWorkspaceRepo();
  const shim = makePnpmShim();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    const res = sh('node', [scriptPath], { cwd: root, env: shim.env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /regenerated pnpm-lock\.yaml/);

    const calls = shimCalls(shim);
    assert.match(calls[0], /--frozen-lockfile --lockfile-only/, 'probe first (non-mutating)');
    assert.ok(calls.some((c) => /--lockfile-only --no-frozen-lockfile --prefer-offline/.test(c)), 'then relock');

    const files = sh('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.match(files, /^pnpm-lock\.yaml$/m, 'pnpm-lock.yaml rides the release commit');
    assert.match(files, /foo-base-a\/package\.json/);
    assert.equal(porcelainStatus(root), '', 'tree is clean: the regenerated lockfile was committed');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: --dry-run lists pnpm-lock.yaml as would-stage but NEVER relocks (no write, no commit)', () => {
  const root = makeWorkspaceRepo();
  const shim = makePnpmShim();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    const before = porcelainStatus(root);
    const res = sh('node', [scriptPath, '--dry-run'], { cwd: root, env: shim.env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /would stage 2 file/);
    assert.match(res.stderr, /- pnpm-lock\.yaml/);
    assert.equal(shimCalls(shim).filter((c) => /--no-frozen-lockfile/.test(c)).length, 0, 'dry-run must not call the mutating relock');
    assert.equal(porcelainStatus(root), before);
    assert.equal(gitLogSubjects(root).length, 2, 'no commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: an already-fresh lockfile is not rewritten and not staged', () => {
  const root = makeWorkspaceRepo();
  const shim = makePnpmShim();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    const res = sh('node', [scriptPath], { cwd: root, env: { ...shim.env, SHIM_ALREADY_FRESH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(shimCalls(shim).filter((c) => /--no-frozen-lockfile/.test(c)).length, 0);
    const files = sh('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.doesNotMatch(files, /pnpm-lock\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test('e98bb455 AC1: a failing relock aborts loudly (exit non-zero, nothing committed)', () => {
  const root = makeWorkspaceRepo();
  const shim = makePnpmShim();
  try {
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    const res = sh('node', [scriptPath], { cwd: root, env: { ...shim.env, SHIM_RELOCK_FAILS: '1' } });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /lockfile sync FAILED/);
    assert.equal(gitLogSubjects(root).length, 2, 'no release commit on a failed relock');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test('e98bb455 AC1 NEGATIVE CONTROL: with the relock call removed the lockfile is NOT in the release commit', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'release-commit-norelock-'));
  const root = makeWorkspaceRepo();
  const shim = makePnpmShim();
  try {
    const src = readFileSync(scriptPath, 'utf8');
    const wrong = src
      .replace("syncLockfileForRelease({ cwd: workspaceRoot, dirtyPaths: dirtyPaths(), dryRun })", "{ action: 'skipped' }")
      .replace("'../../lib/lockfile-sync.js'", JSON.stringify(join(__dirname, '..', '..', 'lib', 'lockfile-sync.js')));
    assert.notEqual(wrong, src, 'the mutation must actually remove the relock call');
    const wrongPath = join(scratch, 'release-commit-norelock.mjs');
    writeFileSync(wrongPath, wrong);
    bump(root, 'packages/foo/foo-base-a/package.json', (s) => s.replace('1.0.0', '1.0.1'));
    const res = sh('node', [wrongPath], { cwd: root, env: shim.env });
    assert.equal(res.status, 0, res.stderr);
    const files = sh('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root }).stdout;
    assert.doesNotMatch(files, /pnpm-lock\.yaml/, 'the mutated script strands a stale lockfile — exactly the defect');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
