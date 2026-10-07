import os from 'node:os';

/**
 * Shared vitest worker-pool cap + timeout defaults (DEBT-TEST-CPU-OVERSUSCRIBED-001).
 *
 * Vitest's default pool sizes itself to `os.cpus().length` workers PER PROJECT it
 * runs `test` for. Nx runs several projects' `test` targets concurrently
 * (`nx.json` `parallel`), so N concurrently running projects each spinning up to
 * `os.cpus().length` workers oversubscribes the machine by up to Nx over —
 * measured directly on this repo: `nx test backlog` alone already averages ~207%
 * CPU (234.74s user + 52.24s sys over 138.35s wall, via `/usr/bin/time -l`), and
 * that project already pins itself to a single fork (`pool: 'forks'`,
 * `fileParallelism: false`); projects left on vitest's unbounded default are the
 * ones that can multiply this across a concurrent `nx affected -t test` run.
 *
 * Capping each project's own pool keeps the aggregate bounded to a sane multiple
 * of core count regardless of how many projects Nx runs at once, without touching
 * `nx.json`'s `parallel` setting (owned elsewhere).
 *
 * VITEST 4: `test.poolOptions` was removed; `maxThreads`/`minThreads` were
 * consolidated into a single top-level `maxWorkers`. This module therefore
 * exports a top-level `test` fragment (spread into each project's `test` block)
 * rather than the old `poolOptions` object — the previous shape was silently
 * ignored under Vitest 4, which is what let the oversubscription back in and
 * pushed heavy real-pipeline suites past the 5s default timeout.
 */
const cores = os.cpus().length;

/** Per-project worker ceiling. Floor of 2 so small-core CI boxes still get real
 * parallelism within one project; capped at 4 so a handful of concurrently-run
 * projects can't collectively exceed a typical dev/CI machine's core count by
 * more than ~2-3x. */
export const maxTestThreads = Math.max(2, Math.min(4, Math.ceil(cores / 3)));

/** Spread into a vitest `test` config for projects using the default pool.
 * Projects that opt into `pool: 'forks'` set their own `fileParallelism`/`maxForks`
 * and are unaffected by the worker cap (but still inherit the timeout). */
export const vitestTestDefaults = {
  maxWorkers: maxTestThreads,
  // Pool settings are MEASURED, not guessed (cache-dag item 6; per-package A/B,
  // interleaved runs, exit codes of every run, see docs/PIPELINE.md §4 and the
  // cache-dag report). `forks` (vitest 4's own default, pinned so a config can't
  // drift) beat `threads` by 10-20% on data-query-engine, apigen-core-client and
  // apigen-engine-runtime, and `vmThreads`/`vmForks` were slower still (and
  // failed on apigen-engine-runtime and backlog). `poolOptions` /
  // `vmMemoryLimit` are deliberately absent: Vitest 4 removed `poolOptions`
  // (silently ignored), and `vmMemoryLimit` only applies to the vm pools, which
  // lose. File parallelism is on (vitest's default) with per-file isolation kept
  // ON: dropping isolation (`vitestNoIsolateDefaults`) was <= ~10% and within
  // noise on 2 of 3 libraries, so it is opt-in per package, never the default.
  pool: 'forks',
  fileParallelism: true,
  logHeapUsage: false,
  // Heavy suites (real TypeScript program builds, real JVM/Python spawns) run
  // well past Vitest's 5s default under Vitest 4's slower collection path;
  // they are deterministic, just slow, so give them headroom rather than
  // flaking on wall-clock.
  testTimeout: 30_000,
};

/**
 * Opt-in for pure-logic / ts-morph libraries whose test files share no mutable
 * module state: skips per-file module-graph re-evaluation (`isolate: false`).
 * Measured win: apigen-engine-runtime 5.03s -> 4.50s median (5 interleaved runs,
 * all exit 0, 218/218 passing). NEVER use it for a package with native addons
 * (better-sqlite3, @tursodatabase/database): the same flag made backlog fail
 * under file parallelism.
 */
export const vitestNoIsolateDefaults = { ...vitestTestDefaults, isolate: false };
