#!/usr/bin/env node
// Dry-run only: a stand-in for `claude -p --output-format stream-json`. MAKES NO NETWORK CALL TO ANY MODEL.
//  * native mode (arm A argv: --tools Bash,...): emulates Bash/Read/Write/Agent/MCP natively, honours --resume
//    (session memory kept in $R2_FAKE_STATE), tags child messages with parent_tool_use_id.
//  * bridge mode (arm B: --mcp-config lists http bridge entries): connects an MCP client to EVERY entry, calls the
//    real bridged tools (so the engine's shell/fs/dispatch/r2probe servers really run), records the stdin message.
// Env: R2_FAKE_STATE (dir), R2_SDK_ROOT (<wt>/node_modules/@modelcontextprotocol/sdk/dist/esm), R2_FAKE_MODE (script mode)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runRole, ROLE_RE } = await import(pathToFileURL(path.join(HERE, 'script.mjs')));
const { priceUsage } = await import(pathToFileURL(path.join(HERE, '..', 'lib.mjs')));

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.1.296 (Claude Code) [r2 fake]'); process.exit(0); }
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const toolsFlag = (() => { const i = argv.indexOf('--tools'); if (i === -1) return null; const out = []; for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(...argv[k].split(',')); return out.filter(Boolean); })();
const STATE = process.env.R2_FAKE_STATE || path.join(process.cwd(), '.r2-fake-state');
fs.mkdirSync(STATE, { recursive: true });
const SDK = process.env.R2_SDK_ROOT;
const MODE = process.env.R2_FAKE_MODE || 'ideal';
const MODEL = flag('--model') || 'claude-haiku-4-5';
const mcpArg = flag('--mcp-config');
const mcpConfig = mcpArg ? JSON.parse(mcpArg.trimStart().startsWith('{') ? mcpArg : fs.readFileSync(mcpArg, 'utf8')) : { mcpServers: {} };
const bridge = Object.values(mcpConfig.mcpServers || {}).some((e) => e.type === 'http' || e.type === 'sse' || e.url);
const resumeId = flag('--resume');
const sid = resumeId || crypto.randomUUID();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const norm = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

let ctxCounters = new Map();             // per parent-id usage simulation
function usageFor(key, outTok = 60) {
  const st = ctxCounters.get(key) || { ctx: 0, first: true };
  const delta = st.first ? (bridge ? 6800 : 9600) : 220;
  const u = { input_tokens: 6, cache_read_input_tokens: st.ctx, cache_creation_input_tokens: delta, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: delta }, output_tokens: outTok };
  st.ctx += delta + 6; st.first = false; ctxCounters.set(key, st);
  return u;
}
const totals = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
function addTotals(u) { totals.input_tokens += u.input_tokens; totals.cache_read_input_tokens += u.cache_read_input_tokens; totals.cache_creation_input_tokens += u.cache_creation_input_tokens; totals.output_tokens += u.output_tokens; totals.cache_creation.ephemeral_1h_input_tokens += u.cache_creation.ephemeral_1h_input_tokens; }

let msgN = 0, toolN = 0, turns = 0;
const sessionMemory = [];

const msgSeen = new Set();
function emitToolUse(name, input, parent, msgIdOverride) {
  const id = msgIdOverride || `msg_fake_${++msgN}`; const tuid = `toolu_fake_${++toolN}`;
  let u = null; if (!msgSeen.has(id)) { msgSeen.add(id); u = usageFor(parent || 'main'); addTotals(u); turns++; }
  emit({ type: 'assistant', parent_tool_use_id: parent || null, message: { id, model: MODEL, role: 'assistant', stop_reason: 'tool_use', usage: u || { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'tool_use', id: tuid, name, input }] } });
  return tuid;
}
function emitToolResult(tuid, text, isError, parent) {
  sessionMemory.push(text);
  emit({ type: 'user', parent_tool_use_id: parent || null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: [{ type: 'text', text }], is_error: !!isError }] } });
}
function emitFinal(text, parent) {
  const id = `msg_fake_${++msgN}`; const u = usageFor(parent || 'main', 120); addTotals(u); turns++;
  emit({ type: 'assistant', parent_tool_use_id: parent || null, message: { id, model: MODEL, role: 'assistant', stop_reason: 'end_turn', usage: u, content: [{ type: 'text', text }] } });
}

async function loadSdk() {
  const c = await import(pathToFileURL(path.join(SDK, 'client/index.js')));
  const s = await import(pathToFileURL(path.join(SDK, 'client/stdio.js')));
  const h = await import(pathToFileURL(path.join(SDK, 'client/streamableHttp.js')));
  return { Client: c.Client, StdioClientTransport: s.StdioClientTransport, StreamableHTTPClientTransport: h.StreamableHTTPClientTransport };
}

const sdk = await loadSdk();
const clients = new Map(); const toolLists = {};
async function connectAll() {
  for (const [name, e] of Object.entries(mcpConfig.mcpServers || {})) {
    const client = new sdk.Client({ name: 'r2-fake-claude', version: '1.0.0' });
    const transport = (e.command)
      ? new sdk.StdioClientTransport({ command: e.command, args: e.args || [], env: { ...process.env, ...(e.env || {}) } })
      : new sdk.StreamableHTTPClientTransport(new URL(e.url), { requestInit: { headers: e.headers || {} } });
    await client.connect(transport);
    clients.set(name, client);
    toolLists[name] = (await client.listTools()).tools.map((t) => t.name);
  }
}
const mcpName = (server, tool) => `mcp__${server}__${tool}`;
async function mcpCall(server, tool, args) {
  const r = await clients.get(server).callTool({ name: tool, arguments: args });
  return { text: (r.content || []).map((b) => b.text || '').join(''), isError: r.isError === true };
}

const sh = (line, cwd) => { const r = spawnSync('/bin/sh', ['-c', line], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }); return { text: `${r.stdout || ''}${r.stderr || ''}`, isError: r.status !== 0 }; };
function editFile(file, oldS, newS) {
  const t = fs.readFileSync(file, 'utf8'); const n = t.split(oldS).length - 1;
  if (n !== 1) return { text: n === 0 ? 'String to replace not found in file.' : `Found ${n} matches of the string to replace`, isError: true };
  fs.writeFileSync(file, t.replace(oldS, () => newS)); return { text: `The file ${file} has been updated.`, isError: false };
}

function nativeIo(parent, depth, prompt) {
  const cwd = process.cwd();
  const nameFor = { shell: 'Bash', read: 'Read', write: 'Write', edit: 'Edit' };
  return {
    cwd: async () => cwd, prompt, history: '', canDispatch: false, canWeb: true,   // real arm A fetches with unrestricted Bash (curl); the fake answers from a canned page, no network
    call: async (kind, a) => {
      let name, input;
      if (kind === 'web') { const tuid = emitToolUse('Bash', { command: `curl -s ${a.url}`, description: 'Fetch the page' }, parent); const text = '<!doctype html><html><body><div><h1>Example Domain</h1></div></body></html>'; emitToolResult(tuid, text, false, parent); return text; }
      if (kind === 'shell') input = { command: a.line, description: 'run' };
      else if (kind === 'read') input = { file_path: a.path };
      else if (kind === 'write') input = { file_path: a.path, content: a.content };
      else if (kind === 'edit') input = { file_path: a.path, old_string: a.old, new_string: a.new };
      else if (kind === 'mkdir') input = { command: `mkdir -p '${a.path}'`, description: 'mkdir' };
      else if (kind === 'ticket') input = {};
      else throw new Error(`native fake has no ${kind}`);
      name = kind === 'ticket' ? mcpName('r2info', 'get_ticket') : nameFor[kind === 'mkdir' ? 'shell' : kind];
      const tuid = emitToolUse(name, input, parent);
      let r;
      try {
        if (kind === 'shell') r = sh(a.line, cwd);
        else if (kind === 'mkdir') r = sh(input.command, cwd);
        else if (kind === 'read') r = { text: fs.readFileSync(a.path, 'utf8').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'), isError: false };
        else if (kind === 'write') { fs.mkdirSync(path.dirname(a.path), { recursive: true }); fs.writeFileSync(a.path, a.content); r = { text: `File created successfully at: ${a.path}`, isError: false }; }
        else if (kind === 'edit') r = editFile(a.path, a.old, a.new);
        else r = await mcpCall('r2info', 'get_ticket', {});
      } catch (e) { r = { text: String(e.message), isError: true }; }
      emitToolResult(tuid, r.text, r.isError, parent);
      return r.text;
    },
    dispatchMany: async (items) => {
      const mid = `msg_fake_${++msgN}`;
      const tuids = items.map((it) => emitToolUse('Agent', { subagent_type: it.name, description: `${it.role} task`, prompt: it.prompt }, parent, mid));
      const replies = [];
      for (let i = 0; i < items.length; i++) {
        const child = nativeIo(tuids[i], depth + 1, items[i].prompt);
        const reply = await runRole({ role: items[i].role, phase: 1, io: child, mode: MODE });
        emitFinal(reply, tuids[i]); replies.push(reply);
      }
      items.forEach((it, i) => emitToolResult(tuids[i], replies[i], false, parent));
      return replies;
    },
  };
}

function bridgeIo(prompt) {
  const cwd = process.cwd();
  const has = (srv, tool) => (toolLists[srv] || []).includes(tool);
  const parseJson = (t) => { try { return JSON.parse(t); } catch { return {}; } };
  const callVia = async (srv, tool, input) => { const tuid = emitToolUse(mcpName(srv, tool), input, null); const r = await mcpCall(srv, tool, input); emitToolResult(tuid, r.text, r.isError, null); return r; };
  const parallelVia = async (calls) => {            // several tool_use blocks in ONE assistant message, executed concurrently
    const mid = `msg_fake_${++msgN}`;
    const tuids = calls.map((c) => emitToolUse(mcpName(c.srv, c.tool), c.input, null, mid));
    const rs = await Promise.all(calls.map((c) => mcpCall(c.srv, c.tool, c.input)));
    rs.forEach((r, i) => emitToolResult(tuids[i], r.text, r.isError, null));
    return rs;
  };
  return {
    cwd: async () => cwd, prompt, history: '', canDispatch: has('agent-mcp', 'agent'), canWeb: false,
    call: async (kind, a) => {
      if (kind === 'shell') return (await callVia('shell', 'shell_execute', { command: a.argv, directory: a.directory })).text;
      if (kind === 'read') return (await callVia('fs', 'read_text_file', { path: a.path })).text;
      if (kind === 'write') return (await callVia('fs', 'write_file', { path: a.path, content: a.content })).text;
      if (kind === 'mkdir') return (await callVia('fs', 'create_directory', { path: a.path })).text;
      if (kind === 'edit') return (await callVia('fs', 'edit_file', { path: a.path, edits: [{ oldText: a.old, newText: a.new }] })).text;
      if (kind === 'ticket') return (await callVia('r2info', 'get_ticket', {})).text;
      throw new Error(kind);
    },
    dispatchMany: async (items) => {
      const sessions = (await parallelVia(items.map((it) => ({ srv: 'agent-mcp', tool: 'agent', input: { name: it.name, cwd } })))).map((r) => parseJson(r.text).session_id);
      const rs = await parallelVia(items.map((it, i) => ({ srv: 'agent-mcp', tool: 'task', input: { session_id: sessions[i], prompt: it.prompt, cwd } })));
      return rs.map((r) => { const j = parseJson(r.text); return String(j.result ?? r.text); });
    },
  };
}

// --- main -------------------------------------------------------------------------------------------------
let stdinBuf = '';
process.stdin.setEncoding('utf8');
let started = false;
process.stdin.on('data', (c) => {
  stdinBuf += c; const nl = stdinBuf.indexOf('\n');
  if (nl !== -1 && !started) { started = true; main(stdinBuf.slice(0, nl)).catch((e) => { console.error('fake-claude error:', e); emit({ type: 'result', subtype: 'error', is_error: true, result: String(e.message), session_id: sid }); process.exit(1); }); }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));

async function main(line) {
  const msg = JSON.parse(line).message;
  const prompt = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((b) => b.text || '').join('');
  fs.writeFileSync(path.join(STATE, `stdin-${sid}-${Date.now()}.txt`), prompt);        // evidence of what phase 2 receives
  await connectAll();
  const names = bridge ? Object.entries(toolLists).flatMap(([s, ts]) => ts.map((t) => mcpName(s, t))) : [...(toolsFlag || []), ...Object.entries(toolLists).flatMap(([s, ts]) => ts.map((t) => mcpName(s, t)))];
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: names, mcp_servers: Object.keys(mcpConfig.mcpServers || {}).map((n) => ({ name: n, status: 'connected' })), model: MODEL, permissionMode: 'bypassPermissions', claude_code_version: '2.1.296-fake' });
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791675600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1791675600 }, seven_day: { utilization: 0.4, resetsAt: 1792047600 } } }, session_id: sid });
  const cur0 = prompt.includes('[Current message]') ? prompt.split('[Current message]').pop() : prompt;   // B replays history ahead of it
  let history = '';
  if (!bridge) { const f = path.join(STATE, `session-${sid}.json`); if (resumeId && fs.existsSync(f)) history = JSON.parse(fs.readFileSync(f, 'utf8')).memory; else if (resumeId) throw new Error(`No conversation found with session ID: ${resumeId}`); }
  else history = prompt;
  const io = bridge ? bridgeIo(cur0) : nativeIo(null, 0, cur0);
  io.history = history;
  const cur = cur0;
  const role = (cur.match(ROLE_RE) || [])[1] || 'parent';
  const phase = /^\s*Follow-up\./.test(cur) ? 2 : 1;
  const reply = await runRole({ role, phase, io, mode: MODE });
  emitFinal(reply, null);
  if (!bridge) fs.writeFileSync(path.join(STATE, `session-${sid}.json`), JSON.stringify({ memory: `${history}\n${sessionMemory.join('\n')}\n${reply}` }));
  // Like the real CLI, `total_cost_usd` and `modelUsage` are SESSION-cumulative on a resumed native session (usage is this turn only).
  const cumFile = path.join(STATE, `cum-${sid}.json`);
  const prev = !bridge && resumeId && fs.existsSync(cumFile) ? JSON.parse(fs.readFileSync(cumFile, 'utf8')) : { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const cum = { input_tokens: prev.input_tokens + totals.input_tokens, cache_read_input_tokens: prev.cache_read_input_tokens + totals.cache_read_input_tokens, cache_creation_input_tokens: prev.cache_creation_input_tokens + totals.cache_creation_input_tokens, output_tokens: prev.output_tokens + totals.output_tokens };
  const cost = priceUsage(totals).usd;
  const cumCost = cost + (prev.cost || 0);
  if (!bridge) fs.writeFileSync(cumFile, JSON.stringify({ ...cum, cost: cumCost }));
  emit({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid, stop_reason: 'end_turn', num_turns: turns, total_cost_usd: bridge ? cost : cumCost, usage: { ...totals, output_tokens_details: { thinking_tokens: 0 } },
    modelUsage: { [MODEL]: { inputTokens: cum.input_tokens, outputTokens: cum.output_tokens, cacheReadInputTokens: cum.cache_read_input_tokens, cacheCreationInputTokens: cum.cache_creation_input_tokens, costUSD: bridge ? cost : cumCost } } });
  for (const c of clients.values()) await c.close().catch(() => {});
}
