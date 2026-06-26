/**
 * Fixture: source file that exports NO callable functions.
 *
 * Used by the lt-fail-fast test to assert that the run command rejects with
 * the actionable "0 functions found" message rather than a cryptic crash.
 *
 * The __samples__ const is intentionally present — it is a non-function export
 * and must NOT be counted as a function by buildFnTable.
 */

export const __samples__: Record<string, Record<string, unknown>> = {}

/** Just a type alias — does not produce a runtime value. */
export type EmptyPayload = Record<string, never>
