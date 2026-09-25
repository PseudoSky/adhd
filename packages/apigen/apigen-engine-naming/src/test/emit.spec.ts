// emit.spec.ts — the shared codegen emit primitive (BUG-APIGEN-032 family).
//
// These assertions pin the exact escaping contract every generated-source
// splice depends on: a value rendered by `escapeStringLiteral` must be a
// complete, syntactically valid JS/TS string literal (including quotes) that
// decodes back to the original, and `sanitizeIdentifier` must yield a valid
// identifier for the repo's hyphenated-package-id convention.
import { describe, it, expect } from 'vitest';

import {
  escapeStringLiteral,
  toPosixPath,
  sanitizeIdentifier as sanitizeFromEmit,
} from '../lib/emit';
import { sanitizeIdentifier } from '../lib/naming';

describe('escapeStringLiteral', () => {
  it('[emit.escape.1] wraps a plain value in double quotes', () => {
    expect(escapeStringLiteral('ping')).toBe('"ping"');
  });

  it('[emit.escape.2] an apostrophe does not terminate the literal', () => {
    expect(escapeStringLiteral("it's")).toBe('"it\'s"');
  });

  it('[emit.escape.3] a double quote is escaped', () => {
    expect(escapeStringLiteral('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('[emit.escape.4] a backslash is escaped', () => {
    expect(escapeStringLiteral('a\\b')).toBe('"a\\\\b"');
  });

  it('[emit.escape.5] a newline becomes a two-character escape, never a raw line break', () => {
    const literal = escapeStringLiteral('a\nb');
    expect(literal).toBe('"a\\nb"');
    expect(literal).not.toContain('\n');
  });

  it('[emit.escape.6] CR / TAB / NUL are escaped, never emitted raw', () => {
    expect(escapeStringLiteral('a\rb')).toBe('"a\\rb"');
    expect(escapeStringLiteral('a\tb')).toBe('"a\\tb"');
    expect(escapeStringLiteral('a\0b')).toBe('"a\\u0000b"');
  });

  it('[emit.escape.7] U+2028 LINE SEPARATOR is escaped, not emitted raw', () => {
    const literal = escapeStringLiteral('\u2028');
    expect(literal).toBe('"\\u2028"');
    expect(literal).not.toContain('\u2028');
  });

  it('[emit.escape.8] U+2029 PARAGRAPH SEPARATOR is escaped, not emitted raw', () => {
    const literal = escapeStringLiteral('a\u2029b');
    expect(literal).toBe('"a\\u2029b"');
    expect(literal).not.toContain('\u2029');
  });

  it('[emit.escape.9] every literal round-trips through JSON.parse to the original value', () => {
    const values = [
      '',
      "it's",
      'say "hi"',
      'a\\b',
      'a\nb',
      'a\rb',
      'a\tb',
      '\u2028\u2029',
      'pkg-a:get-user',
    ];
    for (const v of values) {
      expect(JSON.parse(escapeStringLiteral(v))).toBe(v);
    }
  });

  it('[emit.escape.10] the literal parses as real source in both expression and statement position', () => {
    const literal = escapeStringLiteral("a'b\\c\nd\u2028e");
    // `new Function` compiles the emitted literal the way the engine would when
    // it loads generated code — proving the output is a valid expression, not
    // merely a JSON document.
    const asExpression = new Function(`return ${literal};`)();
    expect(asExpression).toBe("a'b\\c\nd\u2028e");
  });
});

describe('toPosixPath', () => {
  it('[emit.posix.1] backslashes become forward slashes', () => {
    expect(toPosixPath('a\\b')).toBe('a/b');
  });

  it('[emit.posix.2] a POSIX path is unchanged', () => {
    expect(toPosixPath('pkg/src/index.ts')).toBe('pkg/src/index.ts');
  });

  it('[emit.posix.3] mixed separators are fully normalised', () => {
    expect(toPosixPath('a\\b/c\\d')).toBe('a/b/c/d');
  });

  it('[emit.posix.4] multiple consecutive backslashes are each normalised', () => {
    expect(toPosixPath('a\\\\b')).toBe('a//b');
  });
});

describe('emit re-exports sanitizeIdentifier', () => {
  it('[emit.sanitize.reexport] the emit module exposes the single naming definition', () => {
    // Assert the ./emit re-export is the SAME binding as ./naming — never a
    // second, drift-prone copy.
    expect(sanitizeFromEmit).toBe(sanitizeIdentifier);
    expect(sanitizeFromEmit('dispatch-cli')).toBe('dispatch_cli');
  });
});
