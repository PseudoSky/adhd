// @adhd/apigen-engine-naming — emit primitives for generated source.
//
// This module is the single source of truth for safely splicing a dynamic
// value into a generated SourceFile. Every code generator in the apigen family
// that emits TypeScript/JavaScript from a discovered, user-derived value MUST
// route the value through these helpers rather than inlining its own escaping:
//
//   - identifier positions        → `sanitizeIdentifier`  (re-exported below)
//   - string-literal positions    → `escapeStringLiteral`
//   - path positions (on any OS)  → `toPosixPath`
//
// Rationale (BUG-APIGEN-032 family — "optimistic replace + silent collisions
// in codegen"): a raw splice of an untrusted id/route/header into a template
// string is a generated-source syntax error at best and a code-injection
// vector at worst. The fix is never a hand-rolled `.replace(/'/g, ...)` — it
// is a context-correct escaper applied at the splice site.

/**
 * Renders a value as a **complete, double-quoted JavaScript/TypeScript string
 * literal** (including the surrounding quotes), safe to splice into generated
 * source in any string-literal position.
 *
 * Uses `JSON.stringify`, whose output is a valid ECMAScript string literal on
 * ES2019+ targets (the JSON-superset proposal, V8 "JSON ⊂ ECMAScript") and
 * correctly escapes the double-quote, the backslash, and all C0 control
 * characters (newline, carriage return, tab, …). Two characters are escaped
 * explicitly because `JSON.stringify` emits them **verbatim** even though they
 * are line terminators in source text:
 *
 *   - `U+2028` LINE SEPARATOR
 *   - `U+2029` PARAGRAPH SEPARATOR
 *
 * They are valid inside a string literal only on ES2019+ targets; this repo
 * targets `es2018` (`tsconfig.base.json`), and any generated value could be
 * pasted into a single-line context (a comment, a log line) where a raw
 * separator breaks the assumption. Escaping them here makes the literal safe
 * regardless of target or downstream line handling.
 *
 * @example escapeStringLiteral("it's")   // → `"it's"`
 * @example escapeStringLiteral('a\nb')   // → `"a\\nb"` (no raw newline)
 * @example escapeStringLiteral('\u2028') // → `"\\u2028"`
 */
export function escapeStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
// (`sanitizeIdentifier` itself lives in `./naming` — its single definition.)
export { sanitizeIdentifier } from './naming';
