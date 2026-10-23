#!/usr/bin/env node
/**
 * shell-like-server.mjs — a REAL stdio MCP server shaped like the shell MCP
 * server: its single tool, `shell_execute`, declares `command` as an ARRAY OF
 * STRING (schema copied from the OAuth-run capture) and, like the real server,
 * rejects a non-array `command` with an `isError` result. Used by
 * `tool-arg-coercion.e2e.test.ts` (backlog 114e014c AC2.4). It never executes
 * anything: a valid call echoes the argv it received as JSON.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'shell-like-server', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'shell_execute',
      description: 'Execute a shell command (echo-only test double)',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command and its arguments as array',
          },
          stdin: { type: 'string', description: 'Input to be passed to the command via stdin' },
          timeout: { type: 'integer', minimum: 1 },
        },
        required: ['command'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const command = req.params.arguments?.command;
  if (!Array.isArray(command) || !command.every((c) => typeof c === 'string')) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `Invalid arguments: command must be an array of strings, got ${typeof command}` },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, argv: command }) }] };
});

await server.connect(new StdioServerTransport());
