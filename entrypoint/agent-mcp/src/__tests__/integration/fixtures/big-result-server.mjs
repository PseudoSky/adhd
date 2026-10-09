#!/usr/bin/env node
/**
 * big-result-server.mjs — a REAL stdio MCP server (JSON-RPC over stdio) whose
 * single tool, `emit`, returns a deterministic text result of `chars`
 * characters (default 100000). Used by `tool-result-cap.e2e.test.ts`
 * (backlog 3ad735bb AC1.5) to prove an oversize tool result is bounded before
 * the next provider request.
 *
 * Line `n` of the output is `L<n padded to 6>:` + filler, so a head/tail cut is
 * recognisable (first line is `L000001`, the last line carries the highest n).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'big-result-server', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'emit',
      description: 'Return a deterministic text result of the requested length.',
      inputSchema: {
        type: 'object',
        properties: { chars: { type: 'integer' } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const chars = Number(req.params.arguments?.chars ?? 100000);
  let text = '';
  for (let n = 1; text.length < chars; n += 1) {
    text += `L${String(n).padStart(6, '0')}:${'x'.repeat(73)}\n`;
  }
  return { content: [{ type: 'text', text: text.slice(0, chars) }] };
});

await server.connect(new StdioServerTransport());
