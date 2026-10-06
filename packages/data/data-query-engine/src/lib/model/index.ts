/**
 * The v2 reference engine internals: the self-similar, position-typed grammar's
 * leaf types (`./types`), the phase rule, the planner, the reference executor,
 * the index-accelerated store, and the Z-set algebra. The `DataView` here is the
 * ONE shipped `DataView` (`./dataview` re-exports `../query`) — this module is no
 * longer a second surface; it is the engine the merged `DataView` delegates to.
 *
 * The canonical query type is exported from the package's `expressions` barrel
 * (`../expressions`).
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
