#!/usr/bin/env node
// Stdio MCP server used by tool-schema-normalization.e2e.test.ts (020307a5).
//
// It publishes the shape that broke parity run R11: a tool whose input schema has a TOP-LEVEL `oneOf`
// (the apigen-generated backlog server's `batch_action` does exactly this). `pick` executes for real
// and answers `picked:<its arguments as JSON>`, so a test can see the call arrived with the
// arguments the model chose.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'root-oneof-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'pick',
      description: 'Pick an item by id or by name.',
      inputSchema: {
        type: 'object',
        oneOf: [
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        ],
      },
    },
    { name: 'plain', description: 'A tool with an ordinary schema.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'pick') return { content: [{ type: 'text', text: `picked:${JSON.stringify(args ?? {})}` }] };
  if (name === 'plain') return { content: [{ type: 'text', text: String(args?.text ?? '') }] };
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
