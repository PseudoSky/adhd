'use strict';
/**
 * published-state.js — I/O + concurrency-safe read-modify-write for the
 * COMMITTED published-state cache (PUBLISHED-STATE-CACHE-001).
 *
 * `<workspaceRoot>/published-state.json` is the "published-reference": a
 * source-controlled snapshot of what's actually on npm for every publishable
 * package, keyed by npm package name —
 *
 *   { "<pkgName>": { "version": "x.y.z", "normalizedHash": "sha256:…", "publishedIntegrity": "sha512-…" } }
 *
 * - `version` — the last version this cache KNOWS is on the registry.
 * - `normalizedHash` — `compare-published.js`'s `normalizedHash()` of the
 *   PUBLISHED content at that version (computed once, at backfill/publish
 *   time — see `reconcile-core.js` and `executors/publish/impl.js`).
 * - `publishedIntegrity` — the packument's own `dist.integrity` (sha512) for
 *   that version, used by `reconcile-core.js`'s integrity gate to skip a
 *   tarball pull when a fresh local pack already matches what's published.
 *
 * `version`/`sync-deps`/`publish`'s existence-check all read this file to
 * make a zero-network decision; `reconcile` and `publish`'s write-through are
 * the only writers. See `tools/nx-plugins/build/README.md` for the full
 * design and `tools/nx-plugins/build/executors/version/impl.js` for the
 * cache-miss backfill fallback.
 *
 * Concurrency (the lockfile/atomic-write read-modify-write below) is backed
 * by `tools/nx-plugins/lib/file-lock.js`'s generic, dependency-free mutex —
 * extracted (BUILD-TOOLING-METRICS-001) so `lib/metrics.js`'s concurrent
 * `metrics.json` writers reuse the EXACT same proven primitive instead of a
 * second hand-rolled lock implementation.
 *
 * @module published-state
 */
const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { acquireLock, releaseLock } = require('../../lib/file-lock');

const FILE_NAME = 'published-state.json';

/** How long an on-disk lock file is trusted before being treated as abandoned
 * (a crashed holder) and force-broken, so the cache can never deadlock forever. */
const LOCK_STALE_MS = 30_000;
/** How long a writer will retry acquiring the lock before giving up. */
const LOCK_MAX_WAIT_MS = 30_000;
const LOCK_POLL_MS = 40;

function statePath(root) {
  return join(root, FILE_NAME);
}

function lockPath(root) {
  return join(root, `.${FILE_NAME}.lock`);
}

/** Stable key order so a re-write of unchanged data produces a clean, empty `git diff`. */
function sortEntries(state) {
  const out = {};
  for (const k of Object.keys(state).sort()) out[k] = state[k];
  return out;
}

/**
 * Read the cache. A missing or corrupt file is treated as an empty cache —
 * never throws, so a fresh clone (no `published-state.json` yet) or a
 * partially-written file (extremely unlikely given the atomic write below,
 * but not impossible if something external truncated it) degrades to
 * "everything is a cache miss", not a hard failure.
 *
 * @param {string} root workspace root
 * @returns {Record<string, {version:string, normalizedHash:string, publishedIntegrity:string}>}
 */
function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Write-then-rename — atomic on the same filesystem, so a reader never observes a partial write. */
function writeStateAtomic(root, state) {
  const p = statePath(root);
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(sortEntries(state), null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * Acquire an exclusive lock on the cache file — a thin, `published-state`-scoped
 * wrapper over `lib/file-lock.js`'s generic `acquireLock`, parameterized with
 * this module's own stale/wait/poll constants (unchanged behavior from before
 * the BUILD-TOOLING-METRICS-001 extraction).
 *
 * @param {string} root
 * @returns {Promise<string>} the acquired lock's path (pass to {@link releaseLock})
 */
async function acquireStateLock(root) {
  return acquireLock(lockPath(root), {
    staleMs: LOCK_STALE_MS,
    maxWaitMs: LOCK_MAX_WAIT_MS,
    pollMs: LOCK_POLL_MS,
  });
}

/**
 * Concurrency-safe read-modify-write. `mutate(current)` receives the state
 * freshly read UNDER the lock (a fresh copy — safe to mutate in place or
 * return a new object) and returns the next state to persist. Guarantees no
 * lost updates across parallel writers — e.g. every per-project `publish`
 * task spawned by `nx run-many -t publish` serializes through this same
 * exclusive lockfile, so package A's write-through can never clobber package
 * B's concurrently-in-flight write.
 *
 * @param {string} root workspace root
 * @param {(current: Record<string, any>) => (Record<string, any> | Promise<Record<string, any>>)} mutate
 * @returns {Promise<Record<string, any>>} the state that was written
 */
async function updatePublishedState(root, mutate) {
  const lockFilePath = await acquireStateLock(root);
  try {
    const current = readState(root);
    const next = await mutate({ ...current });
    writeStateAtomic(root, next);
    return next;
  } finally {
    releaseLock(lockFilePath);
  }
}

module.exports = {
  FILE_NAME,
  statePath,
  lockPath,
  readState,
  writeStateAtomic,
  updatePublishedState,
  __internals: { acquireLock: acquireStateLock, releaseLock, sortEntries, LOCK_STALE_MS, LOCK_MAX_WAIT_MS },
};
