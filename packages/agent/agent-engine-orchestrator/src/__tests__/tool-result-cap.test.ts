/**
 * tool-result-cap.test.ts — backlog 3ad735bb (BK1), plan 9ed453c1. Pure unit
 * tests for the cap function (AC1.1, AC1.2, AC1.3). The integration proof
 * (AC1.5) is entrypoint/agent-mcp's tool-result-cap.e2e.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  capToolResult,
  validateToolResultMaxChars,
  parseToolResultMaxChars,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  ERROR_RESULT_FLOOR_CHARS,
} from '../engine/tool-result-cap.js';

const MARKER_RE =
  /\[tool result truncated: showing first (\d+) and last (\d+) of (\d+) chars; re-run with a narrower command \(e\.g\. grep, head, sed -n 'a,bp'\)\]/;

describe('3ad735bb AC1.1 oversize result -> head+tail with exact marker', () => {
  it('default cap is 20000 and splits 15000 head / 5000 tail', () => {
    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(20_000);
    const text = 'a'.repeat(15_000) + 'M'.repeat(65_000) + 'z'.repeat(20_000);
    const out = capToolResult(text, false, DEFAULT_TOOL_RESULT_MAX_CHARS);
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(100_000);
    const s = out.result as string;
    const m = s.match(MARKER_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('15000');
    expect(m?.[2]).toBe('5000');
    expect(m?.[3]).toBe('100000');
    expect(s.startsWith('a'.repeat(15_000) + '\n[tool result truncated')).toBe(true);
    expect(s.endsWith(']\n' + 'z'.repeat(5_000))).toBe(true);
    expect(s).not.toContain('M');
    // marker is outside the cap: head + tail == cap exactly
    expect(s.length).toBe(20_000 + (m?.[0].length ?? 0) + 2);
  });

  it('serializes non-string results with JSON.stringify before capping', () => {
    const obj = { rows: Array.from({ length: 5_000 }, (_, i) => ({ i })) };
    const full = JSON.stringify(obj);
    const out = capToolResult(obj, false, 1_000);
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(full.length);
    expect(typeof out.result).toBe('string');
    expect((out.result as string).startsWith(full.slice(0, 750))).toBe(true);
  });

  it('honours a custom cap and rounds the head down (floor(cap*0.75))', () => {
    const out = capToolResult('x'.repeat(1_000), false, 101);
    const m = (out.result as string).match(MARKER_RE);
    expect(m?.[1]).toBe('75');
    expect(m?.[2]).toBe('26');
  });
});

describe('3ad735bb AC1.2 results at or under the cap are byte-identical', () => {
  it('returns the same reference at exactly the cap and under it', () => {
    const atCap = 'q'.repeat(20_000);
    const a = capToolResult(atCap, false, 20_000);
    expect(a.truncated).toBe(false);
    expect(a.result).toBe(atCap);
    const obj = { ok: true };
    const b = capToolResult(obj, false, 20_000);
    expect(b.result).toBe(obj);
    expect(b.originalChars).toBe(JSON.stringify(obj).length);
  });

  it('leaves non-serializable values (undefined) untouched', () => {
    const out = capToolResult(undefined, false, 10);
    expect(out.truncated).toBe(false);
    expect(out.result).toBeUndefined();
  });

  it('never truncates an error result <= 4000 chars even with a tiny cap', () => {
    const err = 'E'.repeat(ERROR_RESULT_FLOOR_CHARS);
    const out = capToolResult(err, true, 100);
    expect(out.truncated).toBe(false);
    expect(out.result).toBe(err);
  });

  it('truncates an error result above 4000 chars with the cap floored at 4000', () => {
    const err = 'E'.repeat(9_000);
    const out = capToolResult(err, true, 100);
    expect(out.truncated).toBe(true);
    const m = (out.result as string).match(MARKER_RE);
    expect(m?.[1]).toBe('3000');
    expect(m?.[2]).toBe('1000');
  });

  it('a non-error result with the same size IS truncated at a small cap (control)', () => {
    expect(capToolResult('E'.repeat(4_000), false, 100).truncated).toBe(true);
  });
});

describe('3ad735bb AC1.3 configuration: 0 disables, invalid fails loud', () => {
  it('0 disables the cap', () => {
    const big = 'y'.repeat(500_000);
    const out = capToolResult(big, false, 0);
    expect(out.truncated).toBe(false);
    expect(out.result).toBe(big);
    expect(out.originalChars).toBe(500_000);
  });

  it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '20000', null, undefined])(
    'rejects %p',
    (bad) => {
      expect(() => validateToolResultMaxChars(bad)).toThrow(RangeError);
      expect(() => validateToolResultMaxChars(bad)).toThrow(/agent\.toolResult\.maxChars/);
    }
  );

  it.each([0, 1, 20_000, 1_000_000])('accepts %p', (ok) => {
    expect(validateToolResultMaxChars(ok)).toBe(ok);
  });
});

describe('3ad735bb AC1.3 strict text parsing (no parseInt truncation, no empty-string disable)', () => {
  it.each([['0', 0], ['20000', 20_000], [' 512 ', 512], [7, 7]])('parses %p -> %p', (raw, want) => {
    expect(parseToolResultMaxChars(raw)).toBe(want);
  });

  it.each(['', '  ', '-1', '1.5', '20000abc', '1e3', 'abc', 'NaN', -3, 2.5])('rejects %p', (bad) => {
    expect(() => parseToolResultMaxChars(bad)).toThrow(RangeError);
  });
});

describe('3ad735bb never splits a UTF-16 surrogate pair', () => {
  it('head cut falling inside a pair backs off by one', () => {
    // cap 40 -> head 30. Put an emoji (2 units) at indices 29..30.
    const text = 'a'.repeat(29) + '😀' + 'b'.repeat(200);
    const out = capToolResult(text, false, 40).result as string;
    const m = out.match(MARKER_RE);
    expect(m?.[1]).toBe('29');
    expect(isWellFormed(out)).toBe(true);
  });

  it('tail cut falling inside a pair advances by one', () => {
    // cap 40 -> tail 10 starts at total-10. Emoji straddles that index.
    const text = 'a'.repeat(200) + '😀' + 'b'.repeat(9); // total 211, tailStart 201 = low surrogate
    const out = capToolResult(text, false, 40).result as string;
    const m = out.match(MARKER_RE);
    expect(m?.[2]).toBe('9');
    expect(isWellFormed(out)).toBe(true);
  });

  it('a string with many emoji stays well-formed at every cap', () => {
    const text = '😀'.repeat(500);
    for (let cap = 1; cap < 60; cap += 1) {
      const out = capToolResult(text, false, cap).result as string;
      expect(isWellFormed(out), `cap=${cap}`).toBe(true);
    }
  });
});

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}
