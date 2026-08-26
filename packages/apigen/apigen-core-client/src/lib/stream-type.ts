// stream-type.ts — shared streaming-return-type detector (SPEC §11).
//
// Both `extract.ts` (function/const/CJS exports) and `extract-classes.ts`
// (class static/instance methods) resolve a TS return type down to plain text
// via `Signature.getReturnType().getText()` and then unwrap `Promise<T> → T`
// with a regex (see each file's "Unwrap Promise<T> → T" comment) rather than
// threading a `ts-morph` `Type` through every call site. This module extends
// that same text-based approach one level further: given the (already
// Promise-unwrapped) return-type text, detect whether it is a streaming
// wrapper — `AsyncGenerator<T, ...>`, `AsyncIterable<T>`,
// `AsyncIterableIterator<T>`, `Generator<T, ...>`, `IterableIterator<T>`,
// `Iterable<T>`, or this codebase's own `ApiStream<T>` (a type alias for
// `AsyncIterable<T>` from `@adhd/apigen-engine-runtime`'s `stream.ts`, whose
// runtime `isApiStream()` guard is the actual dispatch-time authority — see
// that file) — and if so, return the unwrapped per-chunk element type `T`
// per descriptor.ts's `Operation.streaming` / `Operation.output` contract.
//
// Text-based, not `Type`-based, deliberately: `ts-morph`'s `getText()` can
// return an import-qualified name for a cross-module type alias, e.g.
// `import("/abs/path/stream").ApiStream<{ x: number }>` instead of a bare
// `ApiStream<{ x: number }>` — verified empirically against a real `Project`
// (not `useInMemoryFileSystem`, which lacks lib resolution and yields `{}`
// for an unannotated generator's return type). `detectStreamElementType`
// matches on the LAST dotted segment of the wrapper's head so both bare and
// import-qualified forms are recognized identically.
//
// [dev-note] The runtime `isApiStream()` guard (`apigen-engine-runtime/src/
// lib/stream.ts`) checks `Symbol.asyncIterator in value` ONLY — a sync
// `Generator`/`Iterable`-returning export is therefore detected as
// `streaming: true` here (matching descriptor.ts's documented contract,
// which explicitly lists `Generator`) but is NOT treated as a stream by the
// Layer harness dispatcher at runtime (it has no `Symbol.asyncIterator`).
// This pre-existing async/sync asymmetry is not introduced by this module —
// today a sync generator export already gets a useless
// `Generator<Chunk, void, unknown>` output schema — this module simply makes
// the *async* half of that pre-existing gap correct. Tracked as a follow-up
// (BUG-APIGEN-SYNC-GENERATOR-NOT-STREAM-001) rather than silently
// special-cased here, since resolving it would require the descriptor to
// distinguish "streaming, sync" from "streaming, async" — a contract change
// out of scope for this fix.

/** Wrapper type names recognized as streaming (bare or import-qualified). */
const STREAM_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'AsyncGenerator',
  'AsyncIterableIterator',
  'AsyncIterable',
  'Generator',
  'IterableIterator',
  'Iterable',
  // Project-specific: `@adhd/apigen-engine-runtime`'s `ApiStream<T>` — a type
  // alias for `AsyncIterable<T>` (see that package's `stream.ts`). Aliases
  // used directly (not structurally decomposed) are NOT expanded by
  // `getText()`, so this wrapper never surfaces as `AsyncIterable<T>` and
  // must be recognized by its own name.
  'ApiStream',
]);

/**
 * Splits a comma-separated generic-argument list at TOP-LEVEL commas only
 * (i.e. not commas nested inside `<>`, `()`, `[]`, or `{}`) — needed because
 * `AsyncGenerator<T, TReturn, TNext>`'s first argument `T` may itself be a
 * generic, object, tuple, or function type containing commas.
 */
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argsText) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;

    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/**
 * Detects whether `typeText` (a return type, already `Promise<T> → T`
 * unwrapped by the caller) is one of the recognized streaming wrappers, and
 * if so, returns the unwrapped per-chunk element type's text.
 *
 * Returns `null` when `typeText` is not a full, single streaming-wrapper
 * type — including when it's a union with a stream member (e.g.
 * `AsyncGenerator<T> | null`), since only the outermost `<...>` closing at
 * the very end of the string counts as "fully wrapped" (a union closes its
 * generic early, mid-string).
 *
 * @param typeText - Textual return type, e.g. `'AsyncGenerator<Chunk, void, unknown>'`.
 * @returns The element type text (e.g. `'Chunk'`), or `null` if not streaming.
 */
export function detectStreamElementType(typeText: string): string | null {
  const trimmed = typeText.trim();
  const ltIdx = trimmed.indexOf('<');
  if (ltIdx === -1 || !trimmed.endsWith('>')) return null;

  const head = trimmed.slice(0, ltIdx);
  const bareName = head.includes('.') ? head.slice(head.lastIndexOf('.') + 1) : head;
  if (!STREAM_WRAPPER_NAMES.has(bareName)) return null;

  // Verify the `<` at `ltIdx` is the OUTERMOST generic bracket, closing only
  // at the very last character of the string — otherwise this is a union or
  // intersection with a stream member, not a bare streaming return type.
  let depth = 0;
  for (let i = ltIdx; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0 && i !== trimmed.length - 1) return null;
    }
  }
  if (depth !== 0) return null;

  const inner = trimmed.slice(ltIdx + 1, -1);
  const args = splitTopLevelArgs(inner);
  return args.length > 0 ? args[0] : null;
}
