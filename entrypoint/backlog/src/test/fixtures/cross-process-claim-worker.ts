/**
 * cross-process-claim-worker.ts — a REAL separate-process `claim` caller for
 * `write/claim.spec.ts`'s CAS proof (SPEC.md §4c/§6.3.5).
 *
 * Run directly from SOURCE via `tsx` (never `dist/`) — the same discipline
 * `cross-process-issue-writer.ts` documents: `write/claim.ts` is not part of
 * the package's public barrel yet, and running from source means this
 * harness always exercises whatever `write/tx.ts` currently says, live —
 * including the `ADHD_BACKLOG_UNSAFE_TX_MODE` negative-control env var.
 *
 * Opens the SAME on-disk store as every other worker, parks on
 * `<root>/ready-<tag>` until `<root>/GO` appears (bounded, never sleeps the
 * parent test), then calls `claim(handle, {uid, by:'claimant-<tag>',
 * action:'claim'})` EXACTLY ONCE. A `ClaimHeldError` is an EXPECTED outcome
 * here (the loser of the CAS), not a fixture failure — unlike
 * `cross-process-issue-writer.ts`, where any thrown error is unexpected.
 * Reports one JSON line on stdout: `{tag, outcome, status?, heldBy?,
 * heldSince?, message?}`, then exits 0 for `success`/`rejected`, 2 for a
 * genuinely unexpected error, 1 for a fatal (pre-store-open) failure.
 *
 * Usage: tsx cross-process-claim-worker.ts <dbPath> <tag> <issueUid> <root>
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claim } from '../../write/claim.js';
import { ClaimHeldError } from '../../write/errors.js';
import { openTestIssueStore } from '../helpers/open-test-issue-store.js';

const [, , dbPath, tag, issueUid, root] = process.argv;

async function waitForGo(): Promise<void> {
  const go = join(root, 'GO');
  const deadline = Date.now() + 30000;
  while (!existsSync(go)) {
    if (Date.now() > deadline) throw new Error(`${tag}: GO barrier never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Outcome {
  tag: string;
  outcome: 'success' | 'rejected' | 'error';
  status?: string;
  heldBy?: string;
  heldSince?: string;
  message?: string;
}

async function main(): Promise<void> {
  const store = await openTestIssueStore(dbPath);
  const handle = { adapter: store.adapter, typePolicy: store.typePolicy };
  writeFileSync(join(root, `ready-${tag}`), 'ready');
  await waitForGo();

  let result: Outcome;
  try {
    const outcome = await claim(handle, { uid: issueUid, by: `claimant-${tag}`, action: 'claim' });
    result = { tag, outcome: 'success', status: outcome.status };
  } catch (err) {
    if (err instanceof ClaimHeldError) {
      result = { tag, outcome: 'rejected', heldBy: err.heldBy, heldSince: err.heldSince };
    } else {
      result = { tag, outcome: 'error', message: String(err instanceof Error ? err.message : err).slice(0, 300) };
    }
  }
  await store.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.outcome === 'error' ? 2 : 0);
}

main().catch((err) => {
  console.error(`${tag}: FATAL:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
