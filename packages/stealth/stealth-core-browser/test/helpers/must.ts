/**
 * Narrowing helper for specs: returns the value when it is present and throws a descriptive error when it is
 * `null` or `undefined`, so a spec reads a possibly-absent value without a non-null assertion and fails with a
 * message (not a TypeError on a later property read) when the value is missing.
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`)
  return value
}
