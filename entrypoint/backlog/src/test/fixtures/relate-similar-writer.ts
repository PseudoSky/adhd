/**
 * relate-similar-writer.ts — a REAL separate-process `relate` writer for
 * `write/relate-similar.e2e.ts` (C9 AC4 concurrency).
 *
 * Run directly from SOURCE via `tsx` (never the built `dist/`), so it always
 * exercises the live `write/relate.ts` + `write/tx.ts` — including the
 * `ADHD_BACKLOG_UNSAFE_TX_MODE` negative-control env var.
 *
 * Handshake: after store open, writes `<root>/ready-<tag>`, then polls for
 * `<root>/GO`. On release it calls `relate {sourceUid, targetUid, rel,
 * action:'add'}` exactly once and reports the outcome as one JSON line.
 *
 * Exit codes are the contract the parent test keys on (never stdout):
 *   0 — the link committed (or was a stated noop)
 *   3 — the expected `n:1` `SingleValuedRelationConflictError` (reserved
 *       `duplicate_of` losing the race)
 *   1 — any other fatal error (fixture-level failure)
 *
 * Usage: tsx relate-similar-writer.ts <dbPath> <tag> <sourceUid> <targetUid> <rel> <root>
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { relate, type RelateRel } from '../../write/relate.js';
import { openTestIssueStore } from '../helpers/open-test-issue-store.js';

const [, , dbPath, tag, sourceUid, targetUid, relRaw, root] = process.argv;
const rel = relRaw as RelateRel;

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

  let ok = false;
  let noop = false;
  let threw = false;
  let errorName: string | undefined;
  let errorMessage: string | undefined;
  try {
    const outcome = await relate(handle, {
      sourceUid,
      targetUid,
      rel,
      action: 'add',
      by: 'cross-process-reviewer',
    });
    ok = true;
    noop = outcome.noop;
  } catch (err) {
    threw = true;
    errorName = err instanceof Error ? err.constructor.name : 'Error';
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  await store.close();
  process.stdout.write(
    `${JSON.stringify({ tag, ok, noop, threw, errorName, errorMessage })}\n`
  );
  if (threw) process.exit(errorName === 'SingleValuedRelationConflictError' ? 3 : 1);
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `${tag}: FATAL:`,
    err instanceof Error ? err.stack ?? err.message : String(err)
  );
  process.exit(1);
});
