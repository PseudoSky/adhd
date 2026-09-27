#!/usr/bin/env node
/**
 * with-dist-lock.mjs — run a command under the workspace-wide
 * `backlog-dist` cross-process lock.
 *
 * WHY THIS EXISTS (root cause it closes)
 * --------------------------------------
 * `@adhd/backlog` owns ONE shared, in-tree build output: `entrypoint/backlog/dist/`.
 * Two things touch it destructively while other processes may be reading it:
 *
 *   1. `build`'s nx cache restore. `build.outputs` is the bare directory
 *      `{projectRoot}/dist`, so nx's restore is a `remove(dir); copy(cached, dir)`
 *      SWAP. Because this workspace disables the nx daemon
 *      (`nx.json: "useDaemonProcess": false`), `TaskOrchestrator`'s
 *      `shouldCopyOutputsFromCacheBatch` has no daemon to ask "do the on-disk
 *      outputs already match?", so it ALWAYS copies — every cache HIT still
 *      removes and re-copies `dist/` (measured 2026-09-26: a pure-cache-hit
 *      `nx run backlog:build` transiently unlinked `dist/index.js`,
 *      `dist/api.ir.json`, and `dist/api.d.ts` for ~150ms).
 *   2. A real `vite build` (`emptyOutDir: true`) wipes the whole `dist/` dir.
 *
 * The `e2e` lane (`cache: false`) spawns the real `dist/index.js` and reads /
 * renames `dist/api.ir.json` and `dist/api.d.ts`. When a build (from ANY nx
 * invocation — this repo routinely runs several `nx affected -t test` at once)
 * swaps `dist/` while the lane is mid-suite, the lane dies with
 * `ENOENT dist/index.js` / `built artifact missing: dist/api.ir.json`.
 *
 * THE INVARIANT: at most one process may be inside the `dist/` critical
 * section at a time. Both writers/consumers take this one lock:
 *
 *   - `build` (uncacheable — see project.json; a cache-hittable build would do
 *     its destructive restore OUTSIDE this wrapper, so it MUST run the command
 *     every time for the lock to cover it);
 *   - `e2e` (holds the lock for the whole lane, since it reads `dist/`
 *     throughout).
 *
 * This is a deliberate, NARROW serialization: a single `nx affected -t test`
 * has zero added wall-clock (build and e2e are already ordered by
 * `e2e.dependsOn: ["build"]` and never contend with themselves); the lock only
 * bites when two invocations would otherwise corrupt each other's `dist/`,
 * which is exactly when correctness requires one to wait.
 *
 * Reuses the workspace's canonical mutex primitive,
 * `tools/nx-plugins/lib/file-lock.js` (atomic `O_CREAT|O_EXCL` lockfile).
 *
 * USAGE:  node with-dist-lock.mjs <cmd> [args...]
 *   e.g.  node with-dist-lock.mjs sh -c "vite build && node dist/index.js ir-artifact --out dist/api.ir.json"
 *         node with-dist-lock.mjs vitest run --config entrypoint/backlog/vitest.e2e.config.ts
 *
 * The child inherits stdio and this process's exit code. The lock is released
 * on normal exit and on SIGINT/SIGTERM. A crashed holder's lock is force-broken
 * after STALE_MS (see below) so a dead run can never deadlock the gate forever.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // entrypoint/backlog/tools
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const require = createRequire(import.meta.url);
const { acquireLock, releaseLock } = require(
  join(REPO_ROOT, 'tools', 'nx-plugins', 'lib', 'file-lock.js')
);

const LOCK_DIR = join(REPO_ROOT, '.adhd', 'tmp');
const LOCK_PATH = join(LOCK_DIR, 'backlog-dist.lock');

// The `e2e` lane takes ~4.5-5 min normally; 15 min is a generous 3x so a
// legitimately slow holder is never force-broken, while a crashed holder is
// cleared well within any human's patience. A waiter blocks up to 45 min
// (enough for a short queue of concurrent gate runs) before failing loudly.
const STALE_MS = 15 * 60_000;
const MAX_WAIT_MS = 45 * 60_000;
const POLL_MS = 250;

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('with-dist-lock: no command given');
  process.exit(2);
}
const [cmd, ...args] = argv;

mkdirSync(LOCK_DIR, { recursive: true });

let lock;
try {
  lock = await acquireLock(LOCK_PATH, {
    staleMs: STALE_MS,
    maxWaitMs: MAX_WAIT_MS,
    pollMs: POLL_MS,
  });
} catch (err) {
  console.error(`with-dist-lock: ${err.message}`);
  process.exit(1);
}

let released = false;
function release() {
  if (released) return;
  released = true;
  releaseLock(lock);
}

const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
const forward = (sig) => {
  try {
    child.kill(sig);
  } catch {
    /* child already gone */
  }
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('error', (err) => {
  console.error(`with-dist-lock: failed to spawn "${cmd}": ${err.message}`);
  release();
  process.exit(1);
});
child.on('exit', (code) => {
  release();
  process.exit(code ?? 1);
});
