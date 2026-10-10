#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` that behaves like the REAL CLI with
// respect to MCP (9ed453c1 BRIDGE): it parses `--mcp-config`, connects an MCP client to EVERY
// entry in it (stdio: spawn command/args/env; http/sse: the MCP SDK Streamable-HTTP client with
// the entry's headers), and executes the tool calls the "model" (the prompt) asks for through
// those connections. It then emits stream-json `assistant{tool_use}`, `user{tool_result}` (its own
// result), and `result`. Every stdin line the provider writes is appended to
// $ADHD_FAKE_CLAUDE_STDIN_LOG so a synthetic stdin tool_result is observable.
//
// The prompt is JSON: {"calls":[{"server":"counter","tool":"bump","args":{}}, ...]}.
// Env: ADHD_FAKE_CLAUDE_OUT  = file receiving {cwd, mcpConfigRaw, mcpConfig, configMode, toolNames, results}
//      ADHD_FAKE_CLAUDE_MODE = 'fail' (emit an is_error result) | 'hang' (connect, record, never answer)
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const norm = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

// argv + env values are recorded so tests can prove no credential is ps-visible (9ed453c1 BLIND F6c).
const mcpConfigArg = flag('--mcp-config');
const stdinLog = process.env.ADHD_FAKE_CLAUDE_STDIN_LOG;
const selfOut = process.env.ADHD_FAKE_CLAUDE_OUT;

const inline = mcpConfigArg?.trimStart().startsWith('{');
const mcpConfig = mcpConfigArg ? JSON.parse(inline ? mcpConfigArg : readFileSync(mcpConfigArg, 'utf8')) : { mcpServers: {} };
const configMode = inline ? null : (statSync(mcpConfigArg).mode & 0o777);

function noop() {
  /* intentionally empty: keepalive / swallowed close error */
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

let buffered = '';
let handled = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (!line.trim()) continue;
    if (stdinLog) appendFileSync(stdinLog, line + '\n');
    if (!handled) { handled = true; void run(line); }
  }
});

async function connect(name, entry) {
  const client = new Client({ name: 'fake-claude', version: '1.0.0' });
  const transport = entry.type === 'stdio'
    ? new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env: { ...process.env, ...(entry.env ?? {}) } })
    : new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers ?? {} } });
  await client.connect(transport);
  return client;
}

async function run(line) {
  const prompt = JSON.parse(JSON.parse(line).message.content);
  const clients = new Map();
  const toolNames = [];
  const toolListing = {};
  for (const [name, entry] of Object.entries(mcpConfig.mcpServers ?? {})) {
    const client = await connect(name, entry);
    clients.set(name, client);
    const listed = (await client.listTools()).tools;
    toolListing[name] = listed;
    for (const t of listed) toolNames.push(`mcp__${norm(name)}__${norm(t.name)}`);
  }
  emit({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' });
  const mode = process.env.ADHD_FAKE_CLAUDE_MODE;
  if (mode === 'hang' || mode === 'fail') {
    if (selfOut) writeFileSync(selfOut, JSON.stringify({ cwd: process.cwd(), mcpConfig, mcpConfigRaw: mcpConfigArg, configMode, argv, envValues: Object.values(process.env), toolNames, results: [] }));
    if (mode === 'hang') { setInterval(noop, 1e6); return; }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom' }) + '\n', () => process.exit(0));
    return;
  }
  const results = [];
  let n = 0;
  const callOne = async (call, id, idx) => {
    const client = clients.get(call.server);
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: `mcp__${norm(call.server)}__${norm(call.tool)}`, input: call.args ?? {} }],
        // ADHD_FAKE_CLAUDE_USAGE=1: report per-call usage like the real CLI (3 calls -> context 1010 / 1020 / 1030).
        ...(process.env.ADHD_FAKE_CLAUDE_USAGE === '1'
          ? { id: `msg_${idx}`, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 + (idx - 1) * 10, cache_creation_input_tokens: 0 } }
          : {}),
      },
    });
    let text;
    let isError = false;
    try {
      const r = await client.callTool({ name: call.tool, arguments: call.args ?? {} });
      text = (r.content ?? []).map((b) => b.text ?? '').join('');
      isError = r.isError === true;
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
      isError = true;
    }
    results[idx - 1] = { id, text, isError };
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] } });
  };
  const calls = prompt.calls ?? [];
  if (prompt.parallel === true) {
    // 424b6362 AC6: issue every call SIMULTANEOUSLY (as the real CLI does for hinted same-message calls).
    await Promise.all(calls.map((call, i) => callOne(call, `toolu_${i + 1}`, i + 1)));
  } else {
    for (const call of calls) { n += 1; await callOne(call, `toolu_${n}`, n); }
  }
  for (const c of clients.values()) await c.close().catch(noop);
  if (selfOut) {
    writeFileSync(selfOut, JSON.stringify({ cwd: process.cwd(), mcpConfig, mcpConfigRaw: mcpConfigArg, configMode, argv, envValues: Object.values(process.env), toolNames, toolListing, results }));
  }
  process.stdout.write(
    JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: results.map((r) => r.text).join('|') || 'OK', num_turns: results.length + 1,
      ...(process.env.ADHD_FAKE_CLAUDE_USAGE === '1'
        ? { total_cost_usd: 0.004, usage: { input_tokens: 10 * results.length, output_tokens: 5 * results.length, cache_read_input_tokens: 3030, cache_creation_input_tokens: 0 } }
        : {}),
    }) + '\n',
    () => process.exit(0)
  );
}
