/**
 * Re-export shim. The v2 model's multi-source `DataView` has been FOLDED INTO the
 * ONE shipped `DataView` in `../query` — there is exactly one `DataView` class on
 * the package surface. This module exists only so `./index` (and the specs that
 * import from it) keep resolving the same names.
 */
export { DataView } from '../query';
export type { CallableQuery, DataSource, DataViewOptions } from '../query';
