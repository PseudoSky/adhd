/**
 * Re-export shim for the v2 grammar. There is exactly ONE query type — the
 * canonical `QueryExpression` (and its leaf/position types) defined in
 * `../expressions` and exported from the package barrel. This module exists so
 * the engine's internal modules (and their specs) can keep resolving the v2
 * names from `./types`.
 */
export type {
  Arith,
  BooleanExpression,
  BucketKey,
  Expr,
  Fold,
  FoldMods,
  GroupItem,
  Operator,
  OrderByExpression,
  Predicate,
  PredicateValue,
  QuantileSketch,
  QueryExpression,
  Row,
  ScanFrame,
  ScanSpec,
  ScalarOperator,
  SelectItem,
} from '../expressions';
