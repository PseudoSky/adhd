#!/usr/bin/env node
// Stdio MCP server used by claudecli-tool-bridge.e2e.test.ts (9ed453c1 BRIDGE).
//
// It makes tool-execution multiplicity OBSERVABLE on disk:
//   - on start it appends its pid to $COUNTING_PID_FILE  (how many server processes ran)
//   - `bump` is deliberately non-idempotent: it appends one line to $COUNTING_COUNTER_FILE and
//     returns `seq=<n>` where n is the new line count      (how many times the tool executed)
//   - `echo` returns args.text unchanged.
//   - `count_items` returns n=<items.length> (n=-1 when `items` arrives as a non-array: argument-coercion probe).
import { appendFileSync, readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const counterFile = process.env.COUNTING_COUNTER_FILE;
const pidFile = process.env.COUNTING_PID_FILE;
if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);

const server = new Server({ name: 'counting-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'bump', description: 'Increment the counter file by one line; returns seq=<n>.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'echo',
      description: 'Return args.text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'count_items',
      description: 'Return n=<items.length>, or n=-1 when items is not an array.',
      inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'bump') {
    if (!counterFile) return { content: [{ type: 'text', text: 'COUNTING_COUNTER_FILE unset' }], isError: true };
    appendFileSync(counterFile, 'x\n');
    const seq = readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;
    return { content: [{ type: 'text', text: `seq=${seq}` }] };
  }
  if (name === 'count_items') return { content: [{ type: 'text', text: `n=${Array.isArray(args?.items) ? args.items.length : -1}` }] };
  if (name === 'echo') return { content: [{ type: 'text', text: String(args?.text ?? '') }] };
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
