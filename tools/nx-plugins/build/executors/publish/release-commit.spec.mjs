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

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, 'release-commit.mjs');

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return res;
}

/** A real, throwaway git repo with a `nx.json` marker (so the script's findRoot locates it) and a couple of "release-shaped" files. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-commit-'));
  writeFileSync(join(root, 'nx.json'), '{}');
  writeFileSync(join(root, 'published-state.json'), '{}');
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
