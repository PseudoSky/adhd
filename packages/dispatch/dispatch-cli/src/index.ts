// Public library surface. The apigen-generated CLI (`generate-cli` target)
// reads `./api.js` directly and does not go through this file — this is for
// TypeScript consumers who want to call the commands in-process, or import
// the DI'd core seams directly (e.g. to drive `run`/`calibrate` with an
// injected runner without going through the CLI at all).

export { validate, snapshot, optimize, eligible, status, run, calibrate } from './api.js';

export type {
  CalibrationResult,
  MilestoneStatusEntry,
} from './lib/core.js';
export {
  assertModelTier,
  buildClient,
  buildProductionAgentMcpRunner,
  calibrateCore,
  DEFAULT_CALIBRATION_PATH,
  DEFAULT_RUN_DEBUG_DIR,
  eligibleCore,
  optimizeCore,
  runCycleCore,
  snapshotCore,
  statusCore,
  validateCore,
} from './lib/core.js';
