#!/usr/bin/env node
import { runInstallCommand } from '../install.js';

// Dedicated bin for agent-mcp MCP registration (BUG-AGENTMCP-006) — the same
// "secondary bin ships in src/scripts/" pattern as `agent-mcp-tail`. The
// server entrypoint (`src/index.ts`) is deliberately untouched: `--help` on
// the server bin still boots the server, and registration lives here.
runInstallCommand(process.argv.slice(2)).catch((err: unknown) => {
  // `install.ts` errors already carry an `agent-mcp-install:` prefix — print
  // the message as-is rather than double-prefixing.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
