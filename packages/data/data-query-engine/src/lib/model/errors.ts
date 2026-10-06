/**
 * A non-phase query error — an unknown operator, an unresolved source, a bad
 * arity, a malformed predicate, an unimplemented declaration, or a cycle. Kept
 * distinct from {@link PhaseRuleError} so a caller can tell "your query is
 * malformed" from "your `where` tree mixes phases".
 */
export class QueryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryModelError';
  }
}
