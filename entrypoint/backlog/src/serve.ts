/**
 * serve.ts — `backlog serve [--transport mcp|http|both] [--port N] [--host H]`
 * (per the CLI spec §4.5). A thin CLI entry point onto the existing
 * `startBacklogServer` library function (`server.ts`) — the ONLY thing this
 * adds is a process-lifetime wrapper (SIGTERM/SIGINT → `AbortController`,
 * matching `test/fixtures/mcp-stdio-entry.js`'s own proven pattern) so
 * `.mcp.json`'s stdio transport (which just spawns `node dist/index.js serve
 * --transport mcp` and expects the child to speak MCP over stdio
 * indefinitely) has a real, first-class command to point at — before this,
 * `startBacklogServer` was reachable ONLY by importing `@adhd/backlog`
 * programmatically (as the MCP test fixture does), never via the shipped
 * CLI/bin at all.
 *
 * Special-cased in `cli.ts` (like `install-skill`) rather than routed
 * through the apigen CLI-output plugin: `startBacklogServer` is a
 * long-lived listener, not a one-shot `client.ts` op with a JSON
 * request/response shape — it does not fit the "dispatch one command, print
 * one JSON result, exit" model `cliPlugin.run()` implements.
 *
 * BUG-014: `index.ts`'s bin-entry guard calls `initTelemetry({ service:
 * 'backlog', role: 'cli', ... })` unconditionally before ever dispatching —
 * including for this `serve` subcommand, which then runs in the SAME
 * process for its entire multi-day lifetime. Every log line a `serve`
 * session emits (store retries, WAL/turso reconnects, request handling)
 * was stamped `role:'cli'`, identical to a sub-second one-shot `get-item`
 * invocation, making role-based analysis of the JSONL logs impossible
 * without forensic pid/duration pairing. Fixed by re-initialising telemetry
 * here, before entering the long-lived request loop, with the role that
 * actually describes this process from this point on. `Role` (from
 * `@adhd/sox-telemetry`) is a closed union of `'live-service' | 'test' |
 * 'cli' | 'harness'` — there is no `'serve'` member — and `'live-service'`
 * is exactly the population `serve` belongs to per that type's own doc
 * comment ("separates the live-service population from test and harness
 * populations"). `initTelemetry` is safe to call a second time here: it
 * closes the prior sink and opens a new one keyed off
 * `${service}.${role}` (`backlog.live-service`, distinct from
 * `backlog.cli`), and nothing of substance has been logged yet between the
 * bin-entry guard's `role:'cli'` init and this point — `serve` has not
 * dispatched any request handling.
 *
 * BUG-014-LOCK-ORDER: `initTelemetry({ logSink: 'file' })` performs real
 * synchronous file I/O (opens a log file) and is explicitly best-effort —
 * non-fatal by design (see the `catch` around it below): telemetry must
 * never take the server down, and must never delay it either.
 * `startBacklogServer` (server.ts) has its own synchronous prefix (env
 * resolution via `buildBacklogEnv`, `env.ensureDirs()`'s real filesystem
 * work, db-path resolution, and signal-cleanup registration) that runs to
 * completion in the SAME tick, ending only at its first genuine `await`
 * (`openGraphBacklogStore`). Calling `initTelemetry` before
 * `startBacklogServer` (as an earlier version of this fix did) put
 * telemetry's blocking file I/O ahead of that real startup work on the
 * critical path — a best-effort, non-fatal call should never be able to
 * delay the thing it is merely annotating. `startBacklogServer(...)` is
 * therefore invoked FIRST (unawaited) below — its synchronous prefix runs
 * to completion in this same tick before control ever returns here — and
 * `initTelemetry` is called only after that statement, never before. (This
 * ordering previously also protected `[inv:singleton]`'s serve-lock claim
 * window; that lock was removed as unnecessary defense-in-depth — see
 * STATE.md A17 — but the startup-latency reason for the ordering stands on
 * its own and is preserved here.) See `serve.telemetry-role.spec.ts`'s
 * ordering test for the regression proof.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@adhd/environment-base-spec';
import { initTelemetry } from '@adhd/sox-telemetry';
import { startBacklogServer, type StartOpts } from './server.js';
import { BacklogUsageError, failUsage } from './install-skill.js';

export interface RunServeCommandOpts {
  scope?: Scope;
  /** Test-only override — see `buildBacklogEnv`'s `BuildBacklogEnvOptions`. */
  adhdRoot?: string;
  cwd?: string;
  /** Explicit-parameter-first namespace override — see
   *  `BuildBacklogEnvOptions.namespace`'s doc comment. `--namespace sandbox
   *  serve` (cli.ts) sets this to `'sandbox'`, along with minting a fresh
   *  `adhdRoot` and writing D8's sandbox `config.yaml`. */
  namespace?: string;
}

/**
 * BUG-033: `backlog serve --help` used to throw a plain `Error` from
 * `parseArgs` (unknown-argument), which `runServeCommand` neither caught nor
 * short-circuited — the error propagated all the way to `index.ts`'s
 * bin-entry guard, which prints `err.stack` unconditionally, so a completely
 * ordinary "show me the help" request rendered as ten frames of minified
 * dist. Mirrors `install.ts`'s established `--help` + `BacklogUsageError` +
 * `failUsage` pattern exactly: `--help`/`-h` anywhere in argv short-circuits
 * BEFORE parsing, and every argument-parsing failure is a `BacklogUsageError`
 * (never a bare `Error`) so `runServeCommand` can catch it and hand it to
 * `failUsage` instead of letting it reach the bin guard's stack-trace path.
 */
export const SERVE_HELP_TEXT = `backlog serve [--transport mcp|http|both] [--port N] [--host H]

Starts the long-lived backlog server (MCP and/or HTTP), matching one of the
process's own configured transports to the way an agent host or a script
expects to reach it.

  --transport <name>  mcp | http | both (default: mcp)
  --port <N>           HTTP listen port (default: 3300; ignored for mcp-only)
  --host <name>         HTTP listen host (default: 127.0.0.1; ignored for mcp-only)

Examples:
  backlog serve
  backlog serve --transport http --port 3300
  backlog serve --transport both --host 0.0.0.0
`;

function parseArgs(
  argv: string[]
): Pick<StartOpts, 'transport' | 'port' | 'host'> {
  let transport: StartOpts['transport'] = 'mcp';
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transport') transport = argv[++i] as StartOpts['transport'];
    else if (arg === '--port') port = Number(argv[++i]);
    else if (arg === '--host') host = argv[++i];
    else
      throw new BacklogUsageError(
        `backlog serve: unknown argument "${arg}" (expected --transport/--port/--host)`
      );
  }
  if (transport !== 'mcp' && transport !== 'http' && transport !== 'both') {
    throw new BacklogUsageError(
      `backlog serve: --transport must be mcp|http|both, got "${transport}"`
    );
  }
  const opts: Pick<StartOpts, 'transport' | 'port' | 'host'> = { transport };
  if (port !== undefined) opts.port = port;
  if (host !== undefined) opts.host = host;
  return opts;
}

/** Runs until the process receives SIGTERM/SIGINT (the normal way a host
 *  process manager — or `.mcp.json`'s own stdio transport lifecycle — stops
 *  a long-lived MCP/HTTP server), then resolves cleanly. */
export async function runServeCommand(
  argv: string[],
  opts: RunServeCommandOpts = {}
): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(SERVE_HELP_TEXT);
    return;
  }
  let parsed: Pick<StartOpts, 'transport' | 'port' | 'host'>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof BacklogUsageError)
      return failUsage(err, SERVE_HELP_TEXT);
    throw err;
  }
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  // BUG-014-LOCK-ORDER: kick off `startBacklogServer` FIRST, unawaited.
  // Its synchronous prefix (env resolution + `env.ensureDirs()` + signal-
  // cleanup registration, all in server.ts, ahead of its own first `await`)
  // runs to completion in THIS tick, before this function ever reaches the
  // `initTelemetry` call below — so telemetry's best-effort, non-fatal file
  // I/O can never precede or delay the server's real startup work. See the
  // file-level doc comment.
  const serverPromise = startBacklogServer({
    ...parsed,
    ...opts,
    signal: controller.signal,
  });
  // BUG-014: re-stamp this process as the live-service population before
  // any request handling starts — see the file-level doc comment above.
  // Non-fatal by design, matching the bin-entry guard's own contract:
  // telemetry must never take the server down.
  //
  // BUG-BACKLOG-SANDBOX-SERVE-TELEMETRY-001 (found during SPEC.md §5c's
  // `--namespace sandbox serve` proof, entrypoint/backlog): this re-init
  // previously carried NO `logDir` override at all, so it silently UNDID
  // `index.ts`'s bin-entry guard's own sandbox redirect the moment `serve`
  // re-stamped telemetry a few lines below — a real `--namespace sandbox
  // serve` invocation's telemetry ended up written to the REAL, HOME-
  // anchored `~/.adhd/sox-ecosystem/backlog/logs` after all, defeating
  // BUG-BACKLOG-SANDBOX-TELEMETRY-001's guarantee for every long-lived
  // `serve` session (proven empirically: `home/.adhd/sox-ecosystem` was
  // created by a real `--namespace sandbox serve` run against a fake HOME).
  // Mirrors `index.ts`'s own mint-a-fresh-logs-tmpdir pattern, re-keyed off
  // this function's own `opts.namespace` rather than re-parsing argv.
  const sandboxLogDir =
    opts.namespace === 'sandbox'
      ? mkdtempSync(join(tmpdir(), 'backlog-sandbox-logs-'))
      : undefined;
  try {
    initTelemetry({
      service: 'backlog',
      role: 'live-service',
      logSink: 'file',
      ...(sandboxLogDir !== undefined ? { logDir: sandboxLogDir } : {}),
    });
  } catch (err) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed for serve (${
        err instanceof Error ? err.message : String(err)
      }); telemetry records will be silently dropped this process`
    );
  }
  await serverPromise;
}
