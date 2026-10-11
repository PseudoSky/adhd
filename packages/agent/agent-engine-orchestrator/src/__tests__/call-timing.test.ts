import { describe, expect, it } from 'vitest';

import { callTimingFields, computeOverheadMs, createTtfbProbe } from '../providers/call-timing.js';

/** Tests for the P6 per-call timing helpers (adbf1c0b/8dc52aa7 ticket family; plan P6). */
describe('P6 call-timing', () => {
  const clockOf = (ticks: number[]): (() => number) => {
    let i = 0;
    return () => ticks[Math.min(i++, ticks.length - 1)] as number;
  };

  describe('createTtfbProbe', () => {
    it('P6 AC-ttfb: measures first-byte minus start with an injected clock', () => {
      const p = createTtfbProbe(clockOf([1000, 1250]));
      p.start();
      p.firstByte();
      expect(p.ttfbMs()).toBe(250);
    });

    it('P6 AC-ttfb: undefined until both marks exist', () => {
      const p = createTtfbProbe(clockOf([5, 9]));
      expect(p.ttfbMs()).toBeUndefined();
      p.start();
      expect(p.ttfbMs()).toBeUndefined();
      p.firstByte();
      expect(p.ttfbMs()).toBe(4);
    });

    it('P6 AC-ttfb: firstByte before start is ignored (and does not consume the first-byte slot)', () => {
      const p = createTtfbProbe(clockOf([10, 20, 35]));
      p.firstByte(); // ignored, clock not read
      p.start(); // 10
      p.firstByte(); // 20
      expect(p.ttfbMs()).toBe(10);
    });

    it('P6 AC-ttfb: start and firstByte are idempotent (only the first call counts)', () => {
      const p = createTtfbProbe(clockOf([100, 200, 300, 400]));
      p.start(); // 100
      p.start(); // ignored
      p.firstByte(); // 200 (clock read at index 1 because the second start never reads)
      p.firstByte(); // ignored
      expect(p.ttfbMs()).toBe(100);
    });

    it('P6 AC-ttfb: a clock that steps backwards clamps to 0', () => {
      const p = createTtfbProbe(clockOf([500, 400]));
      p.start();
      p.firstByte();
      expect(p.ttfbMs()).toBe(0);
    });

    it('P6 AC-ttfb: defaults to Date.now', () => {
      const p = createTtfbProbe();
      p.start();
      p.firstByte();
      expect(p.ttfbMs()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('computeOverheadMs', () => {
    it('P6 AC-overhead: undefined for the first call (no previous call)', () => {
      expect(computeOverheadMs(undefined, 1234)).toBeUndefined();
    });

    it('P6 AC-overhead: request start minus previous end', () => {
      expect(computeOverheadMs(1000, 1075)).toBe(75);
      expect(computeOverheadMs(1000, 1000)).toBe(0);
    });

    it('P6 AC-overhead: clamps a negative gap to 0', () => {
      expect(computeOverheadMs(2000, 1990)).toBe(0);
    });
  });

  describe('callTimingFields', () => {
    it('P6 AC-fields: emits snake_case ttfb_ms and overhead_ms when both are measured', () => {
      expect(callTimingFields(120, 30)).toEqual({ ttfb_ms: 120, overhead_ms: 30 });
    });

    it('P6 AC-fields: omits absent values so an unmeasured payload is unchanged (no undefined keys)', () => {
      const none = callTimingFields(undefined, undefined);
      expect(none).toEqual({});
      expect(Object.keys(none)).toHaveLength(0);
      expect(Object.keys(callTimingFields(5, undefined))).toEqual(['ttfb_ms']);
      expect(Object.keys(callTimingFields(undefined, 7))).toEqual(['overhead_ms']);
    });

    it('P6 AC-fields: a measured zero is kept, not treated as absent', () => {
      expect(callTimingFields(0, 0)).toEqual({ ttfb_ms: 0, overhead_ms: 0 });
    });
  });
});
