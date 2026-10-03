/**
 * A query that cannot be honoured was written.
 *
 * This is deliberately NOT a silent skip. The rejected `_having`-as-sugar design
 * (d2d72095) failed precisely because an unknown `_`-prefixed operator under
 * `where` was logged and then skipped (`parser.ts` used to `console.error` and
 * fall through), so an aggregate predicate silently no-op'd and the query
 * returned the wrong rows. An unrepresentable query must be loud at COMPILE
 * time (SPEC AC-6, AC-15), so the engine now throws this.
 */
export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryValidationError';
  }
}
