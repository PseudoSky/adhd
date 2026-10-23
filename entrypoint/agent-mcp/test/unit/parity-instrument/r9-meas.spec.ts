/*
 * guards: the duration metrics regress: the graded wallMs changes or phaseSumMs becomes a partial sum, the harness overhead split stops
 *   reconciling, the phase-sum starts gating the verdict, the rederive mode writes to saved R8 records, or paired fixtures change the
 *   unpaired R8 values or share a per-arm nonce.
 * tier: S (in-process pure functions over R8 timing fixtures and tmp copies; no subprocess, no network)
 * cites: R9-meas AC1-AC4 as named in this file; no backlog uid is named in the file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadParity, PARITY_DIR } from '../../helpers/parity-instrument/load';

/**
 * R9-meas (owner answer: "Report both (Recommended)"). Pure instrument tests, no model call, no live run.
 *   AC1 every record carries wallMs (graded, unchanged) AND phaseSumMs plus the harness overhead broken out; rederivable read-only for R8.
 *   AC2 verdict / grid / SUMMARY print both metrics side by side; wall is labelled graded; the phase-sum never gates.
 *   AC3 paired fixtures: one value stream per pairing index n, switched on by ledger.profile.pairedFixtures; existing rounds byte-identical.
 *   AC4 README documents both metrics, the pairing and the owner decision.
 */
const M = await loadParity('metrics.mjs');
const G = await loadParity('grid.mjs');
const F = await loadParity('fixtures.mjs');
const LG = await loadParity('ledger.mjs');
const D = await loadParity('drive.mjs');

// ---- R8 timings, copied from tmp/agent-mcp/parity/R8/live/out/runs/{A1,B1,C1}/record.json (the saved records are never touched) ----
const r8 = {
  A: { runId: 'A1', arm: 'A', wallMs: 85322, metrics: { phases: [{ phase: 1, wallMs: 52568 }, { phase: 2, wallMs: 32169 }] } },
  B: { runId: 'B1', arm: 'B', wallMs: 81144, metrics: { phases: [{ phase: 1, wallMs: 47586, polls: 20 }, { phase: 2, wallMs: 30046, polls: 13 }] } },
  C: { runId: 'C1', arm: 'C', wallMs: 121117, metrics: { phases: [{ phase: 1, wallMs: 70167, polls: 29 }, { phase: 2, wallMs: 47589, polls: 20 }] } },
};

describe('R9-meas AC1: wallMs stays the graded metric, phaseSumMs is added, harness overhead is broken out', () => {
  it('AC1: durationMs is still record.wallMs and phaseSumMs is the sum of phases[].wallMs (R8 A1/B1/C1)', () => {
    expect(M.durationMs(r8.A)).toBe(85322);
    expect(M.durationMs(r8.B)).toBe(81144);
    expect(M.durationMs(r8.C)).toBe(121117);
    expect(M.phaseSumMs(r8.A)).toBe(84737);
    expect(M.phaseSumMs(r8.B)).toBe(77632);
    expect(M.phaseSumMs(r8.C)).toBe(117756);
  });

  it('AC1: harness overhead = wallMs - phaseSumMs (A 585 ms, B 3512 ms, C 3361 ms)', () => {
    expect(M.harnessOverheadMs(r8.A)).toBe(585);
    expect(M.harnessOverheadMs(r8.B)).toBe(3512);
    expect(M.harnessOverheadMs(r8.C)).toBe(3361);
  });

  it('AC1 (negative controls): a missing, non-finite or empty phase makes phaseSumMs null, never a partial sum', () => {
    expect(M.phaseSumMs({ wallMs: 10, metrics: { phases: [] } })).toBeNull();
    expect(M.phaseSumMs({ wallMs: 10 })).toBeNull();
    expect(M.phaseSumMs({ wallMs: 10, metrics: { phases: [{ wallMs: 5 }, { wallMs: Number.NaN }] } })).toBeNull();
    expect(M.phaseSumMs({ wallMs: 10, metrics: { phases: [{ wallMs: 5 }, {}] } })).toBeNull();
    expect(M.harnessOverheadMs({ wallMs: 10, metrics: { phases: [] } })).toBeNull();
    expect(M.harnessOverheadMs({ metrics: { phases: [{ wallMs: 5 }] } })).toBeNull();
  });

  it('AC1: a stored record.duration.phaseSumMs wins over a recomputation (a rederived record is not silently re-summed)', () => {
    expect(M.phaseSumMs({ ...r8.C, duration: { phaseSumMs: 1 } })).toBe(1);
  });

  it('AC1: summarize() carries phaseSumMs next to the graded wallMs', () => {
    const s = M.summarize(r8.C, { genuine: true });
    expect(s.wallMs).toBe(121117);
    expect(s.phaseSumMs).toBe(117756);
  });

  // A synthetic B/C timeline with round numbers: every component is checkable by hand. t0 = base; the run ends at base + 135000.
  const base = Date.parse('2026-10-12T10:00:00.000Z');
  const call = (name: string, endOffset: number, ms: number, args: Record<string, unknown> = {}, text = '{}') => ({ t: new Date(base + endOffset).toISOString(), ms, name, args, text });
  const TASK1 = 'task-1';
  const TASK2 = 'task-2';
  const calls = [
    call('agent_list', 9003, 3, {}, '[]'),
    call('agent_create', 9010, 5),
    call('agent', 9015, 4),
    call('task', 9030, 14, { prompt: 'p1' }, JSON.stringify({ task_id: TASK1 })),
    call('result', 11530, 2, { task_id: TASK1 }),
    call('result', 79030, 3, { task_id: TASK1 }),
    call('task', 79300, 5, { prompt: 'p2' }, JSON.stringify({ task_id: TASK2 })),
    call('result', 81800, 2, { task_id: TASK2 }),
    call('result', 125300, 4, { task_id: TASK2 }),
    call('usage_query', 127309, 9, { task_id: TASK1 }),
    call('task_list', 127330, 1, { session_id: 's', limit: 200 }, JSON.stringify([
      { id: TASK1, recursionDepth: 0, createdAt: new Date(base + 9025).toISOString(), completedAt: new Date(base + 78425).toISOString() },
      { id: TASK2, recursionDepth: 0, createdAt: new Date(base + 79298).toISOString(), completedAt: new Date(base + 124298).toISOString() },
    ])),
  ];
  const rec = {
    runId: 'C1', arm: 'C', wallMs: 135000, finishedAt: new Date(base + 135000).toISOString(),
    metrics: { phases: [{ phase: 1, taskId: TASK1, wallMs: 70000 }, { phase: 2, taskId: TASK2, wallMs: 46000 }] },
  };

  it('AC1: durationBreakdown attributes setup, submit, between-phase, accounting wait (fixed sleep split out), queries and teardown, and they sum to the overhead exactly', () => {
    const b = M.durationBreakdown(rec, calls);
    expect(b.graded).toBe('wallMs');
    expect(b.wallMs).toBe(135000);
    expect(b.phaseSumMs).toBe(116000);
    expect(b.overheadMs).toBe(19000);
    expect(b.overhead.attributed).toBe(true);
    expect(b.overhead).toMatchObject({ setupMs: 9016, submitMs: 19, betweenPhasesMs: 265, accountingWaitMs: 2000, fixedSleepMs: 1500, hiddenAndReadsMs: 500, queriesMs: 30, teardownMs: 7670, residualMs: 0 });
    const parts = ['setupMs', 'submitMs', 'betweenPhasesMs', 'accountingWaitMs', 'queriesMs', 'teardownMs', 'residualMs'].reduce((a, k) => a + b.overhead[k], 0);
    expect(parts).toBe(b.overheadMs);
    expect(b.overhead.fixedSleepMs).toBe(M.ACCOUNTING_SLEEP_MS);
  });

  it('AC1: the poll lag stays INSIDE the phase sum and is reported beside it from the server-side task interval (completedAt - createdAt)', () => {
    const b = M.durationBreakdown(rec, calls);
    expect(b.serverSumMs).toBe(69400 + 45000);
    expect(b.pollLagMs).toBe(116000 - 114400);
  });

  it('AC1 (negative control): the same record without call timings is honest about it (unattributed total, no invented split)', () => {
    const b = M.durationBreakdown(rec, null);
    expect(b.overheadMs).toBe(19000);
    expect(b.overhead).toEqual({ attributed: false, unattributedMs: 19000 });
    const a = M.durationBreakdown(r8.A, null);
    expect(a.overhead).toEqual({ attributed: false, unattributedMs: 585 });
    expect(M.durationBreakdown({ runId: 'x' }, null).phaseSumMs).toBeNull();
  });

  it('AC1: a run whose second phase never started has no between-phase gap and still reconciles', () => {
    const one = calls.filter((c) => !(c.name === 'result' && c.args.task_id === TASK2) && !(c.name === 'task' && c.args.prompt === 'p2'));
    const r1 = { ...rec, wallMs: 82000, finishedAt: new Date(base + 82000).toISOString(), metrics: { phases: [rec.metrics.phases[0]] } };
    const b = M.durationBreakdown(r1, one.map((c) => (c.name === 'usage_query' || c.name === 'task_list' ? { ...c, t: new Date(Date.parse(c.t) - 46000 - 270).toISOString() } : c)));
    expect(b.overhead.betweenPhasesMs).toBe(0);
    expect(Object.values(b.overhead).filter((v) => typeof v === 'number').length).toBeGreaterThan(5);
    expect(b.overhead.residualMs).toBe(0);
  });

  it('AC1: rederiveDurations reports C/A and B/A under BOTH metrics for R8 A1/B1/C1 (wall 1.4195 / 0.9511, phase-sum 1.3896 / 0.9162)', () => {
    const rd = M.rederiveDurations({ A: r8.A, B: r8.B, C: r8.C });
    expect(rd.ratios.C.wall).toBeCloseTo(121117 / 85322, 10);
    expect(rd.ratios.B.wall).toBeCloseTo(81144 / 85322, 10);
    expect(rd.ratios.C.phaseSum).toBeCloseTo(117756 / 84737, 10);
    expect(rd.ratios.B.phaseSum).toBeCloseTo(77632 / 84737, 10);
    expect(rd.ratios.C.wall.toFixed(3)).toBe('1.420');
    expect(rd.ratios.B.wall.toFixed(3)).toBe('0.951');
    expect(rd.ratios.C.phaseSum.toFixed(3)).toBe('1.390');
    expect(rd.ratios.B.phaseSum.toFixed(3)).toBe('0.916');
    const txt = M.formatDurationTable(rd);
    expect(txt).toMatch(/wall \(graded\)/);
    expect(txt).toMatch(/phase-sum \(report-only\)/);
    expect(txt).toMatch(/C\/A[^\n]*1\.420[^\n]*1\.390/);
    expect(txt).toMatch(/B\/A[^\n]*0\.951[^\n]*0\.916/);
  });

  it('AC1 (negative control): rederiveDurations without arm A yields null ratios, not a made-up 1.0', () => {
    const rd = M.rederiveDurations({ B: r8.B, C: r8.C });
    expect(rd.ratios.C.wall).toBeNull();
    expect(rd.ratios.C.phaseSum).toBeNull();
  });
});

describe('R9-meas AC1: the rederive mode is read-only and the driver stamps new records', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9meas-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const snapshot = (root: string): string => {
    const lines: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { lines.push(`D ${path.relative(root, p)}`); walk(p); } else { const st = fs.statSync(p); lines.push(`F ${path.relative(root, p)} ${st.size} ${st.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); }
      }
    };
    walk(root);
    return lines.join('\n');
  };
  const seed = () => {
    const runs = path.join(dir, 'live/out/runs');
    for (const [arm, rec] of Object.entries(r8)) {
      fs.mkdirSync(path.join(runs, `${arm}1`), { recursive: true });
      fs.writeFileSync(path.join(runs, `${arm}1`, 'record.json'), JSON.stringify(rec, null, 2));
    }
  };

  it('AC1: rederiveDurationReport over saved R8 records prints both metrics and writes NOTHING (directory snapshot incl. mtimes is identical)', () => {
    seed();
    const before = snapshot(dir);
    const txt = D.rederiveDurationReport(dir, 'R8', 1);
    expect(snapshot(dir)).toBe(before);
    expect(txt).toMatch(/A1[^\n]*85322[^\n]*84737/);
    expect(txt).toMatch(/C\/A[^\n]*1\.420[^\n]*1\.390/);
    expect(txt).toMatch(/B\/A[^\n]*0\.951[^\n]*0\.916/);
  });

  it('AC1 (negative control): the snapshot detects a write, so the read-only assertion has teeth', () => {
    seed();
    const before = snapshot(dir);
    fs.appendFileSync(path.join(dir, 'live/out/runs/A1/record.json'), ' ');
    expect(snapshot(dir)).not.toBe(before);
  });

  it('AC1: recordDuration stamps record.duration from the run dir mcp-calls.json (B/C) and leaves wallMs untouched; arm A has no call log and stays unattributed', () => {
    const base = Date.parse('2026-10-12T10:00:00.000Z');
    const mk = (name: string, end: number, ms: number, args = {}, text = '{}') => ({ t: new Date(base + end).toISOString(), ms, name, args, text });
    fs.writeFileSync(path.join(dir, 'mcp-calls.json'), JSON.stringify([
      mk('task', 1000, 10, { prompt: 'p' }, JSON.stringify({ task_id: 'T' })), mk('result', 11000, 2, { task_id: 'T' }), mk('usage_query', 12600, 4, { task_id: 'T' }),
    ]));
    const record: Record<string, unknown> = { runId: 'C1', arm: 'C', wallMs: 14000, finishedAt: new Date(base + 14000).toISOString(), metrics: { phases: [{ phase: 1, taskId: 'T', wallMs: 10000 }] } };
    D.recordDuration(record, dir);
    expect(record.wallMs).toBe(14000);
    const d = record.duration as { graded: string; phaseSumMs: number; overheadMs: number; overhead: { attributed: boolean } };
    expect(d.graded).toBe('wallMs');
    expect(d.phaseSumMs).toBe(10000);
    expect(d.overheadMs).toBe(4000);
    expect(d.overhead.attributed).toBe(true);
    const a: Record<string, unknown> = { runId: 'A1', arm: 'A', wallMs: 90, metrics: { phases: [{ wallMs: 80 }] } };
    D.recordDuration(a, path.join(dir, 'no-such-dir'));
    expect((a.duration as { overhead: unknown }).overhead).toEqual({ attributed: false, unattributedMs: 10 });
    expect(a.wallMs).toBe(90);
  });
});

describe('R9-meas AC2: both metrics side by side, wall labelled graded, the phase-sum never gates', () => {
  const sum = (o: object) => ({ runId: 'x', arm: 'B', genuine: true, extra: false, extraRunReason: '', costBilled: 1, costCommon: 1, wallMs: 1000, phaseSumMs: 1000, quality: 80, turns: 5, toolCalls: 9, peakContext: 1000, ...o });
  const A = sum({ arm: 'A' });

  it('AC2: wall over 1.02 while the phase-sum is within it is still a duration FAIL (the new metric is never the pass bar)', () => {
    const v = M.variantVerdict(A, sum({ arm: 'C', wallMs: 1100, phaseSumMs: 1010 }));
    expect(v.goals.duration.ratio).toBeCloseTo(1.1, 10);
    expect(v.goals.duration.result).toBe('FAIL');
    expect(v.verdict).toBe('FAIL');
    expect(v.durationPhaseSum.ratio).toBeCloseTo(1.01, 10);
    expect(v.durationPhaseSum.gating).toBe(false);
    expect(v.durationPhaseSum.result).toBeUndefined();
  });

  it('AC2 (negative control): wall within 1.02 while the phase-sum is over it still PASSes', () => {
    const v = M.variantVerdict(A, sum({ arm: 'C', wallMs: 1010, phaseSumMs: 1200 }));
    expect(v.goals.duration.result).toBe('PASS');
    expect(v.verdict).toBe('PASS');
    expect(v.durationPhaseSum.ratio).toBeCloseTo(1.2, 10);
  });

  it('AC2: the exact reportOnly object is unchanged and a record without phase timings gives a null phase-sum ratio', () => {
    const v = M.variantVerdict(A, sum({ phaseSumMs: null }));
    expect(Object.keys(v.reportOnly)).toEqual(['turns', 'toolCalls', 'peakContext', 'thinkingTurns']);
    expect(v.durationPhaseSum.ratio).toBeNull();
  });

  it('AC2: formatVerdict prints wall (graded) and phase-sum (report-only) side by side per variant', () => {
    const txt = M.formatVerdict(M.roundVerdict({ A, B: sum({ wallMs: 1100, phaseSumMs: 1010 }) }));
    expect(txt).toMatch(/duration wall \(graded\) 1\.100 FAIL/);
    expect(txt).toMatch(/phase-sum \(report-only\) 1\.010/);
    expect(txt.indexOf('duration wall (graded)')).toBeLessThan(txt.indexOf('phase-sum (report-only)'));
  });

  it('AC2: renderMetricLine prints both and labels wall as graded; the grid line for R8 C reads wall +42% beside phase-sum +39%', () => {
    const sums = { A: M.summarize(r8.A, { genuine: true, quality: 1 }), C: M.summarize(r8.C, { genuine: true, quality: 1 }) };
    const rv = M.roundVerdict(sums);
    const line = G.renderMetricLine(rv.variants[0]);
    expect(line).toMatch(/dur wall \+42% \(graded\)/);
    expect(line).toMatch(/phase-sum \+39% \(report-only\)/);
    expect(line.indexOf('wall')).toBeLessThan(line.indexOf('phase-sum'));
    expect(G.renderGrid({ A: { ...r8.A, state: 'done' }, C: { ...r8.C, state: 'done' } }, rv, ['A', 'C'])).toMatch(/phase-sum/);
  });

  it('AC2: SUMMARY rows carry wall s (graded), phase-sum s and overhead s, and the table header labels wall as graded', () => {
    const rows = D.summaryRows([{ ...r8.C, score: { summary: { pass: 1, fail: 0, na: 0, invalid: 0, content: { pass: 1, total: 1 }, process: { pass: 0, total: 0 }, format: { pass: 0, total: 0 } }, fields: {} }, warnings: [] }]);
    expect(rows[0]).toMatchObject({ wallS: 121, phaseSumS: 118, overheadS: 3 });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'r9meas-sum-'));
    try {
      D.writeSummary(out, [{ ...r8.C, score: { summary: { pass: 1, fail: 0, na: 0, invalid: 0, content: { pass: 1, total: 1 }, process: { pass: 0, total: 0 }, format: { pass: 0, total: 0 } }, fields: {} }, warnings: [] }], [{ arm: 'C' }]);
      const md = fs.readFileSync(path.join(out, 'SUMMARY.md'), 'utf8');
      expect(md).toMatch(/wall s \(graded\)/);
      expect(md).toMatch(/phase-sum s \(report-only\)/);
      expect(md).toMatch(/overhead s/);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });
});

describe('R9-meas AC3: paired fixtures', () => {
  // Frozen BEFORE the change from the unchanged generator (seed 20261011): the default path must stay byte-identical so R8 records stay re-scorable and its scenario sha stays valid.
  const FROZEN: Record<string, Record<string, unknown>> = {
    A1: { sysNonce: 'f50e58690ad3b80c', pkg: 'shopkit-77b1', taxRate: 0.08, threshold: 80, rate: 5.99, ticketId: 'TCK-f1aaa67a', owner: 'team-909c12', handlingFee: 0.99 },
    B1: { sysNonce: 'e58071af4fd92e66', pkg: 'shopkit-3423', taxRate: 0.11, threshold: 50, rate: 4.99, ticketId: 'TCK-692031fd', owner: 'team-7c031d', handlingFee: 0.49 },
    C1: { sysNonce: '0ba6b07af349fc0b', pkg: 'shopkit-e98a', taxRate: 0.12, threshold: 110, rate: 7.99, ticketId: 'TCK-8542e89c', owner: 'team-61399f', handlingFee: 0.49 },
    C2: { sysNonce: '0ba6b07af349fc0b', pkg: 'shopkit-d36e', taxRate: 0.12, threshold: 120, rate: 6.99, ticketId: 'TCK-f8a23868', owner: 'team-c58d07', handlingFee: 0.49 },
  };
  const VALUE_KEYS = ['pkg', 'taxRate', 'threshold', 'rate', 'ticketId', 'owner', 'handlingFee', 'carrierRate'];
  const seed = '20261011';

  it('AC3: the default (unpaired) path reproduces the frozen R8 values and carries no `paired` key', () => {
    for (const [id, want] of Object.entries(FROZEN)) {
      const sp = F.makeSpec({ seed, arm: id[0], rep: Number(id[1]) });
      expect(sp, id).toMatchObject(want);
      expect('paired' in sp, id).toBe(false);
    }
  });

  it('AC3: the WHOLE unpaired fixture (spec, repo files, hidden suite, ticket, expectations) hashes to the value the pre-change generator produced, so R8 records stay re-scorable', () => {
    // sha256 of JSON({spec, repo: repoFiles, hidden: hiddenTests, ticket: ticketText, exp: expectedOf}) computed with fixtures.mjs at HEAD before R9-meas (seed 20261011).
    const FROZEN_SHA: Record<string, string> = {
      A1: '569178d17d6ab078489e4af282caee6bcc445a5a1aafaa8133052c7bac263a83', B1: '99951eca35ea758489b7e1c9b80151e6d00537b6f41949e6f7caeaa3d1a80054', C1: 'c36118d2b6c10021f4928aaaed59bf34eebd5c6137eb50e1cb18d680c3acf8cd',
      A2: '60391baf1eeea617c8fceaaa506b6061273b6b10b80cf895e24c45509a7774c4', C2: '7a2ede9593242258c1d933416feb547835ad7c951f0b87cb114b75c9ae67a4b7',
    };
    for (const [id, want] of Object.entries(FROZEN_SHA)) {
      const spec = F.makeSpec({ seed, arm: id[0], rep: Number(id[1]) });
      const blob = JSON.stringify({ spec, repo: F.repoFiles(spec), hidden: F.hiddenTests(spec), ticket: F.ticketText(spec), exp: F.expectedOf(spec) });
      expect(crypto.createHash('sha256').update(blob).digest('hex'), id).toBe(want);
    }
  });

  it('AC3 (negative control): unpaired A1, B1, C1 draw different thresholds, tax, ticket ids and owners (the confound being removed is real)', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((arm) => F.makeSpec({ seed, arm, rep: 1 }));
    expect(new Set([a.threshold, b.threshold, c.threshold]).size).toBe(3);
    expect(new Set([a.ticketId, b.ticketId, c.ticketId]).size).toBe(3);
    expect(new Set([a.owner, b.owner, c.owner]).size).toBe(3);
    expect(F.makeSpec({ seed, arm: 'A', rep: 1, paired: false })).toEqual(a);
  });

  it('AC3: paired A_n, B_n, C_n share every fixture value (ticket id, thresholds, rates, tax, owner), for each n', () => {
    for (const rep of [1, 2, 3]) {
      const [a, b, c] = ['A', 'B', 'C'].map((arm) => F.makeSpec({ seed, arm, rep, paired: true }));
      for (const k of VALUE_KEYS) { expect(b[k], `${k} B${rep}`).toEqual(a[k]); expect(c[k], `${k} C${rep}`).toEqual(a[k]); }
      expect(a.paired).toBe(true);
      expect(F.ticketText(c)).toBe(F.ticketText(a));
      const perArm = (e: Record<string, unknown>) => { const o = { ...e }; delete o.runId; delete o.arm; return o; };   // the run identity is per arm by design
      expect(perArm(F.expectedOf(c))).toEqual(perArm(F.expectedOf(a)));   // includes `original` (the seeded visible cases) and every scored expectation
      expect(F.repoFiles(c)).toEqual(F.repoFiles(a));
      expect(F.hiddenTests(c)).toEqual(F.hiddenTests(a));   // the hidden suite is paired too
    }
  });

  it('AC3: the pairing index n still varies the values (A_1 vs A_2), and the seed still varies them', () => {
    const p1 = F.makeSpec({ seed, arm: 'A', rep: 1, paired: true });
    const p2 = F.makeSpec({ seed, arm: 'A', rep: 2, paired: true });
    const other = F.makeSpec({ seed: '20261012', arm: 'A', rep: 1, paired: true });
    expect(p1.ticketId).not.toBe(p2.ticketId);
    expect(p1.ticketId).not.toBe(other.ticketId);
  });

  it('AC3: the system-prompt nonce and runId stay PER ARM under pairing (identical prompts across arms must not share a prompt-cache prefix)', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((arm) => F.makeSpec({ seed, arm, rep: 1, paired: true }));
    expect(new Set([a.sysNonce, b.sysNonce, c.sysNonce]).size).toBe(3);
    expect(new Set([a.systemPrompt, b.systemPrompt, c.systemPrompt]).size).toBe(3);
    expect([a.runId, b.runId, c.runId]).toEqual(['A1', 'B1', 'C1']);
    expect(a.sysNonce).toBe(FROZEN.A1.sysNonce);
    expect(c.sysNonce).toBe(FROZEN.C1.sysNonce);
  });

  it('AC3: ledger.profile.pairedFixtures is validated (boolean, fail closed) and appears in profileOf only when true', () => {
    const base = { arms: ['A', 'C'], model: 'claude-haiku-5-5' };
    expect(LG.profileOf({ profile: base })).not.toHaveProperty('pairedFixtures');
    expect(LG.profileOf({ profile: { ...base, pairedFixtures: false } })).not.toHaveProperty('pairedFixtures');
    expect(LG.profileOf({ profile: { ...base, pairedFixtures: true } }).pairedFixtures).toBe(true);
    for (const bad of ['yes', 1, {}, []]) {
      expect(() => LG.profileOf({ profile: { ...base, pairedFixtures: bad } }), JSON.stringify(bad)).toThrow(LG.LedgerError);
    }
  });

  it('AC3: specFor derives paired specs only when the round profile says so; the real R8 profile is unpaired', () => {
    const paired = { pairedFixtures: true, model: 'claude-haiku-5-5' };
    const plain = { model: 'claude-haiku-5-5' };
    const a = D.specFor({ seed, arm: 'A', rep: 1, profile: paired });
    const c = D.specFor({ seed, arm: 'C', rep: 1, profile: paired });
    expect(c.ticketId).toBe(a.ticketId);
    expect(c.pin).toBe('claude-haiku-5-5');
    const a8 = D.specFor({ seed, arm: 'A', rep: 1, profile: plain });
    const c8 = D.specFor({ seed, arm: 'C', rep: 1, profile: plain });
    expect(c8.ticketId).not.toBe(a8.ticketId);
    expect(a8).toMatchObject(FROZEN.A1);
    expect(D.roundProfile({ round: 'R8' }).pairedFixtures).toBe(false);
  });

  it('AC3: makeCtx under a tracked ledger profile with pairedFixtures builds A and C with the same fixture values; R8 builds them with different ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9meas-led-'));
    try {
      fs.writeFileSync(LG.ledgerPathFor('R9', dir), JSON.stringify({ ...LG.emptyLedger('R9'), approvedBy: 'owner', profile: { arms: ['A', 'C'], model: 'haiku', armModels: { C: 'claude-haiku-5-5' }, pairedFixtures: true } }));
      const opts = { round: 'R9', ledgerDir: dir, seed, out: path.join(dir, 'out'), wt: dir };
      const a = D.makeCtx(opts, [], { arm: 'A', rep: 1 }, true).spec;
      const c = D.makeCtx(opts, [], { arm: 'C', rep: 1 }, true).spec;
      expect(c.ticketId).toBe(a.ticketId);
      expect(c.owner).toBe(a.owner);
      expect(c.threshold).toBe(a.threshold);
      expect(c.sysNonce).not.toBe(a.sysNonce);
      const a8 = D.makeCtx({ ...opts, round: 'R8', ledgerDir: undefined }, [], { arm: 'A', rep: 1 }, true).spec;
      const c8 = D.makeCtx({ ...opts, round: 'R8', ledgerDir: undefined }, [], { arm: 'C', rep: 1 }, true).spec;
      expect(c8.ticketId).not.toBe(a8.ticketId);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('AC3: the scenario sha (template identity) is unchanged by the pairing switch and still equals the sha recorded in the R8 ledger', () => {
    const r8ledger = JSON.parse(fs.readFileSync(path.join(PARITY_DIR, 'ledger/R8.json'), 'utf8'));
    expect(D.currentScenarioSha()).toBe(r8ledger.scenarioSha);
  });

  it('AC3: a record written for a paired round says so (record.fixtures), an unpaired one does not claim it', () => {
    expect(D.fixturesFact({ pairedFixtures: true })).toEqual({ paired: true, valueStream: 'seed|run|rep' });
    expect(D.fixturesFact({})).toEqual({ paired: false, valueStream: 'seed|run|arm|rep' });
  });
});

describe('R9-meas AC4: README documents both metrics, the pairing and the owner decision', () => {
  const readme = fs.readFileSync(path.join(PARITY_DIR, 'README.md'), 'utf8');
  it('AC4: names the owner decision "Report both", the graded wall metric, the phase-sum, the overhead split and the pairing switch', () => {
    expect(readme).toMatch(/Report both/);
    expect(readme).toMatch(/graded/i);
    expect(readme).toMatch(/phase-sum/i);
    expect(readme).toMatch(/phaseSumMs/);
    expect(readme).toMatch(/pairedFixtures/);
    expect(readme).toMatch(/--rederive-duration/);
    expect(readme).toMatch(/never gat/i);
  });
});
