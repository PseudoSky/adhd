import { Query } from '@adhd/data-query-engine';
import type { QueryExpression } from '@adhd/data-query-engine';
import type { FilterExpression } from '../../spec';

/** A compiled row predicate. */
export type RowPredicate = (row: Record<string, unknown>) => boolean;

/**
 * The single place the query engine is constructed. Compiles `where` into a
 * synchronous row predicate. Throws `QueryValidationError` for an expression
 * the engine rejects.
 */
export function compilePredicate(where: FilterExpression): RowPredicate {
  const query = new Query({ where: where as unknown as QueryExpression['where'] });
  return query.where as RowPredicate;
}
