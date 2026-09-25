// @adhd/apigen-engine-naming — emit primitives for generated source.
//
// This module is the single source of truth for safely splicing a dynamic
// value into a generated SourceFile. Every code generator in the apigen family
// that emits TypeScript/JavaScript from a discovered, user-derived value MUST
// route the value through these helpers rather than inlining its own escaping:
//
//   - identifier positions         → `sanitizeIdentifier` (re-exported below)
//   - collision-safe identifier sets → `uniqueSanitizedIdentifiers`
//   - string-literal positions      → `escapeStringLiteral`
//   - path positions (on any OS)    → `toPosixPath`
//   - numeric-literal positions     → `coercePort`
//   - a multi-value JSON blob       → `escapeLineTerminators` (then splice)
//
// Rationale (BUG-APIGEN-032 family — "optimistic replace + silent collisions
// in codegen"): a raw splice of an untrusted id/route/header into a template
// string is a generated-source syntax error at best and a code-injection
// vector at worst. The fix is never a hand-rolled `.replace(/'/g, ...)` — it
// is a context-correct escaper applied at the splice site.

/**
 * Replaces raw `U+2028` LINE SEPARATOR / `U+2029` PARAGRAPH SEPARATOR
 * characters with their `\u2028` / `\u2029` escape sequences.
 *
 * `JSON.stringify` emits these two code points **verbatim** (they are valid in
 * JSON) even though ECMAScript treats them as line terminators. That is a
 * parse error inside a string literal on pre-ES2019 targets — this repo
 * targets `es2018` (`tsconfig.base.json`) — and a raw separator also breaks any
 * single-line context (a comment, a log line) it lands in.
 *
 * `escapeStringLiteral` applies this to a single string literal.
 * `escapeLineTerminators` is the same escape applied **directly to an
 * already-serialized blob** — e.g. a `JSON.stringify`'d schema map whose
 * nested `description` fields may carry these separators — so a multi-value
 * JSON blob spliced into generated source cannot smuggle a raw line terminator
 * past `JSON.stringify`. It is only safe on JSON/source text (it never touches
 * any other character); it is not a substitute for `escapeStringLiteral` on a
 * raw value, because it does not add quotes or escape backslashes.
 *
 * @example escapeLineTerminators('a\u2028b') // → 'a\\u2028b'
 */
export function escapeLineTerminators(text: string): string {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Renders a value as a **complete, double-quoted JavaScript/TypeScript string
 * literal** (including the surrounding quotes), safe to splice into generated
 * source in any string-literal position.
 *
 * Uses `JSON.stringify`, whose output is a valid ECMAScript string literal on
 * ES2019+ targets (the JSON-superset proposal, V8 "JSON ⊂ ECMAScript") and
 * correctly escapes the double-quote, the backslash, and all C0 control
 * characters (newline, carriage return, tab, …). The two characters
 * `JSON.stringify` emits **verbatim** even though they are line terminators —
 * `U+2028` / `U+2029` — are then escaped via {@link escapeLineTerminators}
 * (see that helper for why this repo needs it at `es2018`).
 *
 * @example escapeStringLiteral("it's")   // → `"it's"`
 * @example escapeStringLiteral('a\nb')   // → `"a\\nb"` (no raw newline)
 * @example escapeStringLiteral('\u2028') // → `"\\u2028"`
 */
export function escapeStringLiteral(value: string): string {
  return escapeLineTerminators(JSON.stringify(value));
}

/**
 * Coerces a caller-supplied `port` option to a validated integer, safe to
 * splice into generated source as a numeric literal.
 *
 * Generate/run options reach a plugin as **untyped** option values — a CLI
 * `--opt port=8080` arrives as the string `'8080'`, and nothing prevents a
 * hostile or fat-fingered `--opt port=8080); process.exit(1); //`. Splicing
 * that raw (`await app.listen({ port: ${port} })`) is a code-injection vector.
 * Collapsing the value to an integer in the valid TCP range `[0, 65535]`
 * (0 = request an ephemeral port) before splicing closes it: the emitted
 * literal is always a bare number.
 *
 * `undefined`/`null` fall back to `fallback` (3000, matching the generators'
 * historical default); a blank string, a non-numeric value, a non-integer, or
 * an out-of-range value throws rather than silently emitting something wrong.
 *
 * @example coercePort('8080')  // → 8080
 * @example coercePort(undefined) // → 3000
 * @throws {TypeError} on a blank/non-numeric/non-integer/out-of-range value.
 */
export function coercePort(value: unknown, fallback = 3000): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') {
    throw new TypeError(
      `apigen: invalid port option ${JSON.stringify(value)} — expected an integer in [0, 65535]`
    );
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(
      `apigen: invalid port option ${JSON.stringify(value)} — expected an integer in [0, 65535]`
    );
  }
  return port;
}

/**
 * Normalises a filesystem path to POSIX separators (`/`).
 *
 * Generated specifiers and paths must be platform-stable: a Windows-joined
 * `pkg\\src\\index.ts` spliced verbatim into an import would not match the
 * value an OpenAPI/schema emitter produces on POSIX. Always emit `/`.
 *
 * @example toPosixPath('a\\b') // → 'a/b'
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// Identifier sanitisation is part of the same emit contract; re-exported here
// so a caller can import the whole "splice safely" surface from one module.
// (`sanitizeIdentifier` / `uniqueSanitizedIdentifiers` live in `./naming` —
// their single definitions.)
export { sanitizeIdentifier, uniqueSanitizedIdentifiers } from './naming';
