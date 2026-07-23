/**
 * Teeth tests for lib/metrics.js — the centralized, generalized per-task-run
 * performance-metrics facility (BUILD-TOOLING-METRICS-001).
 *
 * Run: node --test tools/nx-plugins/lib/metrics.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  metricsPath,
  lockPath,
  readMetrics,
  appendMetricRecord,
  MetricsRecorder,
  withMetrics,
  __internals,
} = require('./metrics.js');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'metrics-'));
}

// ---------------------------------------------------------------------------
// readMetrics / appendMetricRecord — basic I/O
// ---------------------------------------------------------------------------

test('readMetrics: missing file -> empty records, never throws', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(readMetrics(root), { records: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readMetrics: corrupt JSON -> empty records, never throws', () => {
  const root = makeRoot();
  try {
    writeFileSync(metricsPath(root), '{ not valid json');
    assert.deepEqual(readMetrics(root), { records: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readMetrics: object without a records array -> treated as empty (defensive)', () => {
  const root = makeRoot();
  try {
    writeFileSync(metricsPath(root), '{"foo":1}');
    assert.deepEqual(readMetrics(root), { records: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appendMetricRecord: single append round-trips', async () => {
  const root = makeRoot();
  try {
    await appendMetricRecord(root, { task: 'x', durationMs: 1 });
    const { records } = readMetrics(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appendMetricRecord never leaves a temp file behind on success', async () => {
  const root = makeRoot();
  try {
    await appendMetricRecord(root, { task: 'x' });
    const { readdirSync } = require('node:fs');
    const leftovers = readdirSync(root).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(lockPath(root)), false, 'no lock file left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MAX_RECORDS bound: the log never grows past MAX_RECORDS and always keeps the most recent records', async () => {
  const root = makeRoot();
  try {
    const total = __internals.MAX_RECORDS + 5;
    for (let i = 0; i < total; i++) {
      await appendMetricRecord(root, { task: `run-${i}` });
    }
    const { records } = readMetrics(root);
    // A single crossing trims to MAX_RECORDS_KEEP and then grows again by the
    // remaining appends until the NEXT crossing — so the length right after
    // one crossing is MAX_RECORDS_KEEP + (appends since), never MAX_RECORDS+1.
    assert.ok(records.length <= __internals.MAX_RECORDS, `must never exceed MAX_RECORDS (got ${records.length})`);
    assert.ok(records.length >= __internals.MAX_RECORDS_KEEP, `must retain at least MAX_RECORDS_KEEP (got ${records.length})`);
    assert.equal(records[records.length - 1].task, `run-${total - 1}`, 'must keep the MOST RECENT record at the tail');
    assert.equal(records[0].task, `run-${total - records.length}`, 'the retained window must be a contiguous, most-recent suffix');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CONCURRENCY-SAFE writes — teeth test + negative control
// ---------------------------------------------------------------------------

test('appendMetricRecord: N parallel writers (simulating parallel nx run-many tasks) — NO lost updates', async () => {
  const root = makeRoot();
  try {
    const N = 30;
    const writers = Array.from({ length: N }, (_, i) => appendMetricRecord(root, { task: `pkg-${i}`, i }));
    await Promise.all(writers);
    const { records } = readMetrics(root);
    assert.equal(records.length, N, `expected all ${N} concurrent appends to land — lost updates would show up as a smaller count`);
    const seen = new Set(records.map((r) => r.i));
    for (let i = 0; i < N; i++) {
      assert.ok(seen.has(i), `pkg-${i}'s own record must be present`);
    }
    assert.equal(existsSync(lockPath(root)), false, 'no lock file left behind after every writer finishes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEGATIVE CONTROL: the SAME N-parallel-writer workload, done WITHOUT the lock (naive read-modify-write), DOES lose updates', async () => {
  // Proves the locking in appendMetricRecord is actually load-bearing — not
  // that 30 tiny concurrent writes just happen to never race on this machine.
  const root = makeRoot();
  const p = metricsPath(root);
  try {
    writeFileSync(p, JSON.stringify({ records: [] }));
    const naiveAppend = async (record) => {
      // Deliberately UNSYNCHRONIZED: read, mutate, write — with a real await
      // gap in between so concurrent callers interleave, exactly what
      // appendMetricRecord's lock exists to prevent.
      const current = JSON.parse(readFileSync(p, 'utf8'));
      await new Promise((r) => setTimeout(r, 1));
      current.records.push(record);
      writeFileSync(p, JSON.stringify(current));
    };
    const N = 30;
    await Promise.all(Array.from({ length: N }, (_, i) => naiveAppend({ task: `pkg-${i}`, i })));
    const { records } = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(
      records.length < N,
      `negative control must demonstrate LOST updates without a lock (got ${records.length}/${N} — if this ever equals ${N}, the race no longer reproduces on this machine/Node version and the control needs a wider interleaving window, not removal)`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MetricsRecorder — recording primitives
// ---------------------------------------------------------------------------

test('MetricsRecorder.phase: accumulates elapsed time since the last checkpoint under the given name', async () => {
  const rec = new MetricsRecorder('t', { projectName: 'p' });
  await new Promise((r) => setTimeout(r, 5));
  rec.phase('a');
  await new Promise((r) => setTimeout(r, 5));
  rec.phase('b');
  await new Promise((r) => setTimeout(r, 5));
  rec.phase('a'); // accumulates into the same key
  assert.ok(rec.phases.a > 0);
  assert.ok(rec.phases.b > 0);
  // 'a' now holds two accumulated intervals, so it should be roughly >= a single interval.
  assert.ok(rec.phases.a >= rec.phases.b * 0.5);
});

test('MetricsRecorder.subprocess: counts + sums ms, broken down by command', () => {
  const rec = new MetricsRecorder('t', {});
  rec.subprocess('git log', 5);
  rec.subprocess('git log', 3);
  rec.subprocess('npm view foo', 20);
  assert.equal(rec.subprocessCount, 3);
  assert.equal(rec.subprocessMs, 28);
  assert.equal(rec.subprocessByCommand['git log'].count, 2);
  assert.equal(rec.subprocessByCommand['git log'].ms, 8);
  assert.equal(rec.subprocessByCommand['npm view foo'].count, 1);
});

test('MetricsRecorder.time: bracket-times a sync fn and returns its result', () => {
  const rec = new MetricsRecorder('t', {});
  const result = rec.time('cmd', () => 42);
  assert.equal(result, 42);
  assert.equal(rec.subprocessCount, 1);
  assert.ok(rec.subprocessByCommand.cmd.ms >= 0);
});

test('MetricsRecorder.time: still records even when fn throws, then rethrows', () => {
  const rec = new MetricsRecorder('t', {});
  assert.throws(() => rec.time('boom', () => { throw new Error('nope'); }), /nope/);
  assert.equal(rec.subprocessCount, 1);
});

test('MetricsRecorder.timeAsync: bracket-times an async fn and returns its resolved value', async () => {
  const rec = new MetricsRecorder('t', {});
  const result = await rec.timeAsync('cmd', async () => {
    await new Promise((r) => setTimeout(r, 2));
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(rec.subprocessCount, 1);
});

test('MetricsRecorder.network: counts calls and records labels', () => {
  const rec = new MetricsRecorder('t', {});
  rec.network('npm view versions');
  rec.network('npm view dist.integrity');
  assert.equal(rec.networkCount, 2);
  assert.deepEqual(rec.networkCalls, ['npm view versions', 'npm view dist.integrity']);
});

test('MetricsRecorder.toRecord: shape matches the documented schema', () => {
  const rec = new MetricsRecorder('version', { projectName: '@adhd/pkg-b' });
  rec.phase('read');
  rec.subprocess('git log', 4);
  rec.network('npm view');
  const record = rec.toRecord(true, 123.456);
  assert.equal(record.task, 'version');
  assert.equal(record.project, '@adhd/pkg-b');
  assert.equal(record.success, true);
  assert.equal(record.durationMs, 123.46);
  assert.ok(typeof record.t === 'string' && !Number.isNaN(Date.parse(record.t)));
  assert.ok('read' in record.phases);
  assert.equal(record.subprocess.count, 1);
  assert.equal(record.subprocess.byCommand['git log'].count, 1);
  assert.equal(record.network.count, 1);
});

// ---------------------------------------------------------------------------
// withMetrics — the public wrapping API
// ---------------------------------------------------------------------------

test('withMetrics: runs fn, returns its result, and appends exactly one record', async () => {
  const root = makeRoot();
  try {
    const result = await withMetrics('version', { root, projectName: '@adhd/x' }, async (rec) => {
      rec.phase('work');
      return { success: true, extra: 'value' };
    });
    assert.deepEqual(result, { success: true, extra: 'value' });
    const { records } = readMetrics(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, 'version');
    assert.equal(records[0].project, '@adhd/x');
    assert.equal(records[0].success, true);
    assert.ok(records[0].durationMs >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: success=false when the returned result has success:false, without throwing', async () => {
  const root = makeRoot();
  try {
    const result = await withMetrics('version', { root }, async () => ({ success: false }));
    assert.equal(result.success, false);
    const { records } = readMetrics(root);
    assert.equal(records[0].success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: a thrown error is recorded as success:false and RETHROWN (never swallowed)', async () => {
  const root = makeRoot();
  try {
    await assert.rejects(
      () => withMetrics('version', { root }, async () => { throw new Error('task exploded'); }),
      /task exploded/
    );
    const { records } = readMetrics(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: a result without a `success` field defaults to success:true (non-executor callers)', async () => {
  const root = makeRoot();
  try {
    await withMetrics('dist-manifest', { root }, async () => 'no success field');
    const { records } = readMetrics(root);
    assert.equal(records[0].success, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: ADHD_NX_METRICS=0 disables recording but still runs fn and returns its result', async () => {
  const root = makeRoot();
  const prev = process.env.ADHD_NX_METRICS;
  try {
    process.env.ADHD_NX_METRICS = '0';
    const result = await withMetrics('version', { root }, async () => ({ success: true }));
    assert.equal(result.success, true);
    assert.equal(existsSync(metricsPath(root)), false, 'no metrics.json must be written when disabled');
  } finally {
    if (prev === undefined) delete process.env.ADHD_NX_METRICS;
    else process.env.ADHD_NX_METRICS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: N parallel task-runs (simulating nx run-many across projects) each land their OWN record with no cross-contamination', async () => {
  const root = makeRoot();
  try {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withMetrics('version', { root, projectName: `@adhd/pkg-${i}` }, async (rec) => {
          rec.subprocess(`git log --pkg-${i}`, 1);
          return { success: true };
        })
      )
    );
    const { records } = readMetrics(root);
    assert.equal(records.length, N);
    const projects = new Set(records.map((r) => r.project));
    for (let i = 0; i < N; i++) assert.ok(projects.has(`@adhd/pkg-${i}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: a metrics-write failure (unwritable root) never breaks the real task — result still returns', async () => {
  const badRoot = join(tmpdir(), 'metrics-does-not-exist-' + Math.random().toString(36).slice(2), 'nested', 'deeper');
  // badRoot's parent directories deliberately do not exist, so appendMetricRecord's
  // writeFileSync will fail (ENOENT) — withMetrics must swallow that, not the task.
  const result = await withMetrics('version', { root: badRoot }, async () => ({ success: true }));
  assert.equal(result.success, true, 'the real task result must still come through even if metrics recording fails');
});

// ---------------------------------------------------------------------------
// Overhead — the facility itself must be cheap
// ---------------------------------------------------------------------------

test('withMetrics overhead: 100 sequential no-op invocations complete fast (facility itself is not a bottleneck)', async () => {
  const root = makeRoot();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      await withMetrics('version', { root, projectName: `@adhd/pkg-${i}` }, async (rec) => {
        rec.phase('noop');
        return { success: true };
      });
    }
    const elapsed = Date.now() - t0;
    // Generous ceiling (local disk lock+JSON read/write x100) — this is a
    // regression guard against the facility itself becoming the bottleneck
    // it's supposed to be measuring, not a tight perf assertion.
    assert.ok(elapsed < 3000, `100 withMetrics calls took ${elapsed}ms — the facility itself must stay cheap`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
