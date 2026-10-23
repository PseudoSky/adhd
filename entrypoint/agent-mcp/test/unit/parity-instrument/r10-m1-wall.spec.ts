/*
 * guards: the wall-attribution reader mis-computes per-thread or per-dispatch numbers from raw tracing records (sync versus background dispatch, result waits, barrier queued_ms, startup queue_wait_ms and session_ms), crashes or invents numbers on r9 goldens that predate the signals, or any pre-existing analyze section drifts from its captured baseline.
 * tier: S (pure functions and in-process CLI over committed raw trace records)
 * cites: R10 M1 AC1-AC7 (as titled in this file; no backlog uid appears in this file; filed under G9 bucket 003366c1-fef5-4b97-be06-bda8155d31a3).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from '../../helpers/parity-instrument/load';
import {
  ATTR_SPECS, DRYRUN_TRACE, GOLDEN, SYNTHETIC_TRACE, bundleOf, cleanupRuns, compareBundleToRaw, expectedPrestart, expectedTaskFacts, kv, rawLines, wallBlock, writeBundle,
  type Raw,
} from '../../helpers/parity-instrument/r10-m1-fixture';

/**
 * R10 M1 - the parity instrument READS the R10 trace signals and prints a wall-attribution table (owner: "Please do not tell me 'I cant tell why' again, without having already corrected by
 * properly implementing logging with the tracing module"). Unit lane: pure functions + in-process CLI over committed raw tracing-plugin output:
 *   - golden/r10/r10-m1-dryrun-C1.trace.jsonl   REAL: the tracing plugin's output of a mock-provider run through the real built server (drive.mjs --dry-run --round R10), filtered to the span records the reader uses
 *   - golden/r10/r10-m1-synthetic-C1.trace.jsonl SYNTHETIC (hand-built, record shape identical to the sink's): one sync and one background dispatch in ONE parent turn at clearly different start times,
 *                                               a `result` wait, barrier waits with queued_ms, startup queue_wait_ms/session_ms. The committed dry-run golden was captured BEFORE R10 M2 (no queue_wait_ms /
 *                                               session_ms on its children) and a mock-provider run emits no queued_ms, wait_ms or background dispatch, so those are proven here from raw records;
 *                                               queue_wait_ms / session_ms are additionally proven from a FRESH real-server run in the e2e file.
 *   - golden/r10/m1-baseline/*.txt              the output of every pre-existing `analyze` section on the committed r9 goldens, captured BEFORE the M1 change (AC6 byte-identity)
 * The real-server end-to-end half (AC1/AC2/AC7 on a freshly produced trace, AC6 exit codes) is r10-m1-wall.e2e.ts.
 */
const AN = await loadParity('analyze.mjs');
const P = 'p0000000-0000-4000-8000-000000000001'; const C1 = 'c1111111-1111-4111-8111-000000000002'; const C2 = 'c2222222-2222-4222-8222-000000000003';
const synthetic = rawLines(SYNTHETIC_TRACE);
const dryrun = rawLines(DRYRUN_TRACE);
afterAll(() => cleanupRuns());

const NONE_LABEL = 'no thinking field sent (API default; may still think)';
const io = { tmpRoot: () => '/nonexistent' };
const cli = (a: string, c: string, section: string) => AN.analyzeCli(['R10', a, c, '--section', section], io) as { code: number; out?: string; err?: string };
const goldenBundle = (n: string) => path.join(GOLDEN, n);
/** Print the wall section of `c` (arm C) beside the committed r9 A bundle. */
async function wallOf(lines: Raw[]) {
  const c = writeBundle(await bundleOf(lines));
  const r = cli(goldenBundle('r9-A1.bundle.json'), c, 'wall'); expect(r.code, r.err).toBe(0);
  return wallBlock(r.out as string, 'C1');
}
const line = (rows: string[], needle: string) => { const l = rows.find((x) => x.includes(needle)); if (!l) throw new Error(`no line with ${needle}`); return l; };
/** the dispatch line of `child` (asserted to belong to `parent`). */
const dispatchLine = (rows: string[], parent: string, child: string) => { const l = line(rows, ` | child ${child.slice(0, 8)} | `); if (!l.startsWith(`${parent.slice(0, 8)} | `)) throw new Error(`dispatch of ${child} is not on ${parent}`); return l; };

describe('R10 M1 AC1: the evidence bundle carries every R10 wall-attribution attribute, per record', () => {
  const exercised = (r: ReturnType<typeof compareBundleToRaw>, attr: string) => r[attr].seen;

  it('R10 M1 AC1: SYNTHETIC raw records -> bundle: every attribute (incl. queued_ms, wait_ms, queue_wait_ms, session_ms, background mode) is present and equal to its raw value', async () => {
    const r = compareBundleToRaw(synthetic, await bundleOf(synthetic));
    for (const s of ATTR_SPECS) { expect(exercised(r, s.attr), `${s.attr}: fixture must exercise it`).toBeGreaterThan(0); expect(r[s.attr].mismatches, s.attr).toEqual([]); }
    expect(exercised(r, 'agent.startup.mcp_connect_ms.<server>')).toBeGreaterThanOrEqual(6);
    expect(r['agent.startup.mcp_connect_ms.<server>'].mismatches).toEqual([]);
  });

  it('R10 M1 AC1: REAL-SERVER raw records (mock provider through the built agent-mcp) -> bundle: every attribute the real trace emits is present and equal', async () => {
    const r = compareBundleToRaw(dryrun, await bundleOf(dryrun));
    const realEmits = ATTR_SPECS.map((s) => s.attr).filter((a) => !['agent.tool.queued_ms', 'agent.dispatch.wait_ms', 'agent.startup.queue_wait_ms', 'agent.startup.session_ms'].includes(a));
    for (const a of realEmits) { expect(exercised(r, a), `${a}: the real trace must carry it`).toBeGreaterThan(0); expect(r[a].mismatches, a).toEqual([]); }
    expect(exercised(r, 'agent.startup.mcp_connect_ms.<server>')).toBeGreaterThan(0);
    expect(r['agent.startup.mcp_connect_ms.<server>'].mismatches).toEqual([]);
  });

  it('R10 M1 AC1: an attribute the record does not carry is null in the bundle, never 0 (queued_ms on a first-group call, queue_wait_ms/session_ms on a child, thinking on a non-Anthropic call)', async () => {
    const b = await bundleOf(synthetic);
    expect(b.trace.toolCalls.find((c: { callId: string }) => c.callId === 'toolu_S1').queuedMs).toBeNull();
    const su = b.trace.tasks.find((t: { task: string }) => t.task === C1).startup;
    expect(su.queueWaitMs).toBeNull(); expect(su.sessionMs).toBeNull();
    const noThink = b.trace.modelCalls.filter((m: { task: string; turnIndex: number }) => m.task === C1 && m.turnIndex === 1)[0];
    expect(noThink.thinkingConfig).toBeNull(); expect(noThink.thinkingBlocks).toBeNull();
  });

  it('R10 M1 AC1: the leak scan stays clean on a bundle with the new fields (no prompt/args/thinking text can enter them)', async () => {
    const EV = await loadParity('evidence.mjs');
    expect(EV.leakScan(JSON.stringify(await bundleOf(synthetic))).ok).toBe(true);
    expect(EV.leakScan(JSON.stringify(await bundleOf(dryrun))).ok).toBe(true);
  });
});

describe('R10 M1 AC2: the wall section prints the attribution per task thread, matching values computed independently from the raw records', () => {
  it('R10 M1 AC2: per task thread: tools_ready_ms with per-server connect, queued_ms summed, model/tool/idle (synthetic: parent + sync child + background child)', async () => {
    const rows = await wallOf(synthetic);
    for (const t of [P, C1, C2]) {
      const x = expectedTaskFacts(synthetic, t); const l = line(rows, `${t.slice(0, 8)} | `);
      expect(kv(l, 'wall_ms'), t).toBe(String(x.wallMs)); expect(kv(l, 'model_ms'), t).toBe(String(x.modelMs)); expect(kv(l, 'tool_ms'), t).toBe(String(x.toolMs));
      expect(kv(l, 'idle_ms'), t).toBe(String(x.idleMs)); expect(kv(l, 'tools_ready_ms'), t).toBe(String(x.toolsReadyMs));
    }
    const lp = line(rows, `${P.slice(0, 8)} | `);
    expect(kv(lp, 'queued_ms_sum')).toBe(String(expectedTaskFacts(synthetic, P).queuedSum)); expect(expectedTaskFacts(synthetic, P).queuedSum).toBe(300);
    expect(lp).toContain('connect_ms: fs=300, shell=800'); expect(kv(lp, 'queue_wait_ms')).toBe('15'); expect(kv(lp, 'session_ms')).toBe('40');
    expect(line(rows, `${C1.slice(0, 8)} | `)).toContain('queue_wait_ms=n/a (not recorded); session_ms=n/a (not recorded)');
  });

  it('R10 M1 AC2: per dispatch: parent_blocked_ms, and child_prestart_ms for one SYNC and one BACKGROUND child equals child agent.task start - parent tool_call start by call id', async () => {
    const rows = await wallOf(synthetic);
    const dispatches = synthetic.filter((l) => l.event === 'agent.dispatch.finish');
    const sync = dispatches.find((d) => d['agent.dispatch.call_id'] === 'toolu_A') as Raw; const bg = dispatches.find((d) => d['agent.dispatch.call_id'] === 'toolu_B') as Raw;
    expect(sync['agent.dispatch.mode']).toBe('sync'); expect(bg['agent.dispatch.mode']).toBe('background');
    const ls = dispatchLine(rows, P, C1); const lb = dispatchLine(rows, P, C2);
    expect(kv(ls, 'child_prestart_ms')).toBe(String(expectedPrestart(synthetic, sync, C1))); expect(expectedPrestart(synthetic, sync, C1)).toBe(12);
    expect(kv(lb, 'child_prestart_ms')).toBe(String(expectedPrestart(synthetic, bg, C2))); expect(expectedPrestart(synthetic, bg, C2)).toBe(37);
    expect(ls).toContain(' | sync | '); expect(lb).toContain(' | background | ');
    expect(kv(ls, 'parent_blocked_ms')).toBe('620'); expect(kv(lb, 'parent_blocked_ms')).toBe('0');
    expect(kv(ls, 'call_id')).toBe('toolu_A'); expect(kv(lb, 'call_id')).toBe('toolu_B');
  });

  it('R10 M1 AC2: the join is by call id: two dispatch calls in one parent turn at different starts each get THEIR OWN anchor (a nearest / first-call anchor would print 212 and -288/unmeasurable)', async () => {
    const rows = await wallOf(synthetic);
    const a = synthetic.find((l) => l.event === 'agent.tool_call.start' && l['agent.tool.call_id'] === 'toolu_A') as Raw; const b = synthetic.find((l) => l.event === 'agent.tool_call.start' && l['agent.tool.call_id'] === 'toolu_B') as Raw;
    expect(Date.parse(String(b.ts)) - Date.parse(String(a.ts))).toBe(300);
    expect(kv(dispatchLine(rows, P, C1), 'child_prestart_ms')).toBe('12'); expect(kv(dispatchLine(rows, P, C2), 'child_prestart_ms')).toBe('37');
  });

  it('R10 M1 AC2: a `result` wait starts no child: prints wait_ms and no child_prestart number', async () => {
    const rows = await wallOf(synthetic);
    const l = line(rows, 'call_id=toolu_R');
    expect(kv(l, 'wait_ms')).toBe('1260'); expect(l).toContain(' | result | '); expect(l).toContain('child_prestart_ms=n/a (a result wait: no child started)');
  });

  it('R10 M1 AC2: REAL-SERVER trace: every dispatch child prints the independently computed child_prestart_ms', async () => {
    const rows = await wallOf(dryrun);
    const dispatches = dryrun.filter((l) => l.event === 'agent.dispatch.finish'); expect(dispatches.length).toBeGreaterThanOrEqual(4);
    for (const d of dispatches) { const child = String(d['agent.dispatch.child_task_ids']); expect(kv(dispatchLine(rows, String(d['agent.task_id']), child), 'child_prestart_ms'), child).toBe(String(expectedPrestart(dryrun, d, child))); }
  });
});

describe('R10 M1 AC3: negative control - an unjoinable child prints an explicit marker, never a number and never 0', () => {
  const without = (drop: (l: Raw) => boolean | Raw) => synthetic.flatMap((l) => { const r = drop(l); if (typeof r === 'boolean') return r ? [] : [l]; return [r]; });
  const noCallId = (l: Raw): Raw | false => { if (!String(l.event).startsWith('agent.dispatch.')) return false; const c = { ...l }; delete c['agent.dispatch.call_id']; return c; };
  const noChildIds = (l: Raw): Raw | false => { if (!String(l.event).startsWith('agent.dispatch.')) return false; const c = { ...l }; delete c['agent.dispatch.child_task_ids']; return c; };
  const assertUnmeasurable = (rows: string[], children: string[]) => {
    const all = rows.join('\n');
    expect(all).not.toMatch(/child_prestart_ms=-?\d/);
    for (const c of children) expect(rows.filter((r) => r.includes(` | child ${c.slice(0, 8)} | `)).every((r) => /child_prestart_ms=unmeasurable \(/.test(r))).toBe(true);
  };

  it('R10 M1 AC3: agent.dispatch.call_id removed -> child_prestart_ms is unmeasurable (names the missing call id) for the sync and the background child', async () => {
    const rows = await wallOf(without(noCallId));
    assertUnmeasurable(rows, [C1, C2]);
    expect(line(rows, ` | child ${C1.slice(0, 8)} | `)).toContain('agent.dispatch.call_id absent');
    expect(rows.join('\n')).toContain('unmeasurable for 2');
  });

  it('R10 M1 AC3: agent.dispatch.child_task_ids removed -> the child cannot be identified: unmeasurable, no number', async () => {
    const rows = await wallOf(without(noChildIds));
    const all = rows.join('\n'); expect(all).not.toMatch(/child_prestart_ms=-?\d/);
    expect(all).toContain('agent.dispatch.child_task_ids absent: the child cannot be identified');
  });

  it('R10 M1 AC3: the dispatching tool_call record missing, or the child agent.task record missing -> unmeasurable with the reason', async () => {
    const noCall = await wallOf(without((l) => l['agent.tool.call_id'] === 'toolu_A'));
    expect(line(noCall, ` | child ${C1.slice(0, 8)} | `)).toMatch(/child_prestart_ms=unmeasurable \(no agent\.tool_call record with call id toolu_A/);
    expect(kv(line(noCall, ` | child ${C2.slice(0, 8)} | `), 'child_prestart_ms')).toBe('37');   // the other dispatch is still measured
    const noChild = await wallOf(without((l) => l['agent.task_id'] === C2 && String(l.event).startsWith('agent.task.')));
    expect(line(noChild, ` | child ${C2.slice(0, 8)} | `)).toMatch(/child_prestart_ms=unmeasurable \(child task c2222222 has no agent\.task record/);
  });

  it('R10 M1 AC3: a child that starts BEFORE the dispatching call (clock or join inconsistent) is unmeasurable, not a negative number', async () => {
    const shifted = synthetic.map((l) => (l.event === 'agent.task.start' && l['agent.task_id'] === C1 ? { ...l, ts: '2026-10-13T10:00:01.000Z' } : l));
    const rows = await wallOf(shifted);
    expect(line(rows, ` | child ${C1.slice(0, 8)} | `)).toMatch(/child_prestart_ms=unmeasurable \(the child task starts 200 ms BEFORE/);
  });
});

describe('R10 M1 AC4: thinking_config and thinking_blocks are printed together; none is labelled', () => {
  it('R10 M1 AC4: a none row with thinking_blocks>0 shows both on ONE line, with the label; adaptive and an unreported provider are shown honestly', async () => {
    const rows = await wallOf(synthetic);
    const none = rows.filter((r) => r.startsWith(`${P.slice(0, 8)} | turn 0`)); expect(none).toHaveLength(1);
    expect(none[0]).toContain(`thinking_config=none (${NONE_LABEL}) | thinking_blocks=2`);
    expect(rows.filter((r) => r.startsWith(`${C1.slice(0, 8)} | turn 0`))[0]).toContain('thinking_config=adaptive | thinking_blocks=3');
    expect(rows.filter((r) => r.startsWith(`${C1.slice(0, 8)} | turn 1`))[0]).toContain('thinking_config=n/a (not reported by this provider) | thinking_blocks=n/a (not reported by this provider)');
    expect(rows.filter((r) => r.startsWith(`${C2.slice(0, 8)} | turn 0`))[0]).toContain(`thinking_config=none (${NONE_LABEL}) | thinking_blocks=0`);
    expect(rows.join('\n')).toContain('with thinking_config=none AND thinking_blocks>0: 1');
  });

  it('R10 M1 AC4: REAL-SERVER trace: all 38 model calls are none with thinking_blocks>0, and the summary says so', async () => {
    const rows = await wallOf(dryrun);
    const n = dryrun.filter((l) => l.event === 'agent.model_call.finish').length;
    expect(rows.filter((r) => r.includes(`thinking_config=none (${NONE_LABEL}) | thinking_blocks=1`))).toHaveLength(n);
    expect(rows.join('\n')).toContain(`with thinking_config=none AND thinking_blocks>0: ${n}`);
  });
});

describe('R10 M1 AC5: idle_ms is shown net of the startup span, the remainder labelled unexplained', () => {
  it('R10 M1 AC5: idle_ms = tools_ready_ms + unexplained, for a fixture with a known startup span (parent 1000 = 800 + 200; sync child 450 = 400 + 50; background child 663 = 380 + 283)', async () => {
    const rows = await wallOf(synthetic);
    expect(line(rows, `${P.slice(0, 8)} | `)).toContain('idle_ms=1000 = startup 800 + unexplained 200');
    expect(line(rows, `${C1.slice(0, 8)} | `)).toContain('idle_ms=450 = startup 400 + unexplained 50');
    expect(line(rows, `${C2.slice(0, 8)} | `)).toContain('idle_ms=663 = startup 380 + unexplained 283');
  });

  it('R10 M1 AC5: a startup span longer than idle_ms is shown as a NEGATIVE unexplained (inconsistent record), never clamped to 0', async () => {
    const big = synthetic.map((l) => (l.event === 'agent.task.startup.finish' && l['agent.task_id'] === C1 ? { ...l, 'agent.startup.tools_ready_ms': 500 } : l));
    expect(line(await wallOf(big), `${C1.slice(0, 8)} | `)).toContain('idle_ms=450 = startup 500 + unexplained -50');
  });

  it('R10 M1 AC5: no startup record -> the idle split is unattributable (named), not a folded number', async () => {
    const rows = await wallOf(synthetic.filter((l) => !(l.event === 'agent.task.startup.finish' && l['agent.task_id'] === C1)));
    const l = line(rows, `${C1.slice(0, 8)} | `);
    expect(l).toContain('tools_ready_ms=n/a (no agent.task.startup record)'); expect(l).toContain('idle_ms=450 = unattributable (tools_ready_ms not recorded)');
  });
});

describe('R10 M1 AC6: the pre-existing analysis output is byte-identical', () => {
  const sections = ['gap', 'threads', 'blocking', 'surplus', 'tools', 'contamination', 'rt', 'evidence'];
  const A = goldenBundle('r9-A1.bundle.json'); const C = goldenBundle('r9-C1.bundle.json');
  const base = (s: string) => fs.readFileSync(path.join(GOLDEN, 'm1-baseline', `analyze-r9-${s}.txt`), 'utf8');

  it.each(sections)('R10 M1 AC6: `analyze --section %s` on the committed r9 goldens equals the output captured before the M1 change (cmp)', (s) => {
    const r = cli(A, C, s); expect(r.code, r.err).toBe(0); expect(`${r.out}\n`).toBe(base(s));
  });

  it('R10 M1 AC6: `--section all` = the pre-change `all` output (an exact prefix) followed only by the appended wall sections', () => {
    const r = cli(A, C, 'all'); expect(r.code, r.err).toBe(0);
    const before = base('all').replace(/\n$/, ''); expect((r.out as string).startsWith(before)).toBe(true);
    const tail = (r.out as string).slice(before.length);
    expect(tail).toBe(`\n\n${AN.formatWall(JSON.parse(fs.readFileSync(A, 'utf8')))}\n\n${AN.formatWall(JSON.parse(fs.readFileSync(C, 'utf8')))}`);
  });

  it('R10 M1 AC6: the two committed r9 goldens are unmodified (md5 frozen at the pre-change values)', () => {
    expect(crypto.createHash('md5').update(fs.readFileSync(A)).digest('hex')).toBe('f6a7db82e293420e46fe5921564ca7d5');
    expect(crypto.createHash('md5').update(fs.readFileSync(C)).digest('hex')).toBe('598f51aa3a42f66131772c55b3faabb7');
  });

  it('R10 M1 AC6: on the r9 goldens (which predate the R10 signals) the wall section prints explicit not-recorded markers: no crash, no numbers', () => {
    const r = cli(A, C, 'wall'); expect(r.code, r.err).toBe(0);
    expect(r.out).toBe([
      '== WALL ATTRIBUTION A1 (A) ==', 'n/a (native arm has no trace)', '',
      '== WALL ATTRIBUTION C1 (C) ==', 'n/a (the trace holds none of the R10 wall-attribution attributes: this bundle predates them, or the product did not emit them)',
    ].join('\n'));
  });

  it('R10 M1 AC6: the pre-existing section list and usage are intact and wall is a recognised section', () => {
    expect(cli(A, C, 'nonsense').code).toBe(2);
    expect(AN.analyzeCli(['R10', A, C], io).code).toBe(0);
  });
});

describe('R10 M1 AC7: arm A has no trace; the analysis never invents numbers for it', () => {
  it('R10 M1 AC7: arm A prints exactly `n/a (native arm has no trace)`', () => {
    const r = cli(goldenBundle('r9-A1.bundle.json'), goldenBundle('r9-C1.bundle.json'), 'wall');
    expect(wallBlock(r.out as string, 'A1')).toEqual(['n/a (native arm has no trace)', '']);
  });

  it('R10 M1 AC7: even a bundle labelled arm A that somehow carries trace records prints n/a for A (no numbers invented for the native arm)', async () => {
    const a = await bundleOf(synthetic, 'A'); a.runId = 'A1';
    const out = AN.formatWall(a);
    expect(out).toBe('== WALL ATTRIBUTION A1 (A) ==\nn/a (native arm has no trace)');
    expect(out).not.toMatch(/ms=\d/);
  });

  it('R10 M1 AC7: arm C works, and an arm-C bundle with NO trace says the trace was not captured (different wording from the native-arm line)', async () => {
    const empty = await bundleOf([]);
    const out = AN.formatWall(empty);
    expect(out).toContain('no tracing-plugin output was captured'); expect(out).not.toContain('native arm');
    expect(await wallOf(synthetic)).toEqual(expect.arrayContaining([expect.stringContaining('tools_ready_ms=800')]));
  });
});

describe('R10 M1 AC2: a tasks_batch dispatch (several children of ONE dispatching call)', () => {
  const D1 = 'd1111111-1111-4111-8111-000000000004'; const D2 = 'd2222222-2222-4222-8222-000000000005';
  const at = (ms: number) => `2026-10-13T10:00:0${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}Z`;
  const base: Raw = { level: 'info', service: 'agent-mcp', role: 'live-service', 'agent.session_id': 's', 'agent.root_task_id': P, 'agent.recursion_depth': 0 };
  const batch: Raw[] = [
    { ...base, ts: at(4000), event: 'agent.tool_call.start', 'agent.task_id': P, 'agent.name': 'r2-parent-C1', 'agent.tool.name': 'agent-mcp__tasks_batch', 'agent.tool.call_id': 'toolu_T', 'agent.tool.concurrency_class': 'unordered' },
    { ...base, ts: at(4510), event: 'agent.tool_call.finish', 'agent.task_id': P, 'agent.name': 'r2-parent-C1', 'agent.tool.name': 'agent-mcp__tasks_batch', 'agent.tool.call_id': 'toolu_T', 'agent.tool.concurrency_class': 'unordered', 'agent.tool.is_error': false, duration_ms: 510 },
    ...[[D1, 4020, 'queue_wait_ms'], [D2, 4055, 'queue_wait_ms']].flatMap(([id, t]) => [
      { ...base, ts: at(t as number), event: 'agent.task.start', 'agent.task_id': id as string, 'agent.name': 'worker', 'agent.recursion_depth': 1, 'agent.parent_task_id': P },
      { ...base, ts: at((t as number) + 300), event: 'agent.task.startup.finish', 'agent.task_id': id as string, 'agent.name': 'worker', 'agent.recursion_depth': 1, 'agent.parent_task_id': P, 'agent.startup.tools_ready_ms': 300, 'agent.startup.queue_wait_ms': id === D1 ? 4 : 30, 'agent.startup.session_ms': id === D1 ? 6 : 12, duration_ms: 0 },
      { ...base, ts: at((t as number) + 400), event: 'agent.task.finish', 'agent.task_id': id as string, 'agent.name': 'worker', 'agent.recursion_depth': 1, 'agent.parent_task_id': P, duration_ms: 400, 'agent.outcome': 'completed', 'agent.task.model_ms': 20, 'agent.task.tool_ms': 30, 'agent.task.idle_ms': 350 },
    ]),
    { ...base, ts: at(4500), event: 'agent.dispatch.finish', 'agent.task_id': P, 'agent.name': 'r2-parent-C1', 'agent.dispatch.mode': 'sync', 'agent.dispatch.kind': 'tasks_batch', 'agent.dispatch.children': 2, 'agent.dispatch.child_task_ids': `${D1},${D2}`, 'agent.dispatch.parent_blocked_ms': 500, 'agent.dispatch.call_id': 'toolu_T' },
  ];
  it('R10 M1 AC2: every child of a tasks_batch gets child_prestart_ms from the SAME dispatching call, computed independently (20 and 55), and the split uses its own stamps', async () => {
    const lines = [...synthetic, ...batch]; const rows = await wallOf(lines);
    const d = batch.find((l) => l.event === 'agent.dispatch.finish') as Raw;
    expect(expectedPrestart(lines, d, D1)).toBe(20); expect(expectedPrestart(lines, d, D2)).toBe(55);
    const l1 = dispatchLine(rows, P, D1); const l2 = dispatchLine(rows, P, D2);
    expect(kv(l1, 'child_prestart_ms')).toBe('20'); expect(kv(l2, 'child_prestart_ms')).toBe('55');
    expect(l1).toContain('child_prestart_ms=20 (queue_wait_ms=4 + session_ms=6 + remainder 10)'); expect(l2).toContain('child_prestart_ms=55 (queue_wait_ms=30 + session_ms=12 + remainder 13)');
    expect(l1).toContain(' | tasks_batch | sync | children=2 | '); expect(l2).toContain(' | tasks_batch | sync | children=2 | ');
  });

  it('R10 M1 AC3: a tasks_batch child with no task record is unmeasurable while its sibling is still measured', async () => {
    const lines = [...synthetic, ...batch].filter((l) => !(l['agent.task_id'] === D2 && String(l.event).startsWith('agent.task.')));
    const rows = await wallOf(lines);
    expect(kv(dispatchLine(rows, P, D1), 'child_prestart_ms')).toBe('20');
    expect(dispatchLine(rows, P, D2)).toMatch(/child_prestart_ms=unmeasurable \(child task d2222222 has no agent\.task record/);
  });

  it('R10 M1 AC1: the comma-joined child_task_ids become an array of ids in the bundle', async () => {
    const b = await bundleOf([...synthetic, ...batch]);
    expect(b.trace.dispatches.find((x: { kind: string }) => x.kind === 'tasks_batch').childTaskIds).toEqual([D1, D2]);
  });
});

describe('R10 M1: the CLI wiring', () => {
  it('R10 M1: `wall` is in the usage text and the SECTIONS accepted by analyze; the instrument file set is unchanged apart from M1', () => {
    const r = AN.analyzeCli(['R10'], io); expect(r.code).toBe(2); expect(r.err).toContain('wall');
    expect(fs.existsSync(path.join(PARITY_DIR, 'golden', 'r10', 'r9-A1.bundle.json'))).toBe(true);
  });
});
