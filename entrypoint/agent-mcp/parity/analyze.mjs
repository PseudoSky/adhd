// PARITY-INSTRUMENT-ONLY
// Analysis commands (SCOPE-R10-prep, PARITY-R10-prep AC2). They replace the throwaway reader scripts of the R9 triage (combo/agg/threads/calls/timeline/t3*.cjs). Every function is PURE over redacted
// evidence bundles (evidence.mjs `parity-evidence/1`), deterministic, model-free and read-only; the CLI only resolves which bundles to read.
//
//   node drive.mjs analyze <round> <runA> <runC> [--section gap|threads|blocking|surplus|tools|contamination|rt|all]
//   node drive.mjs analyze --emit-bundle <runDir> [--arm A|B|C] [--out FILE] [--redact-spans]     (writes the redacted bundle; the committed golden fixture is made this way)
//   <runA>/<runC> = a run id under tmp/agent-mcp/parity/<round>/live/out/runs (evidence.json when present, else built on the fly from the logs) or a path to a bundle .json.
//
// Output format (documented in README "Analysis commands"): plain text, one section per header line `== <NAME> ==`, seconds with 3 decimals, ms as integers, tables as `col | col` rows.
import fs from 'node:fs';
import path from 'node:path';

import * as L from './lib.mjs';
import * as EV from './evidence.mjs';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const s3 = (ms) => (fin(ms) ? (ms / 1000).toFixed(3) : 'n/a');
const sg = (ms) => (fin(ms) ? `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(3)}` : 'n/a');
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------------------------------------------------------------------------------------------------
// 1. Wall-gap reconciliation
// ---------------------------------------------------------------------------------------------------
/** Task time per phase (ms), pollLag, overhead and the identity wall = task + pollLag + overhead for ONE bundle. */
export function wallParts(b) {
  const rec = b.record; const d = rec?.duration ?? {}; const fair = d.fairTiming === true;
  const rows = new Map((b.taskRows ?? []).map((r) => [r.id, r]));
  const phases = (rec?.phases ?? []).map((p, i) => {
    if (fair && fin(d.windowsMs?.[i])) return { phase: p.phase, ms: d.windowsMs[i], basis: 'fair window (prompt -> product final result)' };
    const r = p.taskId ? rows.get(p.taskId) : null; const iv = r ? Date.parse(r.completedAt) - Date.parse(r.createdAt) : NaN;
    if (fin(iv)) return { phase: p.phase, ms: iv, basis: 'server task interval (completedAt - createdAt)' };
    return { phase: p.phase, ms: p.wallMs, basis: 'phase wall (spawn -> exit)' };
  });
  const taskMs = sum(phases.map((p) => p.ms));
  const phaseSum = fin(d.phaseSumMs) ? d.phaseSumMs : sum((rec?.phases ?? []).map((p) => p.wallMs ?? 0));
  const pollLagMs = fair ? 0 : fin(d.pollLagMs) ? d.pollLagMs : 0;
  const overheadMs = fair ? (d.overheadMs ?? 0) : fin(d.overheadMs) ? d.overheadMs : rec.wallMs - phaseSum;
  const graded = rec.wallMs;
  const identityMs = fair ? graded - taskMs : graded - (taskMs + pollLagMs + overheadMs);
  return { runId: b.runId, arm: b.arm, fair, graded, phases, taskMs, pollLagMs, overheadMs, overhead: d.overhead ?? null, identityMs, runWallMs: fair ? d.runWallMs : graded };
}

/** @returns {{a:object,c:object,deltas:{phases:number[],pollLagMs:number,overheadMs:number}, gapMs:number, sumDeltasMs:number, residualMs:number, measurementMs:number}} */
export function reconcile(A, C) {
  const a = wallParts(A), c = wallParts(C); const n = Math.max(a.phases.length, c.phases.length);
  const dp = Array.from({ length: n }, (_, i) => (c.phases[i]?.ms ?? 0) - (a.phases[i]?.ms ?? 0));
  const dPoll = c.pollLagMs - a.pollLagMs; const dOver = c.fair || a.fair ? 0 : c.overheadMs - a.overheadMs;
  const gapMs = c.graded - a.graded; const sumDeltasMs = sum(dp) + dPoll + dOver;
  return { a, c, deltas: { phases: dp, pollLagMs: dPoll, overheadMs: dOver }, gapMs, sumDeltasMs, residualMs: gapMs - sumDeltasMs, measurementMs: dPoll + dOver };
}
const splitText = (o) => {
  if (!o) return 'none';
  if (o.fair) return `setup ${s3(o.setupMs)}, lag ${s3(o.lagMs)}, verification ${s3(o.verificationMs)}, handoff ${s3(o.handoffMs)}, accounting ${s3(o.accountingMs)}, teardown ${s3(o.teardownMs)}, residual ${s3(o.residualMs)} (not graded)`;
  if (!o.attributed) return `unattributed ${s3(o.unattributedMs)} (no marks; not split)`;
  return `setup ${s3(o.setupMs)}, submit ${s3(o.submitMs)}, between phases ${s3(o.betweenPhasesMs)}, accounting wait ${s3(o.accountingWaitMs)} (fixed sleep ${s3(o.fixedSleepMs)} + hidden/reads ${s3(o.hiddenAndReadsMs)}), usage queries ${s3(o.queriesMs)}, teardown ${s3(o.teardownMs)}, residual ${s3(o.residualMs)}`;
};
export function formatReconcile(r) {
  const { a, c } = r; const L2 = [`== WALL-GAP RECONCILIATION (${c.runId} vs ${a.runId}; graded wall ${c.fair ? 'fair windows' : 'wallMs'}) ==`];
  r.deltas.phases.forEach((d, i) => L2.push(`phase ${i + 1} task time | ${c.runId} ${s3(c.phases[i]?.ms)} (${c.phases[i]?.basis}) | ${a.runId} ${s3(a.phases[i]?.ms)} (${a.phases[i]?.basis}) | ${sg(d)}`));
  L2.push(`client poll lag (inside the phase sum) | ${c.runId} ${s3(c.pollLagMs)} | ${a.runId} ${s3(a.pollLagMs)} | ${sg(r.deltas.pollLagMs)}`);
  L2.push(`harness overhead | ${c.runId} ${s3(c.overheadMs)} | ${a.runId} ${s3(a.overheadMs)} | ${sg(c.overheadMs - a.overheadMs)}${c.fair || a.fair ? ' (fair timing: not in the graded wall)' : ''}`);
  L2.push(`  ${c.runId} overhead split: ${splitText(c.overhead)}`, `  ${a.runId} overhead split: ${splitText(a.overhead)}`);
  L2.push(`graded wall | ${c.runId} ${s3(c.graded)} | ${a.runId} ${s3(a.graded)} | gap ${sg(r.gapMs)} = ${r.deltas.phases.map(sg).join(' ')} ${sg(r.deltas.pollLagMs)} ${sg(r.deltas.overheadMs)} (residual ${r.residualMs} ms)`);
  L2.push(`measurement-path time carried by ${c.runId} and not by ${a.runId}: ${s3(r.measurementMs)} s (${r.gapMs ? ((r.measurementMs / r.gapMs) * 100).toFixed(1) : 'n/a'}% of the gap); task execution: ${s3(sum(r.deltas.phases))} s`);
  return L2.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// 2. Per-thread table, parent blocking, tool-call timing/ordering
// ---------------------------------------------------------------------------------------------------
const isRun = (b) => b.delegation != null;
const rel = (b, ms) => (fin(ms) && fin(b.t0Ms) ? (ms - b.t0Ms) / 1000 : null);
const f2 = (x) => (fin(x) ? x.toFixed(2) : 'n/a');

/** One row per thread: requests, turns, tool calls, errors, model seconds, tool seconds (trace spans when present, else the gaps between the thread's own requests), span. */
export function threadRows(b) {
  return b.threads.map((t) => {
    const rs = b.requests.filter((q) => q.thread === t.id).sort((x, y) => x.startMs - y.startMs); const calls = sum(rs.map((q) => q.blocks.filter((k) => k.type === 'tool_use').length));
    const serverCalls = sum(rs.map((q) => q.blocks.filter((k) => k.type === 'server_tool_use').length));
    const modelMs = sum(rs.map((q) => q.totalMs ?? 0)); let gapMs = 0; for (let i = 1; i < rs.length; i++) gapMs += Math.max(0, rs[i].startMs - rs[i - 1].endMs);
    const traceMs = t.task ? sum(b.trace.toolCalls.filter((x) => x.task === t.task).map((x) => x.durMs ?? 0)) : null;
    return { thread: t.id, role: t.role, agent: t.agent, phase: t.phase, tools: t.tools, requests: rs.length, toolCalls: calls, serverToolCalls: serverCalls, toolErrors: sum(rs.map((q) => q.toolErrors)), retryRounds: rs.filter((q) => q.retryAfterError).length,
      modelMs, toolGapMs: gapMs, toolTraceMs: traceMs, outTokens: sum(rs.map((q) => q.usage.out ?? 0)), thinkingBlocks: sum(rs.map((q) => q.blocks.filter((k) => k.type === 'thinking').length)), startS: rel(b, rs[0].startMs), endS: rel(b, rs[rs.length - 1].endMs) };
  }).sort((x, y) => x.startS - y.startS);
}
export function formatThreads(b) {
  const L2 = [`== THREADS ${b.runId} (${b.arm}) ==`, 'thread | role | agent | phase | tools offered | requests | tool calls (+server) | tool errors | retry rounds | model s | tool s (trace spans | gaps) | out tokens | thinking blocks | span s'];
  for (const r of threadRows(b)) L2.push(`${r.thread} | ${r.role} | ${r.agent ?? '-'} | ${r.phase} | ${r.tools} | ${r.requests} | ${r.toolCalls}+${r.serverToolCalls} | ${r.toolErrors} | ${r.retryRounds} | ${s3(r.modelMs)} | ${r.toolTraceMs != null ? s3(r.toolTraceMs) : 'n/a'} | ${s3(r.toolGapMs)} | ${r.outTokens} | ${r.thinkingBlocks} | ${f2(r.startS)}-${f2(r.endS)}`);
  const rs = threadRows(b); L2.push(`total | requests ${sum(rs.map((r) => r.requests))} (parent ${sum(rs.filter((r) => r.role === 'parent').map((r) => r.requests))}, other ${sum(rs.filter((r) => r.role !== 'parent').map((r) => r.requests))}) | tool errors ${sum(rs.map((r) => r.toolErrors))} | model s ${s3(sum(rs.map((r) => r.modelMs)))}`);
  return L2.join('\n');
}

/**
 * Parent blocking: for every parent request that emitted tool calls, the wait until the parent's NEXT request (response end -> next request start), the delegation mode of each run call
 * (sync | background), the tool spans of the turn from the tracing plugin (arm C) and whether calls of the same turn overlapped (same-turn concurrency).
 */
export function blockingRows(b) {
  const parents = b.threads.filter((t) => t.role === 'parent'); const out = [];
  for (const th of parents) {
    const rs = b.requests.filter((q) => q.thread === th.id).sort((x, y) => x.startMs - y.startMs);
    rs.forEach((q, i) => {
      const uses = q.blocks.filter((k) => k.type === 'tool_use'); if (!uses.length) return;
      const next = rs[i + 1]; const gapMs = next ? next.startMs - q.endMs : null;
      const spans = uses.map((u) => b.trace.toolCalls.find((x) => x.callId === u.id)).filter(Boolean).map((x) => ({ ...x, startMs: x.endMs - (x.durMs ?? 0) }));
      let overlap = false; const sp = [...spans].sort((x, y) => x.startMs - y.startMs); for (let k = 1; k < sp.length; k++) if (sp[k].startMs < sp[k - 1].endMs) overlap = true;
      out.push({ thread: th.id, seq: q.seq, atS: rel(b, q.endMs), gapMs, calls: uses.map((u) => ({ name: u.name, delegation: u.delegation ?? null, items: u.items ?? null, traceMs: b.trace.toolCalls.find((x) => x.callId === u.id)?.durMs ?? null, isError: b.trace.toolCalls.find((x) => x.callId === u.id)?.isError ?? null })), sameTurnConcurrent: uses.length > 1, spansOverlap: overlap, maxTraceMs: spans.length ? Math.max(...spans.map((x) => x.durMs ?? 0)) : null });
    });
  }
  return out;
}
export function formatBlocking(b) {
  const rows = blockingRows(b); const L2 = [`== PARENT BLOCKING ${b.runId} (${b.arm}) ==`, 'parent seq | response end s | wait for next parent request s | calls (name[delegation mode], trace span s) | same-turn calls | spans overlap'];
  for (const r of rows) L2.push(`${r.seq} | ${f2(r.atS)} | ${s3(r.gapMs)} | ${r.calls.map((c) => `${c.name}${c.delegation ? `[${c.delegation}${c.items ? ` x${c.items}` : ''}]` : ''}${c.traceMs != null ? ` ${s3(c.traceMs)}` : ''}${c.isError ? ' ERR' : ''}`).join(', ')} | ${r.sameTurnConcurrent ? r.calls.length : 1} | ${r.spansOverlap ? 'yes' : r.sameTurnConcurrent ? 'no/untraced' : '-'}`);
  const deleg = rows.filter((r) => r.calls.some((c) => c.delegation)); const sync = deleg.filter((r) => r.calls.some((c) => c.delegation === 'sync')); const bg = deleg.filter((r) => !r.calls.some((c) => c.delegation === 'sync'));
  L2.push(`delegation turns: ${deleg.length} | parent blocked on SYNC delegation: ${s3(sum(sync.map((r) => r.gapMs ?? 0)))} s over ${sync.length} turn(s) [${sync.map((r) => s3(r.gapMs)).join(', ')}] | background delegation turns wait ${s3(sum(bg.map((r) => r.gapMs ?? 0)))} s over ${bg.length} turn(s)`);
  const tr = rows.filter((r) => r.maxTraceMs != null); if (tr.length) L2.push(`tracing plugin cross-check: delegation tool spans ${deleg.flatMap((r) => r.calls.filter((c) => c.delegation && c.traceMs != null).map((c) => `${c.name} ${s3(c.traceMs)} s`)).join(', ') || 'none'}`);
  return L2.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// 3. Worker-request surplus, tools offered
// ---------------------------------------------------------------------------------------------------
const catOf = (name, tools) => { try { return L.toolCategoryOf(L.toolNameFacts(name, tools).canonical); } catch { return 'other'; } };
/** purpose of one request: what it was for, from the tool calls it emitted (category set) and whether it retried an error. Text-free. */
export function purposeOf(q) {
  const uses = q.blocks.filter((k) => k.type === 'tool_use' || k.type === 'server_tool_use');
  if (!uses.length) return q.stop === 'end_turn' ? 'final-answer' : `no-tool:${q.stop}`;
  const cats = [...new Set(uses.map((u) => (u.type === 'server_tool_use' ? 'web' : catOf(u.name, q.tools))))].sort().join('+');
  return `${q.retryAfterError ? 'retry-after-error:' : ''}${cats}`;
}
export function workerRows(b) {
  return b.threads.filter((t) => t.role.startsWith('worker')).map((t) => ({ ...t, reqs: b.requests.filter((q) => q.thread === t.id).sort((x, y) => x.startMs - y.startMs) }))
    .sort((x, y) => x.phase - y.phase || x.reqs[0].startMs - y.reqs[0].startMs);
}
/** Worker request surplus of C over A: per worker (phase, order of start) and per purpose. */
export function surplus(A, C) {
  const wa = workerRows(A), wc = workerRows(C); const n = Math.max(wa.length, wc.length);
  const rows = Array.from({ length: n }, (_, i) => ({ idx: i + 1, a: wa[i] ?? null, c: wc[i] ?? null }));
  const count = (ws) => { const m = {}; for (const w of ws) for (const q of w.reqs) { const p = purposeOf(q); m[p] = (m[p] ?? 0) + 1; } return m; };
  const pa = count(wa), pc = count(wc); const purposes = [...new Set([...Object.keys(pa), ...Object.keys(pc)])].sort();
  return { rows, totalA: sum(wa.map((w) => w.reqs.length)), totalC: sum(wc.map((w) => w.reqs.length)), purposes: purposes.map((p) => ({ purpose: p, a: pa[p] ?? 0, c: pc[p] ?? 0 })) };
}
export function formatSurplus(A, C) {
  const r = surplus(A, C); const L2 = [`== WORKER-REQUEST SURPLUS (${C.runId} vs ${A.runId}) ==`, 'worker # | phase | C requests (agent) | A requests | surplus | C request purposes (in order) | A request purposes (in order)'];
  for (const w of r.rows) L2.push(`${w.idx} | ${w.c?.phase ?? w.a?.phase} | ${w.c ? `${w.c.reqs.length} (${w.c.agent ?? w.c.role})` : 0} | ${w.a ? w.a.reqs.length : 0} | ${(w.c?.reqs.length ?? 0) - (w.a?.reqs.length ?? 0)} | ${w.c ? w.c.reqs.map(purposeOf).join(' > ') : '-'} | ${w.a ? w.a.reqs.map(purposeOf).join(' > ') : '-'}`);
  L2.push(`total worker requests | C ${r.totalC} | A ${r.totalA} | surplus ${r.totalC - r.totalA}`, 'purpose | C | A | C-A');
  for (const p of r.purposes) L2.push(`${p.purpose} | ${p.c} | ${p.a} | ${p.c - p.a}`);
  return L2.join('\n');
}
/** tools offered per role: count, names, exact-name diff between arms, and whether the set changed within a thread. */
export function toolsOffered(b) {
  const by = {}; for (const t of b.threads) { const rs = b.requests.filter((q) => q.thread === t.id); const role = t.role.startsWith('worker') ? 'worker' : t.role; const names = rs[0].tools; (by[role] ??= []).push({ thread: t.id, n: names.length, names, changesWithinThread: new Set(rs.map((q) => q.toolsSha)).size > 1 }); }
  return by;
}
export function formatTools(A, C) {
  const ta = toolsOffered(A), tc = toolsOffered(C); const L2 = [`== TOOLS OFFERED (${C.runId} vs ${A.runId}) ==`, 'role | C threads x tools | A threads x tools | only in C (n) | only in A (n)'];
  for (const role of [...new Set([...Object.keys(ta), ...Object.keys(tc)])].sort()) {
    const ca = (ta[role] ?? [])[0], cc = (tc[role] ?? [])[0]; const na = new Set(ca?.names ?? []), nc = new Set(cc?.names ?? []);
    const oc = [...nc].filter((x) => !na.has(x)).sort(), oa = [...na].filter((x) => !nc.has(x)).sort();
    L2.push(`${role} | ${(tc[role] ?? []).length} x ${cc?.n ?? 0} | ${(ta[role] ?? []).length} x ${ca?.n ?? 0} | ${oc.length}: ${oc.join(' ')} | ${oa.length}: ${oa.join(' ')}`);
    for (const [arm, list] of [['C', tc[role] ?? []], ['A', ta[role] ?? []]]) if (list.some((x) => x.changesWithinThread)) L2.push(`  ${arm} ${role}: the offered tool set CHANGES inside a thread (${list.filter((x) => x.changesWithinThread).map((x) => x.thread).join(', ')})`);
  }
  return L2.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// 4. Contamination (q_rate style) and RT1-RT6
// ---------------------------------------------------------------------------------------------------
export function formatContamination(b) {
  const c = b.contamination; const L2 = [`== CONTAMINATION ${b.runId} (${b.arm}; probes: ${c.probes.join(', ') || 'none'}) ==`, 'probe | thread | role | phase | request seq | channel | tool | minimal span'];
  const role = new Map(b.threads.map((t) => [t.id, t.role]));
  for (const m of c.matches) L2.push(`${m.label} | ${m.thread} | ${role.get(m.thread) ?? '?'} | ${m.phase ?? '?'} | ${m.seq} | ${m.channel} | ${m.tool ?? '-'} | ${m.span}`);
  const asst = c.matches.filter((m) => m.channel === 'response.text' && role.get(m.thread) === 'parent' && m.phase === 1);
  L2.push(`matches ${c.matches.length} | in PARENT assistant text of phase 1 (the q_rate invalid rule, oracle.mjs q_rate) ${asst.length}${asst.length ? ` at request seq ${asst.map((m) => m.seq).join(', ')}` : ''}`);
  return L2.join('\n');
}
/** RT1-RT6 from the bundle's wire facts. RT6 is the adopted definition (cache_read >= previous cache_read + cache_creation per thread) AND the literal reading is printed beside it. */
export function rtChecks(b) {
  const r = b.rt; const th = Object.values(r.thinking); const verdict = (ok) => (ok === null ? 'n/a' : ok ? 'PASS' : 'FAIL');
  const emitted = sum(th.map((t) => t.emitted)), replayable = sum(th.map((t) => t.replayable)), matched = sum(th.map((t) => t.replayedMatched)), unknown = sum(th.map((t) => t.replayedUnknown));
  const cache = Object.values(r.cache); const pairs = sum(cache.map((c) => c.pairs)); const ad = sum(cache.map((c) => c.adoptedPass)); const lit = sum(cache.map((c) => c.literalPass));
  const deficits = cache.flatMap((c) => c.literalDeficits);
  return [
    { id: 'RT1', verdict: verdict(emitted === 0 ? null : matched === replayable && unknown === 0), text: `thinking replayed == emitted: ${emitted} emitted, ${replayable} replayable (not the last response of a thread), ${matched} replayed byte-matched by signature, ${unknown} replayed blocks never emitted in their thread` },
    { id: 'RT2', verdict: verdict(sum(Object.values(r.dangling)) === 0), text: `no dangling server_tool_use in replayed history: ${sum(Object.values(r.dangling))} dangling` },
    { id: 'RT3', verdict: verdict(r.fetch.fetches === r.fetch.uniqueUrls), text: `no refetch of an already-fetched URL: ${r.fetch.fetches} fetch calls, ${r.fetch.uniqueUrls} unique URLs` },
    { id: 'RT4', verdict: verdict(r.bareNames == null ? null : r.bareNames === 0), text: r.bareNames == null ? 'bare tool-name emissions: not applicable to this arm' : `bare tool-name emissions: ${r.bareNames}` },
    { id: 'RT5', verdict: verdict(r.http.non200 === 0 && r.historyDegraded === 0), text: `no 400 and no provider:history_degraded: ${r.http.total - r.http.non200}/${r.http.total} requests HTTP 200, ${r.historyDegraded} history_degraded events` },
    { id: 'RT6', verdict: verdict(pairs === 0 ? null : ad === pairs), text: `cache continuity (adopted: cache_read >= previous cache_read + cache_creation, per thread): ${ad}/${pairs} pairs; LITERAL reading (cache_read >= previous total prompt tokens = input + cache_read + cache_creation): ${lit}/${pairs} pairs${deficits.length ? `, deficits of the failing pairs: ${[...new Set(deficits)].sort((x, y) => x - y).join(',')} tokens (the previous request's uncached input_tokens)` : ''}` },
  ];
}
export function formatRt(b) { return [`== RT1-RT6 WIRE CHECKS ${b.runId} (${b.arm}) ==`, ...rtChecks(b).map((c) => `${c.id} ${c.verdict} | ${c.text}`)].join('\n'); }

/** Thinking and delegation evidence summary of a bundle (per arm): the 'omitted' flag so nobody concludes from absence. */
export function formatEvidence(b) {
  const tb = b.requests.flatMap((q) => q.blocks.filter((k) => k.type === 'thinking').map((k) => k.thinking)); const d = b.requests.flatMap((q) => q.blocks.filter((k) => k.delegation).map((k) => k.delegation));
  return [`== EVIDENCE ${b.runId} (${b.arm}) ==`, `sources | wire ${b.sources.wire} | api log ${b.sources.api} | tracing plugin ${b.sources.trace} | mcp calls ${b.sources.calls}`,
    `thinking blocks | ${tb.length} | text omitted by the API (signature only) ${tb.filter((t) => t.state === 'omitted').length} | text returned ${tb.filter((t) => t.state === 'text').length}${tb.length && tb.every((t) => t.state === 'omitted') ? ' | NOTE: the API returned no thinking text; do not infer anything from its absence' : ''}`,
    `thinking config on the wire | ${[...new Set(b.requests.map((q) => JSON.stringify(q.thinkingCfg)))].join(' ')}`,
    `delegation | sync ${d.filter((x) => x === 'sync').length} | background ${d.filter((x) => x === 'background').length}`].join('\n');
}

const SECTIONS = ['gap', 'threads', 'blocking', 'surplus', 'tools', 'contamination', 'rt', 'evidence'];
/** The whole report for a pair of bundles (A first). */
export function formatReport(A, C, sections = ['all']) {
  const want = (s) => sections.includes('all') || sections.includes(s); const out = [];
  if (want('gap')) out.push(formatReconcile(reconcile(A, C)));
  if (want('evidence')) out.push(formatEvidence(A), formatEvidence(C));
  if (want('threads')) out.push(formatThreads(A), formatThreads(C));
  if (want('blocking')) out.push(formatBlocking(A), formatBlocking(C));
  if (want('surplus')) out.push(formatSurplus(A, C));
  if (want('tools')) out.push(formatTools(A, C));
  if (want('contamination')) out.push(formatContamination(A), formatContamination(C));
  if (want('rt')) out.push(formatRt(A), formatRt(C));
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
function resolveBundle(arg, round, io) {
  if (arg.endsWith('.json') && fs.existsSync(arg)) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  const dir = path.join(io.tmpRoot(round), 'live/out/runs', arg); const ev = path.join(dir, 'evidence.json');
  if (fs.existsSync(ev)) return JSON.parse(fs.readFileSync(ev, 'utf8'));
  if (!fs.existsSync(path.join(dir, 'record.json'))) throw new Error(`no run ${arg} under ${dir}`);
  return EV.buildBundle(dir, {}).bundle;
}
/** `analyze ...` argv (after the word `analyze`) -> {code, out, err}. Never writes anything except --emit-bundle's --out file. */
export function analyzeCli(args, io) {
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
  try {
    if (args.includes('--emit-bundle')) {
      const dir = path.resolve(flag('--emit-bundle')); const { bundle } = EV.buildBundle(dir, { arm: flag('--arm') ?? undefined, redactSpans: args.includes('--redact-spans') });
      const text = JSON.stringify(bundle); const scan = EV.leakScan(text);
      if (!scan.ok) return { code: 1, err: `bundle refused: leak scan ${JSON.stringify(scan.kinds)}` };
      const out = flag('--out'); if (out) { fs.writeFileSync(out, text + '\n'); return { code: 0, out: `bundle ${bundle.runId}: ${bundle.requests.length} requests, ${bundle.threads.length} threads -> ${out}` }; }
      return { code: 0, out: text };
    }
    const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--section'));
    if (pos.length < 3) return { code: 2, err: 'usage: analyze <round> <runA> <runC> [--section gap|threads|blocking|surplus|tools|contamination|rt|evidence|all]  |  analyze --emit-bundle <runDir> [--arm X] [--out FILE] [--redact-spans]' };
    const sec = flag('--section') ?? 'all'; if (sec !== 'all' && !SECTIONS.includes(sec)) return { code: 2, err: `unknown --section ${sec}` };
    const [round, ra, rc] = pos; return { code: 0, out: formatReport(resolveBundle(ra, round, io), resolveBundle(rc, round, io), [sec]) };
  } catch (e) { return { code: 1, err: String(e.message || e) }; }
}
