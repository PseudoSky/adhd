export { snapshot, topoSortMilestones } from './snapshot.js';
export { optimize, computeTokensNaive } from './optimize.js';

// Re-exported for ergonomics: consumers of snapshot()/optimize() need this
// type to build their deps argument without a second import from
// @adhd/dispatch-base-spec.
export type { IOptimizerDeps } from '@adhd/dispatch-base-spec';
