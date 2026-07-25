'use strict';
/**
 * metrics.js — centralized, generalized per-task-run performance recording
 * for every custom `@adhd/nx-build` / `@adhd/nx-deps` / `@adhd/nx-assets`
 * executor (BUILD-TOOLING-METRICS-001).
 *
 * ONE instrumentation pattern (`withMetrics`), reused by every executor —
 * never copy-pasted per executor. Each executor's `run(options, context)`
 * wraps its real work in `withMetrics(taskName, context, async (rec) => {
 * ...; return { success }; })`; `withMetrics` measures total wall time and
 * appends one JSON record per invocation to the gitignored, workspace-root
 * `metrics.json` — a LOCAL perf log, never source-controlled (unlike the
 * committed `published-state.json`).
 *
 * Recorded per run: task name, project, total duration, named sub-phase
 * timings (`rec.phase(name)` — checkpoint since the last phase mark),
 * subprocess spawn count + cumulative wall-time broken down BY COMMAND
 * (`rec.subprocess(cmd, ms)` — caller measures elapsed time around whatever
 * it just ran and reports it; see `rec.time`/`rec.timeAsync` below for a
 * zero-boilerplate bracket-timing helper), and network-call count
 * (`rec.network(label)`).
 *
 * CONCURRENCY: `nx run-many -t <target>` fans a target out across every
 * matching project, each potentially a SEPARATE OS process. Appending to the
 * single shared `metrics.json` reuses `lib/file-lock.js` — the exact
 * lockfile/atomic-write primitive `lib/published-state.js` already uses for
 * `published-state.json` — so parallel writers can never lose one another's
 * record (see `metrics.spec.mjs`'s concurrency proof).
 *
 * OVERHEAD: `withMetrics` itself does O(1) `performance.now()` calls plus one
 * lock-guarded read-modify-write of a small JSON file per task invocation —
 * see `metrics.spec.mjs`'s own-overhead measurement. A metrics-write failure
 * (e.g. a read-only filesystem) is swallowed with a warning — recording
 * perf data must never break the real task it's instrumenting.
 *
 * @module metrics
 */
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { acquireLock, releaseLock } = require('./file-lock');

const FILE_NAME = 'metrics.json';
/** Bound long-term growth of the local perf log: once a run's record count
 * exceeds this, the file is truncated to the most recent {@link MAX_RECORDS_KEEP}
 * — a profiling log, not an audit trail, so unbounded growth (and the
 * per-append JSON re-parse cost that comes with it) serves no one. */
const MAX_RECORDS = 5000;
const MAX_RECORDS_KEEP = 2000;

/** Default `ADHD_NX_METRICS_MAX_CPU_PCT` — generous enough that a task using
 * a couple of cores' worth of in-process parallelism (e.g. worker_threads)
 * doesn't false-trip, but tight enough to catch a genuinely runaway task. */
const DEFAULT_MAX_CPU_PCT = 300;

function metricsPath(root) {
  return join(root, FILE_NAME);
}
function lockPath(root) {
  return join(root, `.${FILE_NAME}.lock`);
}

/**
 * Read the current metrics log. A missing or corrupt file degrades to an
 * empty log — never throws (this is a perf log, not a source of truth).
 *
 * @param {string} root workspace root
 * @returns {{records: object[]}}
 */
function readMetrics(root) {
  const p = metricsPath(root);
  if (!existsSync(p)) return { records: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && Array.isArray(parsed.records) ? parsed : { records: [] };
  } catch {
    return { records: [] };
  }
}

/** Write-then-rename — atomic on the same filesystem, so a reader never observes a partial write. */
function writeMetricsAtomic(root, data) {
  const p = metricsPath(root);
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(data) + '\n');
  renameSync(tmp, p);
}

/**
 * Concurrency-safe append of one record to the shared `metrics.json`.
 *
 * @param {string} root workspace root
 * @param {object} record
 */
async function appendMetricRecord(root, record) {
  const lockFilePath = await acquireLock(lockPath(root), {});
  try {
    const current = readMetrics(root);
    current.records.push(record);
    if (current.records.length > MAX_RECORDS) {
      current.records = current.records.slice(current.records.length - MAX_RECORDS_KEEP);
    }
    writeMetricsAtomic(root, current);
  } finally {
    releaseLock(lockFilePath);
  }
}

function round(ms) {
  return Math.round(ms * 100) / 100;
}

/**
 * Per-invocation recorder handed to an executor's `withMetrics` callback.
 * Every method is a cheap, synchronous, in-memory accumulate — the only I/O
 * happens once, in `withMetrics`'s own `finally`, via {@link appendMetricRecord}.
 */
class MetricsRecorder {
  /**
   * @param {string} taskName
   * @param {{projectName?: string}} [context]
   */
  constructor(taskName, context) {
    this.taskName = taskName;
    this.project = (context && context.projectName) || null;
    this._start = performance.now();
    this._lastCheckpoint = this._start;
    this._cpuUsageStart = process.cpuUsage();
    this.cpuPercent = 0;
    this.phases = {};
    this.subprocessCount = 0;
    this.subprocessMs = 0;
    this.subprocessByCommand = {};
    this.networkCount = 0;
    this.networkCalls = [];
  }

  /**
   * Mark a named sub-phase boundary: records elapsed time since the LAST
   * checkpoint (the previous `phase()` call, or the recorder's construction)
   * under `name`. Calling `phase()` with the same `name` more than once in a
   * single run accumulates (useful for a phase that recurs in a loop).
   *
   * @param {string} name
   * @returns {number} the elapsed ms just recorded
   */
  phase(name) {
    const now = performance.now();
    const ms = now - this._lastCheckpoint;
    this.phases[name] = round((this.phases[name] || 0) + ms);
    this._lastCheckpoint = now;
    return ms;
  }

  /**
   * Manually record a subprocess invocation the caller already measured
   * itself (e.g. bracketing an existing `spawnSync`/`execFileSync` call with
   * `performance.now()` before/after). `cmd` should identify WHAT ran (the
   * full command line, or a short stable label) — it becomes the
   * `subprocess.byCommand` breakdown key.
   *
   * @param {string} cmd
   * @param {number} ms
   */
  subprocess(cmd, ms) {
    this.subprocessCount += 1;
    this.subprocessMs += ms;
    const key = String(cmd);
    if (!this.subprocessByCommand[key]) this.subprocessByCommand[key] = { count: 0, ms: 0 };
    this.subprocessByCommand[key].count += 1;
    this.subprocessByCommand[key].ms += ms;
  }

  /**
   * Bracket-time a synchronous function call and record it as a subprocess.
   * Zero-boilerplate alternative to manually bracketing with `performance.now()`.
   *
   * @template T
   * @param {string} cmd label for the `subprocess.byCommand` breakdown
   * @param {() => T} fn
   * @returns {T}
   */
  time(cmd, fn) {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.subprocess(cmd, performance.now() - t0);
    }
  }

  /** Async form of {@link time} — bracket-times a Promise-returning call. */
  async timeAsync(cmd, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.subprocess(cmd, performance.now() - t0);
    }
  }

  /**
   * Record a network call (no timing required — the point is COUNTING
   * network round-trips, e.g. to prove a "zero-network happy path" claim).
   *
   * @param {string} [label]
   */
  network(label = 'network') {
    this.networkCount += 1;
    this.networkCalls.push(label);
  }

  /**
   * Measure this task's own CPU consumption (`process.cpuUsage()` delta
   * since construction) as a percentage of the given wall-clock duration.
   * Self-process only — see the CPU GUARD note on {@link withMetrics}.
   *
   * @param {number} wallMs elapsed wall-clock ms since construction
   * @returns {number} CPU percent (can exceed 100 across multiple threads/cores)
   */
  measureCpuPercent(wallMs) {
    const delta = process.cpuUsage(this._cpuUsageStart);
    const cpuMs = (delta.user + delta.system) / 1000;
    this.cpuPercent = wallMs > 0 ? round((cpuMs / wallMs) * 100) : 0;
    return this.cpuPercent;
  }

  /** @param {boolean} success @param {number} durationMs @returns {object} */
  toRecord(success, durationMs) {
    for (const key of Object.keys(this.subprocessByCommand)) {
      this.subprocessByCommand[key].ms = round(this.subprocessByCommand[key].ms);
    }
    return {
      task: this.taskName,
      project: this.project,
      t: new Date().toISOString(),
      success,
      durationMs: round(durationMs),
      cpuPercent: this.cpuPercent,
      phases: this.phases,
      subprocess: {
        count: this.subprocessCount,
        totalMs: round(this.subprocessMs),
        byCommand: this.subprocessByCommand,
      },
      network: { count: this.networkCount, calls: this.networkCalls },
    };
  }
}

/**
 * Resolve the configured CPU-guard threshold from `ADHD_NX_METRICS_MAX_CPU_PCT`.
 * Falls back to {@link DEFAULT_MAX_CPU_PCT} when unset or non-numeric.
 * `0` (or any value `<= 0`) means "disabled".
 *
 * @returns {number}
 */
function getMaxCpuPercent() {
  const raw = process.env.ADHD_NX_METRICS_MAX_CPU_PCT;
  if (raw === undefined || raw === '') return DEFAULT_MAX_CPU_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_CPU_PCT;
}

/**
 * Check a measured CPU percentage against the configured guard and either
 * throw (default `error` mode) or `console.warn` (`ADHD_NX_METRICS_CPU_MODE=warn`)
 * when it's tripped. A no-op when the guard is disabled (`maxPct <= 0`) or
 * the measurement is within budget.
 *
 * @param {string} taskName
 * @param {{projectName?: string}} [context]
 * @param {number} cpuPercent
 * @throws {Error} when tripped and mode is not `warn`
 */
function checkCpuGuard(taskName, context, cpuPercent) {
  const maxPct = getMaxCpuPercent();
  if (maxPct <= 0 || cpuPercent <= maxPct) return;
  const project = context && context.projectName ? ` (${context.projectName})` : '';
  const message = `metrics: CPU guard tripped for task "${taskName}"${project}: measured ${cpuPercent.toFixed(1)}% CPU, exceeds ADHD_NX_METRICS_MAX_CPU_PCT=${maxPct}%`;
  const mode = (process.env.ADHD_NX_METRICS_CPU_MODE || 'error').toLowerCase();
  if (mode === 'warn') {
    console.warn(message);
    return;
  }
  throw new Error(message);
}

/**
 * Wrap an executor's real work with metrics recording.
 *
 * `fn(rec)` receives a fresh {@link MetricsRecorder} and must return (or
 * resolve to) the executor's normal result (`{success: boolean}`). Success is
 * inferred from that result's `.success` field when present, else from
 * whether `fn` threw.
 *
 * Set `ADHD_NX_METRICS=0` to disable recording entirely (still runs `fn`
 * normally — a pure escape hatch, never required for correctness).
 *
 * CPU GUARD (FEAT-NXMETRICS-CPU-GUARD-001): `withMetrics` also measures the
 * task's own CPU consumption — `process.cpuUsage()` delta over the task's
 * wall-clock duration, expressed as a percentage (can exceed 100% when the
 * task uses multiple threads/cores, e.g. `worker_threads`). This is
 * IN-PROCESS CPU only: a task that mostly blocks on a spawned subprocess
 * (`execFileSync`/`spawnSync`) shows near-0% here even if the child is
 * pegging a core, because the OS accounts a child's CPU separately from the
 * waiting parent — there is no portable, dependency-free way to reliably
 * read a child's rusage across macOS/Linux, so that case is intentionally
 * out of scope for this guard (in-process CPU-heavy work like `secret-scan`
 * is the target). When the measured percentage exceeds
 * `ADHD_NX_METRICS_MAX_CPU_PCT` (default {@link DEFAULT_MAX_CPU_PCT}), the
 * task FAILS by default — `withMetrics` throws, naming the task, project,
 * measured %, and threshold. Set `ADHD_NX_METRICS_MAX_CPU_PCT=0` to disable
 * the guard entirely, or `ADHD_NX_METRICS_CPU_MODE=warn` to downgrade a trip
 * to a `console.warn` instead of a failure. The guard runs independently of
 * `ADHD_NX_METRICS` (recording can be off while the guard stays on).
 *
 * @template T
 * @param {string} taskName
 * @param {{root: string, projectName?: string}} context nx executor context
 * @param {(rec: MetricsRecorder) => (T | Promise<T>)} fn
 * @returns {Promise<T>}
 */
async function withMetrics(taskName, context, fn) {
  const disabled = process.env.ADHD_NX_METRICS === '0';
  const rec = new MetricsRecorder(taskName, context);
  const overallStart = performance.now();
  let success = true;
  try {
    const result = await fn(rec);
    success = result && typeof result === 'object' && 'success' in result ? !!result.success : true;
    rec.measureCpuPercent(performance.now() - overallStart);
    // The guard runs even when ADHD_NX_METRICS=0 disables recording — it's
    // a correctness check on the task, not part of the perf log.
    checkCpuGuard(taskName, context, rec.cpuPercent);
    return result;
  } catch (err) {
    success = false;
    // A guard trip (or the real task's own throw) both land here; either
    // way record the CPU reading we have so far before rethrowing.
    rec.measureCpuPercent(performance.now() - overallStart);
    throw err;
  } finally {
    if (!disabled) {
      const durationMs = performance.now() - overallStart;
      try {
        await appendMetricRecord(context.root, rec.toRecord(success, durationMs));
      } catch (err) {
        // Metrics must never break the real task it's instrumenting.
        console.error(`metrics: failed to write ${FILE_NAME}: ${err && err.message}`);
      }
    }
  }
}

module.exports = {
  FILE_NAME,
  DEFAULT_MAX_CPU_PCT,
  metricsPath,
  lockPath,
  readMetrics,
  writeMetricsAtomic,
  appendMetricRecord,
  MetricsRecorder,
  getMaxCpuPercent,
  checkCpuGuard,
  withMetrics,
  __internals: { MAX_RECORDS, MAX_RECORDS_KEEP, round, DEFAULT_MAX_CPU_PCT },
};
