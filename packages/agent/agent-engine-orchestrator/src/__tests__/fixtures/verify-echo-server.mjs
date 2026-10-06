#!/usr/bin/env node
// Minimal stdio MCP server used by mcp-verify.test.ts (backlog 1f352507).
// Exposes exactly one tool so a real handshake + listTools has something to
// report. It never touches a model.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'verify-echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// A5: this tool appears ONLY when the curated child env (`subprocessEnv()`)
// actually reached this process. It is the observable proof that the verify
// path threads the SAME engine config the task path does.
const envSeen = Boolean(process.env.VERIFY_ENV_TOKEN);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the provided text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    },
    ...(envSeen
      ? [
          {
            name: 'env-seen',
            description: 'Present only when VERIFY_ENV_TOKEN reached the child.',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }],
}));

await server.connect(new StdioServerTransport());
