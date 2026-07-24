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
 */
import type { Scope } from '@adhd/environment-base-spec';
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
  await startBacklogServer({ ...parsed, ...opts, signal: controller.signal });
}
