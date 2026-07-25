#!/usr/bin/env node
// mcp-stdio-entry.js — real subprocess entry point for the MCP-stdio DoD
// test (src/server.mcp.spec.ts, SPEC.md §7 DoD clause 3, MCP variant).
//
// Deliberately plain CommonJS (no TypeScript) so it can be `node`-spawned
// directly by `StdioClientTransport` (which always spawns a child process —
// there is no in-process stdio MCP test possible, since the server side
// would fight the test runner's own stdio channel). Requires the BUILT
// `dist/index.js` — a real consumer path, never a bypass.
//
// argv: [dbAdhdRoot]
const path = require('node:path');

// This fixture is ONLY ever spawned by `StdioClientTransport` in a vitest
// spec, but the SDK's default `getDefaultEnvironment()` (its own
// `stdio.js`) inherits an intentionally narrow allowlist (HOME/LOGNAME/
// PATH/SHELL/TERM/USER) — never the parent's full `process.env` — so
// vitest's own `VITEST=true` never reaches this child process. Stamping it
// here (before `startBacklogServer` builds a `RunInput.logger` via
// `testSilentLogger()` in server.ts) is what silences this subprocess's
// otherwise-real pino output during the test run — confirmed empirically:
// without this line the tool-registration/tool-call log lines still appear
// in the suite's stderr even though the in-process specs went quiet.
process.env.VITEST = 'true';

const distIndexPath = path.join(__dirname, '..', '..', '..', 'dist', 'index.js');
const backlog = require(distIndexPath);

const adhdRoot = process.argv[2];
if (!adhdRoot) {
  process.stderr.write('mcp-stdio-entry: missing adhdRoot argv[2]\n');
  process.exit(1);
}

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

backlog
  .startBacklogServer({ transport: 'mcp', scope: 'project', adhdRoot, signal: controller.signal })
  .catch((err) => {
    process.stderr.write(`mcp-stdio-entry: startBacklogServer failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
