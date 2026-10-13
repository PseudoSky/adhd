// PARITY-INSTRUMENT-ONLY
// Run evidence (SCOPE-R10-prep, PARITY-R10-prep AC2/AC3). Joins the three logs a run already writes into ONE redacted, deterministic bundle that the analysis commands (analyze.mjs) read:
//   - the WIRE capture (logs/wire/proxy-<arm>-anthropic.jsonl, arms A and C): every /v1/messages request body and SSE response -> threads, tools offered, thinking blocks, tool_use inputs, usage;
//   - the agent-mcp API log (logs/api/*.jsonl, arm C): http.request rows carry task_id / session_id / agent, joined to the wire by body sha256 -> the exact thread key of each request;
//   - the agent-mcp TRACING plugin output (logs/trace/*.jsonl, arm C; the plugin is always on, the driver pins its sink and directory): tool_call / model_call / task spans with durations,
//     recursion depth and call ids -> tool timings, same-turn overlap, parent blocking time; and (R10 M1) the wall-attribution signals: tool concurrency class + queued_ms, model-call thinking_config / thinking_blocks,
//     task startup (tools_ready_ms, per-server connect, queue_wait_ms / session_ms when present), dispatch (mode, kind, children, child_task_ids, parent_blocked_ms, call_id, wait_ms) and task model_ms / tool_ms / idle_ms;
//   - mcp-calls.json (arms B, C): the driver's own MCP calls -> task windows (createdAt / completedAt), phase task ids.
// Redaction: the bundle holds NO page text, NO prompt text, NO tool result text, NO thinking text and NO signature (not even a hash). Thinking is recorded as presence + length + a state:
//   'omitted' (a thinking block whose text is empty: the API returned only a signature, so NOBODY may conclude anything from the absence of text), 'text' (the API returned text), and the
//   full per-thread output (text, thinking text when returned, tool_use inputs) goes to a SEPARATE file in the run directory (evidence/threads.jsonl, gitignored with the rest of tmp/).
// Everything here is deterministic and model-free; nothing is signalled, spawned or sent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as L from './lib.mjs';

export const BUNDLE_SCHEMA = 'parity-evidence/1';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const filesIn = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; } };
const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const asObj = (b) => (typeof b === 'string' ? tryJson(b) : b);
const textOfContent = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? (x?.type === 'tool_result' ? textOfContent(x.content) : ''))).join('') : '');

/**
 * Parse one SSE response body into blocks (with text / thinking / tool_use input and the signature kept ONLY in memory, never serialised by the bundle), stop reason and usage.
 * @returns {{blocks:Array<{type:string,name?:string,id?:string,text:string,thinking:string,signature:string,input:any,server:boolean}>, stop:string|null, usage:{in:number|null,out:number|null,cr:number|null,cc:number|null}}}
 */
export function parseSse(body) {
  const o = { blocks: [], stop: null, usage: { in: null, out: null, cr: null, cc: null } }; const byIdx = new Map();
  for (const line of String(body ?? '').split('\n')) {
    if (!line.startsWith('data:')) continue; const d = tryJson(line.slice(5)); if (!d) continue;
    if (d.type === 'message_start') { const u = d.message?.usage ?? {}; o.usage.in = u.input_tokens ?? null; o.usage.cr = u.cache_read_input_tokens ?? null; o.usage.cc = u.cache_creation_input_tokens ?? null; }
    if (d.type === 'content_block_start') { const c = d.content_block ?? {}; const b = { type: c.type, name: c.name, id: c.id ?? c.tool_use_id, text: typeof c.text === 'string' ? c.text : '', thinking: typeof c.thinking === 'string' ? c.thinking : '', signature: typeof c.signature === 'string' ? c.signature : '', json: '', input: c.input, server: c.type === 'server_tool_use' }; byIdx.set(d.index, b); o.blocks.push(b); }
    if (d.type === 'content_block_delta') { const b = byIdx.get(d.index); if (!b) continue; const dl = d.delta ?? {}; if (dl.type === 'text_delta') b.text += dl.text ?? ''; else if (dl.type === 'thinking_delta') b.thinking += dl.thinking ?? ''; else if (dl.type === 'signature_delta') b.signature += dl.signature ?? ''; else if (dl.type === 'input_json_delta') b.json += dl.partial_json ?? ''; }
    if (d.type === 'message_delta') { o.stop = d.delta?.stop_reason ?? o.stop; if (d.usage?.output_tokens != null) o.usage.out = d.usage.output_tokens; }
  }
  for (const b of o.blocks) if (b.json) { b.input = tryJson(b.json) ?? b.input; }
  return o;
}

/** thinking block -> redacted facts. `state`: 'omitted' (empty text, signature only), 'text', or 'empty' (neither). The signature is never returned. */
function thinkingFacts(b) { const chars = b.thinking.length; return { chars, signaturePresent: b.signature.length > 0, state: chars > 0 ? 'text' : b.signature.length > 0 ? 'omitted' : 'empty' }; }

const isDelegationTool = (name) => L.isRunName(name) || /^(Agent|Task)$/.test(String(name));
/** delegation mode of a run tool_use: 'background' when the input says so (agent-mcp `background`, native `run_in_background`), else 'sync'. */
export function delegationMode(input) { return input && (input.background === true || input.run_in_background === true) ? 'background' : 'sync'; }

function blockFacts(b) {
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'thinking', thinking: thinkingFacts(b) };
  if (b.type === 'text') return { type: 'text', chars: b.text.length };
  if (b.type === 'tool_use' || b.type === 'server_tool_use') {
    const inp = b.input && typeof b.input === 'object' ? b.input : {}; const f = { type: b.type, name: b.name, id: b.id, inputKeys: Object.keys(inp).sort() };
    if (isDelegationTool(b.name)) { f.delegation = delegationMode(inp); if (Array.isArray(inp.prompts)) f.items = inp.prompts.length; }
    if (/web_?fetch/i.test(String(b.name))) f.fetch = true;
    return f;
  }
  return { type: b.type };
}

/** The wire log -> request rows (full: with the in-memory text the redacted bundle drops). */
function readWire(dir) {
  const f = filesIn(dir, /^proxy-.*-anthropic\.jsonl$/)[0]; if (!f) return { rows: [], side: 0, t0: null, file: null };
  const L0 = readJsonl(f); const t0 = Date.parse(L0.find((x) => x.type === 'session_start')?.ts);
  const turn = new Map(L0.filter((x) => x.type === 'turn').map((x) => [x.seq, x])); const resp = new Map(L0.filter((x) => x.type === 'raw_response').map((x) => [x.seq, x]));
  const rows = []; let side = 0;
  for (const r of L0.filter((x) => x.type === 'raw_request')) {
    const b = asObj(r.body); if (!b || !Array.isArray(b.messages)) { side++; continue; }
    const t = turn.get(r.seq); const p = parseSse(resp.get(r.seq)?.bodyText);
    rows.push({ seq: r.seq, sha: r.sha256, body: b, startMs: Date.parse(r.ts), endMs: t ? Date.parse(t.ts) : null, ttfbMs: t?.ms_first_byte ?? null, totalMs: t?.ms_total ?? null, status: resp.get(r.seq)?.status ?? t?.status ?? null, parsed: p });
  }
  return { rows, side, t0, file: f };
}

/** trailing user messages of a request (the engine sends parallel tool results as consecutive user messages): the NEW input of this turn. */
function trailingUser(messages) { const out = []; for (let k = messages.length - 1; k >= 0 && messages[k].role === 'user'; k--) out.unshift(messages[k]); return out; }
const blocksOf = (m) => (Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);

/** minimal-span contamination matcher (pure): where does a probed value appear in `text`? */
export function probeForms(value) { if (typeof value === 'number') return [...new Set([value.toFixed(2), String(value)])]; if (value == null || value === '') return []; return [String(value)]; }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function findProbe(text, value, { context = 14, redactSpan = false } = {}) {
  const hits = []; const s = String(text ?? '');
  for (const form of probeForms(value)) {
    const re = typeof value === 'number' ? new RegExp(`(?<![\\d.])${esc(form)}(?!\\d)`, 'g') : new RegExp(esc(form), 'g');
    for (const m of s.matchAll(re)) hits.push({ form, at: m.index, span: redactSpan ? `[${m[0].length} chars]` : s.slice(Math.max(0, m.index - context), m.index + m[0].length + context).replace(/\s+/g, ' ') });
  }
  return hits.sort((a, b) => a.at - b.at).filter((h, i, a) => i === 0 || a[i - 1].at !== h.at);
}

/**
 * Build the redacted bundle of ONE run directory. `probes` = `{label: value}` (default: the q_rate probe, record.expected.carrierRate).
 * @returns {{bundle:object, full:Array<object>}} `full` = per-request full output (text, thinking text when returned, tool_use inputs) for evidence/threads.jsonl, NOT part of the bundle.
 */
export function buildBundle(runDir, { arm, record = null, probes = null, redactSpans = false } = {}) {
  record ??= readJson(path.join(runDir, 'record.json')); arm ??= record?.arm ?? path.basename(runDir)[0];
  const wire = readWire(path.join(runDir, 'logs', 'wire'));
  const api = filesIn(path.join(runDir, 'logs', 'api'), /\.jsonl$/).flatMap(readJsonl).filter((e) => e.event === 'http.request');
  const apiBySha = new Map(api.map((e) => [e.body_sha256, e]));
  const traceEv = filesIn(path.join(runDir, 'logs', 'trace'), /^[^/]*live-service-\d{4}-\d{2}-\d{2}\.jsonl$/).flatMap(readJsonl);
  const opsText = filesIn(path.join(runDir, 'logs', 'ops'), /\.jsonl$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const calls = readJson(path.join(runDir, 'mcp-calls.json')) ?? [];

  // ---- trace (arm C): spans with durations, depth, call ids. No arguments, no results.
  const depthOf = new Map(); const agentOf = new Map();
  for (const e of traceEv) { const t = e['agent.task_id']; if (t) { if (e['agent.recursion_depth'] != null) depthOf.set(t, e['agent.recursion_depth']); if (e['agent.name']) agentOf.set(t, e['agent.name']); } }
  // R10 M1 AC1: the wall-attribution signals (tracing README "Wall-time attribution signals"). Every optional attribute is carried as its value when the emitter wrote it and as `null` when the
  // record does not carry it: an ABSENT attribute is never turned into 0 (the product's own rule), and the reader prints `null` as "not recorded".
  const nz = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const startKey = (e) => `${e['agent.task_id']}\u0000${e['agent.tool.call_id']}`;
  const toolStart = new Map(traceEv.filter((e) => e.event === 'agent.tool_call.start').map((e) => [startKey(e), e]));   // `queued_ms` is written on the START record; the start `ts` is the real start (not end - duration)
  const taskStart = new Map(traceEv.filter((e) => e.event === 'agent.task.start').map((e) => [e['agent.task_id'], e]));
  const startupOf = (e) => { const connect = {}; for (const [k, v] of Object.entries(e)) if (k.startsWith('agent.startup.mcp_connect_ms.') && nz(v) != null) connect[k.slice('agent.startup.mcp_connect_ms.'.length)] = v; return { toolsReadyMs: nz(e['agent.startup.tools_ready_ms']), mcpConnectMs: connect, queueWaitMs: nz(e['agent.startup.queue_wait_ms']), sessionMs: nz(e['agent.startup.session_ms']), tools: nz(e['agent.startup.tools']) }; };
  const startups = new Map(traceEv.filter((e) => e.event === 'agent.task.startup.finish').map((e) => [e['agent.task_id'], startupOf(e)]));
  const trace = { available: traceEv.length > 0,
    toolCalls: traceEv.filter((e) => e.event === 'agent.tool_call.finish' || e.event === 'agent.tool_call.error').map((e) => { const s = toolStart.get(startKey(e)); const endMs = Date.parse(e.ts); const durMs = e.duration_ms ?? null;
      return { task: e['agent.task_id'], depth: e['agent.recursion_depth'] ?? null, name: e['agent.tool.name'], callId: e['agent.tool.call_id'], endMs, durMs, isError: e['agent.tool.is_error'] === true,
        startMs: s ? Date.parse(s.ts) : durMs != null ? endMs - durMs : null, startFrom: s ? 'start-record' : durMs != null ? 'end-minus-duration' : null,
        concurrencyClass: e['agent.tool.concurrency_class'] ?? s?.['agent.tool.concurrency_class'] ?? null, queuedMs: nz(s?.['agent.tool.queued_ms'] ?? e['agent.tool.queued_ms']),
        turnIndex: nz(e['agent.tool.turn_index'] ?? s?.['agent.tool.turn_index']), groupIndex: nz(e['agent.tool.group_index'] ?? s?.['agent.tool.group_index']) }; }),
    modelCalls: traceEv.filter((e) => e.event === 'agent.model_call.finish').map((e) => ({ task: e['agent.task_id'], depth: e['agent.recursion_depth'] ?? null, endMs: Date.parse(e.ts), durMs: e.duration_ms ?? null, tools: e['agent.model_call.tools'] ?? null, stop: e['agent.model_call.stop_reason'] ?? null, toolCalls: e['agent.model_call.tool_calls'] ?? null, out: e['agent.model_call.output_tokens'] ?? null,
      thinkingConfig: e['agent.model_call.thinking_config'] ?? null, thinkingBlocks: nz(e['agent.model_call.thinking_blocks']), ttfbMs: nz(e['agent.model_call.ttfb_ms']), toolResultBytesIn: nz(e['agent.model_call.tool_result_bytes_in']), turnIndex: nz(e['agent.model_call.turn_index']) })),
    tasks: traceEv.filter((e) => e.event === 'agent.task.finish').map((e) => { const s = taskStart.get(e['agent.task_id']); const endMs = Date.parse(e.ts); const durMs = e.duration_ms ?? null;
      return { task: e['agent.task_id'], depth: e['agent.recursion_depth'] ?? null, name: e['agent.name'], outcome: e['agent.outcome'] ?? null, durMs, endMs,
        parent: e['agent.parent_task_id'] ?? null, startMs: s ? Date.parse(s.ts) : durMs != null ? endMs - durMs : null, startFrom: s ? 'start-record' : durMs != null ? 'end-minus-duration' : null,
        modelMs: nz(e['agent.task.model_ms']), toolMs: nz(e['agent.task.tool_ms']), idleMs: nz(e['agent.task.idle_ms']), startup: startups.get(e['agent.task_id']) ?? null }; }),
    // one row per `agent.dispatch.finish` (`.start` carries the same attributes stamped at the same instant and is not an anchor); `childTaskIds` is the comma-joined attribute split
    dispatches: traceEv.filter((e) => e.event === 'agent.dispatch.finish' || e.event === 'agent.dispatch.error').map((e) => ({ task: e['agent.task_id'], parent: e['agent.parent_task_id'] ?? null, depth: e['agent.recursion_depth'] ?? null, endMs: Date.parse(e.ts),
      mode: e['agent.dispatch.mode'] ?? null, kind: e['agent.dispatch.kind'] ?? null, children: nz(e['agent.dispatch.children']),
      childTaskIds: typeof e['agent.dispatch.child_task_ids'] === 'string' && e['agent.dispatch.child_task_ids'] !== '' ? e['agent.dispatch.child_task_ids'].split(',') : null,
      parentBlockedMs: nz(e['agent.dispatch.parent_blocked_ms']), callId: e['agent.dispatch.call_id'] ?? null, waitMs: nz(e['agent.dispatch.wait_ms']) })) };

  // ---- wire rows -> redacted request rows + full output
  const rows = wire.rows; const gen = new Map(); const lastLen = new Map(); const full = []; const requests = [];
  const sigsEmitted = new Map(); const lastReq = new Map();   // thread -> signatures emitted / last request row (in memory only)
  const lastUserText = (msgs) => { for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].role === 'user') { const t = blocksOf(msgs[k]).filter((c) => c.type === 'text'); if (t.length) return t.map((c) => c.text ?? ''); } return []; };   // the last USER message that carries text (a tool_result-only message or a system budget note is skipped)
  const firstFollowUp = rows.filter((r) => lastUserText(r.body.messages).some((t) => /^\s*Follow-up\./.test(t))).map((r) => r.startMs);
  const phaseSplitMs = firstFollowUp.length ? Math.min(...firstFollowUp) : null;
  const contam = []; const pr = probes ?? (record?.expected?.carrierRate != null ? { carrierRate: record.expected.carrierRate } : {});
  const scan = (text, meta) => { for (const [label, value] of Object.entries(pr)) for (const h of findProbe(text, value, { redactSpan: redactSpans })) contam.push({ label, ...meta, form: h.form, span: h.span }); };
  const fetchUrls = []; let bare = 0; const histories = [];
  for (const r of rows) {
    const b = r.body; const m0 = textOfContent(b.messages[0].content); let key = md5(m0);   // the TEXT of the first message: cache_control markers the engine moves between requests must not split a thread
    const len = b.messages.length;
    const g0 = gen.get(key) ?? 0; if (lastLen.has(key + '#' + g0) && len <= lastLen.get(key + '#' + g0)) gen.set(key, g0 + 1);
    const g = gen.get(key) ?? 0; lastLen.set(key + '#' + g, len); const thread = g ? `${key}.${g}` : key;
    const a = apiBySha.get(r.sha); const task = a?.task_id ?? null; if (task && a.agent) agentOf.set(task, a.agent);
    const tools = (b.tools ?? []).map((t) => t.name ?? t.type);
    const tr = []; for (const m of trailingUser(b.messages)) for (const c of blocksOf(m)) if (c.type === 'tool_result') tr.push(c);
    const prevHadErr = tr.some((c) => c.is_error === true);   // this request carries error results of the previous turn's calls: it is the retry round
    const blocks = r.parsed.blocks.map(blockFacts);
    const row = { seq: r.seq, thread, task, agent: a?.agent ?? null, startMs: r.startMs, endMs: r.endMs, ttfbMs: r.ttfbMs, totalMs: r.totalMs, status: r.status, phase: phaseSplitMs != null && r.startMs >= phaseSplitMs ? 2 : 1,
      messages: len, tools, toolsSha: md5(JSON.stringify(tools)), thinkingCfg: b.thinking ?? null, toolResults: tr.length, toolErrors: tr.filter((c) => c.is_error === true).length, retryAfterError: prevHadErr, stop: r.parsed.stop, usage: r.parsed.usage, blocks };
    requests.push(row); lastReq.set(thread, { errs: row.toolErrors });
    // contamination: the thread brief on its first request, the new tool results, the model's text and tool inputs
    const ph = row.phase;
    if (!lastReq.get(thread + '#seen')) { lastReq.set(thread + '#seen', true); scan(textOfContent(b.messages[0].content), { thread, seq: r.seq, phase: ph, channel: 'request.brief' }); }
    for (const c of tr) scan(textOfContent(c.content), { thread, seq: r.seq, phase: ph, channel: 'request.toolResult' });
    for (const bl of r.parsed.blocks) {
      if (bl.type === 'text') scan(bl.text, { thread, seq: r.seq, phase: ph, channel: 'response.text' });
      if (bl.type === 'tool_use' || bl.type === 'server_tool_use') { scan(JSON.stringify(bl.input ?? {}), { thread, seq: r.seq, phase: ph, channel: 'response.toolInput', tool: bl.name }); if (bl.type === 'tool_use' && !String(bl.name).includes('__') && arm === 'C') bare++; if (/web_?fetch/i.test(String(bl.name)) && bl.input?.url) fetchUrls.push(String(bl.input.url)); }
    }
    for (const bl of r.parsed.blocks) if (bl.type === 'thinking' && bl.signature) { (sigsEmitted.get(thread) ?? sigsEmitted.set(thread, []).get(thread)).push({ seq: r.seq, sig: bl.signature }); }
    histories.push({ thread, seq: r.seq, messages: b.messages });
    full.push({ thread, seq: r.seq, startMs: r.startMs, endMs: r.endMs, toolsOffered: tools, thinkingCfg: b.thinking ?? null, stop: r.parsed.stop, usage: r.parsed.usage,
      output: r.parsed.blocks.filter((x) => x.type !== 'web_fetch_tool_result').map((x) => (x.type === 'thinking' ? { type: 'thinking', state: thinkingFacts(x).state, chars: x.thinking.length, text: x.thinking } : x.type === 'text' ? { type: 'text', text: x.text } : x.type === 'tool_use' || x.type === 'server_tool_use' ? { type: x.type, name: x.name, id: x.id, delegation: isDelegationTool(x.name) ? delegationMode(x.input) : undefined, input: x.input } : { type: x.type })) });
  }
  // ---- threads
  const maxTools = Math.max(0, ...requests.map((q) => q.tools.length));
  const threads = [...new Set(requests.map((q) => q.thread))].map((id) => {
    const rs = requests.filter((q) => q.thread === id); const task = rs.find((q) => q.task)?.task ?? null; const depth = task != null ? depthOf.get(task) ?? null : null; const nt = rs[0].tools.length;
    const role = task != null ? (depth === 0 || String(agentOf.get(task) ?? '').startsWith('r2-parent') ? 'parent' : depth != null && depth >= 2 ? 'worker-nested' : 'worker') : nt === maxTools && nt > 0 ? 'parent' : nt === 0 ? 'side' : 'worker';
    return { id, role, task, depth, agent: task != null ? agentOf.get(task) ?? null : null, tools: nt, firstSeq: rs[0].seq, phase: rs[0].phase };
  });
  // ---- RT facts (computed here, where the raw signatures are available; only counts leave this function)
  const rtThinking = {}; const rtDangling = {}; const rtCache = {};
  for (const th of threads) {
    const rs = requests.filter((q) => q.thread === th.id); const emitted = sigsEmitted.get(th.id) ?? [];
    const lastH = histories.filter((h) => h.thread === th.id).pop(); const replayed = new Set();
    for (const m of lastH.messages) if (m.role === 'assistant') for (const c of blocksOf(m)) if (c.type === 'thinking' && c.signature) replayed.add(c.signature);
    const lastSeq = rs[rs.length - 1].seq; const replayable = emitted.filter((e) => e.seq !== lastSeq);
    rtThinking[th.id] = { emitted: emitted.length, replayable: replayable.length, replayedMatched: replayable.filter((e) => replayed.has(e.sig)).length, replayedUnknown: [...replayed].filter((s) => !emitted.some((e) => e.sig === s)).length };
    let dangling = 0; for (const m of lastH.messages) if (m.role === 'assistant') { const bl = blocksOf(m); const ids = new Set(bl.filter((c) => /_tool_result$/.test(c.type)).map((c) => c.tool_use_id)); dangling += bl.filter((c) => c.type === 'server_tool_use' && !ids.has(c.id)).length; }
    rtDangling[th.id] = dangling;
    const pairs = []; for (let i = 1; i < rs.length; i++) { const p = rs[i - 1].usage; const c = rs[i].usage; if ([p.cr, p.cc, p.in, c.cr].some((x) => x == null)) continue; pairs.push({ seq: rs[i].seq, adopted: c.cr >= p.cr + p.cc, literal: c.cr >= p.in + p.cr + p.cc, deficit: Math.max(0, p.in + p.cr + p.cc - c.cr) }); }
    rtCache[th.id] = { pairs: pairs.length, adoptedPass: pairs.filter((x) => x.adopted).length, literalPass: pairs.filter((x) => x.literal).length, literalDeficits: pairs.filter((x) => !x.literal).map((x) => x.deficit), adoptedFailSeqs: pairs.filter((x) => !x.adopted).map((x) => x.seq) };
  }
  const rt = { thinking: rtThinking, dangling: rtDangling, cache: rtCache, fetch: { fetches: fetchUrls.length, uniqueUrls: new Set(fetchUrls).size }, bareNames: arm === 'C' ? bare : null,
    http: { total: requests.length, non200: requests.filter((q) => q.status !== 200).length }, historyDegraded: (opsText.match(/history_degraded/g) ?? []).length };

  // ---- mcp-calls: task windows (arms B/C), text-free
  const tasksIn = (txt) => { const j = tryJson(txt); return Array.isArray(j) ? j : null; };
  const listCall = calls.filter((c) => c?.name === 'task_list' && c.args?.session_id).map((c) => tasksIn(c.text)).find(Boolean) ?? null;
  const taskRows = listCall ? listCall.map((r) => ({ id: r.id, createdAt: r.createdAt ?? null, completedAt: r.completedAt ?? null, status: r.status ?? null })) : [];
  const resultCalls = calls.filter((c) => c?.name === 'result').map((c) => ({ t: c.t, ms: c.ms, task: c.args?.task_id, status: tryJson(c.text)?.status ?? null, wait: c.args?.wait_ms ?? null }));
  const rec = record ? { runId: record.runId, arm: record.arm ?? arm, wallMs: record.wallMs, runWallMs: record.runWallMs ?? null, finishedAt: record.finishedAt, duration: record.duration ?? null, phases: (record.metrics?.phases ?? []).map((p) => ({ phase: p.phase, taskId: p.taskId ?? null, wallMs: p.wallMs ?? null })), probes: pr } : null;
  const bundle = { schema: BUNDLE_SCHEMA, runId: rec?.runId ?? path.basename(runDir), arm, sources: { wire: wire.rows.length > 0, api: api.length > 0, trace: trace.available, calls: calls.length > 0 }, t0Ms: wire.t0, sideRequests: wire.side, phaseSplitMs,
    record: rec, taskRows, resultCalls, threads, requests, trace, rt, contamination: { probes: Object.keys(pr), matches: contam } };
  return { bundle, full };
}

// ---------------------------------------------------------------------------------------------------
// Leak scan (AC3): nothing that looks like a secret, a signature or a given forbidden string (page text) may be in the redacted bundle.
// ---------------------------------------------------------------------------------------------------
/** @returns {{ok:boolean, kinds:Record<string,number>}} counts only; never the matched text. */
export function leakScan(text, { forbidden = [] } = {}) {
  const kinds = {}; const add = (k, n) => { if (n) kinds[k] = (kinds[k] ?? 0) + n; };
  for (const [kind, re] of L.SECRET_PATTERNS) add(kind, (text.match(re) ?? []).length);
  add('signature_like_run', (text.match(/[A-Za-z0-9+/_-]{120,}/g) ?? []).length);
  add('fake_signature', (text.match(/FAKESIGNATURE/g) ?? []).length);
  for (const f of forbidden) if (typeof f === 'string' && f.length >= 3) add('forbidden_text', text.split(f).length - 1);
  return { ok: Object.keys(kinds).length === 0, kinds };
}

/** Write `<runDir>/evidence.json` (redacted bundle) and `<runDir>/evidence/threads.jsonl` (full per-thread output). Returns a small summary for the run record. */
export function writeEvidence({ runDir, arm, record }) {
  const { bundle, full } = buildBundle(runDir, { arm, record });
  const json = JSON.stringify(bundle);
  const forbidden = [record?.expected?.heading].filter(Boolean);
  const scan = leakScan(json, { forbidden });
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  const file = path.join(runDir, 'evidence.json'); fs.writeFileSync(file, scan.ok ? JSON.stringify(bundle, null, 1) : json);
  const threadsFile = path.join(runDir, 'evidence', 'threads.jsonl'); fs.writeFileSync(threadsFile, full.map((x) => JSON.stringify(x)).join('\n') + (full.length ? '\n' : ''));
  const tb = bundle.requests.flatMap((q) => q.blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking));
  return { file: path.relative(runDir, file), threadsFile: path.relative(runDir, threadsFile), sources: bundle.sources, requests: bundle.requests.length, threads: bundle.threads.length,
    thinking: { blocks: tb.length, omitted: tb.filter((t) => t.state === 'omitted').length, withText: tb.filter((t) => t.state === 'text').length,
      note: tb.length && tb.every((t) => t.state === 'omitted') ? 'the API returned thinking blocks with a signature and NO text: thinking text is omitted by the API, so its absence is not evidence about the model reasoning' : null },
    delegation: bundle.requests.flatMap((q) => q.blocks.filter((b) => b.delegation).map((b) => b.delegation)).reduce((a, m) => ({ ...a, [m]: (a[m] ?? 0) + 1 }), {}),
    trace: { toolCalls: bundle.trace.toolCalls.length, modelCalls: bundle.trace.modelCalls.length }, leakScan: scan };
}
