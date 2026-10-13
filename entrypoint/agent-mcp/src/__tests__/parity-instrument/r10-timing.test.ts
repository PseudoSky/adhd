import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * PARITY-R10-prep AC1 (SCOPE-R10-prep): the graded wall carries no arm-specific measurement time. Pure tests over parity/timing.mjs and the metrics.mjs fair branch; the driver-level proof (a real dry
 * run of both arms with accounting < 1 s and no fixed sleep) is r10-trace.e2e.test.ts.
 */
const TM = await loadParity('timing.mjs');
const MT = await loadParity('metrics.mjs');

type Mark = { n: string; ms: number };
/** Marks of a two-phase run from the ENGINE windows plus arm-specific harness time; the work (windows) is the part that must be identical across arms. */
function runMarks(opt: { t0: number; setup: number; windows: [number, number]; lag: [number, number]; verify: [number, number]; handoff: number; accounting: number; teardown: number }): Mark[] {
  const m: Mark[] = []; let t = opt.t0;
  const push = (n: string) => m.push({ n, ms: t });
  push('run.start'); t += opt.setup;
  for (let i = 0; i < 2; i++) {
    push(`p${i + 1}.start`); t += opt.windows[i]; push(`p${i + 1}.engineEnd`); t += opt.lag[i]; push(`p${i + 1}.observed`); t += opt.verify[i]; push(`p${i + 1}.hiddenDone`);
    if (i === 0) t += opt.handoff;
  }
  t += opt.accounting; push('accounting.done'); t += opt.teardown; push('run.end');
  return m;
}

describe('PARITY-R10-prep AC1: fairDuration', () => {
  it('AC1: identical engine work + very different harness time = the SAME graded wall; the extra time lands in named segments; the partition has residual 0', () => {
    const work = { windows: [58125, 34795] as [number, number], verify: [400, 400] as [number, number] };
    // arm A shape: no polling, no sleep. arm C shape: server boot in setup, poll lag per phase, a 1.5 s sleep inside accounting, queries, teardown.
    const a = TM.fairDuration(runMarks({ t0: 1_000, setup: 80, ...work, lag: [60, 60], handoff: 20, accounting: 0, teardown: 30 }));
    const c = TM.fairDuration(runMarks({ t0: 9_000, setup: 1283, ...work, lag: [1100, 1108], handoff: 15, accounting: 1500 + 700, teardown: 400 }));
    expect(a.wallMs).toBe(92920);
    expect(c.wallMs).toBe(a.wallMs);   // the harness differences do not reach the graded number
    expect(c.runWallMs - a.runWallMs).toBeGreaterThan(5000);
    expect(c.split).toMatchObject({ setupMs: 1283, lagMs: 2208, verificationMs: 800, handoffMs: 15, accountingMs: 2200, teardownMs: 400, residualMs: 0 });
    expect(a.split.residualMs).toBe(0);
    expect(c.overheadMs).toBe(c.runWallMs - c.wallMs);
    expect(c.observedSumMs).toBe(c.wallMs + 2208);
    expect(c.graded).toBe('fairWallMs');
  });

  it('AC1: a poll that lands late does not change the graded window (engineEnd is the server completedAt, not the observation)', () => {
    const base = { t0: 0, setup: 10, windows: [1000, 2000] as [number, number], verify: [5, 5] as [number, number], handoff: 1, accounting: 7, teardown: 3 };
    const fast = TM.fairDuration(runMarks({ ...base, lag: [1, 1] }));
    const slow = TM.fairDuration(runMarks({ ...base, lag: [2000, 2000] }));
    expect(slow.wallMs).toBe(fast.wallMs);
    expect(slow.split.lagMs).toBe(4000);
  });

  it('AC1: a missing or non-monotonic mark is an explicit error, never a partial number', () => {
    const ok = runMarks({ t0: 0, setup: 1, windows: [10, 10], lag: [1, 1], verify: [1, 1], handoff: 1, accounting: 1, teardown: 1 });
    expect(() => TM.fairDuration(ok.filter((m) => m.n !== 'accounting.done'))).toThrow(/missing mark accounting.done/);
    expect(() => TM.fairDuration(ok.map((m) => (m.n === 'p1.engineEnd' ? { n: m.n, ms: m.ms - 1000 } : m)))).toThrow(/non-monotonic marks: p1.engineEnd/);
    expect(() => TM.fairDuration([])).toThrow(/no phase start mark/);
    expect(() => TM.fairDuration('x')).toThrow(TM.TimingError);
  });

  it('AC1: metrics.durationBreakdown takes the fair branch only for a record that carries fairTiming marks; a timing error is surfaced, not hidden', () => {
    const marks = runMarks({ t0: 0, setup: 5, windows: [100, 200], lag: [10, 10], verify: [3, 3], handoff: 2, accounting: 4, teardown: 6 });
    const rec = { fairTiming: { version: 1, marks, boot: { serverConnectMs: 4 }, settle: { polls: 2 } }, wallMs: 300 };
    const d = MT.durationBreakdown(rec);
    expect(d).toMatchObject({ graded: 'fairWallMs', fairTiming: true, wallMs: 300, overhead: { attributed: true, fair: true, residualMs: 0, lagMs: 20 }, boot: { serverConnectMs: 4 } });
    const bad = MT.durationBreakdown({ ...rec, fairTiming: { version: 1, marks: marks.slice(0, 4) } });
    expect(bad.timingError).toMatch(/missing mark/);
    expect(bad.overhead.attributed).toBe(false);
    // a legacy record (no fairTiming) keeps the legacy shape
    const legacy = MT.durationBreakdown({ wallMs: 300, metrics: { phases: [{ wallMs: 250 }] } });
    expect(legacy.graded).toBe('wallMs');
    expect(legacy.fairTiming).toBeUndefined();
  });
});

describe('PARITY-R10-prep AC1: waitUntilStable replaces the fixed accounting sleep', () => {
  /** A deterministic clock: `sleep` advances it, nothing waits on the wall clock. */
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; }, get t() { return t; } }; };

  it('AC1: returns after two identical consecutive reads (usage rows settled), in ~one interval, not 1500 ms', async () => {
    const k = clock(); let reads = 0;
    const rows = [[1], [1, 2], [1, 2, 3], [1, 2, 3], [1, 2, 3]];
    const r = await TM.waitUntilStable(async () => rows[Math.min(reads++, rows.length - 1)], { intervalMs: 50, deadlineMs: 5000, now: k.now, sleep: k.sleep });
    expect(r).toMatchObject({ settled: true, deadlineHit: false, polls: 4, waitedMs: 150, snapshot: [1, 2, 3] });
    expect(r.waitedMs).toBeLessThan(1500);
  });

  it('AC1: isReady gates the settle: identical-but-empty reads do not count until the readiness predicate holds', async () => {
    const k = clock(); let reads = 0;
    const r = await TM.waitUntilStable(async () => (reads++ < 3 ? [] : [7]), { intervalMs: 10, deadlineMs: 1000, isReady: (s: number[]) => s.length > 0, now: k.now, sleep: k.sleep });
    expect(r.settled).toBe(true);
    expect(r.snapshot).toEqual([7]);
    expect(r.polls).toBe(5);
  });

  it('AC1: bounded: a snapshot that never settles ends at the deadline with deadlineHit, recorded not assumed', async () => {
    const k = clock(); let n = 0;
    const r = await TM.waitUntilStable(async () => n++, { intervalMs: 100, deadlineMs: 1000, now: k.now, sleep: k.sleep });
    expect(r).toMatchObject({ settled: false, deadlineHit: true });
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000);
    expect(r.waitedMs).toBeLessThan(1200);
  });

  it('AC1 negative control: a fixed-sleep implementation (the legacy 1500 ms pause) is distinguishable: it would report waitedMs >= ACCOUNTING_SLEEP_MS for already-settled data', async () => {
    const k = clock();
    const r = await TM.waitUntilStable(async () => ({ done: true }), { intervalMs: 50, deadlineMs: 5000, now: k.now, sleep: k.sleep });
    expect(r.waitedMs).toBeLessThan(MT.ACCOUNTING_SLEEP_MS);
    expect(MT.ACCOUNTING_SLEEP_MS).toBe(1500);
  });
});
