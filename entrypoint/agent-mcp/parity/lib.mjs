// PARITY-INSTRUMENT-ONLY
// Round 2 driver helpers: cost model, stream / API-log parsers, call metrics, secret scan, process sweep,
// env allowlist, /usage reader. Everything here is local and model-free.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------------------------------
// Cost model (LEARNINGS item 1): tier-aware cache writes. haiku-4.5 list rates, USD per million tokens.
// ---------------------------------------------------------------------------------------------------
export const RATES_PER_M = { input: 1.0, output: 5.0, cacheRead: 0.10, write5m: 1.25, write1h: 2.0 };

/** Normalise an Anthropic usage object into the fields the cost model prices. */
export function normUsage(u) {
  u = u || {};
  const cc = u.cache_creation || null;
  const total = u.cache_creation_input_tokens || 0;
  let w5m = 0, w1h = 0, untiered = 0;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    w5m = cc.ephemeral_5m_input_tokens || 0; w1h = cc.ephemeral_1h_input_tokens || 0;
    untiered = Math.max(0, total - w5m - w1h);
  } else untiered = total;
  const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, out = u.output_tokens || 0;
  return { in: inp, cr, w5m, w1h, wUntiered: untiered, out, ctx: inp + cr + w5m + w1h + untiered };
}
/** Price a normalised usage. Untiered writes are priced at the 5m rate AND flagged (never silently 1h). */
export function priceNorm(n, rates = RATES_PER_M) {
  const parts = {
    input: n.in * rates.input / 1e6, cacheRead: n.cr * rates.cacheRead / 1e6,
    write5m: (n.w5m + n.wUntiered) * rates.write5m / 1e6, write1h: n.w1h * rates.write1h / 1e6, output: n.out * rates.output / 1e6,
  };
  return { usd: parts.input + parts.cacheRead + parts.write5m + parts.write1h + parts.output, parts, untieredFlag: n.wUntiered > 0 };
}
export const priceUsage = (u, rates) => priceNorm(normUsage(u), rates);
export function sumNorm(list) {
  const t = { in: 0, cr: 0, w5m: 0, w1h: 0, wUntiered: 0, out: 0, ctx: 0 };
  for (const n of list) for (const k of Object.keys(t)) if (k !== 'ctx') t[k] += n[k] || 0;
  t.ctx = Math.max(0, ...list.map((n) => n.ctx));
  return t;
}
/**
 * The arm's expected write tier. Parent turns of A and B (claude CLI) write 1h; C (anthropic OAuth) writes 5m. Native subagent turns
 * of A legitimately write 5m (Round 2 evidence), so for A only the PARENT turns are asserted: pass `parentTotal`. Returns warnings.
 */
export function tierAssertion(arm, total, parentTotal = null) {
  const w = [];
  if (arm === 'C' && total.w1h > 0) w.push(`arm C wrote ${total.w1h} 1h-tier tokens (expected 5m only)`);
  if (arm === 'A') { const p = parentTotal || total; if (p.w5m > 0) w.push(`arm A parent turns wrote ${p.w5m} 5m-tier tokens (expected 1h only)`); }
  if (arm === 'B' && total.w5m > 0) w.push(`arm B wrote ${total.w5m} 5m-tier tokens (expected 1h only)`);
  if (total.wUntiered > 0) w.push(`${total.wUntiered} cache-write tokens carried no tier split (priced at 5m)`);
  return w;
}

// ---------------------------------------------------------------------------------------------------
// Tool-name normalisation: bridged CLI names `mcp__srv__tool`, engine names `srv__tool`, native `Bash`.
// ---------------------------------------------------------------------------------------------------
export function splitToolName(name) {
  let n = String(name || '');
  if (n.startsWith('mcp__')) n = n.slice(5);
  const i = n.lastIndexOf('__');
  return i === -1 ? { server: null, tool: n } : { server: n.slice(0, i), tool: n.slice(i + 2) };
}
export const isDispatchName = (name) => { const s = splitToolName(name); return (s.server == null && /^(Agent|Task)$/.test(s.tool)) || (s.server != null && /^agent[-_]mcp$/.test(s.server) && /^(agent|task)$/.test(s.tool)); };
/**
 * R5-scorefix AC3: text of a server-executed tool result block's `content` (web_fetch_result: content.source.data; web_search_result[]: title/url/snippet lines;
 * *_tool_result_error / *_tool_error: `ERROR <error_code>`). Strings and text-block arrays go through blockText. Returns '' when nothing readable is present.
 */
export function serverResultText(c) {
  if (c == null) return '';
  if (typeof c === 'string' || Array.isArray(c) && !c.some((b) => b && /^web_search_result$/.test(b.type))) return blockText(c);
  if (Array.isArray(c)) return c.map((b) => [b.title, b.url, b.page_age].filter(Boolean).join(' | ')).join('\n');
  if (/_error$/.test(String(c.type))) return `ERROR ${c.error_code ?? c.type}`;
  const doc = c.content; const data = doc?.source?.data ?? (typeof doc === 'string' ? doc : blockText(doc));
  return [c.url ? `url: ${c.url}` : '', data].filter(Boolean).join('\n');
}
export const blockText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string') ? b.text : '').join('') : '';

// ---------------------------------------------------------------------------------------------------
// claude stream-json (arm A stdout, and arm B's spawn.stdout reassembled from the API log)
// ---------------------------------------------------------------------------------------------------
export function parseJsonLines(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) { const t = l.trim(); if (!t.startsWith('{')) continue; try { out.push(JSON.parse(t)); } catch { /* partial line */ } }
  return out;
}
export function parseCliStream(events) {
  const o = { init: null, result: null, results: [], rate: [], msgs: new Map(), order: [], toolUses: new Map(), toolResults: new Map(), denials: [], assistantTexts: [] };
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') o.init = e;
    else if (e.type === 'system' && e.subtype === 'permission_denied') o.denials.push(e);
    else if (e.type === 'rate_limit_event' && e.rate_limit_info) o.rate.push(e.rate_limit_info);
    else if (e.type === 'result') { o.result = e; o.results.push(e); }
    else if (e.type === 'assistant' && e.message) {
      const m = e.message; const id = m.id || `anon${o.order.length}`;
      let rec = o.msgs.get(id);
      if (!rec) { rec = { id, model: m.model, parent: e.parent_tool_use_id ?? null, usage: null, stop: null, tools: [], thinking: false }; o.msgs.set(id, rec); o.order.push(id); }
      if (m.usage) rec.usage = m.usage;                       // LAST usage per message id wins (first-seen is a partial)
      if (m.stop_reason) rec.stop = m.stop_reason;
      for (const b of m.content || []) {
        if (b.type === 'tool_use') { if (!o.toolUses.has(b.id)) { o.toolUses.set(b.id, { id: b.id, name: b.name, input: b.input, parent: rec.parent, msgId: id, seq: o.toolUses.size }); rec.tools.push(b.name); } }
        else if (b.type === 'text' && b.text && !o.assistantTexts.some((t) => t.msgId === id && t.text === b.text)) o.assistantTexts.push({ msgId: id, parent: rec.parent, text: b.text });
        else if (b.type === 'thinking') rec.thinking = true;
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'tool_result') o.toolResults.set(b.tool_use_id, { isError: !!b.is_error, text: blockText(b.content), parent: e.parent_tool_use_id ?? null });
    }
  }
  return o;
}
/** Per-turn rows + totals from a parsed stream. `parent`: null = the main agent; else a child (Agent subagent) turn. */
export function turnsFromCliStream(p) {
  return p.order.map((id, i) => {
    const r = p.msgs.get(id); const n = normUsage(r.usage);
    return { idx: i + 1, id, parent: r.parent, model: r.model, ...n, stop: r.stop, tools: r.tools, thinkingBlock: r.thinking, usd: priceNorm(n).usd };
  });
}
const ZERO_CUM = { usd: 0, in: 0, out: 0, cr: 0, cw: 0 };
/** Sum a CLI `modelUsage` map over all models. */
export function sumModelUsage(mu) {
  const t = { in: 0, out: 0, cr: 0, cw: 0, usd: 0, models: Object.keys(mu || {}) };
  for (const m of Object.values(mu || {})) { t.in += m.inputTokens || 0; t.out += m.outputTokens || 0; t.cr += m.cacheReadInputTokens || 0; t.cw += m.cacheCreationInputTokens || 0; t.usd += m.costUSD || 0; }
  return t;
}
/**
 * The claude CLI's own accounting for one phase (AUTHORITATIVE for arm A). A phase can emit several `result` events and each is cumulative
 * (Round 2: A1 p1 emitted two), and a resumed session is cumulative across phases, so: take the LAST result of the phase, sum `modelUsage`
 * over all models (parent + subagents), and subtract the previous phase's cumulative (`prior`) to get the phase increment.
 * Returns { cumulative, increment, nResults } or null without a result. `increment.usd` is null when the CLI reported no cost.
 */
export function cliPhaseAccounting(results, prior = null) {
  const list = Array.isArray(results) ? results : results ? [results] : [];
  const last = list[list.length - 1]; if (!last) return null;
  const mu = sumModelUsage(last.modelUsage);
  const hasMu = mu.models.length > 0;
  const usd = last.total_cost_usd ?? (hasMu ? mu.usd : null);
  // without modelUsage (old CLI) fall back to the parent-only usage of every result event
  const out = hasMu ? mu.out : list.reduce((a, r) => a + (r.usage?.output_tokens || 0), 0);
  const cumulative = { usd, in: hasMu ? mu.in : 0, out, cr: hasMu ? mu.cr : 0, cw: hasMu ? mu.cw : 0, models: mu.models, fromModelUsage: hasMu };
  const b = prior || ZERO_CUM;
  return { cumulative, increment: { usd: usd == null ? null : usd - b.usd, in: cumulative.in - b.in, out: cumulative.out - b.out, cr: cumulative.cr - b.cr, cw: cumulative.cw - b.cw }, nResults: list.length };
}
/** Price explicit token counts (with the cache-write tier split) at list rates. */
export function priceTokens({ in: i = 0, out = 0, cr = 0, w5m = 0, w1h = 0 }, rates = RATES_PER_M) {
  return (i * rates.input + out * rates.output + cr * rates.cacheRead + w5m * rates.write5m + w1h * rates.write1h) / 1e6;
}
/**
 * Per-message `output_tokens` in a claude stream-json are mid-stream placeholders (Round 1: 31 summed vs 2473 in the result); input and cache
 * counts are exact. Scale the per-turn output so the phase sums to `want` (an ESTIMATE per turn, exact in total) and re-price.
 * `want` is the phase's authoritative output: cliPhaseAccounting().increment.out (whole phase, parent + subagents). A number or a bare
 * result/array is also accepted (legacy callers: result.usage.output_tokens). A non-positive target is a no-op (never scale to <= 0).
 */
export function reconcileCliOutput(turns, wantOrResult) {
  let want = wantOrResult;
  if (want && typeof want === 'object') { const acc = cliPhaseAccounting(want); want = acc ? acc.cumulative.out : undefined; }
  const have = turns.reduce((a, t) => a + t.out, 0);
  if (!(want > 0) || !turns.length || want === have) return turns;
  const f = have > 0 ? want / have : null;
  return turns.map((t, i) => { const out = f != null ? t.out * f : (i === 0 ? want : 0); const n = { ...t, out, outScaled: true }; return { ...n, usd: priceNorm(n).usd }; });
}
/** Parent-level calls (parent === null) joined with their results, in order. */
export function callsFromCliStream(p) {
  return [...p.toolUses.values()].filter((t) => t.parent == null).map((t) => {
    const r = p.toolResults.get(t.id);
    return { id: t.id, name: t.name, input: t.input, isError: r ? r.isError : null, resultText: r ? r.text : null, seq: t.seq };
  });
}
/** EVERY tool call of the stream, parent AND child (native subagent) level, with `depth` 0 for the parent and 1 for a child (R2.AC8 / R6 need the workers' calls too). */
export function allCallsFromCliStream(p) {
  return [...p.toolUses.values()].map((t) => {
    const r = p.toolResults.get(t.id);
    return { id: t.id, name: t.name, input: t.input, isError: r ? r.isError : null, resultText: r ? r.text : null, seq: t.seq, depth: t.parent == null ? 0 : 1 };
  });
}

// ---------------------------------------------------------------------------------------------------
// Anthropic SSE (arm C http.response bodies)
// ---------------------------------------------------------------------------------------------------
/**
 * R6-prep AC3: the CONTEXT a turn sent = the usage of the request as sampled, i.e. `message_start` (what the model read). The final `message_delta` usage is
 * CUMULATIVE over a server-tool turn's internal sampling iterations (web_fetch re-reads the prefix), so it is the right basis for BILLING (`sse.usage`) but ~2x too
 * large for context. Falls back to the billing usage when a stream carries no message_start. Pure.
 */
export function turnContextOf(sse) { return normUsage(sse?.startUsage ?? sse?.usage).ctx; }
export function parseSse(text) {
  const o = { id: null, model: null, usage: {}, startUsage: null, stop: null, texts: [], toolUses: [], thinking: false, outputTokens: null, serverResults: new Map() };
  const blocks = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    let d; try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (d.type === 'message_start') { o.id = d.message.id; o.model = d.message.model; o.usage = { ...d.message.usage }; o.startUsage = { ...d.message.usage }; }
    else if (d.type === 'content_block_start') { blocks.set(d.index, { type: d.content_block.type, name: d.content_block.name, id: d.content_block.id, json: '', text: '' }); if (d.content_block.type === 'thinking') o.thinking = true;
      if (/_tool_result$/.test(String(d.content_block.type)) && d.content_block.tool_use_id) o.serverResults.set(d.content_block.tool_use_id, { isError: /_tool_error$/.test(String(d.content_block.content?.type)), text: serverResultText(d.content_block.content) }); }
    else if (d.type === 'content_block_delta') {
      const b = blocks.get(d.index); if (!b) continue;
      if (d.delta.type === 'text_delta') b.text += d.delta.text; else if (d.delta.type === 'input_json_delta') b.json += d.delta.partial_json;
    } else if (d.type === 'message_delta') {
      if (d.delta?.stop_reason) o.stop = d.delta.stop_reason;
      if (d.usage) { if (d.usage.output_tokens != null) o.outputTokens = d.usage.output_tokens; for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (d.usage[k] != null && d.usage[k] > 0) o.usage[k] = d.usage[k]; }
    }
  }
  for (const b of blocks.values()) {
    if (b.type === 'text' && b.text) o.texts.push(b.text);
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') { let input = {}; try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _unparsed: b.json }; } o.toolUses.push({ id: b.id, name: b.name, input, server: b.type === 'server_tool_use' }); }
  }
  // message_start carries a placeholder output count; the LAST message_delta is authoritative (LEARNINGS item 1)
  o.usage = { ...o.usage, output_tokens: o.outputTokens != null ? o.outputTokens : o.usage.output_tokens };
  return o;
}

// ---------------------------------------------------------------------------------------------------
// agent-mcp API log (<logs>/api/*.jsonl): per-task views for arms B and C
// ---------------------------------------------------------------------------------------------------
export function readJsonlFiles(dir, filter = () => true) {
  const out = []; if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!filter(f)) continue; const p = path.join(dir, f); if (!fs.statSync(p).isFile()) continue;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* ignore */ } }
  }
  return out;
}
export function findApiLogs(logsDir) {
  const d = path.join(logsDir, 'api');
  const direct = readJsonlFiles(d, (f) => f.endsWith('.jsonl'));
  if (direct.length) return direct;
  // some layouts nest by namespace: walk one level
  const all = [];
  if (fs.existsSync(logsDir)) for (const sub of fs.readdirSync(logsDir)) { const p = path.join(logsDir, sub, 'api'); if (fs.existsSync(p)) all.push(...readJsonlFiles(p, (f) => f.endsWith('.jsonl'))); }
  return all;
}
/** Arm B: the claude stream of one task, reassembled from `spawn.stdout` chunks (chunks are NOT line-aligned). */
/**
 * Round 4 thinking invariant: count thinking content blocks across EVERY task of an agent-mcp run (parent AND worker/grandchild tasks), not just the
 * root. B: assistant messages in every spawn.stdout stream (deduped per message id); C: thinking blocks in every http.response SSE body.
 */
export function thinkingBlocksInApiLogs(apiEvents) {
  const stdout = new Map(); let n = 0;
  for (const e of apiEvents || []) {
    if (e.event === 'spawn.stdout') { const k = `${e.task_id}|${e.call_id}`; stdout.set(k, (stdout.get(k) || '') + (e.body || '')); }
    else if (e.event === 'http.response' && e.body && parseSse(e.body).thinking) n++;
  }
  for (const text of stdout.values()) {
    const seen = new Set();
    for (const ev of parseJsonLines(text)) if (ev.type === 'assistant' && ev.message) for (const b of ev.message.content || []) if ((b.type === 'thinking' || b.type === 'redacted_thinking') && !seen.has(`${ev.message.id}|${b.thinking ?? ''}`)) { seen.add(`${ev.message.id}|${b.thinking ?? ''}`); n++; }
  }
  return n;
}
export function cliEventsForTask(apiEvents, taskId) {
  const byCall = new Map(); let truncated = false;
  for (const e of apiEvents) if (e.event === 'spawn.stdout' && e.task_id === taskId) { byCall.set(e.call_id, (byCall.get(e.call_id) || '') + (e.body || '')); if (e.truncated) truncated = true; }
  const events = []; for (const text of byCall.values()) events.push(...parseJsonLines(text));
  const start = apiEvents.find((e) => e.event === 'spawn.start' && e.task_id === taskId);
  return { events, truncated, spawn: start ? { args: start.args, cwd: start.cwd, env_names: start.env_names } : null, spawns: byCall.size };
}
/** Arm C: one entry per model request of a task: request body, parsed SSE, response headers/status. */
export function httpTurnsForTask(apiEvents, taskId) {
  const reqs = new Map(), resps = new Map();
  for (const e of apiEvents) { if (e.task_id !== taskId) continue; if (e.event === 'http.request') reqs.set(e.call_id, e); else if (e.event === 'http.response') resps.set(e.call_id, e); }
  const turns = [];
  for (const [callId, rq] of reqs) {
    const rs = resps.get(callId); let body = null;
    try { body = typeof rq.body === 'string' ? JSON.parse(rq.body) : rq.body; } catch { body = null; }
    turns.push({ callId, ts: rq.ts, body, truncatedReq: !!rq.truncated, status: rs?.status ?? null, headers: rs?.headers ?? {}, sse: rs ? parseSse(rs.body) : null, truncatedResp: !!rs?.truncated });
  }
  return turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
/** Calls + results of an http-turn sequence: tool_use from each response, result from the NEXT request's trailing tool_result blocks. */
export function callsFromHttpTurns(turns) {
  const calls = []; const results = new Map();
  for (const t of turns) {
    const msgs = t.body?.messages || [];
    for (const m of msgs) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, { isError: !!b.is_error, text: blockText(b.content) });
      else if (/_tool_result$/.test(String(b.type)) && b.tool_use_id) results.set(b.tool_use_id, { isError: /_error$/.test(String(b.content?.type)), text: serverResultText(b.content) });   // R5-scorefix AC3: server-executed tool results round-trip in the assistant message
  }
  for (const t of turns) for (const [id, r] of t.sse?.serverResults || []) if (!results.has(id)) results.set(id, r);
  for (const t of turns) for (const u of t.sse?.toolUses || []) { const r = results.get(u.id); calls.push({ id: u.id, name: u.name, input: u.input, isError: r ? r.isError : null, resultText: r ? r.text : null, server: u.server }); }
  return calls;
}
export function rateLimitFromHeaders(h) {
  const get = (k) => h?.[`anthropic-ratelimit-unified-${k}`];
  if (!h || get('status') == null) return null;
  return { status: get('status'), representative: get('representative-claim'), five_hour: { utilization: num(get('5h-utilization')), status: get('5h-status'), reset: get('5h-reset') }, seven_day: { utilization: num(get('7d-utilization')), status: get('7d-status'), reset: get('7d-reset') } };
}
const num = (x) => x == null ? null : Number(x);
export function rateLimitFromCli(info) {
  if (!info) return null; const w = info.unifiedWindows || {};
  return { status: info.status, representative: info.rateLimitType, five_hour: { utilization: w.five_hour?.utilization ?? null, reset: w.five_hour?.resetsAt ?? null }, seven_day: { utilization: w.seven_day?.utilization ?? null, reset: w.seven_day?.resetsAt ?? null } };
}

// ---------------------------------------------------------------------------------------------------
// Call metrics (LEARNINGS 7.6): wasted / error / duplicate calls, parallelism
// ---------------------------------------------------------------------------------------------------
/**
 * Process metrics for one phase (not pass/fail traps). `wasted` = parent-level calls issued AFTER the last green test run
 * (a result containing `fail 0`), i.e. after the work was demonstrably done; null when the tests never went green.
 * `errors` = calls whose result was an error; `duplicates` = identical (name,input) repeats.
 */
export function callMetrics(calls, _exp, _phase) {
  let completeAt = null;
  calls.forEach((c, i) => { if (/(?:^|\s)fail 0\b/m.test(c.resultText || '') && /(^|__)(Bash|shell_execute|shell)$/.test(splitToolName(c.name).tool)) completeAt = i; });
  const seen = new Set(); let dup = 0;
  for (const c of calls) { const key = `${c.name}|${JSON.stringify(c.input)}`; if (seen.has(key)) dup++; seen.add(key); }
  const byTool = {}; for (const c of calls) { const s = splitToolName(c.name); const k = s.server ? `${s.server}__${s.tool}` : s.tool; byTool[k] = (byTool[k] || 0) + 1; }
  return { total: calls.length, errors: calls.filter((c) => c.isError === true).length, duplicates: dup, byTool, completeAt, wasted: completeAt == null ? null : calls.length - completeAt - 1 };
}

// ---------------------------------------------------------------------------------------------------
// Secret scan (node, not shell pipes). Never prints a match; redacts in place and counts per kind.
// ---------------------------------------------------------------------------------------------------
export const SECRET_PATTERNS = [
  ['anthropic_key', /sk-ant-[A-Za-z0-9_-]{16,}/g], ['openai_style_key', /sk-[A-Za-z0-9]{32,}/g], ['github_token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g], ['jwt', /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['bearer', /Bearer\s+(?!\[?REDACTED)[A-Za-z0-9._~+/=-]{24,}/g], ['slack_token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
];
export function redactText(text) {
  const hits = {}; let t = text;
  for (const [kind, re] of SECRET_PATTERNS) t = t.replace(re, () => { hits[kind] = (hits[kind] || 0) + 1; return `[REDACTED:${kind}]`; });
  return { text: t, hits };
}
/** Scan every file under `dir`; redact in place; chmod 600 files / 700 dirs. Returns {files, hits:[{file,kind,count}]}. */
export function scanAndLock(dir) {
  const hits = []; let files = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { walk(p); try { fs.chmodSync(p, 0o700); } catch { /* ignore */ } continue; }
      if (!ent.isFile()) continue; files++;
      let buf; try { buf = fs.readFileSync(p); } catch { continue; }
      if (buf.includes(0) && buf.length > 0 && !/\.(jsonl|json|txt|log|md)$/.test(p)) { try { fs.chmodSync(p, 0o600); } catch { /* ignore */ } continue; }   // binary (sqlite): lock only
      const { text, hits: h } = redactText(buf.toString('utf8'));
      for (const [kind, count] of Object.entries(h)) hits.push({ file: path.relative(dir, p), kind, count });
      if (Object.keys(h).length) fs.writeFileSync(p, text);
      try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
    }
  };
  if (fs.existsSync(dir)) { walk(dir); try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ } }
  return { files, hits };
}

// ---------------------------------------------------------------------------------------------------
// Process tracking: only ever signal processes this driver spawned (or their descendants)
// ---------------------------------------------------------------------------------------------------
export function psTable() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }));
}
export function descendantsOf(rootPids, table = psTable()) {
  const kids = new Map(); for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const seen = new Set(); const stack = [...rootPids]; const found = [];
  while (stack.length) { const pid = stack.pop(); for (const k of kids.get(pid) || []) if (!seen.has(k.pid)) { seen.add(k.pid); found.push(k); stack.push(k.pid); } }
  return found;
}
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Kill (TERM then KILL) the given pids if still alive; never touches pids outside the list. Returns the swept pids. */
export async function sweepPids(pids, graceMs = 1500) {
  const live = [...new Set(pids)].filter(alive); const swept = [...live];
  for (const p of live) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  const t0 = Date.now(); while (Date.now() - t0 < graceMs && live.some(alive)) await new Promise((r) => setTimeout(r, 100));
  for (const p of live) if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  return swept;
}

// ---------------------------------------------------------------------------------------------------
// Environment allowlist (LEARNINGS 7.5; advisor 3). Session-identity vars are stripped for EVERY arm.
// ---------------------------------------------------------------------------------------------------
export const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
/** Verbatim copy of claudecli.ts CLAUDE_SESSION_ENV_DENYLIST (the enclosing Claude Code session's identity). */
export const CLAUDE_SESSION_ENV_DENYLIST = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];
export function cleanEnv(extra = {}, base = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (base[k] !== undefined) env[k] = base[k];
  Object.assign(env, extra);
  for (const k of CLAUDE_SESSION_ENV_DENYLIST) delete env[k];
  return env;
}
/** The two envs the claudecli provider sets for every worker (claudecli.ts buildSubprocessEnv). */
export const CLAUDECLI_PROVIDER_ENVS = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

// ---------------------------------------------------------------------------------------------------
// `claude -p /usage`: local command, 0 model calls (asserted every time)
// ---------------------------------------------------------------------------------------------------
export function parseUsageOutput(stdout) {
  const s = String(stdout || ''); const d = JSON.parse(s.slice(s.indexOf('[')));
  const asst = d.find((e) => e.type === 'assistant'); const res = d.find((e) => e.type === 'result');
  const txt = asst?.message?.content?.[0]?.text ?? '';
  const m = txt.match(/Current session: (\d+)% used(?: · resets ([^\n]+))?/); const wk = txt.match(/Current week \(all models\): (\d+)% used/);
  return { session_pct: m ? +m[1] : null, resets: m?.[2] ?? null, week_pct: wk ? +wk[1] : null, model_calls: res?.num_turns ?? null, cost_usd: res?.total_cost_usd ?? null, text: txt };
}
export function readUsageWindow({ claude = 'claude', model = 'claude-haiku-4-5' } = {}) {
  const r = spawnSync(claude, ['-p', '/usage', '--model', model, '--output-format', 'json'], { cwd: os.tmpdir(), env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
  if (r.status !== 0) throw new Error(`claude -p /usage exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  const u = parseUsageOutput(r.stdout);
  if (u.model_calls !== 0 || (u.cost_usd ?? 0) !== 0) throw new Error(`/usage made model calls (num_turns=${u.model_calls}, cost=${u.cost_usd}); refusing to continue`);
  if (u.session_pct == null) throw new Error('could not parse session percentage from /usage output');
  return { session_pct: u.session_pct, week_pct: u.week_pct, resets: u.resets, model_calls: 0, at: new Date().toISOString() };
}

/** Pacing verdict from a /usage reading and the rate-limit statuses seen so far. SCOPE-R5-pacing-gate: 5h threshold 90% (AC1); the 7-day check is removed (AC2); week_pct is informational only. */
export const PACING = { fiveHourMax: 0.90, okStatuses: ['allowed', 'allowed_warning'] };
export function pacingVerdict(reading, seenRateLimits = []) {
  const reasons = [];
  if (reading.session_pct / 100 >= PACING.fiveHourMax) reasons.push(`5h utilisation ${reading.session_pct}% >= ${PACING.fiveHourMax * 100}%`);
  for (const r of seenRateLimits) {
    if (!r) continue;
    if (r.status && !PACING.okStatuses.includes(r.status)) reasons.push(`rate-limit status ${r.status}`);
    if (r.five_hour?.utilization != null && r.five_hour.utilization >= PACING.fiveHourMax) reasons.push(`5h utilisation ${r.five_hour.utilization} >= ${PACING.fiveHourMax}`);
  }
  return { ok: reasons.length === 0, reasons, warnings: seenRateLimits.filter((r) => r?.status === 'allowed_warning').length };
}

// ---------------------------------------------------------------------------------------------------
// Dispatch evidence (added for the realistic-workflow task)
// ---------------------------------------------------------------------------------------------------
/** A tool call that RUNS a subagent: native Agent/Task, or agent-mcp `task` / `tasks_batch` (the `agent` call only opens a session). */
export const isRunName = (name) => { const s = splitToolName(name); return (s.server == null && /^(Agent|Task)$/.test(s.tool)) || (s.server != null && /^agent[-_]mcp$/.test(s.server) && /^(task|tasks_batch)$/.test(s.tool)); };
export const isBatchName = (name) => { const s = splitToolName(name); return s.server != null && /^agent[-_]mcp$/.test(s.server) && s.tool === 'tasks_batch'; };
/** How many subagent runs one run tool_use launches: a tasks_batch fans out (its array length, at least 2), anything else is 1. */
export function runCount(name, input) {
  if (!isBatchName(name)) return 1;
  const lens = Object.values(input || {}).filter(Array.isArray).map((a) => a.length);
  return Math.max(2, ...lens);
}
/**
 * Were >= 2 subagent runs outstanding at the same moment in a stream (parent level only)? Counts two run tool_use
 * blocks of one assistant message id, a second run tool_use before the first run's tool_result, or one tasks_batch of >= 2.
 */
export function parallelFromCliEvents(events) {
  const out = new Set(); const msgOf = new Map(); let maxOutstanding = 0, sameMsg = false, runs = 0;
  for (const e of events) {
    if (e.type === 'assistant' && e.message && (e.parent_tool_use_id ?? null) === null) {
      for (const b of e.message.content || []) if (b.type === 'tool_use' && isRunName(b.name) && !out.has(b.id)) {
        const n = runCount(b.name, b.input); runs += n; out.add(b.id); const k = e.message.id || ''; msgOf.set(k, (msgOf.get(k) || 0) + n); if (msgOf.get(k) >= 2) sameMsg = true; maxOutstanding = Math.max(maxOutstanding, out.size, n);
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content) && (e.parent_tool_use_id ?? null) === null) {
      for (const b of e.message.content) if (b.type === 'tool_result') out.delete(b.tool_use_id);
    }
  }
  return { runs, sameTurn: sameMsg || maxOutstanding >= 2, maxOutstanding };
}
/** Same question for arm C: two run tool_use blocks inside one SSE response. */
export function parallelFromHttpTurns(turns) {
  let runs = 0, same = false;
  for (const t of turns) { const n = (t.sse?.toolUses || []).filter((u) => isRunName(u.name)).reduce((a, u) => a + runCount(u.name, u.input), 0); runs += n; if (n >= 2) same = true; }
  return { runs, sameTurn: same };
}
/**
 * R1.AC6 (90758419 AC3): did >= 2 CHILD runs overlap, judged by outcome? `items` is the stream in order: `{ parent: <parent_tool_use_id|null>, ts?: <ms> }`.
 * Native `Agent` returns "Async agent launched" instantly, so outstanding-counting cannot see parallelism; instead two children overlap when
 * their event index ranges interleave (child 2 starts before child 1's last event and vice versa) or, when every event of both has a timestamp, when
 * their time intervals intersect. Pure.
 * @returns {{children:number, interleaved:boolean, basis:'timestamps'|'stream-order'}}
 */
export function childrenInterleaved(items) {
  const r = new Map();
  items.forEach((it, i) => { if (it.parent == null) return; const x = r.get(it.parent) ?? { first: i, last: i, t0: null, t1: null, ts: true }; x.last = i; if (Number.isFinite(it.ts)) { x.t0 = x.t0 == null ? it.ts : Math.min(x.t0, it.ts); x.t1 = x.t1 == null ? it.ts : Math.max(x.t1, it.ts); } else x.ts = false; r.set(it.parent, x); });
  const ids = [...r.keys()]; let order = false, time = false, allTs = ids.length > 0;
  for (const x of r.values()) if (!x.ts || x.t0 == null) allTs = false;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = r.get(ids[i]), b = r.get(ids[j]);
    if (a.first < b.last && b.first < a.last) order = true;
    if (allTs && a.t0 < b.t1 && b.t0 < a.t1) time = true;
  }
  return { children: ids.length, interleaved: allTs ? time : order, basis: allTs ? 'timestamps' : 'stream-order' };
}
/** `childrenInterleaved` over raw claude stream-json events (a child event carries `parent_tool_use_id`; `timestamp`/`ts` is used when present). */
export function childrenInterleavedFromEvents(events) {
  return childrenInterleaved(events.filter((e) => e && (e.type === 'assistant' || e.type === 'user')).map((e) => ({ parent: e.parent_tool_use_id ?? null, ts: Date.parse(e.timestamp ?? e.ts ?? '') })));
}
/**
 * R1.AC2 (90758419 AC1) cache-carry inputs for arms A and B: the phase-1 LAST parent turn's cache_read + cache_create (NOT `ctx`, which also counts fresh input)
 * and the phase-2 FIRST parent turn's cache_read. Turns are the normalised rows of `turnsFromCliStream` (`parent` null = main agent). Nulls when a phase has no parent turn.
 */
export function cacheCarryFromTurns(p1Turns, p2Turns) {
  const par = (ts) => (ts || []).filter((t) => t.parent == null);
  const last = par(p1Turns).slice(-1)[0], first = par(p2Turns)[0];
  return { p1LastTurnCtx: last ? (last.cr || 0) + (last.w5m || 0) + (last.w1h || 0) + (last.wUntiered || 0) : null, p2FirstTurnCacheRead: first ? (first.cr || 0) : null };
}
/**
 * R1.AC2 arm C: does the FIRST phase-2 request contain the phase-1 `get_ticket` result? `p1Http` / `p2Http` are the per-request records of
 * `httpTurnsForTask` (`sse.toolUses[]` out, `body.messages[]` in). null when phase 1 made no get_ticket call or phase 2 has no request (no data, not a failure).
 */
export function ticketCarriedToPhase2(p1Http, p2Http) {
  const ids = new Set((p1Http || []).flatMap((t) => t.sse?.toolUses || []).filter((u) => /(^|__)get_ticket$/.test(String(u.name))).map((u) => u.id));
  const first = (p2Http || [])[0]; if (!ids.size || !first) return null;
  for (const m of first.body?.messages || []) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result' && ids.has(b.tool_use_id)) return true;
  return false;
}
/** Time overlap of the given task rows (createdAt..completedAt ISO strings): min(completed) - max(created), ms. */
export function overlapMs(rows) {
  const s = rows.map((r) => Date.parse(r.createdAt)), e = rows.map((r) => Date.parse(r.completedAt));
  if (rows.length < 2 || s.concat(e).some(Number.isNaN)) return null;
  return Math.min(...e) - Math.max(...s);
}
/** Task rows created within this many ms of each other belong to ONE dispatch group (a single tasks_batch call creates its rows within a few ms). */
export const DISPATCH_GROUP_WINDOW_MS = 2000;
/**
 * R5-scorefix AC1: the overlap of the INTENDED parallel pair. Depth-1 rows are clustered into dispatch groups (single-link on createdAt, gap <= windowMs: one
 * `tasks_batch` call creates its rows ~1 ms apart, a lone `task` call is a group of one). The intended pair is the FIRST group of two or more rows, and the
 * overlap is the N-way min(completed) - max(created) of THAT group only, so extra model-chosen workers dispatched before or after it cannot turn a real
 * overlap into a fail. When no group has two or more rows (every worker was dispatched on its own) the answer is the overlap of all rows, which is what a
 * background-task run (separate turns, overlapping rows) needs and is negative for a truly sequential run.
 * Returns { overlapMs: n|null, group: string[] (row ids of the scored rows), basis: 'first-batch-group' | 'all-rows' }.
 */
export function intendedPairOverlap(rows, windowMs = DISPATCH_GROUP_WINDOW_MS) {
  const withT = rows.map((r, i) => ({ r, i, t: Date.parse(r.createdAt) })).filter((x) => !Number.isNaN(x.t)).sort((a, b) => a.t - b.t || a.i - b.i);
  const groups = []; let prev = null;
  for (const x of withT) { if (prev != null && x.t - prev <= windowMs) groups[groups.length - 1].push(x.r); else groups.push([x.r]); prev = x.t; }
  const g = groups.find((x) => x.length >= 2);
  const use = g ?? rows;
  return { overlapMs: overlapMs(use.map((r) => ({ createdAt: r.createdAt, completedAt: r.completedAt }))), group: use.map((r) => r.id ?? null), basis: g ? 'first-batch-group' : 'all-rows' };
}
