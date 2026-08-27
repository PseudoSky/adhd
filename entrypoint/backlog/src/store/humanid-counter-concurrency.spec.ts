/**
 * BUG-039 / DEBT-BACKLOG-MONOTONIC-HUMANID-001 — the allocator must not lose
 * writes across PROCESSES.
 *
 * The old allocator was a read-max-then-write: every `create` scanned the
 * family for the highest ordinal and took `max + 1`. Two writers on separate
 * connections can read the same max from their own WAL snapshot, so both mint
 * the same humanId — one insert is then rejected by the partial unique index
 * (or, before that index existed, silently duplicated). No amount of retrying,
 * `.immediate()` escalation, or process-level locking fixes a read-modify-write
 * that reads stale; the only fix is to stop reading.
 *
 * This drives the REAL seam: two genuinely separate OS processes, the real
 * built `dist/`, one shared store file, no serve lock, released from a file
 * barrier so they allocate from the identical initial state. Ground truth is
 * read back out of the store afterwards rather than trusted from the writers'
 * own reports.
 *
 * NEGATIVE CONTROL (run manually, documented for the next reader): restore the
 * pre-counter `ids.ts`, rebuild, and re-run — this suite goes red with
 * duplicate/missing ordinals. It stays green only while allocation is a single
 * atomic counter bump.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PKG_DIR = resolve(__dirname, '..', '..');
const DIST = join(PKG_DIR, 'dist', 'index.js');
const FIXTURE = join(PKG_DIR, 'src', 'test', 'fixtures', 'cross-process-writer.cjs');

const WRITERS = 2;
const PER_WRITER = 40;
const FAMILY = 'BUG-COUNTER';

const root = mkdtempSync(join(tmpdir(), 'backlog-counter-'));
const dbPath = join(root, 'counter.db');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('humanId allocation is atomic across processes', () => {
  it('mints exactly one distinct id per create, with two concurrent processes', async () => {
    expect(existsSync(DIST), `built dist missing at ${DIST} — run \`nx build backlog\` first`).toBe(true);
    expect(existsSync(FIXTURE), `cross-process writer fixture missing at ${FIXTURE}`).toBe(true);

    const env = { ...process.env, REPRO_DIST: DIST, REPRO_ROOT: root };

    // Spawn both writers; each blocks on the GO barrier after opening the store.
    const procs = Array.from({ length: WRITERS }, (_, i) =>
      new Promise<void>((res, rej) => {
        const p = spawn('node', [FIXTURE, dbPath, `w${i}`, String(PER_WRITER), FAMILY], { env, stdio: 'inherit' });
        p.on('exit', (code: number) => (code === 0 ? res() : rej(new Error(`writer w${i} exited ${code}`))));
        p.on('error', rej);
      })
    );

    // Release them together once both report ready (bounded — never sleeps blind).
    const deadline = Date.now() + 60_000;
    while (readdirSync(root).filter((f) => f.startsWith('ready-')).length < WRITERS) {
      if (Date.now() > deadline) throw new Error('writers never reported ready');
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(join(root, 'GO'), 'go');

    await Promise.all(procs);

    // Ground truth: read the ids back out of the store itself.
    const script = `
      const { openGraphBacklogStore, closeGraphBacklogStore } = require(process.env.REPRO_DIST);
      (async () => {
        const store = await openGraphBacklogStore(process.env.REPRO_DB, 5000);
        const { rows } = await store.adapter.executeAll(
          "SELECT json_extract(meta,'$.humanId') AS h FROM node WHERE json_extract(meta,'$.humanId') LIKE ? AND t_invalid IS NULL",
          ['${FAMILY}-%']
        );
        await closeGraphBacklogStore(store);
        console.log(JSON.stringify(rows.map(r => r.h)));
      })();
    `;
    const out = execFileSync('node', ['-e', script], { env: { ...env, REPRO_DB: dbPath }, encoding: 'utf8' });
    const ids: string[] = JSON.parse(out.trim().split('\n').pop() as string);

    const expected = WRITERS * PER_WRITER;
    expect(new Set(ids).size, 'duplicate humanIds were minted — the allocator handed the same ordinal to two processes').toBe(ids.length);
    expect(ids.length, `expected ${expected} items, got ${ids.length} — writes were lost`).toBe(expected);
  }, 180_000);
});
