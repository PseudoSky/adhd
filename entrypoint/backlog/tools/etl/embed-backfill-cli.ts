#!/usr/bin/env -S node
/**
 * embed-backfill-cli.ts — real-process entrypoint for `embed-backfill.ts`.
 *
 *   npx tsx tools/etl/embed-backfill-cli.ts <dbPath> [--concurrency N] [--actor NAME] [--dry-run]
 *
 * Opens `dbPath` as a REAL store, resolves the embedding backend via THE
 * SAME `bootstrapSemanticStoreMembers` every production host
 * (`cli.ts`/`server.ts`, via `api.ts`'s `writeHandle`) uses to wire
 * `create`/`update`'s on-write embedding — never a bespoke provider call —
 * then runs `runEmbedBackfill` (this dir's `embed-backfill.ts`) against
 * every live issue missing a vector.
 *
 * **Config is read directly off `env.ts`'s own documented env vars**, not
 * through the full `@adhd/environment` cascade: this is one-shot ETL
 * tooling operating against an explicit `dbPath` argument, not a long-lived
 * host resolving a scope root, so pulling in `buildBacklogEnv` would add
 * scope-resolution machinery this binary has no use for. The var names and
 * defaults are copied verbatim from `env.ts`'s `backlogEnvironmentSpec`:
 *   - `ADHD_BACKLOG_EMBEDDING_PROVIDER` (default `'fastembed'`)
 *   - `ADHD_BACKLOG_EMBEDDING_MODEL` (default `'bge-base-en-v1.5'`)
 * `embedding.enabled` is unconditionally `true` here — the whole point of
 * this binary is to embed, so there is no "opt out" flag to honor.
 *
 * Prints one `PROGRESS <rowid> <disposition>` line per candidate to stdout
 * (flushed immediately, unbuffered), then a final `REPORT <json>` line, then
 * exits 0 if `failed` is empty, 1 otherwise. An unexpected exception prints
 * to stderr and exits 2.
 */
import { openEtlStore } from './store-bootstrap.js';
import { bootstrapSemanticStoreMembers } from '../../src/write/bootstrap.js';
import { runEmbedBackfill } from './embed-backfill.js';

interface ICliArgs {
  dbPath: string;
  concurrency?: number;
  actor?: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): ICliArgs {
  const [dbPath, ...rest] = argv;
  if (!dbPath) {
    throw new Error(
      'usage: embed-backfill-cli.ts <dbPath> [--concurrency N] [--actor NAME] [--dry-run]'
    );
  }
  let concurrency: number | undefined;
  let actor: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--concurrency') {
      const value = rest[i + 1];
      if (!value || Number.isNaN(Number(value))) {
        throw new Error('--concurrency requires a numeric argument');
      }
      concurrency = Number(value);
      i += 1;
    } else if (arg === '--actor') {
      const value = rest[i + 1];
      if (!value) throw new Error('--actor requires an argument');
      actor = value;
      i += 1;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return { dbPath, concurrency, actor, dryRun };
}

/** Returns the process exit code the caller should use — never calls `process.exit` itself, so `main` stays a plain, testable async function. */
async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const handle = await openEtlStore(args.dbPath);
  try {
    const cfg = {
      enabled: true,
      provider: process.env.ADHD_BACKLOG_EMBEDDING_PROVIDER ?? 'fastembed',
      model: process.env.ADHD_BACKLOG_EMBEDDING_MODEL ?? 'bge-base-en-v1.5',
    };

    const { embedding } = await bootstrapSemanticStoreMembers(
      handle.adapter,
      handle.graph,
      cfg,
      (message) => process.stderr.write(`${message}\n`)
    );

    if (!embedding) {
      process.stderr.write(
        `embed-backfill-cli.ts: embedding backend did not resolve for provider=${cfg.provider} model=${cfg.model}. ` +
          `Check that @adhd/sox-embedding-provider and @adhd/sox-vector-store are installed and the store's adapter reports capabilities.nativeVectors. ` +
          `See the diagnostic line(s) above (if any) for the specific reason.\n`
      );
      return 2;
    }

    process.stderr.write(
      `embed-backfill-cli.ts: resolved embedding backend modelId=${embedding.modelId} provider=${cfg.provider} model=${cfg.model}\n`
    );

    const startedAt = Date.now();
    const report = await runEmbedBackfill({
      handle,
      embedding,
      actor: args.actor,
      concurrency: args.concurrency,
      dryRun: args.dryRun,
      onItemDispositioned: (info) => {
        process.stdout.write(`PROGRESS ${info.rowid} ${info.disposition} ${info.uid}\n`);
      },
    });
    const durationMs = Date.now() - startedAt;

    process.stdout.write(`REPORT ${JSON.stringify({ ...report, durationMs })}\n`);
    return report.failed.length === 0 ? 0 : 1;
  } finally {
    await handle.close();
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(2);
  });
