#!/usr/bin/env node
// Stdio MCP server used by cp-cache-tool-determinism.e2e.test.ts (9ed453c1 CACHE).
//
// Reproduces the ONE behaviour of `tumf/mcp-shell-server` that breaks prompt caching: the
// `Allowed commands:` line of the `shell_execute` description is rendered from an UNORDERED set,
// so the same configured server advertises a differently-ordered description on every spawn
// (Python: PYTHONHASHSEED; here: a fresh Fisher-Yates shuffle per process). Offline stand-in for
// the real server, which the same e2e also drives through `uvx`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const allow = (process.env.ALLOW_COMMANDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
for (let i = allow.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [allow[i], allow[j]] = [allow[j], allow[i]];
}

const server = new Server({ name: 'shuffled-allowlist-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'shell_execute',
      description: `Execute a shell command\n\nAllowed commands: ${allow.join(', ')}\nAllowed patterns: `,
      inputSchema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
await server.connect(new StdioServerTransport());
