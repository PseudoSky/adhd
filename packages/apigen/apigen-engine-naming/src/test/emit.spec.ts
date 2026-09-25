// emit.spec.ts — the shared codegen emit primitive (BUG-APIGEN-032 family).
//
// These assertions pin the exact escaping contract every generated-source
// splice depends on: a value rendered by `escapeStringLiteral` must be a
// complete, syntactically valid JS/TS string literal (including quotes) that
// decodes back to the original, and `sanitizeIdentifier` must yield a valid
// identifier for the repo's hyphenated-package-id convention.
import { describe, it, expect } from 'vitest';

import {
  coercePort,
  escapeLineTerminators,
  escapeStringLiteral,
  toPosixPath,
  sanitizeIdentifier as sanitizeFromEmit,
  uniqueSanitizedIdentifiers as uniqueFromEmit,
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

  it('[emit.sanitize.reexport2] the emit module re-exports uniqueSanitizedIdentifiers too', () => {
    expect(uniqueFromEmit(['a-b', 'a_b'])).toEqual(['a_b', 'a_b_2']);
  });
});

describe('escapeLineTerminators', () => {
  it('[emit.linesep.1] U+2028 / U+2029 become their escape sequences', () => {
    expect(escapeLineTerminators('a\u2028b')).toBe('a\\u2028b');
    expect(escapeLineTerminators('a\u2029b')).toBe('a\\u2029b');
  });

  it('[emit.linesep.2] text without separators is untouched', () => {
    const s = '{"a":1}\nconst x = 2';
    expect(escapeLineTerminators(s)).toBe(s);
  });

  it('[emit.linesep.3] escaping a JSON blob keeps it parseable and round-trips', () => {
    // Mirrors the generator's schema-blob splice: JSON.stringify leaves the
    // separators raw (valid JSON), the escape makes the outer source literal
    // safe, and JSON.parse still recovers the original value.
    const blob = JSON.stringify({ description: 'line\u2028break\u2029end' });
    const escaped = escapeLineTerminators(blob);
    expect(escaped).not.toContain('\u2028');
    expect(escaped).not.toContain('\u2029');
    expect(JSON.parse(escaped)).toEqual({
      description: 'line\u2028break\u2029end',
    });
  });
});

describe('coercePort', () => {
  it('[emit.port.1] nullish falls back to the default (3000)', () => {
    expect(coercePort(undefined)).toBe(3000);
    expect(coercePort(null)).toBe(3000);
    expect(coercePort(undefined, 8080)).toBe(8080);
  });

  it('[emit.port.2] a numeric string (the CLI option shape) is coerced', () => {
    expect(coercePort('8080')).toBe(8080);
    expect(coercePort('0')).toBe(0);
    expect(coercePort(3001)).toBe(3001);
  });

  it('[emit.port.3] an injection-shaped string is rejected, never spliced', () => {
    // The exact hazard: a raw `await app.listen({ port: ${port} })` splice.
    expect(() => coercePort('3000); process.exit(1); //')).toThrow(TypeError);
  });

  it('[emit.port.4] blank / non-numeric / non-integer / out-of-range all throw', () => {
    expect(() => coercePort('')).toThrow(TypeError);
    expect(() => coercePort('   ')).toThrow(TypeError);
    expect(() => coercePort('abc')).toThrow(TypeError);
    expect(() => coercePort('80.5')).toThrow(TypeError);
    expect(() => coercePort(3.14)).toThrow(TypeError);
    expect(() => coercePort(-1)).toThrow(TypeError);
    expect(() => coercePort(65536)).toThrow(TypeError);
    expect(() => coercePort(Infinity)).toThrow(TypeError);
    expect(() => coercePort(NaN)).toThrow(TypeError);
  });
});
