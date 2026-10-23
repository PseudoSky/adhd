#!/usr/bin/env node
/**
 * cwd-echo-server.mjs — a tiny real stdio MCP server (JSON-RPC over stdio) that
 * reports the working directory it was spawned in via its tool NAME.
 *
 * Why: the NAT-TOOL-5 rework e2e must prove, end-to-end through the real
 * dispatch host + a real spawned agent-mcp child, that the DISPATCHING cwd
 * propagates to a resolved server's process (ADR-0008 D9) — without a model
 * call and without spawning the adopted (external, network-fetching) fs/shell
 * servers. `agent_verify_mcp` returns each verified server's tool names, so a
 * server whose tool is `at_<basename(cwd)>` lets the test read back the cwd the
 * server inherited. This fixture is a test-only stand-in at the EXTERNAL MCP
 * boundary, not product code.
 */
import { basename } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const tag = `at_${basename(process.cwd()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const server = new Server(
  { name: 'cwd-echo', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: tag,
      description: `cwd=${process.cwd()}`,
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: process.cwd() }],
}));

await server.connect(new StdioServerTransport());
