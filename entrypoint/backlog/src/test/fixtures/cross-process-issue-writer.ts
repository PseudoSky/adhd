/**
 * cross-process-issue-writer.ts — a REAL separate-process writer for
 * `write/cross-process-write-safety.spec.ts` (BUG-039 / SPEC.md §9.1,
 * AC-22).
 *
 * Run directly from SOURCE via `tsx` (never through the built `dist/` —
 * `write/create-issue.ts` and `query/query.ts` are not part of the package's
 * public `index.ts` barrel yet, and running from source also means this
 * harness always exercises whatever `write/tx.ts` currently says, live —
 * including the `ADHD_BACKLOG_UNSAFE_TX_MODE` negative-control env var —
 * never a stale build left over from an earlier edit).
 *
 * Opens the SAME on-disk store (`openTestIssueStore`) as every other writer
 * — no serve lock, no coordination beyond the file barrier below — then
 * BLOCKS on it before its first `createIssue` call, so every writer begins
 * from the IDENTICAL committed store state at (nearly) the same instant.
 * That cold-start synchronization is what makes a cross-process write-safety
 * defect manifest deterministically instead of by luck.
 *
 * Handshake: after store open, writes `<root>/ready-<tag>`, then polls
 * (bounded, never sleeps the parent test) for `<root>/GO`. Then creates `n`
 * issues under the given `project` (uid), reports per-outcome counts as one
 * JSON line on stdout, closes, exits 0 — a fatal, unexpected throw exits 1.
 * Mirrors `busy-hold-worker.js`/`scale-worker.js`'s own "report, don't
 * silently swallow" discipline.
 *
 * Usage: tsx cross-process-issue-writer.ts <dbPath> <tag> <n> <projectUid> <root>
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createIssue } from '../../write/create-issue.js';
import { openTestIssueStore } from '../helpers/open-test-issue-store.js';

const [, , dbPath, tag, nRaw, projectUid, root] = process.argv;
const n = Number(nRaw);

/**
 * `ADHD_TEST_CROSS_PROCESS_BODY_MODE` — negative/positive-control switch,
 * test-only. `'same'` (default, unset) is the DELIBERATE, deterministic
 * collision documented below: every one of the `2*n` calls across BOTH
 * processes writes the identical `body`, exercising the harder same-target
 * case. `'distinct'` gives every call its OWN unique body (per `tag`+`i`,
 * already-unique the same way `title` is below) — a genuine no-forced-
 * collision case proving the write path is safe when there is no shared
 * content-hash target to even theoretically collide on, per SPEC.md §8
 * AC-22's "both the same-target and distinct-target cases" wording.
 */
const bodyMode =
  process.env['ADHD_TEST_CROSS_PROCESS_BODY_MODE'] === 'distinct'
    ? 'distinct'
    : 'same';

async function waitForGo(): Promise<void> {
  const go = join(root, 'GO');
  const deadline = Date.now() + 30000;
  while (!existsSync(go)) {
    if (Date.now() > deadline)
      throw new Error(`${tag}: GO barrier never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main(): Promise<void> {
  const store = await openTestIssueStore(dbPath);
  const handle = { adapter: store.adapter, typePolicy: store.typePolicy };
  writeFileSync(join(root, `ready-${tag}`), 'ready');
  await waitForGo();

  let ok = 0;
  let threw = 0;
  let firstError: string | undefined;
  for (let i = 0; i < n; i += 1) {
    try {
      await createIssue(handle, {
        project: projectUid,
        // `title` is distinct per (tag, i) — cosmetic, never part of the
        // content-hash dedupe key (`content_hash` hashes `content`/`body`
        // only, `write/tx.ts`'s `writeNodeTx`).
        title: `${tag}-${i}`,
        // `bodyMode === 'same'` (the default): a DELIBERATE, deterministic
        // collision — never per-index, never per-tag. Every one of the 2*n
        // calls across BOTH processes writes this EXACT SAME body, so every
        // issue node's content hashes IDENTICALLY. Under the production
        // default (dedupe off, `ADHD_BACKLOG_UNSAFE_DEDUPE_MODE` unset), that
        // collision is inert — `skipDedupe: true` makes every call insert its
        // own fresh row regardless of content, which is exactly what the
        // CONTROL test proves (2*n distinct rows persist). Under the dedupe
        // negative control (`ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on`), this SAME
        // collision is what the test exists to exploit: it collapses every
        // call — across BOTH processes — onto the ONE row whichever call
        // happens to insert first, while every caller still gets `ok:true`.
        // `bodyMode === 'distinct'`: every call's body is unique — no forced
        // collision at all, proving the write path persists exactly 2*n rows
        // even with zero shared content-hash target (SPEC.md §8 AC-22's
        // "distinct-target" case).
        body:
          bodyMode === 'distinct'
            ? `cross-process-write-safety probe ${tag}-${i}`
            : 'cross-process-write-safety probe',
        // A SHARED identity across BOTH writers, not `writer:${tag}` — this
        // is a fixture-correctness requirement of the dedupe negative
        // control, not a stylistic choice. `authored_by` is declared `n:1`
        // (an issue's source out-degree capped at one agent target,
        // `write/catalog.ts`'s `EDGE_KIND_TABLE`). Once dedupe collapses two
        // different processes' issue writes onto the SAME row, a SECOND
        // distinct agent (`writer:A` vs `writer:B`) writing `authored_by`
        // against that same collapsed row would trip the `n:1` multiplicity
        // guard and throw `SingleValuedRelationConflictError` — a LOUD
        // failure that would make this fixture's writers report `threw > 0`
        // instead of the SILENT "ok:true but only one row landed" signature
        // the dedupe negative control exists to prove. A shared `by` across
        // both processes keeps every collapsed row's `authored_by` edge
        // identical (same src, same dst) so it never conflicts.
        by: 'cross-process-write-safety-probe',
      });
      ok += 1;
    } catch (err) {
      threw += 1;
      if (firstError === undefined)
        firstError = String(err instanceof Error ? err.message : err).slice(
          0,
          200
        );
    }
  }
  await store.close();
  process.stdout.write(`${JSON.stringify({ tag, ok, threw, firstError })}\n`);
  // A thrown createIssue call is a REAL failure the parent must see as a
  // non-zero exit — unlike the old BUG-039 fixture, which deliberately let a
  // silent-loss repro exit 0 because the OLD write path could lose a write
  // while reporting ok:true. `createIssue` has no such path: it either
  // commits (ok) or throws (never silently drops), so any `threw > 0` here
  // is itself already an unexpected fixture-level failure, not the
  // phenomenon under test.
  process.exit(threw > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(
    `${tag}: FATAL:`,
    err instanceof Error ? err.stack ?? err.message : String(err)
  );
  process.exit(1);
});
