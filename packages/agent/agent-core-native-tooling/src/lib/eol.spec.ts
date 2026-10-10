import { describe, expect, it } from 'vitest';

import { classifyEol, restoreLineEndings } from './eol';

describe('8dd148cf AC1 restoreLineEndings (R3-EOL)', () => {
  it('8dd148cf AC1: CRLF-only before + LF after -> CRLF-only', () => {
    expect(restoreLineEndings('a\r\nb\r\n', 'a\nB\n')).toBe('a\r\nB\r\n');
  });

  it('8dd148cf AC1: never doubles an existing CRLF (partially converted after)', () => {
    expect(restoreLineEndings('a\r\nb\r\n', 'a\r\nB\nc\n')).toBe('a\r\nB\r\nc\r\n');
  });

  it('8dd148cf AC1: undefined before -> unchanged', () => {
    expect(restoreLineEndings(undefined, 'a\nb\n')).toBe('a\nb\n');
  });

  it('8dd148cf AC1: LF-only before -> unchanged', () => {
    expect(restoreLineEndings('a\nb\n', 'x\ny\n')).toBe('x\ny\n');
  });

  it('8dd148cf AC1: mixed before -> unchanged', () => {
    expect(restoreLineEndings('a\r\nb\n', 'x\ny\n')).toBe('x\ny\n');
  });

  it('8dd148cf AC1: empty before and empty after', () => {
    expect(restoreLineEndings('', 'x\n')).toBe('x\n');
    expect(restoreLineEndings('a\r\n', '')).toBe('');
  });

  it('8dd148cf AC1: no trailing newline is preserved as-is', () => {
    expect(restoreLineEndings('a\r\nb', 'a\nb')).toBe('a\r\nb');
  });

  it('8dd148cf AC1: classifyEol classes', () => {
    expect(classifyEol('a\r\nb')).toBe('crlf');
    expect(classifyEol('a\nb')).toBe('lf');
    expect(classifyEol('a\r\nb\nc')).toBe('mixed');
    expect(classifyEol('abc')).toBe('none');
    expect(classifyEol('')).toBe('none');
  });
});
