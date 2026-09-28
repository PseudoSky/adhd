/**
 * cross-process-gate-worker.ts — a REAL separate-process terminal-transition
 * caller for `write/cross-process-gate-safety.e2e.ts` (C5 AC5, adhd ADR-0001
 * D5 / ADR-0012).
 *
 * Run directly from SOURCE via `tsx` (never `dist/`) — the same discipline
 * `cross-process-claim-worker.ts` documents: the C5 gate is not part of the
 * package's public barrel, so running from source always exercises whatever
 * `write/transition.ts` + `write/gate.ts` currently say, live — including the
 * `ADHD_BACKLOG_UNSAFE_TX_MODE` negative-control env var.
 *
 * Opens the SAME on-disk store as the peer, parks on `<root>/ready-<tag>`
 * until `<root>/GO` appears (bounded, never a sleep), then calls `transition`
 * to the terminal status EXACTLY ONCE. An `ObligationUnsatisfiedError` is an
 * EXPECTED outcome (the loser of the gate's read-modify-write), not a fixture
 * failure. Reports one JSON line on stdout:
 * `{tag, outcome:'success'|'refused'|'error', code?, message?}`; exits 0 for
 * success/refused, 2 for a genuinely unexpected error, 1 for a fatal
 * (pre-store-open) failure.
 *
 * Usage: tsx cross-process-gate-worker.ts <dbPath> <tag> <issueUid> <root> <toStatus>
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { transition } from '../../write/transition.js';
import { ObligationUnsatisfiedError, OverrideNotPermittedError } from '../../write/errors.js';
import { openTestIssueStore } from '../helpers/open-test-issue-store.js';

const [, , dbPath, tag, issueUid, root, toStatus] = process.argv;

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
  outcome: 'success' | 'refused' | 'error';
  code?: string;
  message?: string;
}

async function main(): Promise<void> {
  const store = await openTestIssueStore(dbPath);
  const handle = { adapter: store.adapter, typePolicy: store.typePolicy };
  writeFileSync(join(root, `ready-${tag}`), 'ready');
  await waitForGo();

  let result: Outcome;
  try {
    await transition(handle, {
      uid: issueUid,
      by: `closer-${tag}`,
      toStatus,
      note: `close by ${tag}`,
    });
    result = { tag, outcome: 'success' };
  } catch (err) {
    if (err instanceof ObligationUnsatisfiedError) {
      result = { tag, outcome: 'refused', code: err.refusal.code, message: err.message };
    } else if (err instanceof OverrideNotPermittedError) {
      result = { tag, outcome: 'refused', code: 'OverrideNotPermitted', message: err.message };
    } else {
      result = {
        tag,
        outcome: 'error',
        message: String(err instanceof Error ? err.message : err).slice(0, 300),
      };
    }
  }
  await store.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.outcome === 'error' ? 2 : 0);
}

main().catch((err) => {
  console.error(
    `${tag}: FATAL:`,
    err instanceof Error ? err.stack ?? err.message : String(err)
  );
  process.exit(1);
});
