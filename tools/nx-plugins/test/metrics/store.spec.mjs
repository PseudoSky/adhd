/**
 * store.spec.mjs: the test-metrics store: where it lives, that one locked batch per run never loses a record under
 * concurrent writers, that a failing write is a warning and never an exception, and that growth is bounded.
 *
 * guards: two parallel runners overwrite each other's records, or a failed write breaks the test run it observes.
 * tier: S (injected writers, a private temporary directory, no subprocess).
 * cites: 595965cc T36.AC1 (the history a repeat-run reports from), T37.AC2 (the history a duration report reads).
 * teeth: red 2026-10-15: `node --test store.spec.mjs` -> exit 1 (5 !== 60 lost records) while appendRecords did not await its writer;
 *   with the lock bypassed 2 cases fail, with appendRecords rethrowing 3 cases fail (authorship was not separated).
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { appendRecords, readRecords, storePath, STORE_FILE_NAME } from './store.mjs';

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-metrics-store-'));
  file = join(dir, STORE_FILE_NAME);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('storePath', () => {
  it('defaults to the pre-push timings directory under the home directory', () => {
    assert.equal(storePath({}, '/h'), '/h/.adhd/test-timings/test-metrics.jsonl');
  });
  it('honors ADHD_TEST_TIMINGS_DIR, and ADHD_TEST_METRICS_FILE outranks it', () => {
    assert.equal(storePath({ ADHD_TEST_TIMINGS_DIR: '/t' }, '/h'), '/t/test-metrics.jsonl');
    assert.equal(storePath({ ADHD_TEST_TIMINGS_DIR: '/t', ADHD_TEST_METRICS_FILE: '/x/y.jsonl' }, '/h'), '/x/y.jsonl');
  });
});

describe('appendRecords and readRecords', () => {
  it('writes one JSON object per line and reads them back in order', async () => {
    const r = await appendRecords(file, [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(r, { ok: true, written: 2 });
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n');
    assert.deepEqual(readRecords(file).records, [{ a: 1 }, { a: 2 }]);
    assert.equal(existsSync(`${file}.lock`), false, 'the lock is released');
  });

  it('reads a missing store as empty history and counts, never throws on, a corrupt line', () => {
    assert.deepEqual(readRecords(file), { records: [], corrupt: 0 });
    writeFileSync(file, '{"a":1}\nnot json\n\n5\n{"a":3}\n');
    const { records, corrupt } = readRecords(file);
    assert.deepEqual(records, [{ a: 1 }, { a: 3 }]);
    assert.equal(corrupt, 2, 'a non-JSON line and a JSON line that is not a record');
  });

  it('never throws when the store cannot be written: it warns, reports ok false and leaves no lock', async () => {
    writeFileSync(join(dir, 'a-file'), 'x');
    const unwritable = join(dir, 'a-file', 'sub', STORE_FILE_NAME); // a directory cannot be created under a regular file
    const warnings = [];
    const r = await appendRecords(unwritable, [{ a: 1 }], { warn: (m) => warnings.push(m) });
    assert.equal(r.ok, false);
    assert.equal(r.written, 0);
    assert.match(warnings.join('\n'), /test-metrics: could not write/);
  });

  it('never throws when the lock cannot be taken in time', async () => {
    writeFileSync(`${file}.lock`, String(process.pid)); // a fresh lock held by someone else
    const warnings = [];
    const r = await appendRecords(file, [{ a: 1 }], { lockWaitMs: 60, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, false);
    assert.match(warnings.join('\n'), /could not acquire lock/);
    assert.equal(existsSync(file), false, 'nothing was written without the lock');
  });

  it('never throws when the injected writer throws, and releases the lock', async () => {
    const r = await appendRecords(file, [{ a: 1 }], { write: () => { throw new Error('disk full'); }, warn: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'disk full');
    assert.equal(existsSync(`${file}.lock`), false);
  });

  it('an empty batch writes nothing', async () => {
    assert.deepEqual(await appendRecords(file, []), { ok: true, written: 0 });
    assert.equal(existsSync(file), false);
  });
});

describe('concurrent writers', () => {
  // A deliberately non-atomic read-modify-write with a real await gap: the shape of write that loses data when two
  // writers interleave. The lock must serialize it; without the lock the same workload loses records.
  const racyWrite = async (f, text) => {
    const current = existsSync(f) ? readFileSync(f, 'utf8') : '';
    await new Promise((r) => setTimeout(r, 2));
    writeFileSync(f, current + text);
  };
  const N = 12;
  const PER = 5;
  const batch = (i) => Array.from({ length: PER }, (_, j) => ({ writer: i, n: j }));

  it('N parallel batches all land, whole, when each goes through the lock', async () => {
    const results = await Promise.all(Array.from({ length: N }, (_, i) => appendRecords(file, batch(i), { write: racyWrite })));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const { records, corrupt } = readRecords(file);
    assert.equal(corrupt, 0);
    assert.equal(records.length, N * PER, 'a lost update would show as a smaller count');
    for (let i = 0; i < N; i++) assert.equal(records.filter((r) => r.writer === i).length, PER, `writer ${i}'s batch is whole`);
    assert.equal(existsSync(`${file}.lock`), false);
  });

  it('NEGATIVE CONTROL: the same workload without the lock loses records, so the lock is what protects them', async () => {
    await Promise.all(Array.from({ length: N }, (_, i) => racyWrite(file, batch(i).map((r) => `${JSON.stringify(r)}\n`).join(''))));
    assert.ok(readRecords(file).records.length < N * PER, 'the race must reproduce without the lock; if this ever equals the full count, widen the gap rather than delete the control');
  });
});

describe('growth bound', () => {
  it('rotates past maxBytes into <store>.1 and keeps reading both', async () => {
    await appendRecords(file, [{ gen: 1, pad: 'x'.repeat(200) }]);
    await appendRecords(file, [{ gen: 2 }], { maxBytes: 100 });
    assert.equal(existsSync(`${file}.1`), true, 'the full file was rotated');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gen: 2 }, 'the live file starts over');
    assert.deepEqual(readRecords(file).records.map((r) => r.gen), [1, 2]);
    appendFileSync(file, '');
  });

  it('does not rotate a small file', async () => {
    await appendRecords(file, [{ gen: 1 }]);
    await appendRecords(file, [{ gen: 2 }]);
    assert.equal(existsSync(`${file}.1`), false);
  });
});
