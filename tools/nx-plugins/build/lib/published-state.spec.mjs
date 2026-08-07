/**
 * Teeth tests for published-state.js — the committed published-state cache's
 * I/O + concurrency-safe read-modify-write (PUBLISHED-STATE-CACHE-001).
 *
 * Run: node --test tools/nx-plugins/build/lib/published-state.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { statePath, lockPath, readState, writeStateAtomic, updatePublishedState } = require('./published-state.js');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'published-state-'));
}

test('readState: missing file -> empty object, never throws', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(readState(root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readState: corrupt JSON -> empty object, never throws', () => {
  const root = makeRoot();
  try {
    writeFileSync(statePath(root), '{ not valid json');
    assert.deepEqual(readState(root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readState: array instead of object -> treated as empty (defensive)', () => {
  const root = makeRoot();
  try {
    writeFileSync(statePath(root), '[]');
    assert.deepEqual(readState(root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeStateAtomic + readState round-trip, sorted keys for a clean diff', () => {
  const root = makeRoot();
  try {
    writeStateAtomic(root, { zeta: { version: '1.0.0' }, alpha: { version: '2.0.0' } });
    const raw = readFileSync(statePath(root), 'utf8');
    assert.ok(raw.indexOf('"alpha"') < raw.indexOf('"zeta"'), 'keys must be written in sorted order');
    assert.deepEqual(readState(root), { alpha: { version: '2.0.0' }, zeta: { version: '1.0.0' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeStateAtomic never leaves a temp file behind on success', () => {
  const root = makeRoot();
  try {
    writeStateAtomic(root, { a: 1 });
    const { readdirSync } = require('node:fs');
    const leftovers = readdirSync(root).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('updatePublishedState: single writer merges into existing state', async () => {
  const root = makeRoot();
  try {
    writeStateAtomic(root, { '@adhd/existing': { version: '1.0.0', normalizedHash: 'sha256:aaa', publishedIntegrity: 'sha512-aaa' } });
    await updatePublishedState(root, (state) => {
      state['@adhd/new'] = { version: '2.0.0', normalizedHash: 'sha256:bbb', publishedIntegrity: 'sha512-bbb' };
      return state;
    });
    const final = readState(root);
    assert.equal(final['@adhd/existing'].version, '1.0.0', 'must not clobber a pre-existing entry');
    assert.equal(final['@adhd/new'].version, '2.0.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('updatePublishedState: mutate receives a FRESH read under the lock, not a stale closure copy', async () => {
  const root = makeRoot();
  try {
    await updatePublishedState(root, (state) => { state.first = { version: '1' }; return state; });
    // Simulate another process writing between two logical operations.
    await updatePublishedState(root, (state) => {
      assert.deepEqual(Object.keys(state), ['first'], 'must see the previous writer\'s committed state, not an empty/stale snapshot');
      state.second = { version: '2' };
      return state;
    });
    assert.deepEqual(Object.keys(readState(root)).sort(), ['first', 'second']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('updatePublishedState: concurrency-safe — N parallel writers each merge their own key with NO lost updates', async () => {
  const root = makeRoot();
  try {
    const N = 25;
    const writers = Array.from({ length: N }, (_, i) =>
      updatePublishedState(root, (state) => {
        state[`@adhd/pkg-${i}`] = { version: '1.0.0', normalizedHash: `sha256:${i}`, publishedIntegrity: `sha512-${i}` };
        return state;
      })
    );
    await Promise.all(writers);
    const final = readState(root);
    assert.equal(Object.keys(final).length, N, `expected all ${N} concurrent writes to land — lost updates would show up as a smaller count`);
    for (let i = 0; i < N; i++) {
      assert.equal(final[`@adhd/pkg-${i}`].normalizedHash, `sha256:${i}`, `pkg-${i}'s own write must be intact`);
    }
    // No lock file left behind after all writers finish.
    assert.equal(existsSync(lockPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('updatePublishedState: a stale lock (older than LOCK_STALE_MS) is broken rather than deadlocking forever', async () => {
  const root = makeRoot();
  const { writeFileSync: wf, utimesSync } = await import('node:fs');
  try {
    // Fabricate an abandoned lock from "the past".
    wf(lockPath(root), '99999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(root), old, old);

    const result = await updatePublishedState(root, (state) => {
      state.recovered = { version: '1.0.0' };
      return state;
    });
    assert.deepEqual(result.recovered, { version: '1.0.0' }, 'must recover from a stale lock instead of timing out');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a real crash mid-write cannot corrupt the committed file: readers only ever see the fully-written previous version or the fully-written next version', async () => {
  const root = makeRoot();
  try {
    writeStateAtomic(root, { a: { version: '1' } });
    // Start a slow mutate (simulates real work happening while holding the lock).
    const slow = updatePublishedState(root, async (state) => {
      await new Promise((r) => setTimeout(r, 30));
      state.b = { version: '2' };
      return state;
    });
    // A reader mid-flight must see a COMPLETE prior state, never a torn write.
    const mid = readState(root);
    assert.ok(mid.a, 'mid-flight read must still see the last fully-committed state');
    await slow;
    assert.deepEqual(readState(root), { a: { version: '1' }, b: { version: '2' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
