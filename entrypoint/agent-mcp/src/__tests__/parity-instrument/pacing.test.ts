import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * Pacing gate (SCOPE-R5-pacing-gate, owner decision 2026-10-11): AC1 the 5-hour threshold is 90%; AC2 the 7-day check is removed.
 * The usage reader is injected, so nothing here spawns `claude`.
 */
const L = await loadParity('lib.mjs');
const D = await loadParity('drive.mjs');

const read = (session_pct: number, week_pct = 10) => () => ({ session_pct, week_pct, resets: null, model_calls: 0 });

describe('SCOPE-R5-pacing-gate', () => {
  it('AC1 5h threshold is 90%: 89% passes', () => {
    expect(L.PACING.fiveHourMax).toBe(0.9);
    expect(D.gatePacing(read(89)).ok).toBe(true);
  });
  it('AC1 5h threshold is 90%: 90% aborts with a recorded reason', () => {
    const g = D.gatePacing(read(90));
    expect(g.ok).toBe(false);
    expect(g.verdict.reasons.join()).toMatch(/5h utilisation 90% >= 90%/);
  });
  it('AC2 weekly check removed: 7d at 100% no longer aborts', () => {
    expect(D.gatePacing(read(10, 100)).ok).toBe(true);
    expect(D.gatePacing(() => ({ session_pct: 10 })).ok).toBe(true);
    expect(L.PACING.sevenDayMax).toBeUndefined();
    expect(L.pacingVerdict({ session_pct: 0, week_pct: 100 }, [{ seven_day: { utilization: 1 } }]).ok).toBe(true);
  });
  it('gate stays fail-closed on unreadable or non-numeric session readings and on bad rate-limit status', () => {
    expect(D.gatePacing(() => { throw new Error('x'); }).ok).toBe(false);
    expect(D.gatePacing(() => ({ session_pct: null, week_pct: 5 })).ok).toBe(false);
    expect(D.gatePacing(read(0), [{ status: 'rejected' }]).ok).toBe(false);
  });
});
