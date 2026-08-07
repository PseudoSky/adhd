/**
 * Teeth tests for file-lock.js — the generic mutex extracted from
 * lib/published-state.js (BUILD-TOOLING-METRICS-001) so lib/metrics.js
 * reuses the exact same proven primitive.
 *
 * Run: node --test tools/nx-plugins/lib/file-lock.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { acquireLock, releaseLock } = require('./file-lock.js');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'file-lock-'));
}

test('acquireLock + releaseLock round-trip: lock file exists while held, gone after release', async () => {
  const root = makeRoot();
  const lp = join(root, '.x.lock');
  try {
    const acquired = await acquireLock(lp);
    assert.equal(acquired, lp);
    assert.equal(existsSync(lp), true);
    releaseLock(lp);
    assert.equal(existsSync(lp), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseLock on an already-gone lock is a silent no-op, never throws', () => {
  const root = makeRoot();
  try {
    assert.doesNotThrow(() => releaseLock(join(root, 'never-existed.lock')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second acquirer blocks until the first releases', async () => {
  const root = makeRoot();
  const lp = join(root, '.x.lock');
  try {
    const first = await acquireLock(lp);
    let secondAcquired = false;
    const secondPromise = acquireLock(lp, { pollMs: 5 }).then((p) => {
      secondAcquired = true;
      return p;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(secondAcquired, false, 'must still be waiting while the first holder has not released');
    releaseLock(first);
    const second = await secondPromise;
    assert.equal(secondAcquired, true);
    releaseLock(second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale lock (older than staleMs) is broken rather than deadlocking forever', async () => {
  const root = makeRoot();
  const lp = join(root, '.x.lock');
  try {
    writeFileSync(lp, '99999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);
    const acquired = await acquireLock(lp, { staleMs: 1000, maxWaitMs: 2000, pollMs: 5 });
    assert.equal(acquired, lp);
    releaseLock(acquired);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh (non-stale) contended lock times out per maxWaitMs rather than hanging forever', async () => {
  const root = makeRoot();
  const lp = join(root, '.x.lock');
  try {
    const holder = await acquireLock(lp);
    await assert.rejects(
      () => acquireLock(lp, { staleMs: 60_000, maxWaitMs: 100, pollMs: 10 }),
      /could not acquire lock/
    );
    releaseLock(holder);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('N parallel acquirers each get exclusive access in turn — no double-acquire', async () => {
  const root = makeRoot();
  const lp = join(root, '.x.lock');
  try {
    let holders = 0;
    let maxConcurrentHolders = 0;
    const N = 20;
    const work = Array.from({ length: N }, async () => {
      const p = await acquireLock(lp, { pollMs: 5 });
      holders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, holders);
      await new Promise((r) => setTimeout(r, 5));
      holders -= 1;
      releaseLock(p);
    });
    await Promise.all(work);
    assert.equal(maxConcurrentHolders, 1, 'exactly one holder must ever be inside the critical section at a time');
    assert.equal(existsSync(lp), false, 'no lock file left behind after every acquirer finishes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
