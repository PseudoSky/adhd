/**
 * serve.ts — `backlog serve [--transport mcp|http|both] [--port N] [--host H]`
 * (MIGRATION.md §4.5). A thin CLI entry point onto the existing
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
 * synchronous file I/O (opens a log file). `startBacklogServer` (server.ts)
 * claims the `[inv:singleton]` writer lock (`store/serve-lock.ts`,
 * `acquireServeLock`) SYNCHRONOUSLY, before its first `await` — but only if
 * nothing runs ahead of it that could stretch the window between two
 * concurrent `serve` starts. Calling `initTelemetry` before
 * `startBacklogServer` (as an earlier version of this fix did) put that
 * synchronous file I/O ahead of lock acquisition on the critical path,
 * which is never correct ordering for a singleton guard regardless of
 * whether it can be proven to flip an observed test result: the guard
 * should never have anything unrelated to its own correctness able to
 * widen its claim window. `startBacklogServer(...)` is therefore invoked
 * FIRST (unawaited) below — its synchronous prefix, ending at its own
 * first `await` (well past `acquireServeLock`), runs to completion in this
 * same tick before control ever returns here — and `initTelemetry` is
 * called only after that statement, never before. See
 * `serve.telemetry-role.spec.ts`'s ordering test for the regression proof.
 */
import type { Scope } from '@adhd/environment-base-spec';
import { initTelemetry } from '@adhd/sox-telemetry';
import { startBacklogServer, type StartOpts } from './server.js';

export interface RunServeCommandOpts {
  scope?: Scope;
  /** Test-only override — see `buildBacklogEnv`'s `BuildBacklogEnvOptions`. */
  adhdRoot?: string;
  cwd?: string;
}

function parseArgs(argv: string[]): Pick<StartOpts, 'transport' | 'port' | 'host'> {
  let transport: StartOpts['transport'] = 'mcp';
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transport') transport = argv[++i] as StartOpts['transport'];
    else if (arg === '--port') port = Number(argv[++i]);
    else if (arg === '--host') host = argv[++i];
    else throw new Error(`backlog serve: unknown argument "${arg}" (expected --transport/--port/--host)`);
  }
  if (transport !== 'mcp' && transport !== 'http' && transport !== 'both') {
    throw new Error(`backlog serve: --transport must be mcp|http|both, got "${transport}"`);
  }
  const opts: Pick<StartOpts, 'transport' | 'port' | 'host'> = { transport };
  if (port !== undefined) opts.port = port;
  if (host !== undefined) opts.host = host;
  return opts;
}

/** Runs until the process receives SIGTERM/SIGINT (the normal way a host
 *  process manager — or `.mcp.json`'s own stdio transport lifecycle — stops
 *  a long-lived MCP/HTTP server), then resolves cleanly. */
export async function runServeCommand(argv: string[], opts: RunServeCommandOpts = {}): Promise<void> {
  const parsed = parseArgs(argv);
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  // BUG-014-LOCK-ORDER: kick off `startBacklogServer` FIRST, unawaited.
  // Its synchronous prefix (env resolution + the `[inv:singleton]`
  // `acquireServeLock` call, both in server.ts, ahead of its own first
  // `await`) runs to completion in THIS tick, before this function ever
  // reaches the `initTelemetry` call below — so telemetry's file I/O can
  // never precede lock acquisition. See the file-level doc comment.
  const serverPromise = startBacklogServer({ ...parsed, ...opts, signal: controller.signal });
  // BUG-014: re-stamp this process as the live-service population before
  // any request handling starts — see the file-level doc comment above.
  // Non-fatal by design, matching the bin-entry guard's own contract:
  // telemetry must never take the server down.
  try {
    initTelemetry({ service: 'backlog', role: 'live-service', logSink: 'file' });
  } catch (err) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed for serve (${
        err instanceof Error ? err.message : String(err)
      }); telemetry records will be silently dropped this process`,
    );
  }
  await serverPromise;
}
