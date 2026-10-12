// PARITY-INSTRUMENT-ONLY
// Zero-cost unit tests for the driver's helpers (`node drive.mjs --check-lib`). No model call, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';
import * as F from './fixtures.mjs';
import * as O from './oracle.mjs';
import * as OLD from './golden/r4/oracle.r4.frozen.mjs';
import * as DT from './detectors.mjs';
import * as QLt from './quality.mjs';
import * as JGt from './judge.mjs';
import { buildPlan, ancestorLeaks, runHidden } from './drive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUND1 = path.join(HERE, 'golden/absent-round1.jsonl');
const LIVE_RUNS = path.join(HERE, 'golden/absent-round2-runs');   // Round 2 evidence, read-only

export async function runLibTests({ log = console.log } = {}) {
  const results = [];
  const t = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); log(`  ok   ${name}`); }
    catch (e) { results.push({ name, ok: false, err: e.message }); log(`  FAIL ${name}: ${e.message}`); }
  };
  const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
  const ok = (c, m) => { if (!c) throw new Error(m); };
  const near = (a, b, tol, m = '') => { if (Math.abs(a - b) > tol) throw new Error(`${m} ${a} not within ${tol} of ${b}`); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-libtest-'));

  // ---- cost model
  await t('cost: tiered pricing arithmetic', () => {
    const n = L.normUsage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } });
    near(L.priceNorm(n).usd, 1000 * 1 / 1e6 + 200 * 5 / 1e6 + 10000 * 0.1 / 1e6 + 1000 * 1.25 / 1e6 + 2000 * 2 / 1e6, 1e-12);
  });
  await t('cost: untiered writes are flagged and priced at 5m, never 1h', () => {
    const p = L.priceNorm(L.normUsage({ cache_creation_input_tokens: 1000000 }));
    ok(p.untieredFlag, 'flag'); near(p.usd, 1.25, 1e-9);
  });
  await t('cost: tier assertion fires for C-1h; for A only when the PARENT writes 5m (native subagents legitimately write 5m)', () => {
    ok(L.tierAssertion('C', { w1h: 5, w5m: 0, wUntiered: 0 }).length === 1, 'C');
    eq(L.tierAssertion('A', { w1h: 33063, w5m: 20537, wUntiered: 0 }, { w1h: 33063, w5m: 0, wUntiered: 0 }), []);                 // A1 p1: child 5m, parent 1h => no warning
    ok(L.tierAssertion('A', { w1h: 0, w5m: 5, wUntiered: 0 }, { w1h: 0, w5m: 5, wUntiered: 0 }).length === 1, 'parent 5m must warn (negative control)');
    ok(L.tierAssertion('A', { w1h: 0, w5m: 5, wUntiered: 0 }).length === 1, 'without a parent split the total is asserted');
    ok(L.tierAssertion('B', { w1h: 0, w5m: 5, wUntiered: 0 }).length === 1, 'B 5m warns'); eq(L.tierAssertion('B', { w1h: 5, w5m: 0, wUntiered: 0 }), []);
  });
  await t('cost: A1 phase 1 = $0.239084 reproduced from modelUsage tokens (304 in, 17,995 out, 570,076 cache read, 20,537 5m + 33,063 1h writes) at haiku-4.5 list rates', () => {
    near(L.priceTokens({ in: 304, out: 17995, cr: 570076, w5m: 20537, w1h: 33063 }), 0.239084, 5e-7);
    const result = { total_cost_usd: 0.23908385, usage: { output_tokens: 2909 }, modelUsage: { 'claude-haiku-4-5': { inputTokens: 304, outputTokens: 17995, cacheReadInputTokens: 570076, cacheCreationInputTokens: 53600, costUSD: 0.23908385 } } };
    const acc = L.cliPhaseAccounting([result]); near(acc.increment.usd, 0.239084, 5e-7); eq(acc.increment.out, 17995);
    near(L.priceTokens({ in: acc.increment.in, out: acc.increment.out, cr: acc.increment.cr, w5m: 20537, w1h: acc.increment.cw - 20537 }), acc.increment.usd, 5e-7, 'recompute vs CLI');
    // negative control: the old basis (result.usage.output_tokens, the parent's last segment) undercounts by exactly the Round 2 gap
    const old = L.priceTokens({ in: 304, out: 2909, cr: 570076, w5m: 20537, w1h: 33063 }); near(0.239084 - old, 15086 * 5 / 1e6, 5e-7, 'old basis gap'); ok(old < 0.17, 'old basis was expected to undercount');
  });
  await t('cost: phase 2 of a resumed session is the INCREMENT over phase 1 (CLI cost and modelUsage are session-cumulative); several result events per phase use the last', () => {
    const mu = (i, o, cr, cw, usd) => ({ total_cost_usd: usd, modelUsage: { m: { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, costUSD: usd } } });
    const p1 = L.cliPhaseAccounting([mu(1, 10, 100, 5, 0.1), mu(2, 20, 200, 6, 0.2)]); eq(p1.nResults, 2); near(p1.cumulative.usd, 0.2, 1e-12);
    const p2 = L.cliPhaseAccounting([mu(5, 50, 500, 9, 0.5)], p1.cumulative); near(p2.increment.usd, 0.3, 1e-12); eq(p2.increment.out, 30); eq(p2.increment.cr, 300); eq(p2.cumulative.out, 50);
    eq(L.cliPhaseAccounting([]), null);
  });
  await t('cost: Round 2 A1 / A2 streams (read-only evidence): per-phase and whole-run costs equal the CLI (A1 0.239084 + 0.124014 = 0.363098; A2 0.136359 + 0.058448 = 0.194807) and the tier-aware recompute lands within 0.5%', () => {
    if (!fs.existsSync(LIVE_RUNS) || !fs.existsSync(ROUND1)) return;   // round-1/2 evidence is not shipped with the instrument (only the R4 goldens are)
    for (const [run, want] of [['A1', [0.239084, 0.124014, 0.363098]], ['A2', [0.136359, 0.058448, 0.194807]]]) {
      let prior = null; const incs = []; let lastCum = null;
      for (const ph of [1, 2]) {
        const f = path.join(LIVE_RUNS, run, `A.phase${ph}.stream.jsonl`); ok(fs.existsSync(f), `evidence missing: ${f}`);
        const p = L.parseCliStream(L.parseJsonLines(fs.readFileSync(f, 'utf8'))); const acc = L.cliPhaseAccounting(p.results, prior); prior = acc.cumulative; lastCum = acc.cumulative; incs.push(acc.increment.usd);
        const turns = L.reconcileCliOutput(L.turnsFromCliStream(p), acc.increment.out); const re = turns.reduce((a, x) => a + x.usd, 0);
        near(re / acc.increment.usd, 1, 0.005, `${run} p${ph} recompute ${re} vs CLI ${acc.increment.usd}`);
        const old = L.reconcileCliOutput(L.turnsFromCliStream(p), p.result.usage.output_tokens).reduce((a, x) => a + x.usd, 0); ok(old / acc.increment.usd < 0.9, `old basis should undercount (${old})`);
      }
      near(incs[0], want[0], 5e-7, `${run} p1`); near(incs[1], want[1], 5e-7, `${run} p2`); near(incs[0] + incs[1], want[2], 5e-7, `${run} total`); near(lastCum.usd, want[2], 5e-7, `${run} cumulative`);
    }
  });
  await t('cost: Round 1 stream: raw per-message output undercounts (31 vs 2473 in the result), reconciliation lands within 0.5% of the CLI total_cost_usd', () => {
    if (!fs.existsSync(LIVE_RUNS) || !fs.existsSync(ROUND1)) return;   // round-1/2 evidence is not shipped with the instrument (only the R4 goldens are)
    const events = L.parseJsonLines(fs.readFileSync(ROUND1, 'utf8'));
    const p = L.parseCliStream(events); ok(p.result && p.result.total_cost_usd > 0, 'no result with a cost');
    const raw = L.turnsFromCliStream(p); const rawSum = raw.reduce((a, x) => a + x.usd, 0);
    ok(rawSum / p.result.total_cost_usd < 0.97, 'the raw stream was expected to undercount (negative control)');
    const rec = L.reconcileCliOutput(raw, p.result); const sum = rec.reduce((a, x) => a + x.usd, 0);
    near(sum / p.result.total_cost_usd, 1, 0.005, `reconciled ${sum} cli ${p.result.total_cost_usd}`);
    near(rec.reduce((a, x) => a + x.out, 0), L.cliPhaseAccounting(p.results).increment.out, 1e-6); eq(L.cliPhaseAccounting(p.results).increment.out, p.result.usage.output_tokens); ok(rec.every((x) => x.outScaled), 'not flagged');
  });
  await t('cost: reconcileCliOutput is a no-op without a result or when the stream already agrees', () => {
    const turns = [{ in: 1, cr: 0, w5m: 0, w1h: 0, wUntiered: 0, out: 10, usd: 1 }];
    eq(L.reconcileCliOutput(turns, null), turns); eq(L.reconcileCliOutput(turns, { usage: { output_tokens: 10 } }), turns);
  });

  // ---- SSE parsing and chunked reassembly
  await t('sse: last message_delta output_tokens wins over the message_start placeholder; tool_use input assembled', () => {
    const sse = [
      'event: message_start', 'data: ' + JSON.stringify({ type: 'message_start', message: { id: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 } } } }),
      'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'agent-mcp__task' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
      'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } }),
      'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 77 } }), ''].join('\n');
    const o = L.parseSse(sse);
    eq(o.usage.output_tokens, 77); eq(o.toolUses[0].input, { a: 1 }); eq(o.stop, 'tool_use'); eq(o.usage.cache_creation_input_tokens, 9);
  });
  await t('spawn.stdout: line-unaligned chunks across two calls reassemble into whole events', () => {
    const e1 = JSON.stringify({ type: 'assistant', message: { id: 'a', content: [] } }), e2 = JSON.stringify({ type: 'result', total_cost_usd: 1 });
    const whole = e1 + '\n' + e2 + '\n';
    const api = [];
    for (let i = 0; i < whole.length; i += 7) api.push({ event: 'spawn.stdout', task_id: 'T', call_id: 'c1', body: whole.slice(i, i + 7) });
    api.push({ event: 'spawn.stdout', task_id: 'T', call_id: 'c2', body: e2 + '\n' }, { event: 'spawn.stdout', task_id: 'OTHER', call_id: 'c3', body: e2 + '\n' });
    const r = L.cliEventsForTask(api, 'T'); eq(r.events.length, 3); eq(r.spawns, 2);
  });
  await t('http turns: tool result of the NEXT request pairs with the previous response tool_use', () => {
    const sse = (id) => ['data: ' + JSON.stringify({ type: 'message_start', message: { id: 'm', usage: {} } }), 'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'shell__shell_execute' } }), 'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }), ''].join('\n');
    const api = [
      { event: 'http.request', task_id: 'T', call_id: '1', ts: '2026-01-01T00:00:01Z', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }, { event: 'http.response', task_id: 'T', call_id: '1', status: 200, body: sse('x1') },
      { event: 'http.request', task_id: 'T', call_id: '2', ts: '2026-01-01T00:00:02Z', body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: [{ type: 'text', text: 'fail 0' }] }] }] }) }, { event: 'http.response', task_id: 'T', call_id: '2', status: 200, body: '' }];
    const calls = L.callsFromHttpTurns(L.httpTurnsForTask(api, 'T')); eq(calls.length, 1); eq(calls[0].resultText, 'fail 0');
  });
  await t('rate limit: headers and CLI info normalise', () => {
    eq(L.rateLimitFromHeaders({ 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.25' }).five_hour.utilization, 0.25);
    eq(L.rateLimitFromHeaders({}), null);
    eq(L.rateLimitFromCli({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } }).five_hour.utilization, 0.1);
  });

  // ---- secret scanner
  await t('secret scan: planted keys are redacted in place, counted, never echoed; files 0600, dir 0700', () => {
    const d = path.join(tmp, 'scan'); fs.mkdirSync(d);
    const fake = 'sk-ant-' + 'a1B2c3D4'.repeat(4), bearer = 'Bearer ' + 'Zz9'.repeat(10);
    fs.writeFileSync(path.join(d, 'x.log'), `token=${fake}\nAuthorization: ${bearer}\nclean line\n`);
    const r = L.scanAndLock(d);
    ok(r.hits.some((h) => h.kind === 'anthropic_key' && h.count === 1), 'anthropic hit'); ok(r.hits.some((h) => h.kind === 'bearer'), 'bearer hit');
    const after = fs.readFileSync(path.join(d, 'x.log'), 'utf8'); ok(!after.includes(fake) && !after.includes('Zz9Zz9'), 'secret survived'); ok(after.includes('clean line'), 'clean line lost');
    eq(fs.statSync(path.join(d, 'x.log')).mode & 0o777, 0o600); eq(fs.statSync(d).mode & 0o777, 0o700);
    ok(!JSON.stringify(r).includes(fake), 'report leaks the secret');
  });
  await t('secret scan: a REDACTED placeholder is not re-flagged', () => { eq(L.redactText('Bearer [REDACTED:bearer]').hits, {}); });

  // ---- processes
  await t('sweep: kills an owned process and its descendant, leaves an unrelated process alone', async () => {
    const child = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grand = await new Promise((res) => child.stdout.once('data', (b) => res(+String(b).trim())));
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const desc = L.descendantsOf([child.pid]).map((p) => p.pid); ok(desc.includes(grand), 'grandchild not found');
    ok(!desc.includes(bystander.pid), 'bystander counted as descendant');
    const swept = await L.sweepPids([child.pid, ...desc], 300);
    ok(swept.includes(child.pid) && swept.includes(grand), 'not swept'); await new Promise((r) => setTimeout(r, 300));
    ok(!L.alive(child.pid) && !L.alive(grand), 'owned still alive'); ok(L.alive(bystander.pid), 'bystander was killed');
    bystander.kill('SIGKILL');
  });
  await t('env: allowlist drops secrets and the enclosing session identity', () => {
    const e = L.cleanEnv({ KEEP: '1', CLAUDECODE: '1' }, { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', AWS_SECRET_ACCESS_KEY: 'y', CLAUDE_CODE_SESSION_ID: 'z', CLAUDE_CODE_ENTRYPOINT: 'e' });
    eq(Object.keys(e).sort(), ['HOME', 'KEEP', 'PATH']);
  });

  // ---- pacing
  await t('pacing: thresholds 5h>=90%, no 7d check, bad status abort; warning counted', () => {
    ok(L.pacingVerdict({ session_pct: 89, week_pct: 100 }).ok, 'under'); ok(!L.pacingVerdict({ session_pct: 90, week_pct: 0 }).ok, '5h'); ok(L.pacingVerdict({ session_pct: 0, week_pct: 100 }, [{ seven_day: { utilization: 1 } }]).ok, '7d ignored');
    ok(!L.pacingVerdict({ session_pct: 0, week_pct: 0 }, [{ status: 'rejected' }]).ok, 'status');
    eq(L.pacingVerdict({ session_pct: 0, week_pct: 0 }, [{ status: 'allowed_warning' }]).warnings, 1);
  });
  await t('pacing: /usage output parser', () => {
    const out = JSON.stringify([{ type: 'assistant', message: { content: [{ text: 'Current session: 12% used · resets 3pm\nCurrent week (all models): 34% used' }] } }, { type: 'result', num_turns: 0, total_cost_usd: 0 }]);
    const u = L.parseUsageOutput('noise\n' + out); eq([u.session_pct, u.week_pct, u.model_calls, u.cost_usd], [12, 34, 0, 0]);
  });

  // ---- call metrics and dispatch evidence
  await t('metrics: wasted = calls after the last green test run; null when never green', () => {
    const c = (name, resultText) => ({ name, input: { n: Math.random() }, isError: false, resultText });
    const m = L.callMetrics([c('Bash', 'fail 3'), c('Edit', 'ok'), c('Bash', 'ℹ fail 0'), c('Read', 'x'), c('Read', 'y')]);
    eq([m.completeAt, m.wasted, m.total], [2, 2, 5]);
    eq(L.callMetrics([c('Bash', 'fail 3')]).wasted, null);
    eq(L.callMetrics([c('mcp__shell__shell_execute', 'fail 0')]).wasted, 0);
    ok(L.callMetrics([c('Read', 'fail 0')]).wasted === null, 'a Read result is not a test run');
  });
  await t('dispatch: only Agent/Task and agent-mcp task RUN a worker (agent merely opens a session)', () => {
    for (const n of ['Agent', 'Task', 'mcp__agent-mcp__task', 'agent-mcp__task']) ok(L.isRunName(n), n);
    for (const n of ['mcp__agent-mcp__agent', 'agent-mcp__result', 'Bash', 'mcp__r2info__get_ticket']) ok(!L.isRunName(n), n);
  });
  await t('parallel (native stream): same-message pair counts; sequential pair does not', () => {
    const tu = (mid, id) => ({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
    const tr = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    ok(L.parallelFromCliEvents([tu('m1', 'a'), tu('m1', 'b'), tr('a'), tr('b')]).sameTurn, 'same message');
    ok(L.parallelFromCliEvents([tu('m1', 'a'), tu('m2', 'b'), tr('a'), tr('b')]).sameTurn, 'second issued before first returned');
    ok(!L.parallelFromCliEvents([tu('m1', 'a'), tr('a'), tu('m2', 'b'), tr('b')]).sameTurn, 'sequential');
    ok(!L.parallelFromCliEvents([{ ...tu('m1', 'a'), parent_tool_use_id: 'P' }, { ...tu('m1', 'b'), parent_tool_use_id: 'P' }]).sameTurn, 'child-level calls are not the parent dispatch');
  });
  await t('parallel (native/CLI stream): one tasks_batch of 2 counts as a parallel fan-out; two sequential task turns do not (bridged and engine names)', () => {
    const tb = (mid, id, name, input) => ({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name, input }] } });
    const tr = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    for (const name of ['mcp__agent-mcp__tasks_batch', 'agent_mcp__tasks_batch', 'agent-mcp__tasks_batch']) { ok(L.isRunName(name), name); const r = L.parallelFromCliEvents([tb('m1', 'a', name, { tasks: [{}, {}] }), tr('a')]); ok(r.sameTurn && r.runs === 2, `${name} ${JSON.stringify(r)}`); }
    ok(!L.parallelFromCliEvents([tb('m1', 'a', 'mcp__agent-mcp__task', {}), tr('a'), tb('m2', 'b', 'mcp__agent-mcp__task', {}), tr('b')]).sameTurn, 'sequential task turns');
    ok(L.parallelFromHttpTurns([{ sse: { toolUses: [{ name: 'agent-mcp__tasks_batch', input: { tasks: [{}, {}, {}] } }] } }]).sameTurn, 'http batch');
  });
  await t('x2_parallel verdict chained from detection: a tasks_batch of 2 passes; two sequential task turns fail; same-message dispatches whose child rows ran strictly serially fail', () => {
    const e = { runId: 'T', arm: 'B', rep: 2, pin: 'claude-haiku-4-5', ticketId: 'TCK-0a1b2c3d', owner: 'team-4f5e6d', threshold: 110, rate: 4.99, carrierRate: 4.5, handlingFee: 0.49, heading: 'Example Domain', firstFile: 'src/checkout.js', original: {} };
    const tu = (mid, id, name, input) => ({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name, input }] } });
    const tr = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    const verdict = (events, rows) => { const par = L.parallelFromCliEvents(events); const o = O.idealObservation('B', e); o.dispatch.p1Parallel = { sameTurn: par.sameTurn, overlapMs: rows ? L.overlapMs(rows) : null }; return O.scoreObservation(o, e).fields.x2_parallel.status; };
    const row = (c, d) => ({ createdAt: `2026-01-01T00:00:${c}Z`, completedAt: `2026-01-01T00:00:${d}Z` });
    eq(verdict([tu('m1', 'a', 'mcp__agent-mcp__tasks_batch', { tasks: [{}, {}] }), tr('a')], [row('00', '10'), row('01', '12')]), 'pass');
    eq(verdict([tu('m1', 'a', 'mcp__agent-mcp__tasks_batch', { tasks: [{}, {}] }), tr('a')], null), 'pass');
    eq(verdict([tu('m1', 'a', 'mcp__agent-mcp__task', {}), tr('a'), tu('m2', 'b', 'mcp__agent-mcp__task', {}), tr('b')], null), 'fail');
    eq(verdict([tu('m1', 'a', 'mcp__agent-mcp__task', {}), tu('m1', 'b', 'mcp__agent-mcp__task', {}), tr('a'), tr('b')], [row('00', '05'), row('06', '12')]), 'fail');
  });
  await t('parallel (http) and overlapMs', () => {
    const turn = (n) => ({ sse: { toolUses: Array.from({ length: n }, () => ({ name: 'agent-mcp__task' })) } });
    ok(L.parallelFromHttpTurns([turn(2)]).sameTurn, '2 in one response'); ok(!L.parallelFromHttpTurns([turn(1), turn(1)]).sameTurn, 'split across responses');
    eq(L.overlapMs([{ createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }, { createdAt: '2026-01-01T00:00:02Z', completedAt: '2026-01-01T00:00:12Z' }]), 8000);
    ok(L.overlapMs([{ createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' }, { createdAt: '2026-01-01T00:00:05Z', completedAt: '2026-01-01T00:00:09Z' }]) < 0, 'disjoint is negative');
    eq(L.overlapMs([{ createdAt: 'x', completedAt: 'y' }, { createdAt: 'x', completedAt: 'y' }]), null);
  });

  // ---- plan / isolation
  await t('plan (R3+): 3 runs, one per arm, arm A first, deterministic, B/C alternate by round', () => {
    for (const round of ['R5', 'R6']) { const p = buildPlan({ round }); eq(p.length, 3); eq(p[0].arm, 'A'); eq(buildPlan({ round }), p); for (const arm of ['A', 'B', 'C']) eq(p.filter((x) => x.arm === arm).length, 1); }
    ok(buildPlan({ round: 'R5' }).map((x) => x.arm).join('') !== buildPlan({ round: 'R6' }).map((x) => x.arm).join(''), 'B/C order never alternates');
  });
  await t('isolation: ancestorLeaks flags a .git / CLAUDE.md ancestor and passes a clean tree', () => {
    const clean = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r2-anc-')), 'a', 'b'); fs.mkdirSync(clean, { recursive: true });
    eq(ancestorLeaks(clean).filter((x) => x.startsWith(path.dirname(path.dirname(clean)))), []);
    const dirty = path.join(tmp, 'dirty', 'a'); fs.mkdirSync(dirty, { recursive: true }); fs.writeFileSync(path.join(tmp, 'dirty', 'CLAUDE.md'), 'x');
    ok(ancestorLeaks(dirty).some((x) => x.endsWith('CLAUDE.md')), 'CLAUDE.md ancestor missed');
  });

  // ---- fixtures: the hidden suite has teeth
  const spec = F.makeSpec({ seed: 'libtest', arm: 'A', rep: 1 });
  const fx = (name) => { const base = path.join(tmp, name); const d = { repoDir: path.join(base, 'repo'), hiddenDir: path.join(base, 'hidden'), ticketFile: path.join(base, 'ticket.txt') }; F.writeFixture(d, spec); return d; };
  await t('fixture: pristine repo fails `make test` loudly (> 6000 chars) and the buggy line is present exactly twice (computeTotal + frozen legacy copy)', () => {
    const d = fx('pristine'); const r = spawnSync('make', ['test'], { cwd: d.repoDir, encoding: 'utf8' });
    ok(r.status !== 0, 'pristine tests pass'); ok((r.stdout + r.stderr).length > 6000, `output only ${(r.stdout + r.stderr).length} chars`);
    eq(fs.readFileSync(path.join(d.repoDir, 'src/checkout.js'), 'utf8').split('discounted + subtotal * taxRate').length - 1, 2);
  });
  await t('fixture: hidden suites fail pristine, pass with the reference, and discriminate partial solutions', () => {
    const none = fx('none'); eq(runHidden(none.hiddenDir, none.repoDir, ['bugfix', 'feature', 'empty']), { bugfix: false, feature: false, empty: false, visible: false });
    const bug = fx('bug'); F.applyReference(bug.repoDir, spec, ['bugfix']); eq(runHidden(bug.hiddenDir, bug.repoDir, ['bugfix', 'feature']), { bugfix: true, feature: false, visible: true });
    const feat = fx('feat'); F.applyReference(feat.repoDir, spec, ['feature']); eq(runHidden(feat.hiddenDir, feat.repoDir, ['bugfix', 'feature']), { bugfix: false, feature: true, visible: false });
    const all = fx('all'); F.applyReference(all.repoDir, spec, ['bugfix', 'feature', 'empty']); eq(runHidden(all.hiddenDir, all.repoDir, ['bugfix', 'feature', 'empty']), { bugfix: true, feature: true, empty: true, visible: true });
    const noEmpty = fx('noempty'); F.applyReference(noEmpty.repoDir, spec, ['bugfix', 'feature']); eq(runHidden(noEmpty.hiddenDir, noEmpty.repoDir, ['bugfix', 'feature', 'empty']), { bugfix: true, feature: true, empty: false, visible: true });
    const mk = spawnSync('make', ['test'], { cwd: all.repoDir, encoding: 'utf8' }); eq(mk.status, 0, 'visible suite should be green after the reference');
  });
  await t('fixture: edit hazards exist as bytes: summary.js is all-CRLF, the other sources are LF, and the reference solution keeps both invariants', () => {
    const d = fx('hazard'); const read = (f) => fs.readFileSync(path.join(d.repoDir, f), 'utf8');
    const s0 = read('src/summary.js'); ok(s0.includes('\r\n') && !/(?<!\r)\n/.test(s0), 'summary.js is not pure CRLF');
    for (const f of ['src/checkout.js', 'src/shipping.js', 'src/format.js']) ok(!read(f).includes('\r'), `${f} unexpectedly has CR`);
    ok(s0.split('checkoutSummary').length - 1 === 2, 'checkoutSummary should appear in a comment and in code');
    const before = read('src/checkout.js'); F.applyReference(d.repoDir, spec, ['bugfix', 'feature']);
    const after = read('src/checkout.js'); const cut = before.indexOf(F.LEGACY_MARKER);
    eq(after.slice(after.indexOf(F.LEGACY_MARKER)), before.slice(cut), 'legacy block changed'); ok(!/subtotal \* taxRate/.test(after.slice(0, after.indexOf(F.LEGACY_MARKER))), 'head still buggy');
    const s1 = read('src/summary.js'); ok(s1.includes('grandTotal') && !/(?<!\r)\n/.test(s1), 'reference summary lost CRLF');
  });
  await t('fixture: the ticket, owner and nonces are per-seed (no cross-run reuse) and deterministic', () => {
    const a = F.makeSpec({ seed: 's1', arm: 'A', rep: 1 }), b = F.makeSpec({ seed: 's2', arm: 'A', rep: 1 });
    ok(a.ticketId !== b.ticketId && a.owner !== b.owner, 'seeds collide'); eq(F.makeSpec({ seed: 's1', arm: 'A', rep: 1 }).ticketId, a.ticketId);
  });
  await t('recall probe: ticket splits the flat rate into carrier + handling (carrier never needed by a requested file), the phase-1 prompt asks only for the total, phase 2 asks for the carrier; older values keep their seed', () => {
    for (const seed of ['s1', 's2', '20261010', 'x']) for (const arm of ['A', 'B', 'C']) {
      const sp = F.makeSpec({ seed, arm, rep: 1 }); near(sp.carrierRate + sp.handlingFee, sp.rate, 1e-9, 'carrier + handling = rate'); ok(sp.carrierRate > 0 && sp.carrierRate.toFixed(2) !== sp.rate.toFixed(2), 'distinct');
      const t = F.ticketText(sp); ok(t.includes(`flat shipping rate of ${sp.rate.toFixed(2)}`), 'total sentence verbatim'); ok(t.includes(`carrier rate of ${sp.carrierRate.toFixed(2)}`), 'carrier stated');
      ok(!F.hiddenTests(sp)['feature.test.mjs'].includes(sp.carrierRate.toFixed(2)) || sp.carrierRate === sp.rate, 'hidden suite does not need the carrier');
    }
    const p = F.prompts(); ok(/flat_shipping_total/.test(p.phase1) && !/carrier/.test(p.phase1), 'phase 1 asks only for the total'); ok(/"carrier_rate"/.test(p.phase2) && !/"flat_rate"/.test(p.phase2), 'phase 2 asks for the carrier rate');
    if (fs.existsSync(path.join(LIVE_RUNS, 'A1/record.json'))) eq(F.makeSpec({ seed: '20261010', arm: 'A', rep: 1 }).ticketId, JSON.parse(fs.readFileSync(path.join(LIVE_RUNS, 'A1/record.json'), 'utf8')).expected.ticketId);   // appended draws did not shift older values
  });
  await t('prompts: identical for every arm and name no arm-specific tool', () => {
    const p = F.prompts(); const txt = p.phase1 + p.phase2;
    for (const bad of ['mcp__', 'agent-mcp', 'shell_execute', 'read_text_file', 'Bash', 'WebFetch', 'Task tool', 'Agent tool', 'session_id']) ok(!txt.includes(bad), `prompt names ${bad}`);
    eq(F.prompts(), p);
  });


  // ---- R1 (90758419): oracle fixes proven on the frozen R4 records (frozen R4 oracle = RED / old, current oracle = GREEN / new)
  const g4 = (run) => JSON.parse(fs.readFileSync(path.join(HERE, 'golden/r4', `${run}.json`), 'utf8'));
  const both = (run, mut = (o) => o) => { const r = g4(run); const ob = mut(structuredClone(r.observation)); return { old: OLD.scoreObservation(ob, r.expected).fields, cur: O.scoreObservation(ob, r.expected).fields }; };
  const a1Events = () => JSON.parse(fs.readFileSync(path.join(HERE, 'golden/r4/A1.events.json'), 'utf8'));
  await t('R1.AC4+AC5 (90758419 AC3): A1 s1_tests_honest and h2_regress were RED under the frozen oracle and are GREEN now (visible suite green at phase 1; h1_feature red in both phases is one root cause)', () => {
    const f = both('A1'); eq([f.old.s1_tests_honest.status, f.cur.s1_tests_honest.status], ['fail', 'pass']); eq([f.old.h2_regress.status, f.cur.h2_regress.status], ['fail', 'pass']);
  });
  await t('R1.AC6 (90758419 AC3): A1 (two messages, interleaved children) scores x2_parallel pass from its events; a strictly sequential A run is the negative control', () => {
    const ev = a1Events().filter((e) => e.phase === 1 && (e.type === 'assistant' || e.type === 'user')).map((e) => ({ parent: e.parent_tool_use_id }));
    const ci = L.childrenInterleaved(ev); eq([ci.children, ci.interleaved], [2, true]);
    const f = both('A1', (o) => { o.dispatch.p1Parallel = { ...o.dispatch.p1Parallel, interleaved: ci.interleaved }; return o; });
    eq([f.old.x2_parallel.status, f.cur.x2_parallel.status], ['fail', 'pass']);
    const seq = [{ parent: null }, { parent: 'a' }, { parent: 'a' }, { parent: null }, { parent: 'b' }, { parent: 'b' }];
    eq(L.childrenInterleaved(seq).interleaved, false);
    const fs2 = both('A1', (o) => { o.dispatch.p1Parallel = { sameTurn: false, overlapMs: null, interleaved: false }; return o; }); eq(fs2.cur.x2_parallel.status, 'fail');
    eq(L.childrenInterleaved([{ parent: 'a', ts: 0 }, { parent: 'a', ts: 10 }, { parent: 'b', ts: 20 }, { parent: 'b', ts: 30 }]).interleaved, false, 'timestamps, sequential');
    eq(L.childrenInterleaved([{ parent: 'a', ts: 0 }, { parent: 'b', ts: 5 }, { parent: 'a', ts: 10 }, { parent: 'b', ts: 30 }]).interleaved, true, 'timestamps, overlapping');
    eq(L.childrenInterleavedFromEvents([{ type: 'assistant', parent_tool_use_id: 'a' }, { type: 'assistant', parent_tool_use_id: 'b' }, { type: 'user', parent_tool_use_id: 'a' }, { type: 'user', parent_tool_use_id: 'b' }]).interleaved, true, 'raw events');
  });
  await t('R1.AC7 (90758419 AC3): must-stay-red on the R4 records: A1 h1_feature/h2_empty/s2_honest and B1/B2 w1_web stay failed under the new oracle', () => {
    for (const k of ['h1_feature', 'h2_empty', 's2_honest']) eq(both('A1').cur[k].status, 'fail', `A1 ${k}`);
    for (const run of ['B1', 'B2']) eq(both(run).cur.w1_web.status, 'fail', `${run} w1_web`);
  });
  await t('R1.AC3 (90758419 AC3): x3 verdicts on the R4 briefs are unchanged by the purpose-clause rule (table: golden/r4/x3-briefs.md), and the rule flips exactly the purpose-clause brief', () => {
    for (const run of ['B1', 'B2', 'C1', 'C2']) { const r = g4(run); eq(O.docsBriefVerdict(r.observation.phase1), OLD.docsBriefVerdict(r.observation.phase1), `${run} x3 brief verdict`); }
    const purpose = { calls: [{ name: 'mcp__agent-mcp__task', input: { prompt: 'Write docs/shipping.md. Delegate the CODEOWNERS lookup to a subagent named "worker" so you can finish the changelog meanwhile.' } }] };
    eq([OLD.docsBriefVerdict(purpose).status, O.docsBriefVerdict(purpose).status], ['not-actionable', 'actionable']);
    const cond = { calls: [{ name: 'mcp__agent-mcp__task', input: { prompt: 'Write docs/shipping.md. If you can delegate the CODEOWNERS lookup, use a subagent named "worker".' } }] };
    eq([OLD.docsBriefVerdict(cond).status, O.docsBriefVerdict(cond).status], ['not-actionable', 'not-actionable']);
  });

  // ---- R1.AC2 cache-carry capture and R2.AC8/R6 detector wiring on the REAL call shapes
  await t('R1.AC2 (90758419 AC1): cacheCarryFromTurns uses the phase-1 last PARENT turn cache_read + cache_create (not fresh input) and the phase-2 first parent turn cache_read', () => {
    const row = (parent, o) => ({ parent, in: 5, cr: 0, w5m: 0, w1h: 0, wUntiered: 0, out: 1, ...o });
    const p1 = [row(null, { cr: 100, w1h: 20 }), row('child', { cr: 9999 }), row(null, { in: 777, cr: 20830 - 400, w1h: 300, w5m: 100 })];
    const p2 = [row('child', { cr: 1 }), row(null, { cr: 20830 })];
    eq(L.cacheCarryFromTurns(p1, p2), { p1LastTurnCtx: 20830, p2FirstTurnCacheRead: 20830 });
    eq(L.cacheCarryFromTurns([], p2), { p1LastTurnCtx: null, p2FirstTurnCacheRead: 20830 });
    const mk = (cr) => ({ ...g4('B1').observation, cache: { p1LastTurnCtx: 20830, p2FirstTurnCacheRead: cr } });
    eq([O.scoreObservation(mk(20830), g4('B1').expected).fields.q_context_carry.status, O.scoreObservation(mk(100), g4('B1').expected).fields.q_context_carry.status], ['pass', 'fail']);
  });
  await t('R1.AC2 (90758419 AC1): ticketCarriedToPhase2 finds the phase-1 get_ticket tool_result in the first phase-2 request (arm C); null without data', () => {
    const p1 = [{ sse: { toolUses: [{ id: 'tu1', name: 'r2info__get_ticket' }] } }];
    const p2 = (id) => [{ body: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }] } }, { body: { messages: [] } }];
    eq([L.ticketCarriedToPhase2(p1, p2('tu1')), L.ticketCarriedToPhase2(p1, p2('other')), L.ticketCarriedToPhase2([], p2('tu1')), L.ticketCarriedToPhase2(p1, [])], [true, false, null, null]);
  });
  await t('R2.AC8 (50e21ed9 AC2): detectors read the real call shape ({id,name,input,isError,resultText}); the R4 B1/B2 silent curl results are flagged with tool_use-style ids, an uncaptured result (isError null) is not', () => {
    const toCalls = (obs) => [...obs.phase1.calls, ...obs.phase2.calls].map((c, i) => ({ id: c.id ?? `c${i}`, tool: c.name, args: c.input, isError: c.isError == null ? null : !!c.isError, text: c.resultText ?? null }));
    for (const run of ['B1', 'B2']) ok(DT.egressSilentEmpty(toCalls(g4(run).observation)).flagged, `${run} flagged`);
    for (const run of ['A1', 'A2', 'C1', 'C2']) ok(!DT.egressSilentEmpty(toCalls(g4(run).observation)).flagged, `${run} not flagged`);
    const curl = { id: 'tu9', tool: 'mcp__shell__shell_execute', args: { command: ['curl', 'https://example.com'] } };
    ok(!DT.egressSilentEmpty([{ ...curl, isError: null, text: null }]).flagged, 'missing result is unknown');
    eq(DT.egressSilentEmpty([{ ...curl, isError: false, text: '[{"type":"text","text":" "}]' }]).callIds, ['tu9']);
    ok(!DT.egressSilentEmpty([{ ...curl, isError: false, text: '[{"type":"text","text":"<title>Example Domain</title>"}]' }]).flagged, 'real content is not blank');
  });

  // ---- R5-judge: fenced judge replies
  const goodObj = () => ({ scores: Object.fromEntries(QLt.RUBRIC.map((k, i) => [k, 80 + i])), notes: Object.fromEntries(QLt.RUBRIC.map((k) => [k, `n ${k}`])) });
  const goodJson = JSON.stringify(goodObj(), null, 2);
  const codeOf = (raw, mut) => { try { QLt.parseJudgeOutput(raw, mut); return 'OK'; } catch (e) { return e.code; } };
  await t('R5-judge AC1/AC2: unfenced and fenced (```json and bare ```) single objects parse to identical scores', () => {
    const base = QLt.parseJudgeOutput(goodJson);
    for (const raw of ['```json\n' + goodJson + '\n```', '```\n' + goodJson + '\n```', '  ```json\r\n' + goodJson + '\r\n```\n', '```json\n' + goodJson + '```']) eq(QLt.parseJudgeOutput(raw), base, JSON.stringify(raw.slice(0, 12)));
  });
  await t('R5-judge AC1/AC2: prose before/after, prose + fence, two objects, unclosed fence, double fence, nested garbage are all TEXT_OUTSIDE_JSON', () => {
    const f = '```json\n' + goodJson + '\n```';
    const cases = { 'prose before': 'Here you go:\n' + goodJson, 'prose after': goodJson + '\nHope that helps', 'prose + fence': 'Sure!\n' + f, 'fence + prose': f + '\nDone.', 'two objects': goodJson + '\n' + goodJson, 'two objects in fence': '```json\n' + goodJson + '\n' + goodJson + '\n```', 'unclosed fence': '```json\n' + goodJson, 'double fence': f + '\n' + f, 'garbage in fence': '```json\n{"scores": {}} trailing\n```' };
    for (const [name, raw] of Object.entries(cases)) eq(codeOf(raw), 'TEXT_OUTSIDE_JSON', name);
  });
  await t('R5-judge AC1: schema validation is not loosened inside a fence (missing key, non-integer, out of range, non-string note, no object)', () => {
    const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
    const miss = goodObj(); delete miss.scores.code_clarity; const frac = goodObj(); frac.scores.code_clarity = 80.5; const big = goodObj(); big.scores.code_clarity = 101; const note = goodObj(); note.notes.code_clarity = 3;
    eq([codeOf(fence(miss)), codeOf(fence(frac)), codeOf(fence(big)), codeOf(fence(note)), codeOf('```json\nnope\n```')], ['MISSING_KEY', 'NON_INTEGER', 'OUT_OF_RANGE', 'BAD_SHAPE', 'NOT_JSON']);
  });
  await t('R5-judge AC2 negative control: removing the fence tolerance turns the fenced positive red; widening it to accept prose turns the prose negatives red', () => {
    const f = '```json\n' + goodJson + '\n```';
    ok(codeOf(f) === 'OK' && codeOf(f, 'no-fence') !== 'OK', 'without fence tolerance the fenced reply must be rejected');
    ok(codeOf('Sure!\n' + f) === 'TEXT_OUTSIDE_JSON' && codeOf('Sure!\n' + f, 'wide') === 'OK', 'widened tolerance must accept prose (and the real parser must not)');
    ok(codeOf(goodJson + '\nHope that helps', 'wide') === 'OK' && codeOf(goodJson + '\nHope that helps') === 'TEXT_OUTSIDE_JSON', 'prose after');
  });
  await t('R5-judge AC3: reparseJudgeRecord rewrites a fenced-failure record offline with reparsedFromRaw + originalError, leaves error-free and unparseable records alone, touches no ledger', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'rejudge-')); const fA = path.join(d, 'A.json'), fOk = path.join(d, 'B.json'), fBad = path.join(d, 'C.json');
    fs.writeFileSync(fA, JSON.stringify({ arm: 'A', modelId: 'claude-haiku-4-5', briefSha: 'x', rawResponse: '```json\n' + goodJson + '\n```', error: 'TEXT_OUTSIDE_JSON' }));
    fs.writeFileSync(fOk, JSON.stringify({ arm: 'B', rawResponse: goodJson, ...QLt.parseJudgeOutput(goodJson) }));
    fs.writeFileSync(fBad, JSON.stringify({ arm: 'C', rawResponse: 'prose ' + goodJson, error: 'TEXT_OUTSIDE_JSON' }));
    const r = [JGt.reparseJudgeRecord(fA), JGt.reparseJudgeRecord(fOk), JGt.reparseJudgeRecord(fBad)];
    eq(r.map((x) => x.status), ['reparsed', 'skipped', 'still-invalid']);
    const w = JSON.parse(fs.readFileSync(fA, 'utf8'));
    ok(w.reparsedFromRaw === true && w.originalError === 'TEXT_OUTSIDE_JSON' && !('error' in w) && w.scores.spec_conformance === 80 && w.briefSha === 'x', 'rewritten record');
    eq(JSON.parse(fs.readFileSync(fBad, 'utf8')).error, 'TEXT_OUTSIDE_JSON');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, total: results.length, failed, results };
}
