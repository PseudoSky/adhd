'use strict';
/**
 * file-lock.js — generic, dependency-free, cross-process mutual exclusion via
 * an atomic `O_CREAT|O_EXCL` lockfile create (`wx`) as the mutex primitive.
 * Portable (no native deps) and safe across BOTH threads and separate OS
 * processes — the exact property `nx run-many -t <target>` needs, since
 * parallel per-project tasks are typically separate processes.
 *
 * Extracted from `tools/nx-plugins/build/lib/published-state.js`'s original
 * PUBLISHED-STATE-CACHE-001 lock so every concurrency-safe local JSON store in
 * this workspace (published-state.json, and now metrics.json —
 * BUILD-TOOLING-METRICS-001) reuses ONE proven implementation instead of a
 * second hand-rolled copy. `published-state.js` re-exports this module's
 * `acquireLock`/`releaseLock` behind its own `LOCK_STALE_MS`/`LOCK_MAX_WAIT_MS`
 * constants for backward compatibility with its existing `__internals`.
 *
 * A lock older than `staleMs` is assumed abandoned (a crashed prior holder)
 * and force-broken rather than deadlocking every future writer forever.
 *
 * @module file-lock
 */
const { existsSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } = require('node:fs');

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 40;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive lock at `lockFilePath`.
 *
 * @param {string} lockFilePath
 * @param {{staleMs?: number, maxWaitMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<string>} the acquired lock's path (pass to {@link releaseLock})
 */
async function acquireLock(lockFilePath, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const fd = openSync(lockFilePath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return lockFilePath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (existsSync(lockFilePath) && Date.now() - statSync(lockFilePath).mtimeMs > staleMs) {
          unlinkSync(lockFilePath);
          continue; // retry immediately — the stale lock is gone
        }
      } catch {
        // Lock vanished between the EEXIST and this stat (another writer
        // just released it) — fall through and retry the create.
      }
      if (Date.now() > deadline) {
        throw new Error(`file-lock: could not acquire lock at ${lockFilePath} within ${maxWaitMs}ms`);
      }
      await sleep(pollMs);
    }
  }
}

/** Release a lock acquired via {@link acquireLock}. Safe to call even if the lock is already gone. */
function releaseLock(lockFilePath) {
  try {
    unlinkSync(lockFilePath);
  } catch {
    // Already gone — fine (e.g. a stale-lock break by a concurrent waiter).
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  DEFAULT_STALE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_MS,
};
