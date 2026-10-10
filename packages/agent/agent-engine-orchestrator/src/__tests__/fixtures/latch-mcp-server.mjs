#!/usr/bin/env node
// Stdio MCP server for 424b6362 (R3-PAR-B): task-shaped tools (`task`, `agent`) whose calls are a
// CROSS-PROCESS LATCH. `task` with id "a"/"b" writes $LATCH_DIR/started-<id>, then waits (bounded by
// $LATCH_DEADLINE_MS) for the OTHER id's started file, and records $LATCH_DIR/done-<id> = {"sawPeer":bool}.
// Overlap is therefore decided by the latch, not by timing. `agent` records $LATCH_DIR/ran-agent when it
// EXECUTES (so a governance denial is observable as the file's absence).
import { existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const dir = process.env.LATCH_DIR;
const deadlineMs = Number(process.env.LATCH_DEADLINE_MS ?? 8000);
const idSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

const server = new Server({ name: 'latch-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'task', description: 'Latch test tool. Pass id "a" or "b".', inputSchema: idSchema },
    { name: 'agent', description: 'Records that it executed. Pass any id.', inputSchema: idSchema },
  ],
}));

/** Resolve true once `file` exists, false at the deadline. Event-driven (fs.watch), no polling loop. */
function waitForFile(file) {
  return new Promise((resolve) => {
    if (existsSync(file)) return resolve(true);
    const watcher = watch(dir, () => { if (existsSync(file)) { cleanup(); resolve(true); } });
    const timer = setTimeout(() => { cleanup(); resolve(existsSync(file)); }, deadlineMs);
    function cleanup() { clearTimeout(timer); watcher.close(); }
    if (existsSync(file)) { cleanup(); resolve(true); }
  });
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const id = String(args?.id ?? '');
  if (name === 'task' && (id === 'a' || id === 'b')) {
    writeFileSync(join(dir, `started-${id}`), '');
    const sawPeer = await waitForFile(join(dir, `started-${id === 'a' ? 'b' : 'a'}`));
    writeFileSync(join(dir, `done-${id}`), JSON.stringify({ sawPeer }));
    return { content: [{ type: 'text', text: `done ${id} sawPeer=${sawPeer}` }] };
  }
  if (name === 'agent') {
    writeFileSync(join(dir, 'ran-agent'), id);
    return { content: [{ type: 'text', text: `agent ran ${id}` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
