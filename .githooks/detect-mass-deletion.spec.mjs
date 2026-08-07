/**
 * Teeth tests for detect-mass-deletion.js — the pre-commit guard for
 * BUG-ADHD-EE8D24C8-REVERT-001 (stale working tree committed back over
 * already-fixed files after a `git update-ref` ref move).
 *
 * Unit-tests the pure `classify()` against the REAL incident's numbers (39
 * files, 630 insertions, 1399 deletions) and against legitimate-work shapes
 * that must NEVER fire. Then reconstructs the incident end-to-end in a
 * disposable real git repo under `os.tmpdir()` and drives the actual CLI
 * `main()` against `--staged` (git index) and `--range` (post-commit shape),
 * proving both the block and the `ADHD_CONFIRM_MASS_DELETE=1` escape hatch.
 *
 * Run: `node --test .githooks/detect-mass-deletion.spec.mjs`
 * (also wired into `pnpm test:build-tools` — see package.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { main, classify } = require('./detect-mass-deletion.js');

// ─── Pure classify() unit coverage ─────────────────────────────────────────

test('classify: the REAL ee8d24c8 incident shape (39 files, 630 ins, 1399 del) is flagged', () => {
  const rows = [];
  // 39 files summing to the real totals; distribution shape doesn't matter,
  // only that each file existed (deletions > 0) and the aggregate crosses
  // every threshold, matching the real commit's reported stat line.
  for (let i = 0; i < 39; i++) {
    rows.push({ file: `packages/x/file${i}.ts`, insertions: i < 10 ? Math.floor(630 / 10) : 0, deletions: Math.floor(1399 / 39), binary: false });
  }
  const v = classify(rows);
  assert.equal(v.massDeletion, true);
});

test('classify: NEGATIVE CONTROL — normal feature work (more insertions than deletions) never fires', () => {
  const rows = [
    { file: 'a.ts', insertions: 80, deletions: 5, binary: false },
    { file: 'b.ts', insertions: 40, deletions: 2, binary: false },
    { file: 'c.ts', insertions: 20, deletions: 0, binary: false },
  ];
  assert.equal(classify(rows).massDeletion, false);
});

test('classify: NEGATIVE CONTROL — a genuine, deliberate large single-file refactor stays under the file-count floor', () => {
  const rows = [{ file: 'big-generated.json', insertions: 5, deletions: 5000, binary: false }];
  assert.equal(classify(rows).massDeletion, false, 'one file, however large, is not a "mass" pattern by file count');
});

test('classify: NEGATIVE CONTROL — a real, intentional bulk delete of genuinely-obsolete files (e.g. a rm sweep) with no matching adds IS flagged (by design — must be acknowledged, not silently allowed)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ file: `dead/${i}.ts`, insertions: 0, deletions: 50, binary: false }));
  assert.equal(classify(rows).massDeletion, true, 'even an intentional bulk delete must be surfaced for explicit ack — that is the entire point of the guard');
});

test('classify: binary files never contribute phantom line counts', () => {
  const rows = [{ file: 'image.png', insertions: 0, deletions: 0, binary: true }];
  assert.equal(classify(rows).massDeletion, false);
});

test('classify: threshold boundaries are configurable', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.ts`, insertions: 0, deletions: 20, binary: false }));
  assert.equal(classify(rows, { minFiles: 6, minDeletions: 100, ratio: 1.5 }).massDeletion, true);
  assert.equal(classify(rows, { minFiles: 7, minDeletions: 100, ratio: 1.5 }).massDeletion, false, 'below the file-count floor');
});

// ─── Integration: real disposable git repo, real CLI ──────────────────────

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'mass-delete-it-'));
  sh(root, ['init', '-q']);
  sh(root, ['config', 'user.email', 'test@example.com']);
  sh(root, ['config', 'user.name', 'Test']);
  return root;
}

/** Build N files each with `linesPerFile` lines of stable, distinguishable content. */
function seedFiles(root, dir, n, linesPerFile) {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < n; i++) {
    const lines = Array.from({ length: linesPerFile }, (_, l) => `line ${l} of file ${i} — real fixed content`);
    writeFileSync(join(root, dir, `f${i}.ts`), lines.join('\n') + '\n');
  }
}

test('integration: reconstructs the incident — stale tree staged over fixed files is BLOCKED (--staged)', () => {
  const root = makeRepo();
  try {
    seedFiles(root, 'packages/x', 15, 40); // ~600 lines of "already-fixed" content
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'merge: fixed content lands on main']);

    // Simulate the ref-move-without-tree-update aftermath: every file's
    // content is replaced with much shorter "stale" content (as if the
    // working tree never actually had the merge's fixes) and staged.
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(root, 'packages/x', `f${i}.ts`), `stale line for file ${i}\n`);
    }
    sh(root, ['add', '-A']);

    const exitCode = main(['--staged'], { cwd: root, env: {} });
    assert.equal(exitCode, 1, 'must BLOCK a staged commit shaped like the real incident');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: NEGATIVE CONTROL — legitimate work (edit + a few new lines) passes --staged cleanly', () => {
  const root = makeRepo();
  try {
    seedFiles(root, 'packages/x', 5, 20);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'initial']);

    // Normal edit: touch two files, net INSERT more than delete.
    writeFileSync(join(root, 'packages/x/f0.ts'), 'line 0 of file 0 — real fixed content\nnew line added\nanother new line\n');
    sh(root, ['add', '-A']);

    const exitCode = main(['--staged'], { cwd: root, env: {} });
    assert.equal(exitCode, 0, 'legitimate incremental work must never be blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: NEGATIVE CONTROL — a normal git rebase/squash-shaped small commit passes', () => {
  const root = makeRepo();
  try {
    seedFiles(root, 'packages/x', 3, 10);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'initial']);
    unlinkSync(join(root, 'packages/x/f0.ts'));
    sh(root, ['add', '-A']);
    const exitCode = main(['--staged'], { cwd: root, env: {} });
    assert.equal(exitCode, 0, 'deleting ONE small file is nowhere near the mass-deletion shape');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: ADHD_CONFIRM_MASS_DELETE=1 is a real, working escape hatch for a genuinely-intended mass delete', () => {
  const root = makeRepo();
  try {
    seedFiles(root, 'packages/x', 15, 40);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'initial']);
    for (let i = 0; i < 15; i++) writeFileSync(join(root, 'packages/x', `f${i}.ts`), `intentionally-shortened stub ${i}\n`);
    sh(root, ['add', '-A']);

    const blocked = main(['--staged'], { cwd: root, env: {} });
    assert.equal(blocked, 1);

    const acknowledged = main(['--staged'], { cwd: root, env: { ADHD_CONFIRM_MASS_DELETE: '1' } });
    assert.equal(acknowledged, 0, 'the explicit acknowledgement must let a genuinely-intended mass delete through');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: --range mode (used by post-commit) detects the same shape between two commits', () => {
  const root = makeRepo();
  try {
    seedFiles(root, 'packages/x', 15, 40);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'merge: fixed content']);
    const base = sh(root, ['rev-parse', 'HEAD']).trim();

    for (let i = 0; i < 15; i++) writeFileSync(join(root, 'packages/x', `f${i}.ts`), `stale ${i}\n`);
    sh(root, ['add', '-A']);
    sh(root, ['commit', '-q', '-m', 'commit pre-existing in-progress work found uncommitted', '--no-verify']);
    const target = sh(root, ['rev-parse', 'HEAD']).trim();

    const exitCode = main(['--range', base, target], { cwd: root, env: {} });
    assert.equal(exitCode, 1, '--range must classify an already-made commit the same way --staged would have');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: unknown args are a hard failure (exit 2), never a silent pass', () => {
  assert.equal(main(['--bogus']), 2);
});
