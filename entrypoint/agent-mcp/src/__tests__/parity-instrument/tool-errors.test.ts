import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/** R6 tool-error detector (ported from parity/libtest.mjs + detectors.mjs contract). Ticket 90758419 (R1/R6 family); ACs R6.AC1-AC3 and R2.AC8. */
const DT = await loadParity('detectors.mjs');

const call = (id: string, tool: string, args: unknown, isError: boolean, text = '') => ({ id, tool, args, isError, text });

describe('parity detectors: tool-errors (R6)', () => {
  it('R6.AC1: the same tool with the same normalized args erroring 3x is a DEFECT_SIGNAL naming every call id', () => {
    const calls = [1, 2, 3].map((i) => call(`e${i}`, 'shell', { command: ['cat', `/tmp/x${i}`] }, true, 'no such file'));
    const r = DT.toolErrorSignal(calls);
    expect(r.verdict).toBe('DEFECT_SIGNAL');
    expect(r.defectSignal).toBe(true);
    expect(r.callIds.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(r.text).toContain('suspect a test or code bug');
    expect(r.text).not.toMatch(/model failure/i);
  });

  it('R6.AC1: two same-args errors stay below the threshold (negative control), as do errors with different tools', () => {
    expect(DT.toolErrorSignal([call('a', 'shell', { c: 1 }, true), call('b', 'shell', { c: 1 }, true)]).verdict).toBe('OK');
    const mixed = [call('a', 'shell', { c: 'x' }, true), call('b', 'read', { c: 'x' }, true), call('c', 'edit', { c: 'x' }, true)];
    expect(DT.toolErrorSignal(mixed).defectSignal).toBe(false);
  });

  it('R6.AC1: the error rate trips only above 25% AND with at least 8 calls', () => {
    const mk = (errs: number, total: number) =>
      Array.from({ length: total }, (_, i) => call(`c${i}`, `tool${i}`, { i: `s${i}x`.repeat(1) }, i < errs));
    // 3/8 = 37.5% > 25%: flagged, ids are the errored calls
    const hot = DT.toolErrorSignal(mk(3, 8));
    expect(hot.defectSignal).toBe(true);
    expect(hot.callIds).toEqual(['c0', 'c1', 'c2']);
    // exactly 2/8 = 25% is NOT above the threshold
    expect(DT.toolErrorSignal(mk(2, 8)).defectSignal).toBe(false);
    // 3/7 has too few calls
    expect(DT.toolErrorSignal(mk(3, 7)).defectSignal).toBe(false);
  });

  it('R6.AC2: thresholds are function arguments (never an env switch)', () => {
    const calls = [call('a', 'shell', { c: 1 }, true), call('b', 'shell', { c: 1 }, true)];
    expect(DT.toolErrorSignal(calls, { sameToolMin: 2 }).defectSignal).toBe(true);
    expect(DT.TOOL_ERROR_DEFAULTS).toEqual({ sameToolMin: 3, rateMin: 0.25, rateMinCalls: 8 });
    expect(Object.isFrozen(DT.TOOL_ERROR_DEFAULTS)).toBe(true);
  });

  it('R6.AC3: normalizeArgs collapses digits, uuids and key order so retries count as the same call', () => {
    const a = DT.normalizeArgs({ args: { b: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', a: 12 } });
    const b = DT.normalizeArgs({ args: { a: 99, b: '00000000-0000-4000-8000-000000000000' } });
    expect(a).toBe(b);
    expect(DT.normalizeArgs({ argsKey: 'fixed', args: { z: 1 } })).toBe('fixed');
    expect(DT.normalizeArgs({ args: { a: 'x' } })).not.toBe(DT.normalizeArgs({ args: { a: 'y' } }));
  });

  it('R6.AC3: runDetectors turns a throwing detector into a red DEFECT_SIGNAL, never a skip', () => {
    const out = DT.runDetectors(null);
    expect(out).toHaveLength(2);
    expect(out.every((d: { verdict: string }) => d.verdict === 'DEFECT_SIGNAL')).toBe(true);
    const ok = DT.runDetectors([call('a', 'read', {}, false, 'fine')]);
    expect(ok.map((d: { detector: string }) => d.detector)).toEqual(['egress-silent-empty', 'tool-errors']);
  });
});

describe('parity detectors: egress-silent-empty (R2.AC8)', () => {
  const curl = { id: 'tu9', tool: 'mcp__shell__shell_execute', args: { command: ['curl', 'https://example.com'] } };

  it('R2.AC8: a blank web result with isError false is flagged with its call id and marks w1_web INVALID(egress)', () => {
    const r = DT.egressSilentEmpty([{ ...curl, isError: false, text: '[{"type":"text","text":" "}]' }]);
    expect(r.flagged).toBe(true);
    expect(r.callIds).toEqual(['tu9']);
    expect(r.w1_web).toBe('INVALID(egress)');
  });

  it('R2.AC8: a never-captured result (null text) is unknown, not silent-empty; real content and real errors are not flagged', () => {
    expect(DT.egressSilentEmpty([{ ...curl, isError: null, text: null }]).flagged).toBe(false);
    expect(DT.egressSilentEmpty([{ ...curl, isError: false, text: '[{"type":"text","text":"<title>Example Domain</title>"}]' }]).flagged).toBe(false);
    expect(DT.egressSilentEmpty([{ ...curl, isError: true, text: '' }]).flagged).toBe(false);
  });

  it('R2.AC8: only web calls count: native web tools and shell curl/wget, not an unrelated blank result', () => {
    expect(DT.isWebCall({ tool: 'mcp__x__web_fetch' })).toBe(true);
    expect(DT.isWebCall({ tool: 'WebSearch' })).toBe(true);
    expect(DT.isWebCall({ tool: 'Bash', args: { command: 'wget http://x' } })).toBe(true);
    expect(DT.isWebCall({ tool: 'Bash', args: { command: 'ls' } })).toBe(false);
    expect(DT.egressSilentEmpty([{ id: 'r', tool: 'Read', args: {}, isError: false, text: '' }]).flagged).toBe(false);
  });
});
