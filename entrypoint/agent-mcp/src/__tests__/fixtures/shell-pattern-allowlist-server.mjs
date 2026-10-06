#!/usr/bin/env node
// Minimal stdio MCP server used by native-tooling-pattern-allowlist.e2e.test.ts.
//
// It is a FAITHFUL stand-in for the adopted external server
// (`tumf/mcp-shell-server`, ADR-0008 D7) at the ONE boundary this suite needs to
// exercise: the allow-list decision. It mirrors v1.1.12's
// `CommandValidator.is_command_allowed` exactly —
//
//     cmd = command[0]
//     allowed ⇔ cmd ∈ ALLOW_COMMANDS ∪ { p | re.fullmatch(p, cmd) for ALLOW_PATTERNS }
//
// — so a test can prove the resolver's `ALLOW_PATTERNS` passthrough reaches a
// REAL spawned child process and drives an allow/deny outcome. The genuinely
// external server (fetched from PyPI by `uvx`) is driven live by the gated
// `native-tooling-adoption.e2e.test.ts` (NAT_TOOL_LIVE=1); this fixture never
// touches the network and runs in the default suite.
//
// NOTE: this is the TEST's stand-in for the external boundary — the harness
// under test owns NO regex evaluation (ADR-0008 D5; it only plumbs the env).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** Comma-separated exact NAMES, mirroring the server's ALLOW_COMMANDS reader. */
const allowCommands = new Set(
  (process.env.ALLOW_COMMANDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** Regexes, mirroring the server's ALLOW_PATTERNS reader. */
const allowPatterns = (process.env.ALLOW_PATTERNS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => new RegExp(`^(?:${p})$`)); // Python `re.fullmatch` semantics

/** Mirrors `is_command_allowed`: exact-name set ∪ pattern fullmatch. */
function isCommandAllowed(name) {
  if (allowCommands.has(name)) return true;
  return allowPatterns.some((re) => re.test(name));
}

const server = new Server(
  { name: 'shell-pattern-allowlist-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'shell_execute',
      description: 'Run an allowlisted argv command (fixture).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const argv = Array.isArray(req.params.arguments?.command)
    ? req.params.arguments.command
    : [];
  const name = String(argv[0] ?? '');
  if (!isCommandAllowed(name)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Command not allowed: ${name}` }],
    };
  }
  return {
    content: [{ type: 'text', text: `ran:${argv.join(' ')}` }],
  };
});

await server.connect(new StdioServerTransport());
