// PARITY-INSTRUMENT-ONLY
// Offline reader for the capture proxy's logs (R6B-proxy AC5): what context did each arm actually SEND to the provider?
//
//   node wire-diff.mjs <run-dir | logs/wire dir | proxy-*.jsonl ...>
//
// Per arm: system text, tool names / count / bytes of the tools JSON, first-request message count and bytes, per-turn input and cache usage.
// Then a side-by-side delta of the arms' first requests: tool names present/absent per arm, whether the system text is equal.
// "First request" = the first request of the arm that declares tools (the main agent turn); the claude CLI also makes tool-less side calls
// (title / quota probes), so every request's model is listed too. Offline, no network, no model call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve a run dir, a wire dir or explicit files to the list of proxy-*.jsonl files. */
export function resolveWireFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`wire-diff: no such path ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const dir of [abs, path.join(abs, 'logs', 'wire')]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).sort()) if (/^proxy-.+\.jsonl$/.test(f)) out.push(path.join(dir, f));
        if (out.length) break;
      }
    } else out.push(abs);
  }
  return [...new Set(out)];
}

/** Parse JSONL leniently (a truncated final line, or a secret-scan marker, never aborts the report). */
export function readEvents(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const textOfContent = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : '');
const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null));

/** Normalise one request body (Anthropic /v1/messages or OpenAI chat/completions) to the comparable facts. */
export function describeRequest(body) {
  if (!body || typeof body !== 'object') return { kind: 'non-json', system: '', tools: [], toolsBytes: 0, messageCount: 0, messagesBytes: 0, model: null, effort: null, thinking: null };
  const isAnthropic = 'system' in body || (Array.isArray(body.messages) && body.max_tokens !== undefined && !Array.isArray(body.tools?.[0]?.function) && body.tools?.[0]?.type !== 'function');
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let system = ''; let nonSystem = msgs;
  if (isAnthropic && body.system !== undefined) system = textOfContent(body.system);
  else { const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer'); system = sys.map((m) => textOfContent(m.content)).join('\n'); nonSystem = msgs.filter((m) => m.role !== 'system' && m.role !== 'developer'); }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((t) => t?.name ?? t?.function?.name ?? t?.type ?? '?');
  return { kind: isAnthropic ? 'anthropic' : 'openai-chat', model: body.model ?? null, system, tools: names, toolsBytes: tools.length ? bytes(tools) : 0, messageCount: nonSystem.length, messagesBytes: bytes(nonSystem), systemBytes: Buffer.byteLength(system), stream: body.stream ?? null,
    // R8-effort: the reasoning-effort setting the request ACTUALLY carried. Anthropic /v1/messages: `output_config.effort` (the claude CLI 2.1.296 sends it for models with an effort setting, probed against a local mock
    // upstream: --effort high or CLAUDE_CODE_EFFORT_LEVEL=high -> "high", unset -> the model default "medium" for claude-haiku-5-5). OpenAI chat: `reasoning_effort`. null = the request carries none.
    effort: body.output_config?.effort ?? body.reasoning_effort ?? null, thinking: body.thinking?.type ?? (body.thinking ? 'set' : null), maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null };
}

const usageFacts = (u) => {
  if (!u) return null;
  const inp = u.input_tokens ?? u.prompt_tokens ?? null;
  return { input: inp, cacheRead: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? u.completion_tokens ?? null };
};

/** Analyse the files: { arms: { <arm>: { providers, requests[], first, turns[] } } }. Multiple providers of one arm are listed; the first anthropic-or-first provider drives the diff. */
export function analyzeWire(files) {
  const arms = {};
  for (const file of files) {
    const ev = readEvents(file);
    const start = ev.find((e) => e.type === 'session_start');
    const m = /proxy-(.+?)-(anthropic|openai|deepseek)\.jsonl$/.exec(path.basename(file));
    const arm = start?.arm ?? m?.[1] ?? '?'; const provider = start?.provider ?? m?.[2] ?? '?';
    const a = (arms[arm] ??= { arm, providers: [], requests: [], turns: [], files: [] });
    a.providers.push(provider); a.files.push(file);
    const resp = new Map(ev.filter((e) => e.type === 'raw_response').map((e) => [e.seq, e]));
    const turn = new Map(ev.filter((e) => e.type === 'turn').map((e) => [e.seq, e]));
    for (const rq of ev.filter((e) => e.type === 'raw_request')) {
      const d = describeRequest(rq.body);
      const r = resp.get(rq.seq); const t = turn.get(rq.seq);
      a.requests.push({ provider, seq: rq.seq, path: rq.path, requestBytes: rq.bytes, ...d, status: r?.status ?? t?.status ?? null, usage: usageFacts(r?.usage), msFirstByte: t?.ms_first_byte ?? null, msTotal: t?.ms_total ?? null, redacted: !rq.body && !!rq.bodyBase64 });
    }
  }
  for (const a of Object.values(arms)) {
    a.requests.sort((x, y) => (x.provider === y.provider ? x.seq - y.seq : x.provider.localeCompare(y.provider)));
    a.first = a.requests.find((r) => r.tools.length > 0) ?? a.requests[0] ?? null;
    a.turns = a.requests.map((r, i) => ({ n: i + 1, provider: r.provider, seq: r.seq, model: r.model, ...r.usage, status: r.status, msFirstByte: r.msFirstByte, msTotal: r.msTotal, messageCount: r.messageCount }));
  }
  return { arms };
}

/**
 * R8-effort / R8-model: what the wire says about one arm. "Main" requests declare tools (the agent turns); the claude CLI's tool-less side calls (title, probes) are
 * reported apart so they can never satisfy or fail an effort check. Efforts and models are distinct values in first-seen order.
 * @returns {{requests:number, mainRequests:number, mainModels:string[], mainEfforts:(string|null)[], sideEfforts:(string|null)[], sideModels:string[]}}
 */
export function wireFactsFor(analysis, arm) {
  const rs = analysis.arms[arm]?.requests ?? []; const main = rs.filter((r) => r.tools.length > 0); const side = rs.filter((r) => r.tools.length === 0);
  const uniq = (xs) => [...new Set(xs)];
  return { requests: rs.length, mainRequests: main.length, mainModels: uniq(main.map((r) => r.model).filter(Boolean)), mainEfforts: uniq(main.map((r) => r.effort)), sideEfforts: uniq(side.map((r) => r.effort)), sideModels: uniq(side.map((r) => r.model).filter(Boolean)) };
}

/** Side-by-side delta of the arms' first requests. */
export function diffFirstRequests(analysis) {
  const names = Object.keys(analysis.arms).sort();
  const firsts = Object.fromEntries(names.map((n) => [n, analysis.arms[n].first]));
  const withFirst = names.filter((n) => firsts[n]);
  const allTools = [...new Set(withFirst.flatMap((n) => firsts[n].tools))].sort();
  const toolMatrix = allTools.map((t) => ({ tool: t, present: Object.fromEntries(withFirst.map((n) => [n, firsts[n].tools.includes(t)])) }));
  const differing = toolMatrix.filter((r) => new Set(Object.values(r.present)).size > 1);
  const systemPairs = [];
  for (let i = 0; i < withFirst.length; i++) for (let j = i + 1; j < withFirst.length; j++) {
    const x = firsts[withFirst[i]].system; const y = firsts[withFirst[j]].system;
    let at = -1; if (x !== y) { at = 0; while (at < x.length && at < y.length && x[at] === y[at]) at++; }
    systemPairs.push({ a: withFirst[i], b: withFirst[j], equal: x === y, firstDiffAt: at, lengths: [x.length, y.length] });
  }
  return { arms: withFirst, toolMatrix, differing, systemPairs, systemEqualAll: systemPairs.every((p) => p.equal) };
}

/** Human-readable report. */
export function renderWireDiff(analysis) {
  const out = [];
  for (const name of Object.keys(analysis.arms).sort()) {
    const a = analysis.arms[name]; const f = a.first;
    out.push(`== arm ${name}  providers=[${[...new Set(a.providers)].join(',')}]  requests=${a.requests.length}  models=${JSON.stringify(Object.fromEntries([...new Set(a.requests.map((r) => r.model))].map((m) => [m ?? 'null', a.requests.filter((r) => r.model === m).length])))}`);
    if (!f) { out.push('   (no requests captured)', ''); continue; }
    out.push(`   first request (${f.provider} seq ${f.seq} ${f.path ?? ''}, model ${f.model}${f.redacted ? ', BODY REDACTED/UNPARSED' : ''})`,
      `   system: ${f.systemBytes ?? 0} bytes`, ...(f.system ? ['      | ' + f.system.slice(0, 600).replace(/\n/g, '\n      | ') + (f.system.length > 600 ? '\n      | ...[' + (f.system.length - 600) + ' more chars]' : '')] : []),
      `   effort: ${f.effort ?? '(none sent)'}   thinking: ${f.thinking ?? '(none sent)'}   max_tokens: ${f.maxTokens ?? '-'}`,
      `   tools: ${f.tools.length} (${f.toolsBytes} bytes of tools JSON): ${f.tools.join(', ') || '(none)'}`,
      `   messages: ${f.messageCount} (${f.messagesBytes} bytes); request body ${f.requestBytes} bytes`);
    out.push('   per-turn usage:', '      #  prov       status  msgs  input  cacheRead  cacheCreate  output  ttfb ms  total ms');
    for (const t of a.turns) out.push(`      ${String(t.n).padEnd(2)} ${String(t.provider).padEnd(10)} ${String(t.status ?? '-').padEnd(7)} ${String(t.messageCount).padEnd(5)} ${String(t.input ?? '-').padEnd(6)} ${String(t.cacheRead ?? '-').padEnd(10)} ${String(t.cacheCreate ?? '-').padEnd(12)} ${String(t.output ?? '-').padEnd(7)} ${String(t.msFirstByte ?? '-').padEnd(8)} ${t.msTotal ?? '-'}`);
    out.push('');
  }
  const d = diffFirstRequests(analysis);
  out.push(`== delta of first requests (arms: ${d.arms.join(' vs ')})`);
  out.push(`   system text equal across all arms: ${d.systemEqualAll ? 'YES' : 'NO'}`);
  for (const p of d.systemPairs) out.push(`      ${p.a} vs ${p.b}: ${p.equal ? 'equal' : `DIFFER (lengths ${p.lengths[0]} / ${p.lengths[1]}, first differing char at ${p.firstDiffAt})`}`);
  out.push(`   tools: ${d.toolMatrix.length} distinct names, ${d.differing.length} not present in every arm`);
  for (const r of d.differing) out.push(`      ${r.tool.padEnd(28)} ${d.arms.map((n) => `${n}:${r.present[n] ? 'yes' : 'no'}`).join('  ')}`);
  out.push(`   counts: ${d.arms.map((n) => { const f = analysis.arms[n].first; return `${n} tools=${f.tools.length}/${f.toolsBytes}B msgs=${f.messageCount}/${f.messagesBytes}B sys=${f.systemBytes}B`; }).join('   ')}`);
  return out.join('\n') + '\n';
}

function main(argv) {
  if (!argv.length || argv.includes('--help')) { console.error('usage: node wire-diff.mjs <run-dir | logs/wire dir | proxy-*.jsonl ...> [--json]'); return 2; }
  const json = argv.includes('--json'); const inputs = argv.filter((a) => a !== '--json');
  const files = resolveWireFiles(inputs);
  if (!files.length) { console.error('wire-diff: no proxy-*.jsonl files found'); return 1; }
  const analysis = analyzeWire(files);
  process.stdout.write(json ? JSON.stringify({ analysis, diff: diffFirstRequests(analysis) }, null, 2) + '\n' : renderWireDiff(analysis));
  return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); } }
