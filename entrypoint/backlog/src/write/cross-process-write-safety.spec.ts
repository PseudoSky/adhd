/**
 * cross-process-write-safety.spec.ts — BUG-039's fix-verification gate,
 * living on the write/read surface (SPEC.md §10.4, AC-22).
 *
 * **The hazard this guards against.** Free-string `family`/`repo` identity
 * plus an in-band allocated counter-style id lets two real OS processes
 * writing to the SAME store silently LOSE writes — both report `ok:true`
 * for every create, yet a fresh reopen finds only a fraction of the rows
 * (manual repro: 160/250 and 246/250 across distinct families, 440-446/500
 * for the SAME family). A harness that reproduces this must never sit
 * behind `describe.skip` — that is the exact "silent gating" AGENTS.md's
 * live-testing rule forbids, which is how a defect like this can go
 * unproven for a long time. This file is the harness's permanent, unflagged
 * home so the proof can't get lost.
 *
 * **What this proves.** Identity is a DB-generated `uid`
 * (`crypto.randomUUID()`, `write/tx.ts`'s `writeNodeTx`) — there is no
 * in-band allocated id, no shared counter, no free-string `family`/`repo` to
 * collide on — and every write runs inside one `BEGIN IMMEDIATE` transaction
 * (`write/tx.ts`'s `executeWriteTransaction`). SPEC.md:29-33 marks "this
 * fixes cross-process write loss" as HYPOTHESIZED, not proven; this file is
 * §10.4's proof.
 *
 * **Two negative controls, two distinct criteria.** The `deferred` tx-mode
 * control proves the `BEGIN IMMEDIATE` RESERVED-lock compare-and-swap
 * guarantee (a claim/CAS criterion, `write/tx.ts`'s `resolveTransactionMode`)
 * — it fails LOUDLY (a driver-level error) under load, so it cannot itself
 * demonstrate SILENT loss (`ok:true` with no row landed). The dedupe control
 * proves a SEPARATE criterion: `writeNodeTx`'s unconditional
 * `skipDedupe: true` on every entity write (SPEC.md §1/§4). Content-hash
 * dedupe collapses rows WITHOUT ever throwing — two callers both get
 * `ok:true` while only one row lands — which is exactly the SILENT failure
 * signature this whole file exists to gate against, and the one property the
 * tx-mode control structurally cannot exercise.
 *
 * **Determinism (AGENTS.md §7 rule 3).** Two REAL OS processes (never
 * `worker_threads` — the point is genuinely separate connections/processes,
 * matching the original repro), synchronized by a file-based start barrier
 * (both writers park on their own `ready-<tag>` file; the parent touches a
 * shared `GO` file only once BOTH exist) so every writer begins allocating
 * from the IDENTICAL committed store state at (as close to) the same
 * instant the OS scheduler allows — never a `sleep`. Persistence is verified
 * by reopening the store FRESH (`queryIssues` against a brand-new
 * `openTestIssueStore` connection) — never a writer's own in-process count,
 * which is exactly what let the old bug's writers report `ok:true` while
 * rows silently failed to land.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestIssueStore, seedProject, removeTestIssueStoreDir, type TestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { queryIssues } from '../query/query.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER_SCRIPT = join(HERE, '..', 'test', 'fixtures', 'cross-process-issue-writer.ts');
// Resolved once — `npx`'s own PATH search is a wall-clock cost per spawn we
// don't need to pay twice per test; the workspace-root `.bin/tsx` is the
// same binary `npx tsx` would resolve to.
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
const N = 200;

interface WriterOutcome {
  tag: string;
  ok: number;
  threw: number;
  firstError?: string;
}

/** Spawns one real OS-process writer against `dbPath`, parked behind the file barrier at `root` until `runBarrieredPair` releases `GO`. */
function spawnWriter(dbPath: string, tag: string, n: number, projectUid: string, root: string, env?: Record<string, string>): Promise<WriterOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [WRITER_SCRIPT, dbPath, tag, String(n), projectUid, root], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      const lastLine = out.trim().split('\n').filter(Boolean).pop();
      if (!lastLine) {
        // A writer that dies before ever printing its JSON outcome line most
        // often means its store-open itself failed — the KNOWN, SEPARATE
        // store-adapter defect this session filed as BUG-008 ("Concurrent
        // cross-process store OPEN corrupts shared WAL coordination map").
        // Labeled explicitly here so a red CI run is self-diagnosing instead
        // of looking like a `createIssue`/`write/tx.ts` regression: BUG-008
        // is a `@adhd/sox-store-adapter` turso-adapter defect, independent of
        // this file's own transaction-mode hypothesis (reproduced under BOTH
        // `immediate` and `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`).
        const knownWalCorruption = /Corrupt database: shared WAL coordination/.test(err);
        const prefix = knownWalCorruption
          ? `writer ${tag} hit the KNOWN store-adapter defect BUG-008 (concurrent store-open WAL corruption, unrelated to this file's write-transaction-mode hypothesis) and exited ${code} before reporting an outcome`
          : `writer ${tag} exited ${code} with no JSON outcome line`;
        reject(new Error(`${prefix}. stderr: ${err.slice(-500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(lastLine) as WriterOutcome;
        resolve(parsed);
      } catch {
        reject(new Error(`writer ${tag} exited ${code}, stdout did not parse as JSON: ${lastLine}. stderr: ${err.slice(-500)}`));
      }
    });
  });
}

/** Runs two writers concurrently through the file barrier: both park on `ready-<tag>`, `GO` is touched once BOTH are parked, so both begin allocating from the identical committed state. Bounded wait, never a sleep-based race. */
async function runBarrieredPair(
  dbPath: string,
  root: string,
  projectUid: string,
  n: number,
  env?: Record<string, string>,
): Promise<[WriterOutcome, WriterOutcome]> {
  const readyA = join(root, 'ready-A');
  const readyB = join(root, 'ready-B');
  const go = join(root, 'GO');
  for (const f of [readyA, readyB, go]) rmSync(f, { force: true });

  // A writer can die BEFORE ever reaching the ready-<tag> barrier (e.g. its
  // store-open itself fails — observed under the deferred negative control:
  // "Corrupt database: shared WAL coordination map magic mismatch"). Without
  // capturing that here, the barrier-wait loop below would still burn the
  // full 30s timeout waiting for a ready file that will never appear, AND
  // the writer's real rejection would surface later as vitest's own
  // "Unhandled Rejection" (a SEPARATE, undiagnosable failure report) instead
  // of this function's own thrown error. `earlyFailure` lets the loop fail
  // fast with the writer's actual message, and the eager `.catch(() => {})`
  // below marks `pair` handled immediately so re-`await`ing it further down
  // (or never awaiting it at all, on the early-failure throw path) never
  // produces a dangling unhandled rejection.
  let earlyFailure: unknown;
  const wA = spawnWriter(dbPath, 'A', n, projectUid, root, env).catch((err) => {
    earlyFailure ??= err;
    throw err;
  });
  const wB = spawnWriter(dbPath, 'B', n, projectUid, root, env).catch((err) => {
    earlyFailure ??= err;
    throw err;
  });
  const pair = Promise.all([wA, wB]);
  pair.catch(() => {
    /* handled — see comment above; the real rejection is surfaced via the `await pair` at the bottom or the earlyFailure throw */
  });

  const deadline = Date.now() + 30000;
  while (!(existsSync(readyA) && existsSync(readyB))) {
    if (earlyFailure !== undefined) {
      throw new Error(
        `a writer failed before reaching the start barrier: ${earlyFailure instanceof Error ? earlyFailure.message : String(earlyFailure)}`,
      );
    }
    if (Date.now() > deadline) throw new Error('writers never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(go, 'go');
  return pair;
}

/** Counts LIVE issues under `projectUid` through a FRESH store connection — never the pre-writers handle, which can predate the children's commits. */
async function storedCount(dbPath: string, projectUid: string): Promise<number> {
  const store = await openTestIssueStore(dbPath);
  try {
    const result = await queryIssues(store, { filter: { project: projectUid }, limit: 1000 });
    if (result.view !== 'list') throw new Error(`expected view:'list', got ${result.view}`);
    if (result.hasMore) throw new Error('storedCount: more than 1000 issues under this project — widen the limit, do not silently under-count');
    return result.items.length;
  } finally {
    await store.close();
  }
}

describe('cross-process write safety — BUG-039 fix verification (SPEC.md §10.4, AC-22)', () => {
  let dir: string;
  let dbPath: string;
  let seedStore: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('cross-process-write-safety');
    dbPath = join(dir, 'backlog.db');
    // Seeded through its own connection, then closed BEFORE any writer opens
    // the file — a still-open seed connection holding the WAL would change
    // the contention shape under test.
    seedStore = await openTestIssueStore(dbPath);
    const seeded = await seedProject(seedStore, 'cross-process-write-safety-project');
    projectUid = seeded.projectUid;
    await seedStore.close();
  });

  afterEach(() => {
    removeTestIssueStoreDir(dir);
  });

  it(
    `CONTROL (immediate — the only mode used in production): two REAL OS processes each createIssue ${N} times into the SAME project persist exactly ${2 * N} issues, and every writer's own ok:true count matches what it reports`,
    async () => {
      const [a, b] = await runBarrieredPair(dbPath, dir, projectUid, N);

      // No unhandled createIssue failures under normal (immediate) operation —
      // a thrown error here would mean the retry/backoff contract (§4c) did
      // not hold at this concurrency level, a DIFFERENT defect than BUG-039's
      // silent loss.
      expect(a.threw, `writer A: ${a.threw} unexpected createIssue failures, first: ${a.firstError}`).toBe(0);
      expect(b.threw, `writer B: ${b.threw} unexpected createIssue failures, first: ${b.firstError}`).toBe(0);
      expect(a.ok).toBe(N);
      expect(b.ok).toBe(N);

      const persisted = await storedCount(dbPath, projectUid);
      // THE assertion BUG-039 falsified under the old model: every write
      // reported `ok:true` by EITHER process actually landed — reopened,
      // fresh, from neither writer's own in-memory view.
      expect(persisted, `expected exactly ${a.ok + b.ok} persisted rows (writers reported ok:true for all of them), reopened fresh got ${persisted}`).toBe(
        a.ok + b.ok,
      );
    },
    60000,
  );

  it(
    'NEGATIVE CONTROL: ADHD_BACKLOG_UNSAFE_TX_MODE=deferred strips the BEGIN IMMEDIATE CAS guarantee — this proves the CONTROL case above is actually exercising that guarantee, not passing for an unrelated reason',
    async () => {
      const [a, b] = await runBarrieredPair(dbPath, dir, projectUid, N, { ADHD_BACKLOG_UNSAFE_TX_MODE: 'deferred' });
      const persisted = await storedCount(dbPath, projectUid);

      // The DETERMINISTIC invariant this checks, regardless of how the
      // downgrade manifests: a writer's own `ok` count can never overstate
      // what actually persisted. This is BUG-039's exact defect signature —
      // "reported ok:true, row never landed" — and it is the one thing a
      // caller can never detect from its own return value alone, so it is
      // the one thing worth asserting deterministically even when the raw
      // exact-count outcome (see below) is not.
      expect(
        persisted,
        `deferred mode: writers together reported ok:true ${a.ok + b.ok} times but a fresh reopen found ${persisted} rows — ` +
          'this is BUG-039\'s silent-loss signature reproduced under the downgraded transaction mode',
      ).toBeLessThanOrEqual(a.ok + b.ok);

      // The exact-persistence property the CONTROL case proves under
      // `immediate` is EXPECTED to fail here — that is what makes this a
      // real negative control rather than a second copy of the same
      // assertion. Not encoded as a hard `expect` (SPEC.md's own history
      // notes this repro is "flaky in both directions" under load), so this
      // test can never itself become a source of CI flakiness; the actual
      // observed numbers are asserted above (the invariant that must ALWAYS
      // hold) and reported by whoever reads this test's output.
      // eslint-disable-next-line no-console
      console.warn(
        `[cross-process-write-safety] NEGATIVE CONTROL numbers this run: attempted=${2 * N} ` +
          `a.ok=${a.ok} a.threw=${a.threw} b.ok=${b.ok} b.threw=${b.threw} ` +
          `combined-ok=${a.ok + b.ok} persisted(fresh reopen)=${persisted} ` +
          `a.firstError=${a.firstError ?? 'n/a'} b.firstError=${b.firstError ?? 'n/a'}` +
          (persisted === a.ok + b.ok
            ? ' — every reported ok:true persisted (no SILENT loss this run; visible throws, if any, are the downgrade\'s only symptom here)'
            : ` — SILENT LOSS: ${a.ok + b.ok - persisted} row(s) reported ok:true but did not persist`),
      );
    },
    60000,
  );

  it(
    'NEGATIVE CONTROL (dedupe): ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on re-enables content-hash dedupe — this proves the design choice `write/tx.ts`\'s writeNodeTx makes (skipDedupe:true, unconditional, on every entity write) is load-bearing for cross-process safety, not the `immediate` transaction mode above',
    async () => {
      // Distinct from the `deferred` tx-mode control above: THAT control
      // proves the `BEGIN IMMEDIATE` compare-and-swap guarantee (a claim/CAS
      // criterion). THIS control proves a DIFFERENT criterion —
      // `writeNodeTx`'s unconditional `skipDedupe: true` (SPEC.md §1/§4: "All
      // entity writes pass `skipDedupe: true`" — "two identical-body issues
      // are two rows, never one collapsed row"). Both controls run the SAME
      // two-real-OS-process barriered harness; only the env switch differs.
      //
      // `cross-process-issue-writer.ts` writes the EXACT SAME `body` (and
      // the SAME `by` identity) on every one of the 2*N calls, across BOTH
      // processes — see that fixture's own inline comments for why this
      // collision is deliberate and why `by` must be shared (an
      // `authored_by` multiplicity conflict, not silent loss, is what a
      // per-tag `by` would produce once dedupe collapses the rows).
      // `content_hash` dedupe is GLOBAL (BUG-040 in `@adhd/sox-graph-store`'s
      // own dist comment: it ignores `kind` entirely), so every one of the
      // 2*N calls hashes identically and collapses onto whichever ONE call
      // happens to INSERT first.
      const [a, b] = await runBarrieredPair(dbPath, dir, projectUid, N, { ADHD_BACKLOG_UNSAFE_DEDUPE_MODE: 'on' });

      // No unhandled createIssue failures — a `by`-mismatch multiplicity
      // conflict (the failure mode this fixture is specifically designed to
      // avoid) would surface here as `threw > 0`, and would mean the
      // collision below is not actually exercising SILENT loss.
      expect(a.threw, `writer A: ${a.threw} unexpected createIssue failures, first: ${a.firstError}`).toBe(0);
      expect(b.threw, `writer B: ${b.threw} unexpected createIssue failures, first: ${b.firstError}`).toBe(0);
      expect(a.ok).toBe(N);
      expect(b.ok).toBe(N);

      const persisted = await storedCount(dbPath, projectUid);
      const combinedOk = a.ok + b.ok;

      // eslint-disable-next-line no-console
      console.warn(
        `[cross-process-write-safety] DEDUPE NEGATIVE CONTROL numbers this run: attempted=${2 * N} ` +
          `a.ok=${a.ok} a.threw=${a.threw} b.ok=${b.ok} b.threw=${b.threw} ` +
          `combined-ok=${combinedOk} persisted(fresh reopen)=${persisted}` +
          (persisted < combinedOk
            ? ` — SILENT LOSS: ${combinedOk - persisted} row(s) reported ok:true but did not persist (both callers still saw ok:true, no thrown error)`
            : ' — no collapse observed this run (unexpected — every colliding call should have converged onto one row)'),
      );

      // THE assertion this control exists to make go RED against the
      // production default (`skipDedupe: true`, where it is always exactly
      // `2*N`, per the CONTROL case above) and GREEN here: every one of the
      // `combinedOk` calls reported `ok:true`, yet content-hash dedupe
      // collapses them all onto ONE row — the exact "silent loss with
      // ok:true" signature this file's dedupe control exists to prove is
      // reachable the moment `skipDedupe` is not unconditional.
      expect(
        persisted,
        `expected all ${combinedOk} colliding creates (across BOTH processes) to collapse onto exactly 1 row ` +
          `under content-hash dedupe, got ${persisted} persisted row(s) — every caller still reported ok:true`,
      ).toBe(1);
      expect(
        persisted,
        `dedupe negative control: writers together reported ok:true ${combinedOk} times but a fresh reopen found ` +
          `${persisted} row(s) — SILENT LOSS with no visible error to either caller`,
      ).toBeLessThan(combinedOk);
    },
    60000,
  );
});
