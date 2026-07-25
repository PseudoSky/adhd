import os from 'node:os';

/**
 * Shared vitest thread-pool cap (DEBT-TEST-CPU-OVERSUBSCRIBED-001).
 *
 * Vitest's default pool (`'threads'`) sizes itself to `os.cpus().length`
 * worker threads PER PROJECT it runs `test` for. Nx runs several projects'
 * `test` targets concurrently (`nx.json` `parallel`), so N concurrently
 * running projects each spinning up to `os.cpus().length` threads
 * oversubscribes the machine by up to Nx over — measured directly on this
 * repo: `nx test backlog` alone already averages ~207% CPU (234.74s user +
 * 52.24s sys over 138.35s wall, via `/usr/bin/time -l`), and that project
 * already pins itself to a single fork (`pool: 'forks'`, `fileParallelism:
 * false`); projects left on vitest's unbounded default are the ones that
 * can multiply this across a concurrent `nx affected -t test` run.
 *
 * Capping each project's own pool keeps the aggregate bounded to a sane
 * multiple of core count regardless of how many projects Nx runs at once,
 * without touching `nx.json`'s `parallel` setting (owned elsewhere).
 */
const cores = os.cpus().length;

/** Per-project worker-thread ceiling. Floor of 2 so small-core CI boxes still
 * get real parallelism within one project; capped at 4 so a handful of
 * concurrently-run projects can't collectively exceed a typical dev/CI
 * machine's core count by more than ~2-3x. */
export const maxTestThreads = Math.max(2, Math.min(4, Math.ceil(cores / 3)));

/** Spread into a vitest `test` config's `poolOptions` (for projects using the
 * default `'threads'` pool). Projects that opt into `pool: 'forks'` set
 * their own `fileParallelism`/`maxForks` and are unaffected by this. */
export const vitestPoolOptions = {
  threads: { maxThreads: maxTestThreads, minThreads: 1 },
};
