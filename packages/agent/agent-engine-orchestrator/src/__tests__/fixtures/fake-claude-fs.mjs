#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` that behaves like Claude Code toward its
// `fs` MCP server (9ed453c1 CWD AC5). Unlike fake-claude.mjs (which only launches the servers), this
// one is a real MCP CLIENT of the server the provider wrote into --mcp-config:
//   - it launches the `fs` entry exactly as the config says (command/args/env; inherited cwd),
//   - it advertises the `roots` capability and answers roots/list with ITS OWN process.cwd(),
//     which is what Claude Code does (the reference fs server then REPLACES its argv allow-list
//     with those roots - server-filesystem/dist/index.js),
//   - it reads `marker.txt` under its cwd through the server and records the outcome.
// The record is written to `<cwd>/.fake-claude-fs-report.json` so a test that dispatches the task with
// cwd=/P reads it from /P without injecting any env. Nothing here speaks to a real model.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const mcpConfigPath = flag('--mcp-config');
const cwd = process.cwd();
const report = { cwd, servers: [], text: undefined, error: undefined };

process.stdin.resume();
process.stdin.once('data', async () => {
  try {
    const raw = mcpConfigPath.trimStart().startsWith('{') ? mcpConfigPath : readFileSync(mcpConfigPath, 'utf8');
    const servers = JSON.parse(raw).mcpServers ?? {};
    report.servers = Object.keys(servers);
    const entry = servers.fs;
    if (!entry) throw new Error('no fs server in --mcp-config');
    const client = new Client({ name: 'fake-claude-fs', version: '0.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(cwd).href, name: 'cwd' }],
    }));
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: { ...process.env, ...(entry.env ?? {}) },
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const readTool = tools.includes('read_text_file') ? 'read_text_file' : 'read_file';
    const res = await client.callTool({ name: readTool, arguments: { path: join(cwd, 'marker.txt') } });
    report.text = (res.content ?? []).map((b) => b.text ?? '').join('');
    report.isError = res.isError === true;
    await client.close();
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }
  writeFileSync(join(cwd, '.fake-claude-fs-report.json'), JSON.stringify(report));
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }) + '\n',
    () => process.exit(0)
  );
});
