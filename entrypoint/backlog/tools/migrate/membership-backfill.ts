#!/usr/bin/env -S node
/**
 * membership-backfill.ts — one-shot, reversible migration CLI that gives every
 * live issue its `in_component` membership rows (e54bd58b A-AC5, S02.S2). The
 * logic lives in `src/write/membership-backfill.ts`; this file is argv, the
 * production guard, plan/measurement reporting, journal persistence and exit
 * codes.
 *
 * Usage:
 *
 *   npx tsx tools/migrate/membership-backfill.ts <dbPath> [--apply|--reverse <journal.json>] [--allow-production-write]
 *
 * Default mode is dry-run: plan, print, write NOTHING.
 *
 * Exit codes (same shape as `backfill-status-terminal.ts`):
 *   0  clean    — dry-run: nothing pending and I1/I2 hold; apply: counts by
 *                 primary project unchanged, membership a superset, I1/I2 hold,
 *                 re-plan = 0; reverse: the journal was restored.
 *   1  violations — an invariant or equality check failed.
 *   2  harness failure — bad argv, an unreadable journal, a refused production
 *                 write, or any thrown error.
 *
 * PRODUCTION GUARD. This runner opens the database directly, which bypasses
 * `assertProductionWriteAllowed` (that gate only guards transport handles). So
 * it carries its own: a `--apply`/`--reverse` against a path under
 * `~/.adhd/backlog/production/` is refused unless `--allow-production-write` is
 * passed. A dry-run is always permitted. Take a verified backup first.
 *
 * The apply journal is written under `tmp/migrate/` (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  applyMembershipBackfill,
  measureMembership,
  planMembershipBackfill,
  primaryMembershipByProject,
  reverseMembershipBackfill,
  type IMembershipBackfillJournal,
  type IMembershipMeasurement,
} from '../../src/write/membership-backfill.js';
import { openEtlStore } from '../etl/store-bootstrap.js';

type Mode = 'dry-run' | 'apply' | 'reverse';

interface IParsedArgs {
  dbPath: string;
  mode: Mode;
  journalPath?: string;
  allowProduction: boolean;
}

/** The directory holding the live production store(s). */
export function productionStoreRoot(home: string = homedir()): string {
  return join(home, '.adhd', 'backlog', 'production');
}

/** True when `dbPath` resolves under the production store root. */
export function isProductionPath(dbPath: string, home: string = homedir()): boolean {
  const root = resolve(productionStoreRoot(home)) + sep;
  return (resolve(dbPath) + sep).startsWith(root);
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: membership-backfill.ts <dbPath> [--apply|--reverse <journal.json>] [--allow-production-write]\n`
  );
  process.exit(2);
}

export function parseArgs(argv: readonly string[]): IParsedArgs {
  const positional: string[] = [];
  let mode: Mode = 'dry-run';
  let journalPath: string | undefined;
  let sawApply = false;
  let sawReverse = false;
  let allowProduction = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      sawApply = true;
      mode = 'apply';
    } else if (arg === '--reverse') {
      sawReverse = true;
      mode = 'reverse';
      journalPath = argv[i + 1];
      if (journalPath === undefined || journalPath.startsWith('--')) usage('--reverse requires a <journal.json> path');
      i += 1;
    } else if (arg === '--allow-production-write') {
      allowProduction = true;
    } else if (arg.startsWith('--')) {
      usage(`unknown flag "${arg}"`);
    } else {
      positional.push(arg);
    }
  }
  if (sawApply && sawReverse) usage('--apply and --reverse are mutually exclusive');
  if (positional.length !== 1) usage(`expected exactly one positional <dbPath>, got ${positional.length}`);
  return { dbPath: positional[0]!, mode, journalPath, allowProduction };
}

function writeJournal(journal: IMembershipBackfillJournal): string {
  const dir = join(process.cwd(), 'tmp', 'migrate');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `membership-${new Date().toISOString().replace(/[:.]/g, '-')}.journal.json`);
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  return path;
}

function summarize(m: IMembershipMeasurement): string {
  return JSON.stringify({
    countsByPrimaryProject: m.countsByPrimaryProject,
    i1Violations: m.i1Violations.length,
    i2Violations: m.i2Violations.length,
  });
}

async function run(args: IParsedArgs): Promise<number> {
  if (args.mode !== 'dry-run' && isProductionPath(args.dbPath) && !args.allowProduction) {
    process.stderr.write(
      `REFUSED: ${args.dbPath} is under ${productionStoreRoot()}; pass --allow-production-write after taking a verified backup.\n`
    );
    return 2;
  }
  const store = await openEtlStore(args.dbPath, 10_000);
  try {
    if (args.mode === 'reverse') {
      const journal = JSON.parse(readFileSync(args.journalPath!, 'utf8')) as IMembershipBackfillJournal;
      await reverseMembershipBackfill(store, journal);
      process.stdout.write(`REVERSED created=${journal.created.length} invalidated=${journal.invalidated.length}\n`);
      return 0;
    }
    const before = await measureMembership(store);
    const primaryBefore = await primaryMembershipByProject(store);
    const plan = await planMembershipBackfill(store);
    process.stdout.write(
      `BEFORE ${summarize(before)}\n` +
        `PLAN issuesExamined=${plan.issuesExamined} pendingIssues=${plan.pendingIssueUids.length} pendingWrites=${plan.pendingWrites}\n`
    );
    if (args.mode === 'dry-run') {
      return plan.pendingWrites === 0 && before.i1Violations.length === 0 && before.i2Violations.length === 0 ? 0 : 1;
    }

    const journal = await applyMembershipBackfill(store);
    const journalPath = writeJournal(journal);
    const after = await measureMembership(store);
    const replan = await planMembershipBackfill(store);
    process.stdout.write(
      `APPLIED created=${journal.created.length} invalidated=${journal.invalidated.length}\n` +
        `JOURNAL ${journalPath}\n` +
        `AFTER ${summarize(after)}\n` +
        `REPLAN pendingWrites=${replan.pendingWrites}\n`
    );

    const failures: string[] = [];
    if (JSON.stringify(sortKeys(after.countsByPrimaryProject)) !== JSON.stringify(sortKeys(before.countsByPrimaryProject))) {
      failures.push('counts by primary project changed');
    }
    for (const [project, issues] of Object.entries(primaryBefore)) {
      const now = new Set(after.membershipByProject[project] ?? []);
      const lost = issues.filter((u) => !now.has(u));
      if (lost.length > 0) failures.push(`project ${project} lost ${lost.length} member(s)`);
    }
    if (after.i1Violations.length > 0) failures.push(`I1 violations: ${after.i1Violations.length}`);
    if (after.i2Violations.length > 0) failures.push(`I2 violations: ${after.i2Violations.length}`);
    if (replan.pendingWrites > 0) failures.push(`re-plan still pending ${replan.pendingWrites}`);
    if (failures.length > 0) {
      process.stdout.write(`VIOLATIONS ${JSON.stringify(failures)}\n`);
      return 1;
    }
    return 0;
  } finally {
    await store.close();
  }
}

function sortKeys(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.exit(await run(args));
}

// Run only as a CLI, never when imported (the spec imports the pure helpers).
if (process.argv[1] !== undefined && /membership-backfill\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(2);
  });
}
