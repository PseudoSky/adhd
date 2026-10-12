import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/** R4 metric model and verdict (parity/metrics.mjs). Ported from the R4 verdict cases; spec R4.AC1-AC7. Pure, no model call. */
const M = await loadParity('metrics.mjs');

const sum = (o: object) => ({ runId: 'x', arm: 'B', genuine: true, extra: false, extraRunReason: '', costBilled: 1, costCommon: 1, wallMs: 1000, quality: 80, turns: 5, toolCalls: 9, peakContext: 1000, ...o });
const A = sum({ arm: 'A' });

describe('parity metrics: variantVerdict', () => {
  it('R4.AC1: a variant at exactly the thresholds passes (cost 1.02, duration 1.02, quality 0.98 are inclusive)', () => {
    const v = M.variantVerdict(A, sum({ costBilled: 1.02, wallMs: 1020, quality: 78.4 }));
    expect(v.verdict).toBe('PASS');
    expect(v.goals.cost.result).toBe('PASS');
    expect(v.goals.quality.ratio).toBeCloseTo(0.98, 10);
  });

  it('R4.AC1: each gated goal fails independently just past its threshold (negative controls)', () => {
    expect(M.variantVerdict(A, sum({ costBilled: 1.03 })).goals.cost.result).toBe('FAIL');
    expect(M.variantVerdict(A, sum({ wallMs: 1030 })).goals.duration.result).toBe('FAIL');
    expect(M.variantVerdict(A, sum({ quality: 78 })).goals.quality.result).toBe('FAIL');
    expect(M.variantVerdict(A, sum({ costBilled: 1.03 })).verdict).toBe('FAIL');
  });

  it('R4.AC2: turns, tool calls, peak context and thinking turns are report-only and never gate', () => {
    const v = M.variantVerdict(A, sum({ turns: 500, toolCalls: 900, peakContext: 9e9 }));
    expect(v.verdict).toBe('PASS');
    expect(v.reportOnly).toEqual({ turns: { arm: 500, A: 5 }, toolCalls: { arm: 900, A: 9 }, peakContext: { arm: 9e9, A: 1000 }, thinkingTurns: { arm: null, A: null } });
  });

  it('R7-think AC1: thinking turns are carried report-only (arm / A) and an enormous count never changes the verdict', () => {
    const v = M.variantVerdict({ ...A, thinkingTurns: 3 }, { ...sum({}), thinkingTurns: 9999 });
    expect(v.reportOnly.thinkingTurns).toEqual({ arm: 9999, A: 3 });
    expect(v.verdict).toBe(M.variantVerdict(A, sum({})).verdict);
    expect(M.thinkingTurnsOf({ thinking: { observedThinkingTurns: 7 } })).toBe(7);
    expect(M.thinkingTurnsOf({})).toBeNull();
  });

  it('R4.AC3: an A that did not genuinely succeed voids the iteration with no ratios', () => {
    const v = M.variantVerdict(sum({ arm: 'A', genuine: false }), sum({}));
    expect(v.verdict).toBe('VOID');
    expect(v.goals).toBeUndefined();
    expect(M.variantVerdict(null, sum({})).verdict).toBe('VOID');
  });

  it('R4.AC4: a variant that is not a genuine success is FAIL on correctness even with perfect ratios', () => {
    const v = M.variantVerdict(A, sum({ genuine: false }));
    expect([v.verdict, v.correctness]).toEqual(['FAIL', 'FAIL']);
  });

  it('R4.AC6: thresholds are an argument; a stricter cost threshold flips the verdict, unspecified keys keep defaults', () => {
    const x = sum({ costBilled: 1.01 });
    expect(M.variantVerdict(A, x).verdict).toBe('PASS');
    expect(M.variantVerdict(A, x, { cost: 1.0 }).verdict).toBe('FAIL');
    expect(M.variantVerdict(A, x, { cost: 1.0 }).goals.duration.limit).toBe(M.DEFAULT_THRESHOLDS.duration);
  });

  it('R4.AC7: an extra run is EXCLUDED unless it carries an extraRunReason', () => {
    expect(M.variantVerdict(A, sum({ extra: true })).verdict).toBe('EXCLUDED');
    expect(M.variantVerdict(A, sum({ extra: true, extraRunReason: '   ' })).verdict).toBe('EXCLUDED');
    expect(M.variantVerdict(A, sum({ extra: true, extraRunReason: 'run 3 void: egress' })).verdict).toBe('PASS');
  });

  it('R4.AC1: a missing measurement is n/a, not a pass by default and not a crash', () => {
    const v = M.variantVerdict(A, sum({ quality: null }));
    expect(v.goals.quality.result).toBe('n/a');
    expect(v.verdict).toBe('PASS');
  });

  it('R4.AC1: the common-card cost ratio is reported beside the billed ratio but never gates', () => {
    const v = M.variantVerdict(A, sum({ costCommon: 5 }));
    expect(v.commonCard.ratio).toBe(5);
    expect(v.verdict).toBe('PASS');
  });
});

describe('parity metrics: roundVerdict, accessors, formatting, decomposition', () => {
  it('R4.AC4: the round is PASS only if every variant passes; one red variant makes it FAIL; a void A makes it VOID', () => {
    expect(M.roundVerdict({ A, B: sum({}), C: sum({ arm: 'C' }) }).verdict).toBe('PASS');
    expect(M.roundVerdict({ A, B: sum({}), C: sum({ arm: 'C', wallMs: 5000 }) }).verdict).toBe('FAIL');
    expect(M.roundVerdict({ A: sum({ arm: 'A', genuine: false }), B: sum({}) }).verdict).toBe('VOID');
    expect(M.roundVerdict({ A, B: sum({}) }).variants).toHaveLength(1);
  });

  it('R4.AC1: accessors sum run-record phases; authoritative billed cost wins over the common-card total', () => {
    const rec = {
      wallMs: 4200,
      metrics: {
        phases: [
          { costUsd: { authoritative: 0.5, total: 0.4 }, turns: { parent: 2, child: 3 }, calls: { total: 7 }, peakContext: 100 },
          { costUsd: { total: 0.25 }, turns: { parent: 1 }, calls: { total: 2 }, peakContext: 300 },
        ],
      },
    };
    expect(M.costBilled(rec)).toBeCloseTo(0.75, 12);
    expect(M.costCommonCard(rec)).toBeCloseTo(0.65, 12);
    expect(M.durationMs(rec)).toBe(4200);
    expect(M.turnsOf(rec)).toBe(6);
    expect(M.toolCallsOf(rec)).toBe(9);
    expect(M.peakContextOf(rec)).toBe(300);
    expect(M.peakContextOf({})).toBeNull();
    expect(M.durationMs({})).toBeNull();
  });

  it('R4.AC1: summarize defaults to a non-genuine run (genuine must be supplied by the gate) and derives the arm from the run id', () => {
    const s = M.summarize({ runId: 'B2', metrics: { phases: [] }, wallMs: 5 }, {});
    expect([s.genuine, s.arm, s.quality]).toEqual([false, 'B', null]);
    expect(M.summarize({ runId: 'C1', arm: 'C' }, { genuine: true, quality: 90 }).quality).toBe(90);
  });

  it('R4.AC6: formatVerdict states n=1 and prints VOID/EXCLUDED reasons and per-goal ratios', () => {
    const txt = M.formatVerdict(M.roundVerdict({ A, B: sum({ costBilled: 1.5 }), C: sum({ arm: 'C', extra: true }) }));
    expect(txt).toContain('n=1 per arm');
    expect(txt).toMatch(/B: FAIL .*cost 1\.500 FAIL/);
    expect(txt).toContain('C: EXCLUDED');
    expect(M.pct(1.05)).toBe('+5.0%');
    expect(M.pct(null)).toBe('n/a');
  });

  it('R4.AC5: decomposeDuration separates model, tool and time-to-first-model-event, per phase, clamping negative durations', () => {
    const d = M.decomposeDuration([
      { phase: 1, kind: 'model', startMs: 100, endMs: 600, ttfbMs: 40 },
      { phase: 1, kind: 'tool', startMs: 600, endMs: 900 },
      { phase: 2, kind: 'model', startMs: 1000, endMs: 1300 },
      { phase: 2, kind: 'tool', startMs: 1300, endMs: 1200 },
    ]);
    expect(d.timeToFirstModelEventMs).toBe(140);
    expect(d.summedModelMs).toBe(800);
    expect(d.summedToolMs).toBe(300);
    expect(d.byPhase).toEqual({ 1: { modelMs: 500, toolMs: 300 }, 2: { modelMs: 300, toolMs: 0 } });
    expect(d.perCallTtfbMs).toEqual([40, null]);
    expect(M.decomposeDuration([]).timeToFirstModelEventMs).toBeNull();
  });
});
