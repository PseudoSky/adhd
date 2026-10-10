/**
 * Line-ending preservation helpers (backlog 8dd148cf, R3-EOL).
 *
 * The adopted `@modelcontextprotocol/server-filesystem` normalizes every file it
 * edits to bare LF, so a CRLF file comes back converted. A host uses these pure
 * helpers to restore the pre-call line-ending class after such a write.
 */

/** The line-ending class of a text. `none` = no line break at all. */
export type EolClass = 'crlf' | 'lf' | 'mixed' | 'none';

/** Classify the line endings of `text` (a lone CR is not a line ending here). */
export function classifyEol(text: string): EolClass {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && bareLf === 0) return 'crlf';
  if (crlf === 0 && bareLf > 0) return 'lf';
  if (crlf > 0 && bareLf > 0) return 'mixed';
  return 'none';
}

/**
 * Re-apply the line-ending class of `before` to `after`.
 *
 * - `before` is CRLF-only: every bare `\n` in `after` becomes `\r\n` (existing
 *   `\r\n` is never doubled).
 * - `before` is `undefined`, LF-only, mixed, or has no line break: `after` is
 *   returned unchanged (nothing to preserve, or no single class to restore).
 */
export function restoreLineEndings(before: string | undefined, after: string): string {
  if (before === undefined || classifyEol(before) !== 'crlf') return after;
  return after.replace(/(?<!\r)\n/g, '\r\n');
}
