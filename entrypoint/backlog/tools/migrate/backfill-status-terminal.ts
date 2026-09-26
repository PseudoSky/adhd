#!/usr/bin/env -S node
/**
 * backfill-status-terminal.ts — one-shot, reversible repair CLI for the
 * `status` catalog's `terminal` flag drift. The repair logic itself lives in
 * `src/write/catalog-repair.ts`; this file is only argv parsing, plan
 * reporting, journal persistence, and exit codes.
 *
 * Usage:
 *
 *   npx tsx tools/migrate/backfill-status-terminal.ts <dbPath> [--apply|--reverse <journal.json>]
 *
 * Default mode is `--dry-run`: build the plan, print it, and write NOTHING.
 *
 * Exit codes — mirroring `tools/etl/cli.ts`'s argv + exit-code shape exactly:
 *
 *   0  clean    — the invariant holds (dry-run: nothing to repair; apply: no
 *                 reserved status row lacks `terminal:true` afterwards;
 *                 reverse: the journal was restored).
 *   1  violations — dry-run found reserved status rows lacking the flag;
 *                 apply left some (a concurrent writer added one).
 *   2  harness failure — bad argv, an unreadable journal, or any thrown error
 *                 (`FATAL` to stderr), so a crashed run is never mistaken for a
 *                 clean one.
 *
 * The apply journal is written under `tmp/migrate/<timestamp>.journal.json`
 * (relative to the process CWD) — `tmp/` is gitignored and no artifact is ever
 * written at the repo root or to a tracked path.
 *
 * Run against a THROWAWAY database path. Pointing it at a live store is a
 * deliberate, reviewed operator action, never this tool's default.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyTerminalBackfill,
  planTerminalBackfill,
  reverseTerminalBackfill,
  type ITerminalBackfillJournal,
  type ITerminalBackfillPlan,
} from '../../src/write/catalog-repair.js';
import { openEtlStore } from '../etl/store-bootstrap.js';

type Mode = 'dry-run' | 'apply' | 'reverse';

interface IParsedArgs {
  dbPath: string;
  mode: Mode;
  journalPath?: string;
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: backfill-status-terminal.ts <dbPath> [--apply|--reverse <journal.json>]\n`
  );
  process.exit(2);
}

/** Parse argv with the same fail-loud-on-unknown posture as `tools/etl/cli.ts`: an unrecognized flag is a harness error (2), never silently ignored. */
function parseArgs(argv: readonly string[]): IParsedArgs {
  const positional: string[] = [];
  let mode: Mode = 'dry-run';
  let journalPath: string | undefined;
  let sawApply = false;
  let sawReverse = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      sawApply = true;
      mode = 'apply';
    } else if (arg === '--reverse') {
      sawReverse = true;
      mode = 'reverse';
      journalPath = argv[i + 1];
      if (journalPath === undefined || journalPath.startsWith('--')) {
        usage('--reverse requires a <journal.json> path');
      }
      i += 1;
    } else if (arg.startsWith('--')) {
      usage(`unknown flag "${arg}"`);
    } else {
      positional.push(arg);
    }
  }

  if (sawApply && sawReverse) {
    usage('--apply and --reverse are mutually exclusive');
  }
  if (positional.length !== 1) {
    usage(
      `expected exactly one positional <dbPath>, got ${positional.length}`
    );
  }
  return { dbPath: positional[0]!, mode, journalPath };
}

/** A filesystem-safe journal filename stamp, derived from the ISO clock. */
function journalStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJournal(journal: ITerminalBackfillJournal): string {
  const dir = join(process.cwd(), 'tmp', 'migrate');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${journalStamp()}.journal.json`);
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  return path;
}

function printPlan(dbPath: string, plan: ITerminalBackfillPlan): void {
  process.stdout.write(
    `backfill-status-terminal: dry-run\n` +
      `  dbPath: ${dbPath}\n` +
      `  reserved status rows needing terminal:true: ${plan.setTerminalRowids.length}\n` +
      `  rowids: ${JSON.stringify(plan.setTerminalRowids)}\n` +
      `PLAN ${JSON.stringify(plan)}\n`
  );
}

async function run(args: IParsedArgs): Promise<number> {
  const store = await openEtlStore(args.dbPath, 10_000);
  try {
    if (args.mode === 'reverse') {
      const raw = readFileSync(args.journalPath!, 'utf8');
      const journal = JSON.parse(raw) as ITerminalBackfillJournal;
      await reverseTerminalBackfill(store, journal);
      process.stdout.write(
        `REVERSED ${journal.entries.length} entr${journal.entries.length === 1 ? 'y' : 'ies'}\n`
      );
      // Informational only: reversing deliberately re-opens the drift, so the
      // post-state plan is reported but does not decide this run's exit code.
      const reopened = await planTerminalBackfill(store);
      process.stdout.write(`VERIFY ${JSON.stringify(reopened)}\n`);
      return 0;
    }

    const plan = await planTerminalBackfill(store);
    if (args.mode === 'dry-run') {
      printPlan(args.dbPath, plan);
      return plan.setTerminalRowids.length === 0 ? 0 : 1;
    }

    const journal = await applyTerminalBackfill(store, plan);
    const journalPath = writeJournal(journal);
    process.stdout.write(
      `APPLIED ${journal.entries.length} row(s)\n` +
        `JOURNAL ${journalPath}\n` +
        `      ${JSON.stringify(journal)}\n`
    );

    const remaining = await planTerminalBackfill(store);
    process.stdout.write(
      `  reserved status rows still needing the flag: ${remaining.setTerminalRowids.length}\n` +
        `VERIFY ${JSON.stringify(remaining)}\n`
    );
    return remaining.setTerminalRowids.length === 0 ? 0 : 1;
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = await run(args);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(
    `FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(2);
});
