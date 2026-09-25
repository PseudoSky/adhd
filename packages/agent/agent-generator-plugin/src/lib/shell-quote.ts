/**
 * POSIX shell quoting for values that are interpolated into a command string
 * handed to a shell (e.g. an `nx:run-commands` target's `command`).
 *
 * A value wrapped in single quotes is taken literally by every POSIX shell, so
 * `;`, `|`, `&`, `$`, backticks, spaces and quotes in the value cannot break
 * out into a second command. The only character a single-quoted span cannot
 * contain is a single quote itself, so each embedded `'` is closed, escaped as
 * `\'`, and reopened — the classic `'\''` idiom.
 *
 * @param value - the raw value to quote.
 * @returns the value wrapped in single quotes, with embedded quotes escaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
