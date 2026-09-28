/**
 * verdict-core.ts — the PURE rules of C6's verdict (DESIGN §2 Primitive 4).
 *
 * No I/O, no graph, no clock: this module owns exactly two decisions — how a
 * condition set collapses to a tri-state `actionable`, and the stable condition
 * order. Every caller (the graph-backed `deriveVerdict` and the tx-backed
 * `evaluateVerdictTx`) calls THESE, never a locally re-implemented boolean rule
 * (adhd ADR-0002 — one implementation of the grammar's semantics).
 */
import type { IActionable, ICondition } from './types.js';

/**
 * The ONE actionability rule (DESIGN §2 Primitive 4).
 *
 * - `false` iff at least one `block`-severity condition is `True` (the item IS
 *   blocked — a definite answer beats an uncertain one);
 * - `'unknown'` iff any `block`-severity condition is `Unknown` and none is
 *   `True` (the check could not be run / decided — NEVER a green light);
 * - otherwise `true`.
 *
 * `'Unknown'` is never treated as `false` OR as `true`. `warn`-severity
 * conditions never affect the result.
 */
export function computeActionable(
  conditions: readonly ICondition[]
): IActionable {
  let unknownBlock = false;
  for (const c of conditions) {
    if (c.severity !== 'block') continue;
    if (c.status === 'True') return false;
    if (c.status === 'Unknown') unknownBlock = true;
  }
  return unknownBlock ? 'unknown' : true;
}

/**
 * Stable ordering: all `block` before all `warn`; within a band, by `code`
 * then `subject` (both lexical, `undefined` subject sorts first). Pure and
 * total — two callers ordering the same set always agree.
 */
export function orderConditions(
  conditions: readonly ICondition[]
): ICondition[] {
  const band = (c: ICondition): number => (c.severity === 'block' ? 0 : 1);
  return [...conditions].sort((a, b) => {
    const byBand = band(a) - band(b);
    if (byBand !== 0) return byBand;
    const byCode = a.code.localeCompare(b.code);
    if (byCode !== 0) return byCode;
    return (a.subject ?? '').localeCompare(b.subject ?? '');
  });
}
