import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PARITY_DIR, loadParity } from './load';

/**
 * R1 oracle fixes (ticket 90758419 AC1-AC3) proven on the frozen R4 records: the frozen R4 oracle is RED/old, the current oracle is GREEN/new.
 * Ported from the R1 section of parity/libtest.mjs. Goldens are read-only evidence under parity/golden/r4.
 */
const L = await loadParity('lib.mjs');
const O = await loadParity('oracle.mjs');
const OLD = await loadParity('golden/r4/oracle.r4.frozen.mjs');
const DT = await loadParity('detectors.mjs');

const g4 = (run: string) => JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden/r4', `${run}.json`), 'utf8'));
const a1Events = () => JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'golden/r4/A1.events.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const both = (run: string, mut: (o: any) => any = (o) => o) => {
  const r = g4(run);
  const ob = mut(structuredClone(r.observation));
  return { old: OLD.scoreObservation(ob, r.expected).fields, cur: O.scoreObservation(ob, r.expected).fields };
};

describe('oracle R1 (90758419 AC3)', () => {
  it('R1.AC4+AC5: A1 s1_tests_honest and h2_regress were RED under the frozen oracle and are GREEN now', () => {
    const f = both('A1');
    expect([f.old.s1_tests_honest.status, f.cur.s1_tests_honest.status]).toEqual(['fail', 'pass']);
    expect([f.old.h2_regress.status, f.cur.h2_regress.status]).toEqual(['fail', 'pass']);
  });

  it('R1.AC6: A1 (two messages, interleaved children) scores x2_parallel pass from its events; sequential runs are the negative control', () => {
    const ev = a1Events()
      .filter((e: { phase: number; type: string }) => e.phase === 1 && (e.type === 'assistant' || e.type === 'user'))
      .map((e: { parent_tool_use_id: string | null }) => ({ parent: e.parent_tool_use_id }));
    const ci = L.childrenInterleaved(ev);
    expect([ci.children, ci.interleaved]).toEqual([2, true]);
    const f = both('A1', (o) => {
      o.dispatch.p1Parallel = { ...o.dispatch.p1Parallel, interleaved: ci.interleaved };
      return o;
    });
    expect([f.old.x2_parallel.status, f.cur.x2_parallel.status]).toEqual(['fail', 'pass']);

    const seq = [{ parent: null }, { parent: 'a' }, { parent: 'a' }, { parent: null }, { parent: 'b' }, { parent: 'b' }];
    expect(L.childrenInterleaved(seq).interleaved).toBe(false);
    const sequential = both('A1', (o) => {
      o.dispatch.p1Parallel = { sameTurn: false, overlapMs: null, interleaved: false };
      return o;
    });
    expect(sequential.cur.x2_parallel.status).toBe('fail');
    expect(L.childrenInterleaved([{ parent: 'a', ts: 0 }, { parent: 'a', ts: 10 }, { parent: 'b', ts: 20 }, { parent: 'b', ts: 30 }]).interleaved).toBe(false);
    expect(L.childrenInterleaved([{ parent: 'a', ts: 0 }, { parent: 'b', ts: 5 }, { parent: 'a', ts: 10 }, { parent: 'b', ts: 30 }]).interleaved).toBe(true);
    const raw = [{ type: 'assistant', parent_tool_use_id: 'a' }, { type: 'assistant', parent_tool_use_id: 'b' }, { type: 'user', parent_tool_use_id: 'a' }, { type: 'user', parent_tool_use_id: 'b' }];
    expect(L.childrenInterleavedFromEvents(raw).interleaved).toBe(true);
  });

  it('R1.AC7: must-stay-red on the R4 records: A1 h1_feature/h2_empty/s2_honest and B1/B2 w1_web stay failed under the new oracle', () => {
    for (const k of ['h1_feature', 'h2_empty', 's2_honest']) expect(both('A1').cur[k].status, `A1 ${k}`).toBe('fail');
    for (const run of ['B1', 'B2']) expect(both(run).cur.w1_web.status, `${run} w1_web`).toBe('fail');
  });

  it('R1.AC3: x3 verdicts on the R4 briefs are unchanged by the purpose-clause rule, and the rule flips exactly the purpose-clause brief', () => {
    for (const run of ['B1', 'B2', 'C1', 'C2']) {
      const r = g4(run);
      expect(O.docsBriefVerdict(r.observation.phase1), `${run} x3 brief verdict`).toEqual(OLD.docsBriefVerdict(r.observation.phase1));
    }
    const purpose = { calls: [{ name: 'mcp__agent-mcp__task', input: { prompt: 'Write docs/shipping.md. Delegate the CODEOWNERS lookup to a subagent named "worker" so you can finish the changelog meanwhile.' } }] };
    expect([OLD.docsBriefVerdict(purpose).status, O.docsBriefVerdict(purpose).status]).toEqual(['not-actionable', 'actionable']);
    const cond = { calls: [{ name: 'mcp__agent-mcp__task', input: { prompt: 'Write docs/shipping.md. If you can delegate the CODEOWNERS lookup, use a subagent named "worker".' } }] };
    expect([OLD.docsBriefVerdict(cond).status, O.docsBriefVerdict(cond).status]).toEqual(['not-actionable', 'not-actionable']);
  });

  it('R1.AC2: cacheCarryFromTurns uses the phase-1 last PARENT turn cache_read + cache_create (not fresh input) and the phase-2 first parent turn cache_read', () => {
    const row = (parent: string | null, o: object) => ({ parent, in: 5, cr: 0, w5m: 0, w1h: 0, wUntiered: 0, out: 1, ...o });
    const p1 = [row(null, { cr: 100, w1h: 20 }), row('child', { cr: 9999 }), row(null, { in: 777, cr: 20830 - 400, w1h: 300, w5m: 100 })];
    const p2 = [row('child', { cr: 1 }), row(null, { cr: 20830 })];
    expect(L.cacheCarryFromTurns(p1, p2)).toEqual({ p1LastTurnCtx: 20830, p2FirstTurnCacheRead: 20830 });
    expect(L.cacheCarryFromTurns([], p2)).toEqual({ p1LastTurnCtx: null, p2FirstTurnCacheRead: 20830 });
    const mk = (cr: number) => ({ ...g4('B1').observation, cache: { p1LastTurnCtx: 20830, p2FirstTurnCacheRead: cr } });
    const status = (cr: number) => O.scoreObservation(mk(cr), g4('B1').expected).fields.q_context_carry.status;
    expect([status(20830), status(100)]).toEqual(['pass', 'fail']);
  });

  it('R1.AC2: ticketCarriedToPhase2 finds the phase-1 get_ticket tool_result in the first phase-2 request (arm C); null without data', () => {
    const p1 = [{ sse: { toolUses: [{ id: 'tu1', name: 'r2info__get_ticket' }] } }];
    const p2 = (id: string) => [{ body: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }] } }, { body: { messages: [] } }];
    expect([L.ticketCarriedToPhase2(p1, p2('tu1')), L.ticketCarriedToPhase2(p1, p2('other')), L.ticketCarriedToPhase2([], p2('tu1')), L.ticketCarriedToPhase2(p1, [])]).toEqual([true, false, null, null]);
  });

  it('R2.AC8: detectors read the real call shape; the R4 B1/B2 silent curl results are flagged, no other R4 run is', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toCalls = (obs: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [...obs.phase1.calls, ...obs.phase2.calls].map((c: any, i: number) => ({ id: c.id ?? `c${i}`, tool: c.name, args: c.input, isError: c.isError == null ? null : !!c.isError, text: c.resultText ?? null }));
    for (const run of ['B1', 'B2']) expect(DT.egressSilentEmpty(toCalls(g4(run).observation)).flagged, `${run} flagged`).toBe(true);
    for (const run of ['A1', 'A2', 'C1', 'C2']) expect(DT.egressSilentEmpty(toCalls(g4(run).observation)).flagged, `${run} not flagged`).toBe(false);
  });

  it('R1 teeth: the frozen oracle really is the old behaviour (negative control) - it fails A1 where the current oracle passes', () => {
    const f = both('A1');
    expect(f.old.s1_tests_honest.status).not.toBe(f.cur.s1_tests_honest.status);
  });
});

describe('call metrics and dispatch evidence (ported from libtest)', () => {
  const c = (name: string, resultText: string) => ({ name, input: { n: Math.random() }, isError: false, resultText });

  it('metrics: wasted = calls after the last green test run; null when never green', () => {
    const m = L.callMetrics([c('Bash', 'fail 3'), c('Edit', 'ok'), c('Bash', 'ℹ fail 0'), c('Read', 'x'), c('Read', 'y')]);
    expect([m.completeAt, m.wasted, m.total]).toEqual([2, 2, 5]);
    expect(L.callMetrics([c('Bash', 'fail 3')]).wasted).toBeNull();
    expect(L.callMetrics([c('mcp__shell__shell_execute', 'fail 0')]).wasted).toBe(0);
    expect(L.callMetrics([c('Read', 'fail 0')]).wasted).toBeNull();
  });

  it('dispatch: only Agent/Task and agent-mcp task RUN a worker (agent merely opens a session)', () => {
    for (const n of ['Agent', 'Task', 'mcp__agent-mcp__task', 'agent-mcp__task']) expect(L.isRunName(n), n).toBe(true);
    for (const n of ['mcp__agent-mcp__agent', 'agent-mcp__result', 'Bash', 'mcp__r2info__get_ticket']) expect(L.isRunName(n), n).toBe(false);
  });

  it('parallel (native stream): same-message pair counts; sequential pair does not; child-level calls are not the parent dispatch', () => {
    const tu = (mid: string, id: string) => ({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
    const tr = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    expect(L.parallelFromCliEvents([tu('m1', 'a'), tu('m1', 'b'), tr('a'), tr('b')]).sameTurn).toBe(true);
    expect(L.parallelFromCliEvents([tu('m1', 'a'), tu('m2', 'b'), tr('a'), tr('b')]).sameTurn).toBe(true);
    expect(L.parallelFromCliEvents([tu('m1', 'a'), tr('a'), tu('m2', 'b'), tr('b')]).sameTurn).toBe(false);
    expect(L.parallelFromCliEvents([{ ...tu('m1', 'a'), parent_tool_use_id: 'P' }, { ...tu('m1', 'b'), parent_tool_use_id: 'P' }]).sameTurn).toBe(false);
  });

  it('parallel: one tasks_batch of 2 is a parallel fan-out under every bridged name; two sequential task turns are not', () => {
    const tb = (mid: string, id: string, name: string, input: object) => ({ type: 'assistant', message: { id: mid, content: [{ type: 'tool_use', id, name, input }] } });
    const tr = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    for (const name of ['mcp__agent-mcp__tasks_batch', 'agent_mcp__tasks_batch', 'agent-mcp__tasks_batch']) {
      expect(L.isRunName(name), name).toBe(true);
      const r = L.parallelFromCliEvents([tb('m1', 'a', name, { tasks: [{}, {}] }), tr('a')]);
      expect([r.sameTurn, r.runs], name).toEqual([true, 2]);
    }
    expect(L.parallelFromCliEvents([tb('m1', 'a', 'mcp__agent-mcp__task', {}), tr('a'), tb('m2', 'b', 'mcp__agent-mcp__task', {}), tr('b')]).sameTurn).toBe(false);
    expect(L.parallelFromHttpTurns([{ sse: { toolUses: [{ name: 'agent-mcp__tasks_batch', input: { tasks: [{}, {}, {}] } }] } }]).sameTurn).toBe(true);
  });

  it('parallel (http) and overlapMs: 2 in one response counts, split does not; overlap is positive/negative/null', () => {
    const turn = (n: number) => ({ sse: { toolUses: Array.from({ length: n }, () => ({ name: 'agent-mcp__task' })) } });
    expect(L.parallelFromHttpTurns([turn(2)]).sameTurn).toBe(true);
    expect(L.parallelFromHttpTurns([turn(1), turn(1)]).sameTurn).toBe(false);
    expect(L.overlapMs([{ createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }, { createdAt: '2026-01-01T00:00:02Z', completedAt: '2026-01-01T00:00:12Z' }])).toBe(8000);
    expect(L.overlapMs([{ createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' }, { createdAt: '2026-01-01T00:00:05Z', completedAt: '2026-01-01T00:00:09Z' }])).toBeLessThan(0);
    expect(L.overlapMs([{ createdAt: 'x', completedAt: 'y' }, { createdAt: 'x', completedAt: 'y' }])).toBeNull();
  });
});
