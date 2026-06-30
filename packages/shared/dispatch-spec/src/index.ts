export type {
  OperationType, OperationAction, CodeKind, ConfigKind, ShapeKind, KindFamily,
  MilestoneStatus, DispatchUnitStatus, OperationStatus, GuardResult, MilestoneGuardResult,
  Provenance, Confidence, KiSource, DispatchKind, ProviderType, SentinelRole,
  ModelTier, EffortTier, PlanKind,
  ShapeOpType, ShapeOpDag, ShapeOpSnapshot,
  ShapeCode, ShapeConfig, ShapeDoc, ShapeStructuredOutput, ShapeNull, Shape,
  ShapeCodeSnapshot, ShapeConfigSnapshot, ShapeSnapshot,
  BlastRadiusEntry, OperationConflict,
  RetryConfig, ProviderConfig, Turn, DispatchResult, DispatchNote, DispatchLogEntry,
  OperationDag, OperationSnapshot,
  MilestoneDag, MilestoneSnapshot,
  SentinelFanoutConfig, OptimizationConfig, DagJson, CrossPlanDep,
  SnapshotOptimization, DagSnapshot,
  DispatchUnit,
  ValidationError, ValidationResult,
  IOptimizerDeps,
} from "./lib/types.js";

export { WRITE_CLASS_ACTIONS, VALID_OPS_BY_KIND, isValidOpForKind } from "./lib/types.js";

export { validateDagJson, validateSnapshot, assertValidDagJson, assertValidSnapshot } from "./lib/validate.js";

export { migrateDag } from "./lib/migrate.js";
