/**
 * BUG-039 / humanId allocation must be atomic, and must survive the upgrade.
 *
 * The old allocator was a read-max-then-write: every `create` scanned the
 * family for the highest ordinal and took `max + 1`. Two writers on separate
 * connections read the same max from their own WAL snapshot and both mint it.
 * No amount of retrying, `.immediate()` escalation, or process-level locking
 * fixes a read-modify-write that reads stale — the only fix is to stop
 * reading, which is what the `backlog_humanid_counter` row does.
 *
 * Two things are proven here, and they are different:
 *
 *  1. CONCURRENCY — two genuinely separate OS processes, the real built
 *     `dist/`, one shared store, no serve lock, released together from a file
 *     barrier so they allocate from identical initial state. Ground truth is
 *     read back out of the store, not trusted from the writers' reports.
 *
 *  2. THE UPGRADE PATH — a store that already holds items but has NO counter
 *     row yet. That is the exact state of the real production store (1300+
 *     items, counter introduced after them). If the seed did not land at
 *     `max + 1` the first create would mint a colliding id, the partial unique
 *     index would reject the insert, and — because the counter bump shares the
 *     transaction — the rollback would re-mint the SAME id on every retry.
 *     This test is what proves those existing items survive without migration.
 *
 * The cross-process writer is written to a temp dir by this file at run time,
 * so this suite owns every file it touches and needs no external fixture.
 *
 * NEGATIVE CONTROL (verified 2026-08-27): restoring the pre-counter scan-based
 * `ids.ts` and rebuilding turns this suite RED. It stays green only while
 * allocation is a single atomic counter bump.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PKG_DIR = resolve(__dirname, '..', '..');
const DIST = join(PKG_DIR, 'dist', 'index.js');

const WRITERS = 2;
const PER_WRITER = 40;
const FAMILY = 'BUG-COUNTER';

const root = mkdtempSync(join(tmpdir(), 'backlog-counter-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real separate-process writer: opens the SAME store via the built dist
 *  (no serve lock), reports ready, blocks on the GO barrier, then creates N
 *  items. The barrier is what makes both writers allocate from the identical
 *  initial state, which is what exposes a read-max-then-write race. */
const WRITER_SRC = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openGraphBacklogStore, buildBacklogEnv, createItem, closeGraphBacklogStore } = require(process.env.REPRO_DIST);
const [dbPath, tag, n, family] = process.argv.slice(2);
const N = Number(n);
const root = process.env.REPRO_ROOT;
(async () => {
  const env = buildBacklogEnv({ adhdRoot: root });
  const store = await openGraphBacklogStore(dbPath, 5000);
  const ctx = { store, env };
  fs.writeFileSync(path.join(root, 'ready-' + tag), 'ready');
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(path.join(root, 'GO'))) {
    if (Date.now() > deadline) throw new Error(tag + ': GO barrier never appeared');
    await new Promise((r) => setTimeout(r, 10));
  }
  let ok = 0, rejected = 0, threw = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await createItem(ctx, { family, title: tag + '-' + i, body: 'x', repo: 'repro' });
      if (r && r.ok === false) rejected += 1; else ok += 1;
    } catch (e) { threw += 1; if (threw <= 1) console.error(tag + ' threw:', String((e && e.message) || e).slice(0, 160)); }
  }
  await closeGraphBacklogStore(store);
  console.log(JSON.stringify({ tag, ok, rejected, threw }));
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
`;

function distEnv(extra: Record<string, string> = {}) {
  return { ...process.env, REPRO_DIST: DIST, REPRO_ROOT: root, ...extra };
}

/** Read every live humanId for a family straight out of the store file. */
function readIds(dbPath: string, family: string): string[] {
  const script = `
    const { openGraphBacklogStore, closeGraphBacklogStore } = require(process.env.REPRO_DIST);
    (async () => {
      const store = await openGraphBacklogStore(process.env.REPRO_DB, 5000);
      const { rows } = await store.adapter.executeAll(
        "SELECT json_extract(meta,'$.humanId') AS h FROM node WHERE json_extract(meta,'$.humanId') LIKE ? AND t_invalid IS NULL",
        [process.env.REPRO_FAMILY + '-%']
      );
      await closeGraphBacklogStore(store);
      console.log(JSON.stringify(rows.map((r) => r.h)));
    })();
  `;
  const out = execFileSync('node', ['-e', script], {
    env: distEnv({ REPRO_DB: dbPath, REPRO_FAMILY: family }),
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop() as string);
}

describe('humanId allocation', () => {
  it('mints exactly one distinct id per create across two concurrent processes', async () => {
    expect(existsSync(DIST), `built dist missing at ${DIST} — build backlog first`).toBe(true);
    const dbPath = join(root, 'concurrent.db');
    const writerPath = join(root, 'writer.cjs');
    writeFileSync(writerPath, WRITER_SRC);

    const procs = Array.from({ length: WRITERS }, (_, i) =>
      new Promise<void>((res, rej) => {
        const p = spawn('node', [writerPath, dbPath, `w${i}`, String(PER_WRITER), FAMILY], {
          env: distEnv(),
          stdio: 'inherit',
        });
        p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`writer w${i} exited ${code}`))));
        p.on('error', rej);
      })
    );

    const deadline = Date.now() + 60_000;
    while (readdirSync(root).filter((f) => f.startsWith('ready-')).length < WRITERS) {
      if (Date.now() > deadline) throw new Error('writers never reported ready');
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(join(root, 'GO'), 'go');
    await Promise.all(procs);

    const ids = readIds(dbPath, FAMILY);
    expect(new Set(ids).size, 'duplicate humanIds — the allocator gave two processes the same ordinal').toBe(ids.length);
    expect(ids.length, `expected ${WRITERS * PER_WRITER} items, got ${ids.length} — writes were lost`).toBe(WRITERS * PER_WRITER);
  }, 180_000);

  it('seeds the counter from existing items when a populated store has no counter row', () => {
    // The production-upgrade path: items already exist, the counter table does
    // not. Dropping the counter row after seeding reproduces that state exactly.
    const dbPath = join(root, 'seed.db');
    const script = `
      const { openGraphBacklogStore, buildBacklogEnv, createItem, closeGraphBacklogStore } = require(process.env.REPRO_DIST);
      (async () => {
        const env = buildBacklogEnv({ adhdRoot: process.env.REPRO_ROOT });
        const store = await openGraphBacklogStore(process.env.REPRO_DB, 5000);
        const ctx = { store, env };
        const mk = async (i) => (await createItem(ctx, { family: 'BUG-SEED', title: 't' + i, body: 'b', repo: 'repro' }));
        await mk(1); await mk(2); await mk(3);
        // Forget the counter entirely — this is a store with items and no counter.
        await store.adapter.executeRun('DELETE FROM backlog_humanid_counter');
        const fourth = await mk(4);
        await closeGraphBacklogStore(store);
        console.log(JSON.stringify({ fourth: (fourth && (fourth.item ? fourth.item.humanId : fourth.humanId)) || null }));
      })().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
    `;
    const out = execFileSync('node', ['-e', script], {
      env: distEnv({ REPRO_DB: dbPath }),
      encoding: 'utf8',
    });
    const { fourth } = JSON.parse(out.trim().split('\n').pop() as string);

    // Had the seed restarted at 1, this would be BUG-SEED-001 — a collision the
    // unique index rejects, rolling back the counter bump with it and making
    // every retry re-mint the same id.
    expect(fourth, 'counter did not seed from the existing items — an upgraded store would re-mint taken ids').toBe('BUG-SEED-004');

    const ids = readIds(dbPath, 'BUG-SEED');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4);
  }, 120_000);
});
