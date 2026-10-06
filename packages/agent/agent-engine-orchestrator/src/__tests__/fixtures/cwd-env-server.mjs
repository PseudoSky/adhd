#!/usr/bin/env node
// Minimal stdio MCP server used by nat-tool-3-cwd-env.e2e.test.ts (ADR-0008 D9).
//
// It reports two things about ITS OWN process so a real spawn can prove what
// the engine threaded through:
//   - get_cwd -> process.cwd()      (the spawned child's working directory)
//   - get_env -> ADHD_TEST_CWD_ENV  (an env var injected via subprocessEnv())
//
// Report mode: when ADHD_CWD_REPORT_FILE is set, the server writes its cwd to
// that file and exits BEFORE speaking MCP. The claudecli test uses this: the
// fake `claude` launches this server with an INHERITED cwd (no explicit cwd),
// exactly as Claude Code launches its stdio MCP children, so the written file
// proves the cwd configured on the `claude` process propagated transitively.
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const reportFile = process.env.ADHD_CWD_REPORT_FILE;
if (reportFile) {
  writeFileSync(reportFile, process.cwd() + '\n');
  process.exit(0);
}

const server = new Server(
  { name: 'cwd-env-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_cwd',
      description: 'Return the server process working directory.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_env',
      description: 'Return the ADHD_TEST_CWD_ENV probe value.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === 'get_cwd') {
    return { content: [{ type: 'text', text: process.cwd() }] };
  }
  if (name === 'get_env') {
    return { content: [{ type: 'text', text: process.env.ADHD_TEST_CWD_ENV ?? '' }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
