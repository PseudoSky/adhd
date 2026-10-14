// PARITY-INSTRUMENT-ONLY
// Dry-run only: a dependency-free stdio MCP server standing in for the backlog MCP server (`adhd-backlog serve --transport mcp`) in the R11 backlog-operator design.
// MAKES NO NETWORK CALL and never touches the real backlog store. Tools keep the real names and the apigen calling convention ({data:{input:{...}}}):
//   backlog_query (view ready -> the unblocked items), backlog_get, backlog_claim, backlog_transition.
// State: $R2_BACKLOG_ITEMS (a JSON array file, rewritten on a transition). Call log: $R2_BACKLOG_LOG (one JSON line per call: {t, tool, input}); the dry-run e2e reads the
// log to prove the backlog tool call really arrived through performance -> backlog-operator -> agent-mcp.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const itemsFile = process.env.R2_BACKLOG_ITEMS;
const logFile = process.env.R2_BACKLOG_LOG;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const env = { type: 'object', properties: { data: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] } }, required: ['data'] };
const TOOLS = ['backlog_query', 'backlog_get', 'backlog_claim', 'backlog_transition'].map((name) => ({ name, description: `Fake ${name} (parity dry run).`, inputSchema: env }));
const load = () => { try { return JSON.parse(readFileSync(itemsFile, 'utf8')); } catch { return []; } };
const save = (items) => { if (itemsFile) writeFileSync(itemsFile, JSON.stringify(items, null, 2)); };
const text = (o, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(o) }] });

function call(name, input) {
  const items = load();
  if (name === 'backlog_query') {
    const ready = items.filter((i) => i.status === 'open');
    return text({ ok: true, data: { view: input?.view ?? 'list', items: (input?.view === 'ready' ? ready : items).map((i) => ({ uid: i.uid, title: i.title, status: i.status, priority: i.priority })) }, meta: { total: ready.length } });
  }
  const it = items.find((i) => i.uid === input?.uid);
  if (!it) return text({ ok: false, error: { code: 'not_found', message: `no item ${input?.uid}` } }, true);
  if (name === 'backlog_get') return text({ ok: true, data: it });
  if (name === 'backlog_claim') { it.claimedBy = input?.by ?? null; save(items); return text({ ok: true, data: { uid: it.uid, claimedBy: it.claimedBy } }); }
  if (name === 'backlog_transition') { const from = it.status; it.status = input?.toStatus ?? it.status; save(items); return text({ ok: true, data: { uid: it.uid, from, to: it.status } }); }
  return text({ ok: false, error: { code: 'unknown_tool', message: name } }, true);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-backlog', version: '1.0.0' } });
  else if (m.method === 'tools/list') ok({ tools: TOOLS });
  else if (m.method === 'tools/call') {
    const input = m.params?.arguments?.data?.input;
    if (logFile) appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), tool: m.params?.name, input: input ?? null }) + '\n');
    ok(call(m.params?.name, input));
  } else if (m.method === 'ping') ok({});
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
});
