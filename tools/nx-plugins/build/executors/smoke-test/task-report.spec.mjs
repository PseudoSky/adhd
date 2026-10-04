/**
 * task-report.spec.mjs — real-execution teeth tests for task-report.mjs.
 *
 * These spawn the SHIPPED report binary against a synthetic metrics.json and
 * assert the two things the item is about:
 *
 *   1. the per-package PUBLISHED vs SKIPPED partition is driven by the
 *      executor's own `outcome` field (`publish/impl.js` -> `withMetrics`
 *      persistence) — never guessed from success/network;
 *   2. the window auto-detection picks the LAST run's publish start, NOT a
 *      publish from an earlier run — the naive-global-scan bug that once
 *      picked a publish from two days earlier (see the report's own header).
 *
 * A record with no `outcome` (a failed/refused publish, or one written before
 * the field existed) must be reported UNCLASSIFIED, never folded into
 * PUBLISHED or SKIPPED.
 *
 * Run: `node --test tools/nx-plugins/build/executors/smoke-test/task-report.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = join(here, 'task-report.mjs');

/**
 * Run the shipped report against a metrics.json fixture written into a temp
 * workspace root. Returns { status, stdout, stderr }.
 */
function runReport(records, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'task-report-'));
  writeFileSync(join(root, 'metrics.json'), JSON.stringify({ records }, null, 2));
  try {
    const res = spawnSync('node', [reportPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ADHD_REPO_ROOT: root },
    });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/**
 * Fixture: an OLD run (3 days ago) whose sole record is a `publish` — this is
 * exactly what a naive "earliest publish in the whole log" scan would wrongly
 * pick. Then a RECENT run (minutes ago): a version record, then three publish
 * records covering all three outcome classes.
 */
const FIXTURE = [
  { task: 'publish', project: 'old-pkg', t: iso(3 * 86_400_000), success: true, durationMs: 1 },
  { task: 'version', project: 'pkg-a', t: iso(10 * 60_000), success: true, durationMs: 5 },
  {
    task: 'publish', project: 'pkg-a', t: iso(9 * 60_000), success: true, durationMs: 100,
    outcome: { status: 'published', name: '@adhd/pkg-a', version: '2.0.0' },
  },
  {
    task: 'publish', project: 'pkg-b', t: iso(8 * 60_000), success: true, durationMs: 50,
    outcome: { status: 'skipped-already-published', name: '@adhd/pkg-b', version: '2.0.0' },
  },
  { task: 'publish', project: 'pkg-c', t: iso(7 * 60_000), success: false, durationMs: 10 },
];

test('task-report: partitions PUBLISHED vs SKIPPED from the executor outcome, and reports an outcome-less publish UNCLASSIFIED', () => {
  const { status, stdout } = runReport(FIXTURE);
  assert.equal(status, 0, `report must exit 0 on a readable metrics file\n${stdout}`);

  assert.match(stdout, /PUBLISHED \(1\): @adhd\/pkg-a@2\.0\.0/);
  assert.match(stdout, /SKIPPED already published \(1\): @adhd\/pkg-b@2\.0\.0/);
  assert.match(stdout, /UNCLASSIFIED \(1\): pkg-c \(failed\)/);
  // The old-run publish must NOT leak into the partition — it is outside the window.
  assert.ok(!stdout.includes('old-pkg'), 'the previous run\'s publish must be excluded by the window');
});

test('task-report: --json exposes the same partition as structured data', () => {
  const { status, stdout } = runReport(FIXTURE, ['--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.publishes.published, ['@adhd/pkg-a@2.0.0']);
  assert.deepEqual(parsed.publishes.skippedAlreadyPublished, ['@adhd/pkg-b@2.0.0']);
  assert.deepEqual(parsed.publishes.unclassified, ['pkg-c (failed)']);
});

test('task-report: default window starts at the LAST run\'s publish, not the earliest publish in the whole log (naive-scan regression guard)', () => {
  const { stdout } = runReport(FIXTURE, ['--json']);
  const parsed = JSON.parse(stdout);
  // The window source names the auto-detection, and only the three publish
  // records of the last run are in it — NOT the version record that precedes
  // the publish, and NOT the 3-day-old publish a naive global scan would pick.
  assert.equal(parsed.window, 'publish start (auto, last run)');
  assert.equal(parsed.records, 3, 'exactly the three publish records of the last run are in the window');
  assert.deepEqual(
    parsed.tasks.map((t) => t.task),
    ['publish'],
    'the pre-publish version phase must be outside the default window'
  );
});

test('task-report: --all widens the window to the whole log (version phase included)', () => {
  const { stdout } = runReport(FIXTURE, ['--all']);
  assert.match(stdout, /window: whole log \(--all\)/);
  assert.match(stdout, /version/, '--all must include the pre-publish version phase the default window omits');
});

test('task-report RED-equivalent: an outcome-less publish is never counted as published or skipped', () => {
  // Simulate the pre-change world: EVERY publish record lacks `outcome`.
  // The report must put them all in UNCLASSIFIED, not guess from success.
  const preChange = [
    { task: 'publish', project: 'p1', t: iso(3 * 60_000), success: true, durationMs: 1 },
    { task: 'publish', project: 'p2', t: iso(2 * 60_000), success: true, durationMs: 1 },
  ];
  const { stdout } = runReport(preChange, ['--json']);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.publishes.published, [], 'success:true alone must NOT be read as PUBLISHED');
  assert.deepEqual(parsed.publishes.skippedAlreadyPublished, [], 'success:true alone must NOT be read as SKIPPED');
  assert.deepEqual(parsed.publishes.unclassified, ['p1', 'p2']);
});
