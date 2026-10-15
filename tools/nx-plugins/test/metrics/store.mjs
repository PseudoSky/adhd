/**
 * store — the durable, concurrency-safe test-metrics history (one JSON record per line).
 *
 * LOCATION. `<ADHD_TEST_TIMINGS_DIR | ~/.adhd/test-timings>/test-metrics.jsonl` (override the whole path with
 * ADHD_TEST_METRICS_FILE). It lives beside the pre-push hook's `*.log` captures, in the user's home, not in a workspace
 * root, for one reason: G5 and G7 need history across runs, and a workspace-root file is per worktree and is deleted
 * with the worktree at merge. Nothing under the home directory can be tracked, so there is nothing to gitignore; the
 * repository root `.gitignore` also lists `/test-metrics.jsonl` for the case where the path is pointed into a checkout.
 *
 * WRITES. A runner buffers its records and appends them once per run, under `lib/file-lock.js` (the cross-process
 * lock `lib/metrics.js` and `published-state.js` already use), so parallel nx tasks never interleave a batch. A write
 * failure is a warning, never an exception: recording must not break the run it observes.
 *
 * GROWTH. When the file passes MAX_BYTES it is renamed to `test-metrics.jsonl.1` (replacing the previous rotation),
 * so the store is bounded at about twice MAX_BYTES. Readers read the rotation and the live file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { acquireLock, releaseLock } = require('../../lib/file-lock.js');

export const STORE_FILE_NAME = 'test-metrics.jsonl';
export const MAX_BYTES = 64 * 1024 * 1024;
export const SCHEMA_VERSION = 1;

/** Absolute path of the store. */
export function storePath(env = process.env, home = homedir()) {
  if (env.ADHD_TEST_METRICS_FILE) return env.ADHD_TEST_METRICS_FILE;
  return join(env.ADHD_TEST_TIMINGS_DIR || join(home, '.adhd', 'test-timings'), STORE_FILE_NAME);
}

const defaultWrite = (file, text) => appendFileSync(file, text);

/**
 * Append `records` to the store as one locked batch. Never throws.
 * @param {string} file store path
 * @param {object[]} records
 * @param {{ write?: (file: string, text: string) => void | Promise<void>, lockWaitMs?: number, maxBytes?: number, warn?: (m: string) => void }} [opts]
 * @returns {Promise<{ ok: boolean, written: number, error?: string }>}
 */
export async function appendRecords(file, records, opts = {}) {
  const { write = defaultWrite, lockWaitMs = 5000, maxBytes = MAX_BYTES, warn = (m) => console.warn(m) } = opts;
  if (records.length === 0) return { ok: true, written: 0 };
  let lock = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    lock = await acquireLock(`${file}.lock`, { maxWaitMs: lockWaitMs });
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    await write(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return { ok: true, written: records.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    warn(`test-metrics: could not write ${file}: ${error}`);
    return { ok: false, written: 0, error };
  } finally {
    if (lock) releaseLock(lock);
  }
}

/**
 * Read every record (rotation first, then the live file). A missing file is empty history; a corrupt line is counted and
 * skipped, never fatal.
 * @returns {{ records: object[], corrupt: number }}
 */
export function readRecords(file) {
  const records = [];
  let corrupt = 0;
  for (const f of [`${file}.1`, file]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === 'object') records.push(rec);
        else corrupt++;
      } catch {
        corrupt++;
      }
    }
  }
  return { records, corrupt };
}
