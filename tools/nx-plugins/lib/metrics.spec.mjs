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
import { performance } from 'node:perf_hooks';

// The CPU guard is DISABLED by default (`ADHD_NX_METRICS_MAX_CPU_PCT` defaults
// to 0), so `withMetrics` never trips it here unless a test opts in. Tests in
// the "CPU GUARD" block below that exercise tripping behavior set a finite
// threshold explicitly via `withEnv(...)`.

const require = createRequire(import.meta.url);
const {
  metricsPath,
  lockPath,
  readMetrics,
  appendMetricRecord,
  MetricsRecorder,
  getMaxCpuPercent,
  checkCpuGuard,
  withMetrics,
  __internals,
} = require('./metrics.js');

/** Synchronous, deterministic CPU-bound loop — no timers/sleeps, so the
 * elapsed CPU time it produces is real, not an artifact of scheduling. */
function busyLoopMs(ms) {
  const end = Date.now() + ms;
  let x = 1;
  while (Date.now() < end) x = Math.sqrt(x) + 1;
  return x;
}

/** Run `fn` with the given env vars set, restoring the previous values (or
 * absence) afterward — used by the CPU-guard tests below. */
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'metrics-'));
}

/**
 * Stub `process.cpuUsage()` so a test's measured CPU-time delta is a FULLY
 * CONTROLLED, fake value rather than a real measurement of real machine load
 * — used by the CPU-guard tests below (flaky-CPU-guard-under-load fix).
 *
 * Real short-burst `process.cpuUsage()` deltas are legitimately noisy on a
 * loaded, shared dev/CI machine (observed 320%-550% for a 30ms busy loop
 * across repeated runs, vs. the intended few-percent-to-tens-of-percent
 * range) — asserting the GUARD's pass/fail LOGIC against that noise makes
 * the test flaky, not the guard wrong. Injecting a deterministic
 * `process.cpuUsage()` delta proves the exact same logic — "does measured %
 * cross the threshold?" — without depending on what else the machine is
 * doing for its CPU-time half. (Wall-clock is left REAL and un-mocked — see
 * each call site: they either pass an explicit `wallMs` straight to
 * `measureCpuPercent()`, or rely on a real `setTimeout` floor, so the
 * fake-vs-real-clock arithmetic never has to line up with `withMetrics`'s
 * own internal `performance.now()` call sequence.)
 *
 * @param {{cpuUserMs?: number, cpuSystemMs?: number}} opts ms of fake CPU time
 *   the NEXT `process.cpuUsage(prev)` delta call reports (the construction-time
 *   baseline call always reports zero).
 * @param {() => any} fn
 */
async function withFakeCpuUsage({ cpuUserMs = 0, cpuSystemMs = 0 } = {}, fn) {
  const origCpuUsage = process.cpuUsage;
  process.cpuUsage = (prev) => {
    if (prev === undefined) return { user: 0, system: 0 };
    return { user: Math.round(cpuUserMs * 1000), system: Math.round(cpuSystemMs * 1000) };
  };
  try {
    return await fn();
  } finally {
    process.cpuUsage = origCpuUsage;
  }
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
  assert.equal('outcome' in record, false, 'no `outcome` field unless the executor supplied one — base schema unchanged');
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

test('withMetrics: a result.outcome is persisted on the record (executor-sourced PUBLISHED vs SKIPPED)', async () => {
  const root = makeRoot();
  try {
    const outcome = { status: 'skipped-already-published', name: '@adhd/pkg-b', version: '1.0.0' };
    const result = await withMetrics('publish', { root, projectName: 'pkg-b' }, async () => ({ success: true, outcome }));
    assert.deepEqual(result, { success: true, outcome }, 'withMetrics must return the result UNCHANGED');
    const { records } = readMetrics(root);
    assert.deepEqual(records[0].outcome, outcome, 'the executor outcome must be persisted on the metrics record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics: a result with no `outcome` adds no outcome field (base schema unchanged)', async () => {
  const root = makeRoot();
  try {
    await withMetrics('version', { root }, async () => ({ success: true }));
    const { records } = readMetrics(root);
    assert.equal('outcome' in records[0], false);
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

// ---------------------------------------------------------------------------
// CPU GUARD (FEAT-NXMETRICS-CPU-GUARD-001)
// ---------------------------------------------------------------------------

test('getMaxCpuPercent: defaults to DEFAULT_MAX_CPU_PCT when unset', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: undefined }, () => {
    assert.equal(getMaxCpuPercent(), __internals.DEFAULT_MAX_CPU_PCT);
  });
});

test('getMaxCpuPercent: honors an explicit override', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '42' }, () => {
    assert.equal(getMaxCpuPercent(), 42);
  });
});

test('getMaxCpuPercent: non-numeric override falls back to the default rather than disabling silently', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: 'not-a-number' }, () => {
    assert.equal(getMaxCpuPercent(), __internals.DEFAULT_MAX_CPU_PCT);
  });
});

test('checkCpuGuard: throws naming the task, project, measured %, and threshold when tripped', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '50', ADHD_NX_METRICS_CPU_MODE: undefined }, () => {
    assert.throws(
      () => checkCpuGuard('secret-scan', { projectName: '@adhd/x' }, 187.3),
      (err) =>
        /secret-scan/.test(err.message) &&
        /@adhd\/x/.test(err.message) &&
        /187\.3/.test(err.message) &&
        /50/.test(err.message)
    );
  });
});

test('checkCpuGuard: does not throw when the measurement is within budget', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '300' }, () => {
    assert.doesNotThrow(() => checkCpuGuard('secret-scan', {}, 90));
  });
});

test('checkCpuGuard: exactly at the threshold does not trip (strictly-greater-than semantics)', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '100' }, () => {
    assert.doesNotThrow(() => checkCpuGuard('t', {}, 100));
  });
});

test('checkCpuGuard: ADHD_NX_METRICS_MAX_CPU_PCT=0 disables the guard entirely', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '0' }, () => {
    assert.doesNotThrow(() => checkCpuGuard('t', {}, 999999));
  });
});

test('checkCpuGuard: the DEFAULT (no env) is DISABLED — a measurement above the old 300% cap does not throw', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: undefined }, () => {
    assert.equal(__internals.DEFAULT_MAX_CPU_PCT, 0, 'the compiled-in default must be the disabled sentinel');
    assert.doesNotThrow(() => checkCpuGuard('runaway', { projectName: '@adhd/x' }, 395.1));
  });
});

test('checkCpuGuard: a negative threshold is also treated as disabled', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '-1' }, () => {
    assert.doesNotThrow(() => checkCpuGuard('runaway', {}, 999999));
  });
});

test('checkCpuGuard: ADHD_NX_METRICS_CPU_MODE=warn downgrades a trip to console.warn, never throws', async () => {
  await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '10', ADHD_NX_METRICS_CPU_MODE: 'warn' }, () => {
    const calls = [];
    const origWarn = console.warn;
    console.warn = (msg) => calls.push(msg);
    try {
      assert.doesNotThrow(() => checkCpuGuard('t', {}, 500));
      assert.equal(calls.length, 1);
      assert.ok(/CPU guard tripped/.test(calls[0]));
    } finally {
      console.warn = origWarn;
    }
  });
});

test('MetricsRecorder.measureCpuPercent: reflects the process.cpuUsage() delta as a % of wall-clock (mocked — deterministic regardless of machine load)', async () => {
  // 60ms of (fake) CPU over a 100ms (fake) wall-clock window == 60%: well
  // within "meaningfully non-zero" and "not wildly over one core", proving
  // the percentage MATH is correct without depending on real scheduler noise.
  await withFakeCpuUsage({ cpuUserMs: 60 }, () => {
    const rec = new MetricsRecorder('t', {});
    const pct = rec.measureCpuPercent(100);
    assert.equal(pct, 60, `60ms CPU / 100ms wall should be exactly 60%, got ${pct}`);
  });
});

test('MetricsRecorder.measureCpuPercent: an idle task shows near-zero CPU% (mocked — deterministic regardless of machine load)', async () => {
  // 1ms of (fake) CPU over a 100ms (fake) wall-clock window == 1%.
  await withFakeCpuUsage({ cpuUserMs: 1 }, () => {
    const rec = new MetricsRecorder('t', {});
    const pct = rec.measureCpuPercent(100);
    assert.ok(pct < 20, `idle wait should show near-zero CPU%, got ${pct}`);
  });
});

test('withMetrics + CPU GUARD teeth test: a busy-loop task TRIPS the guard under a low threshold and FAILS (throws)', async () => {
  const root = makeRoot();
  try {
    await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '1' }, async () => {
      await assert.rejects(
        () =>
          withMetrics('busy-task', { root, projectName: '@adhd/busy' }, async () => {
            busyLoopMs(30);
            return { success: true };
          }),
        /CPU guard tripped for task "busy-task" \(@adhd\/busy\)/
      );
    });
    // The trip is recorded too: success:false with the offending cpuPercent captured.
    const { records } = readMetrics(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].success, false);
    assert.ok(records[0].cpuPercent > 1, 'the recorded cpuPercent must be the one that tripped the guard');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics + CPU GUARD negative control: a low-CPU task PASSES at the default (guard disabled) (mocked CPU — deterministic regardless of machine load)', async () => {
  const root = makeRoot();
  try {
    // At the default `ADHD_NX_METRICS_MAX_CPU_PCT=0` the guard is disabled, so
    // any measurement passes. Mock a tiny fixed CPU-time delta and give the
    // task a real `setTimeout` wall-clock floor so the recorded cpuPercent is
    // low and independent of what else the machine is doing.
    await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: undefined }, async () => {
      await withFakeCpuUsage({ cpuUserMs: 1 }, async () => {
        const result = await withMetrics('busy-task', { root, projectName: '@adhd/busy' }, async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { success: true };
        });
        assert.equal(result.success, true);
      });
    });
    const { records } = readMetrics(root);
    assert.equal(records[0].success, true);
    assert.ok(records[0].cpuPercent < 20, `expected a low mocked cpuPercent, got ${records[0].cpuPercent}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics + CPU GUARD: at the DEFAULT (guard disabled, no env) a task measuring far above the old 300% cap still SUCCEEDS (mocked CPU — deterministic)', async () => {
  const root = makeRoot();
  try {
    // The compiled-in default guard is OFF (`ADHD_NX_METRICS_MAX_CPU_PCT=0`),
    // so a task whose measured CPU wildly exceeds the old 300% cap must not
    // trip. Mock a huge fixed CPU-time delta over a real `setTimeout`
    // wall-clock floor so the recorded cpuPercent is far above 300%
    // regardless of machine load (1e6ms fake CPU / any wall < ~5.5min => >300%).
    await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: undefined }, async () => {
      await withFakeCpuUsage({ cpuUserMs: 1e6 }, async () => {
        const result = await withMetrics('runaway', { root, projectName: '@adhd/busy' }, async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { success: true };
        });
        assert.equal(result.success, true);
      });
    });
    const { records } = readMetrics(root);
    assert.equal(records[0].success, true);
    assert.ok(records[0].cpuPercent > 300, `expected a measured cpuPercent above the old 300% cap, got ${records[0].cpuPercent}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics + CPU GUARD: a normal (non-CPU-bound) task never trips, even measured (mocked CPU — deterministic regardless of machine load)', async () => {
  const root = makeRoot();
  try {
    // Same reasoning as the negative-control test above: mock a tiny fixed
    // CPU-time delta and rely on a real setTimeout floor for the wall-clock
    // half, so the computed % is bounded regardless of real machine load.
    const result = await withFakeCpuUsage({ cpuUserMs: 1 }, () =>
      withMetrics('sync-deps', { root }, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { success: true };
      })
    );
    assert.equal(result.success, true);
    const { records } = readMetrics(root);
    assert.ok(records[0].cpuPercent < 50, `idle task should record low cpuPercent, got ${records[0].cpuPercent}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics + CPU GUARD: the guard runs even when ADHD_NX_METRICS=0 disables recording', async () => {
  const root = makeRoot();
  try {
    await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '1', ADHD_NX_METRICS: '0' }, async () => {
      await assert.rejects(
        () =>
          withMetrics('busy-task', { root }, async () => {
            busyLoopMs(30);
            return { success: true };
          }),
        /CPU guard tripped/
      );
    });
    assert.equal(existsSync(metricsPath(root)), false, 'recording stays off; the guard is independent of it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withMetrics + CPU GUARD: a thrown task error is NOT masked by the guard — original error wins', async () => {
  const root = makeRoot();
  try {
    await withEnv({ ADHD_NX_METRICS_MAX_CPU_PCT: '1' }, async () => {
      await assert.rejects(
        () =>
          withMetrics('busy-task', { root }, async () => {
            busyLoopMs(30);
            throw new Error('the real task failed');
          }),
        /the real task failed/
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
