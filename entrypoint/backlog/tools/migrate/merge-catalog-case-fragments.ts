#!/usr/bin/env -S node
/**
 * merge-catalog-case-fragments.ts — one-shot, reversible CLI that collapses
 * the status/priority/kind catalog's case-fragment duplicates (the same token
 * living as two LIVE rows that differ only in case). The repair logic itself
 * lives in `src/write/catalog-merge.ts`; this file is only argv parsing, plan
 * reporting, journal persistence, post-apply verification, and exit codes.
 * The plan covers all three kinds the invariant guard reads
 * (`catalog-invariant-guard.ts`'s `GUARDED_CATALOG_KINDS`) — including the
 * OPEN `kind` vocabulary (`bug`/`BUG`), whose collapse C8 added to the
 * planner but this CLI originally omitted.
 *
 * Usage:
 *
 *   npx tsx tools/migrate/merge-catalog-case-fragments.ts <dbPath> [--apply|--reverse <journal.json>]
 *
 * Default mode is `--dry-run`: build the plan, print the explicit
 * OLD → CANONICAL mapping, and write NOTHING.
 *
 * Exit codes — mirroring `tools/etl/cli.ts` and D1's
 * `backfill-status-terminal.ts`:
 *
 *   0  clean    — dry-run: no live case-variant group; apply: none remain and
 *                 the D1 classifier is clean afterwards; reverse: restored.
 *   1  violations — dry-run found case-variant groups; apply left some (a
 *                 concurrent writer re-created one); apply's verification
 *                 found a terminal-named issue still returned under
 *                 `status:'open'`.
 *   2  harness failure — bad argv, an unreadable journal, or any thrown error
 *                 (`FATAL` to stderr), so a crashed run is never mistaken for
 *                 a clean one.
 *
 * The apply journal is written under `tmp/migrate/<timestamp>.journal.json`
 * (relative to the process CWD) — `tmp/` is gitignored and no artifact is ever
 * written at the repo root or to a tracked path.
 *
 * Run against a THROWAWAY database path. Pointing it at a live store is a
 * deliberate, reviewed operator action, never this tool's default.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyCaseFragmentMerge,
  planCaseFragmentMerge,
  reverseCaseFragmentMerge,
  type IMergeJournal,
  type IMergePlan,
} from '../../src/write/catalog-merge.js';
import { planTerminalBackfill } from '../../src/write/catalog-repair.js';
import { RESERVED_TERMINAL_STATUS_NAMES } from '../../src/write/catalog-repair.js';
import { catalogNameFold } from '../../src/write/catalog-repair.js';
import { queryIssues } from '../../src/query/query.js';
import { openEtlStore, type IEtlStoreHandle } from '../etl/store-bootstrap.js';

type Mode = 'dry-run' | 'apply' | 'reverse';

interface IParsedArgs {
  dbPath: string;
  mode: Mode;
  journalPath?: string;
}

const FOLDED_TERMINAL_STATUS_NAMES: ReadonlySet<string> = new Set(
  [...RESERVED_TERMINAL_STATUS_NAMES].map((name) => catalogNameFold(name))
);

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: merge-catalog-case-fragments.ts <dbPath> [--apply|--reverse <journal.json>]\n`
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
    usage(`expected exactly one positional <dbPath>, got ${positional.length}`);
  }
  return { dbPath: positional[0]!, mode, journalPath };
}

/** A filesystem-safe journal filename stamp, derived from the ISO clock. */
function journalStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJournal(journal: IMergeJournal): string {
  const dir = join(process.cwd(), 'tmp', 'migrate');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${journalStamp()}.journal.json`);
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  return path;
}

interface IPlanView {
  plan: IMergePlan;
  nameByUid: Map<string, string>;
  kindByUid: Map<string, string>;
}

async function buildPlan(store: IEtlStoreHandle): Promise<IPlanView> {
  const statuses = await store.graph.queryNodes({ kind: 'status', liveOnly: true });
  const priorities = await store.graph.queryNodes({ kind: 'priority', liveOnly: true });
  // C8 widened BOTH the write-path refusal and the invariant guard to the OPEN
  // `kind` catalog (`catalog-invariant-guard.ts`'s `GUARDED_CATALOG_KINDS`), and
  // `planCaseFragmentMerge` grew a third `liveKinds` parameter to match. This
  // CLI was not updated at the same time, so its plan silently held only the
  // status/priority groups: an apply would collapse those, report `VERIFY
  // clean`, and leave every `bug`/`BUG`-style KIND duplicate live — i.e. the
  // repair the guard's own message names could not turn `store-check` green.
  // Pass the live `kind` rows too so the plan covers exactly the three kinds
  // the guard reads.
  const kinds = await store.graph.queryNodes({ kind: 'kind', liveOnly: true });
  const nameByUid = new Map<string, string>();
  const kindByUid = new Map<string, string>();
  for (const n of [...statuses, ...priorities, ...kinds]) {
    nameByUid.set(n.uid, n.name ?? '');
    kindByUid.set(n.uid, n.kind);
  }
  return {
    plan: planCaseFragmentMerge(statuses, priorities, kinds),
    nameByUid,
    kindByUid,
  };
}

function printPlan(dbPath: string, view: IPlanView): void {
  const lines: string[] = [
    `merge-catalog-case-fragments: dry-run`,
    `  dbPath: ${dbPath}`,
    `  groups: ${view.plan.groups.length}`,
  ];
  for (const group of view.plan.groups) {
    const canonical = view.nameByUid.get(group.canonicalUid) ?? group.canonicalUid;
    const kind = view.kindByUid.get(group.canonicalUid) ?? '?';
    for (const fragmentUid of group.fragmentUids) {
      const from = view.nameByUid.get(fragmentUid) ?? fragmentUid;
      lines.push(`    [${kind}] ${from} -> ${canonical}`);
    }
  }
  for (const group of view.plan.unmergeable) {
    lines.push(
      `    [${group.kind}] REFUSED (no write-spelling member, not merged): ${group.names.join(' / ')}`
    );
  }
  lines.push(`PLAN ${JSON.stringify(view.plan)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

interface IVerifyResult {
  clean: boolean;
  detail: string;
}

/**
 * Post-apply verification. Three independent checks, each with teeth:
 *
 *  1. re-plan — no live case-variant group remains (the repair is complete);
 *  2. D1's classifier (`planTerminalBackfill`) — every reserved-terminal-named
 *     status row carries `terminal:true` (the two repairs compose);
 *  3. the REAL `queryIssues({filter:{status:'open'}})` read verb — no returned
 *     issue carries a terminal-named status. This is the consumer-visible
 *     assertion: a status named `closed`/`DONE`-and-friends must never be
 *     returned as open.
 */
async function verify(store: IEtlStoreHandle): Promise<IVerifyResult> {
  const remaining = await buildPlan(store);
  if (remaining.plan.groups.length > 0) {
    return {
      clean: false,
      detail: `case-variant groups still live: ${remaining.plan.groups.length}`,
    };
  }
  if (remaining.plan.unmergeable.length > 0) {
    return {
      clean: false,
      detail: `status group(s) with no lowercase (write-spelling) member, refused: ${remaining.plan.unmergeable
        .map((g) => g.names.join('/'))
        .join(', ')}`,
    };
  }

  const backfill = await planTerminalBackfill(store);
  if (backfill.setTerminalRowids.length > 0) {
    return {
      clean: false,
      detail: `D1 classifier still flags ${backfill.setTerminalRowids.length} reserved status row(s) lacking terminal:true`,
    };
  }

  const offenders: string[] = [];
  let offset = 0;
  for (;;) {
    const open = await queryIssues(store, {
      filter: { status: 'open' },
      limit: 1000,
      offset,
    });
    if (open.view !== 'list') {
      return { clean: false, detail: `queryIssues returned view "${open.view}"` };
    }
    for (const item of open.items) {
      const issue = await store.graph.getNodeByUid(item.uid);
      if (!issue) continue;
      const edges = await store.graph.getEdges({ src: issue.id, rel: 'has_status' });
      const statusId = edges[0]?.dst;
      if (statusId === undefined) continue;
      const [status] = await store.graph.getNodesByIds([statusId]);
      if (!status) continue;
      const folded = catalogNameFold(status.name ?? '');
      if (FOLDED_TERMINAL_STATUS_NAMES.has(folded) && status.metadata?.terminal !== true) {
        offenders.push(`${item.uid} -> ${status.name ?? ''}`);
      }
    }
    if (!open.hasMore || open.items.length === 0) break;
    offset += open.items.length;
  }
  if (offenders.length > 0) {
    return {
      clean: false,
      detail: `terminal-named issue(s) still returned under status:'open': ${offenders.join(', ')}`,
    };
  }

  return { clean: true, detail: 'no case-variant group, D1 classifier clean, no terminal-named issue under status:open' };
}

async function run(args: IParsedArgs): Promise<number> {
  const store = await openEtlStore(args.dbPath, 10_000);
  try {
    if (args.mode === 'reverse') {
      const raw = readFileSync(args.journalPath!, 'utf8');
      const journal = JSON.parse(raw) as IMergeJournal;
      await reverseCaseFragmentMerge(store, journal);
      process.stdout.write(
        `REVERSED ${journal.entries.length} entr${journal.entries.length === 1 ? 'y' : 'ies'}\n`
      );
      // Informational: reversing deliberately re-opens the case fragments, so
      // the post-state plan is reported but does not decide this run's exit code.
      const reopened = await buildPlan(store);
      process.stdout.write(`VERIFY ${JSON.stringify(reopened.plan)}\n`);
      return 0;
    }

    const view = await buildPlan(store);
    if (args.mode === 'dry-run') {
      printPlan(args.dbPath, view);
      return view.plan.groups.length === 0 && view.plan.unmergeable.length === 0
        ? 0
        : 1;
    }

    const journal = await applyCaseFragmentMerge(store, view.plan);
    const journalPath = writeJournal(journal);
    process.stdout.write(
      `APPLIED ${journal.entries.length} fragment(s)\n` +
        `JOURNAL ${journalPath}\n` +
        `      ${JSON.stringify(journal)}\n`
    );

    const result = await verify(store);
    process.stdout.write(`VERIFY ${result.clean ? 'clean' : 'VIOLATIONS'}: ${result.detail}\n`);
    return result.clean ? 0 : 1;
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
