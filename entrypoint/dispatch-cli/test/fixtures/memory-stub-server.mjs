#!/usr/bin/env node
/**
 * memory-stub-server.mjs — a REAL stdio MCP server (JSON-RPC over stdio) standing
 * in for the external `memory-server` boundary in the live dispatch e2e.
 *
 * Why a stub and not the real memory server: `memory-server` is an external
 * system (not shipped in this repo), so it is exactly the boundary AGENTS.md §7
 * permits a test to mock. The thing under test — a dispatch-created agent that
 * is born with `memory-server` in its `mcpServers` and actually CALLS
 * `memory_recall` through the real MCP registry — is not mocked: this server is
 * spawned and spoken to over genuine stdio JSON-RPC by the unmodified agent-mcp.
 *
 * The real default wiring (that dispatch-created agents carry a `memory-server`
 * entry at all) is proven separately and by default in
 * `dispatch-default-mcp-servers.e2e.test.ts`.
 *
 * Each `memory_recall` call appends a line to `$MEMORY_STUB_MARKER` (when set)
 * so the test can prove the tool was really invoked, and returns
 * `$MEMORY_STUB_FINDING` (a fixed, known finding).
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const FINDING =
  process.env.MEMORY_STUB_FINDING ??
  'Never stash in this repo — git stash corrupts the nx project graph.';

const server = new Server(
  { name: 'memory-server-stub', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_recall',
      description: 'Recall prior findings for a query.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const marker = process.env.MEMORY_STUB_MARKER;
  if (marker) {
    try {
      appendFileSync(marker, `memory_recall ${JSON.stringify(req.params.arguments)}\n`, 'utf8');
    } catch {
      /* marker is best-effort evidence, never load-bearing for the server */
    }
  }
  return { content: [{ type: 'text', text: FINDING }] };
});

await server.connect(new StdioServerTransport());
