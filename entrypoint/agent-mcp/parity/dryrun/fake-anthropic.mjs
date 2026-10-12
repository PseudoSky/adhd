// Dry-run only: a loopback fake of POST /v1/messages (SSE). MAKES NO NETWORK CALL; arm C's provider is pointed
// here via the agent's provider.env.base_url. One coroutine (the same scripted "model" as the fake claude) per
// conversation; each HTTP request either feeds the tool_result block(s) into it or starts it. A response may carry
// SEVERAL tool_use blocks (parallel tool calls in one turn).
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runRole, ROLE_RE } = await import(pathToFileURL(path.join(HERE, 'script.mjs')));

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const blockText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : '';
/** The engine hands tool results to the model as the JSON text of the MCP content array (or a JSON string for errors); unwrap to the plain text. */
const unwrap = (t, depth = 0) => {
  const s = String(t ?? ''); if (depth > 3 || !/^\s*[\["]/.test(s)) return s;
  let v; try { v = JSON.parse(s); } catch { return s; }
  if (Array.isArray(v) && v.every((b) => b && typeof b === 'object' && 'text' in b)) return v.map((b) => b.text ?? '').join('');
  return typeof v === 'string' ? unwrap(v, depth + 1) : s;
};
const userTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')).filter(Boolean);
/** Plain text of the whole conversation so far (user/assistant text and unwrapped tool results), for the scripted model's recall. */
const historyText = (messages) => messages.map((m) => typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? unwrap(blockText(b.content)) : b.type === 'tool_use' ? JSON.stringify(b.input) : '').join('\n')).join('\n');
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const parse = (t) => { try { return JSON.parse(t); } catch { return {}; } };

const warmPrefixes = new Set();   // module scope: like the real prompt cache, it outlives one run (rep 2 reads what rep 1 wrote)
export function startFakeAnthropic({ mode = 'ideal', log = () => {} } = {}) {
  const convs = new Map();
  const stats = { requests: 0, bodies: [], toolNamesSeen: new Set(), hosts: new Set() };
  const pick = (tools, re) => tools.find((x) => re.test(x.name))?.name;

  function makeConv(body, texts) {
    const tools = body.tools || [];
    const T = { shell: pick(tools, /(^|__)shell_execute$/), read: pick(tools, /(^|__)read_text_file$/), write: pick(tools, /(^|__)write_file$/), edit: pick(tools, /(^|__)edit_file$/), mkdir: pick(tools, /(^|__)create_directory$/), list: pick(tools, /(^|__)list_allowed_directories$/),
      ticket: pick(tools, /(^|__)get_ticket$/), agent: pick(tools, /agent-mcp__agent$/), task: pick(tools, /agent-mcp__task$/), web: tools.find((t) => /^web_fetch/.test(t.type || '') || t.name === 'web_fetch')?.name };
    const firstUser = texts[0] || '';
    const cur = texts[texts.length - 1] || '';
    const role = (cur.match(ROLE_RE) || [])[1] || (firstUser.match(ROLE_RE) || [])[1] || 'parent';
    const phase = /^\s*Follow-up\./.test(cur) ? 2 : 1;
    const c = { serverBlocks: [], pendingRes: null, pendingIds: [], signalNext: null, nextP: null, ctx: 0, first: true, turn: 0 };
    c.arm = () => new Promise((r) => { c.signalNext = r; });
    const callMany = (calls) => new Promise((res) => {
      c.pendingRes = res; c.pendingIds = calls.map(() => `toolu_${crypto.randomBytes(6).toString('hex')}`);
      c.signalNext({ tools: calls.map((x, i) => ({ id: c.pendingIds[i], name: x.name, input: x.input })) });
    });
    const callTool = async (name, input) => (await callMany([{ name, input }]))[0];
    let cwd = null;
    const io = {
      history: historyText(body.messages), prompt: cur, canDispatch: !!(T.agent && T.task), canWeb: !!T.web,
      cwd: async () => { if (cwd) return cwd; const t = await callTool(T.list, {}); cwd = [...String(t).matchAll(/(\/[^\s"\\\]]+)/g)].map((m) => m[1]).pop(); if (!cwd) throw new Error(`fake: cannot read cwd from list_allowed_directories: ${String(t).slice(0, 200)}`); return cwd; },
      call: async (kind, a) => {
        if (kind === 'shell') return callTool(T.shell, { command: a.argv, directory: a.directory });
        if (kind === 'read') return callTool(T.read, { path: a.path });
        if (kind === 'write') return callTool(T.write, { path: a.path, content: a.content });
        if (kind === 'mkdir') return callTool(T.mkdir, { path: a.path });
        if (kind === 'edit') return callTool(T.edit, { path: a.path, edits: [{ oldText: a.old, newText: a.new }] });
        if (kind === 'ticket') return callTool(T.ticket, {});
        if (kind === 'web') { const id = `srvtoolu_${crypto.randomBytes(6).toString('hex')}`; c.serverBlocks.push({ id, url: a.url }); return '<h1>Example Domain</h1>'; }   // a SERVER tool: Anthropic runs it inside the same response
        throw new Error(kind);
      },
      dispatchMany: async (items) => {
        const cw = await io.cwd();
        const sess = (await callMany(items.map((it) => ({ name: T.agent, input: { name: it.name, cwd: cw } })))).map((t) => parse(t).session_id);
        const rs = await callMany(items.map((it, i) => ({ name: T.task, input: { session_id: sess[i], prompt: it.prompt, cwd: cw } })));
        return rs.map((t) => String(parse(t).result ?? t));
      },
    };
    c.nextP = c.arm();
    runRole({ role, phase, io, mode }).then((final) => c.signalNext({ final }), (err) => c.signalNext({ error: String(err?.stack || err) }));
    return c;
  }

  const server = http.createServer((req, res) => {
    stats.hosts.add(req.headers.host);
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url)) { res.writeHead(404); res.end('{}'); return; }
      stats.requests++;
      let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{}'); return; }
      stats.bodies.push({ model: body.model, nTools: (body.tools || []).length, toolNames: (body.tools || []).map((t) => t.name), thinking: body.thinking ?? null, max_tokens: body.max_tokens, system: body.system });
      for (const t of body.tools || []) stats.toolNamesSeen.add(t.name);
      const texts = userTexts(body.messages);
      const key = `${sha(texts[0] || '')}#${texts.length}#${sha(JSON.stringify(body.system))}`;
      let c = convs.get(key), next;
      if (!c) { c = makeConv(body, texts); convs.set(key, c); next = await c.nextP; }
      else {
        // the engine sends parallel tool results as consecutive user messages (one per call): gather the whole trailing run
        const blocks = []; for (let k = body.messages.length - 1; k >= 0 && body.messages[k].role === 'user'; k--) if (Array.isArray(body.messages[k].content)) blocks.unshift(...body.messages[k].content);
        const results = c.pendingIds.map((id) => blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === id));
        if (!results.length || results.some((r) => !r)) { res.writeHead(409); res.end(JSON.stringify({ error: 'fake: unexpected request, no matching tool_result(s)' })); return; }
        c.nextP = c.arm(); c.pendingRes(results.map((r) => unwrap(blockText(r.content)))); next = await c.nextP;
      }
      if (next.error) { res.writeHead(500); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: next.error.slice(0, 500) } })); return; }
      if (c.first) { c.warm = warmPrefixes.has(sha(JSON.stringify(body.system))); warmPrefixes.add(sha(JSON.stringify(body.system))); if (c.warm) c.ctx = 8400; }
      const delta = c.first ? (c.warm ? 0 : 8400) : 260; const u = { input_tokens: 5, cache_read_input_tokens: c.first ? (c.warm ? 8400 : 0) : c.ctx, cache_creation_input_tokens: delta, cache_creation: { ephemeral_5m_input_tokens: delta, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 };
      c.ctx += delta + 5; c.first = false; c.turn++;
      const id = `msg_fake_${crypto.randomBytes(5).toString('hex')}`;
      const parts = [ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model || 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: u } })];
      let bi = 0;
      for (const sb of c.serverBlocks.splice(0)) {      // server-executed web_fetch: server_tool_use + its result, inside this very response
        parts.push(ev('content_block_start', { type: 'content_block_start', index: bi, content_block: { type: 'server_tool_use', id: sb.id, name: 'web_fetch', input: {} } }),
          ev('content_block_delta', { type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ url: sb.url }) } }), ev('content_block_stop', { type: 'content_block_stop', index: bi }));
        bi++;
        parts.push(ev('content_block_start', { type: 'content_block_start', index: bi, content_block: { type: 'web_fetch_tool_result', tool_use_id: sb.id, content: { type: 'web_fetch_result', url: sb.url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '<h1>Example Domain</h1> This domain is for use in illustrative examples.' }, title: 'Example Domain' } } } }), ev('content_block_stop', { type: 'content_block_stop', index: bi }));
        bi++;
      }
      if (next.tools) {
        next.tools.forEach((t) => { parts.push(ev('content_block_start', { type: 'content_block_start', index: bi, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } }),
          ev('content_block_delta', { type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } }), ev('content_block_stop', { type: 'content_block_stop', index: bi })); bi++; });
      } else {
        parts.push(ev('content_block_start', { type: 'content_block_start', index: bi, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { type: 'content_block_delta', index: bi, delta: { type: 'text_delta', text: next.final } }), ev('content_block_stop', { type: 'content_block_stop', index: bi }));
      }
      parts.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: next.tools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: next.tools ? 90 : 140 } }), ev('message_stop', { type: 'message_stop' }));
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': `req_fake_${id}`, 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.05', 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.4', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
      res.end(parts.join(''));
      log(`fake-anthropic req#${stats.requests} ${next.tools ? 'tool_use x' + next.tools.length : 'final'}`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}`, port, stats, close: () => new Promise((r) => server.close(() => r())) });
  }));
}
