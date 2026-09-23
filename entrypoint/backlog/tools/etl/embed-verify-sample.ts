#!/usr/bin/env -S node
/**
 * embed-verify-sample.ts — proves the backfilled vectors actually serve
 * semantic search, not just that a vector column is non-null (STATE.md's
 * B2b requirement).
 *
 *   npx tsx tools/etl/embed-verify-sample.ts <dbPath> [sampleSize=5]
 *
 * For `sampleSize` live issues (evenly spread through the live-issue rowid
 * range, deterministic — never random, so the output is reproducible run to
 * run), runs the REAL `view:'similar'` read path
 * (`queryIssuesWithMeta`/`querySimilarView`, `src/query/query.ts`) anchored
 * on that issue, exactly as a `query({view:'similar', filter:{anchor}})`
 * call over the mounted MCP/CLI/HTTP surface would. Prints each anchor's
 * title plus its top-K neighbours' titles and `_score`, for direct human
 * inspection — this script makes NO pass/fail assertion of its own (there is
 * no oracle for "is this a sensible neighbour" outside a human reading it),
 * it only drives the real path and prints real output.
 */
import { openEtlStore } from './store-bootstrap.js';
import { bootstrapSemanticStoreMembers } from '../../src/write/bootstrap.js';
import { queryIssuesWithMeta } from '../../src/query/query.js';
import type { IQueryStoreHandle } from '../../src/query/query.js';

interface ILiveIssueRow {
  rowid: number;
  uid: string;
  name: string | null;
}

async function main(): Promise<void> {
  const [dbPath, sampleSizeArg] = process.argv.slice(2);
  if (!dbPath) {
    process.stderr.write('usage: embed-verify-sample.ts <dbPath> [sampleSize=5]\n');
    process.exit(2);
  }
  const sampleSize = sampleSizeArg ? Number(sampleSizeArg) : 5;
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    process.stderr.write(`sampleSize must be a positive integer, got ${JSON.stringify(sampleSizeArg)}\n`);
    process.exit(2);
  }

  const handle = await openEtlStore(dbPath);
  try {
    const cfg = {
      enabled: true,
      provider: process.env.ADHD_BACKLOG_EMBEDDING_PROVIDER ?? 'fastembed',
      model: process.env.ADHD_BACKLOG_EMBEDDING_MODEL ?? 'bge-base-en-v1.5',
    };
    const { search } = await bootstrapSemanticStoreMembers(
      handle.adapter,
      handle.graph,
      cfg,
      (message) => process.stderr.write(`${message}\n`)
    );
    if (!search) {
      process.stderr.write(
        'embed-verify-sample.ts: semantic search did not resolve — nothing to verify (see diagnostics above).\n'
      );
      process.exit(2);
    }

    const queryHandle: IQueryStoreHandle = { graph: handle.graph, search };

    const { rows } = await handle.adapter.executeAll<ILiveIssueRow>(
      `SELECT rowid, uid, name FROM node
       WHERE kind = 'issue' AND t_invalid IS NULL AND (is_superseded IS NULL OR is_superseded = 0)
       ORDER BY rowid`
    );
    if (rows.length === 0) {
      process.stdout.write('embed-verify-sample.ts: no live issues in this store.\n');
      return;
    }

    // Evenly-spaced sample across the live-issue rowid range — deterministic,
    // never `Math.random()` (AGENTS.md §7: "Be deterministic").
    const step = Math.max(1, Math.floor(rows.length / sampleSize));
    const anchors: ILiveIssueRow[] = [];
    for (let i = 0; i < rows.length && anchors.length < sampleSize; i += step) {
      anchors.push(rows[i]!);
    }

    for (const anchor of anchors) {
      const outcome = await queryIssuesWithMeta(queryHandle, {
        view: 'similar',
        filter: { anchor: anchor.uid },
        fields: ['title', '_score'],
        limit: 6,
      });
      const result = outcome.result;
      process.stdout.write(
        `\nANCHOR uid=${anchor.uid} title=${JSON.stringify(anchor.name ?? '')}\n`
      );
      if (result.view !== 'similar' || !('items' in result)) {
        process.stdout.write(`  (unexpected result shape: view=${result.view})\n`);
        continue;
      }
      // The anchor itself is excluded by `querySimilarView`'s own contract;
      // print whatever ranked neighbours come back, verbatim.
      for (const item of result.items) {
        process.stdout.write(
          `  -> uid=${item.uid} score=${item._score?.toFixed(4) ?? 'n/a'} title=${JSON.stringify(item.title ?? '')}\n`
        );
      }
      if (result.items.length === 0) {
        process.stdout.write('  (no neighbours returned)\n');
      }
    }
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    `FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(2);
});
