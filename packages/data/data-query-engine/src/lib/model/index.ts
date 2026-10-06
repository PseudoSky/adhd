/**
 * `queryModel` — the v2 query model (self-similar, position-typed grammar), with a
 * reference executor and a multi-source, append-incremental `DataView`.
 * Additive; see `./types` and `tmp/data-query-engine/model.md`.
 */
export * from './types';
export * from './errors';
export * from './zset';
export * from './canonical';
export * from './indexing';
export * from './phase';
export * from './plan';
export * from './execute';
export * from './dataview';
