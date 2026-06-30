/**
 * types.ts — Complete TypeScript type system for the dispatch plan ecosystem.
 *
 * Source: docs/plan/dispatch-optimizer/PROPOSED_DAG_STRUCTURE.md
 * Design decisions: D-01 through D-18 in DECISIONS.md
 *
 * Field provenance: dag | derived | scheduler | optimizer | clock | gitnexus
 * Zero dependencies. Pure TypeScript. platform:shared.
 */

// ---------------------------------------------------------------------------
// ── PRIMITIVE DISCRIMINANTS ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

/** D-03 + D-18 — which executor the orchestrator routes this operation to. */
export type OperationType = "automated" | "tool-call" | "generative";

export type OperationAction =
  | "create" | "delete" | "move" | "rename"
  | "modify-signature" | "modify-body" | "add-export" | "remove-export"
  | "guard" | "exec" | "dag.inject" | "dag.wait"
  | "dag.add-milestone" | "dag.set-field" | "dag.clear-pending" | "dag.append-dispatch-log"
  | "fs.move" | "fs.delete" | "fs.scaffold";

export const WRITE_CLASS_ACTIONS: ReadonlySet<OperationAction> = new Set([
  "create", "modify-signature", "modify-body", "add-export", "remove-export", "rename",
]);

export type CodeKind = "function" | "interface" | "type" | "class" | "enum" | "const" | "script";
export type ConfigKind = "config" | "env" | "schema" | "manifest";
export type ShapeKind = CodeKind | ConfigKind | "doc" | "structured-output";
export type KindFamily = "code-config" | "doc" | "structured" | "tool-call";

export type MilestoneStatus = "pending" | "pending-surfaced" | "in_progress" | "complete" | "failed" | "skipped";
export type DispatchUnitStatus = "pending" | "in_progress" | "complete" | "failed";
export type OperationStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";
export type GuardResult = "pass" | "fail";
export type MilestoneGuardResult = "pass" | "fail" | "pending";
export type Provenance = "gitnexus" | "manual" | "assumed" | "vendored";
export type Confidence = "verified" | "vendored" | "documented" | "assumed";
export type KiSource = "estimate" | "calibrated" | "actual";
export type DispatchKind = "planning" | "execution";
export type ProviderType = "anthropic" | "openai" | "claudecli";
export type SentinelRole = "prewarm" | "payload";
export type ModelTier = "Haiku" | "Sonnet" | "Opus";
export type EffortTier = "low" | "medium" | "high" | "xhigh" | "max";
export type PlanKind = "brownfield" | "greenfield";

// ---------------------------------------------------------------------------
// ── SHAPE OPS ───────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export type ShapeOpType =
  | "add-param" | "remove-param" | "rename-param" | "retype-param" | "change-param-optional" | "reorder-params" | "change-return"
  | "add-field" | "remove-field" | "rename-field" | "retype-field" | "change-field-optional"
  | "add-generic" | "remove-generic" | "constrain-generic" | "add-extends" | "remove-extends"
  | "set-key" | "remove-key" | "rename-key" | "add-array-item" | "remove-array-item"
  | "add-var" | "remove-var" | "rename-var" | "change-default"
  | "add-section" | "remove-section" | "rename-section" | "update-section"
  | "add-table" | "remove-table" | "add-column" | "remove-column" | "rename-column" | "retype-column" | "change-nullable" | "add-index" | "remove-index"
  | "add-entry" | "remove-entry" | "update-entry" | "bump-version" | "update-checksum"
  | "add-export" | "remove-export";

export const VALID_OPS_BY_KIND: Record<string, ReadonlySet<ShapeOpType>> = {
  function: new Set<ShapeOpType>(["add-param","remove-param","rename-param","retype-param","change-param-optional","reorder-params","change-return"]),
  interface: new Set<ShapeOpType>(["add-field","remove-field","rename-field","retype-field","change-field-optional","add-generic","remove-generic","constrain-generic","add-extends","remove-extends"]),
  type: new Set<ShapeOpType>(["add-field","remove-field","retype-field"]),
  class: new Set<ShapeOpType>(["add-field","remove-field","rename-field","retype-field","change-field-optional","add-param","add-generic","remove-generic","constrain-generic","add-extends","remove-extends"]),
  enum: new Set<ShapeOpType>(["add-field","remove-field","rename-field"]),
  const: new Set<ShapeOpType>(["add-var","remove-var","rename-var","change-default"]),
  config: new Set<ShapeOpType>(["set-key","remove-key","rename-key","add-entry","remove-entry","update-entry","bump-version","update-checksum"]),
  env: new Set<ShapeOpType>(["set-key","remove-key","rename-key"]),
  schema: new Set<ShapeOpType>(["add-table","remove-table","add-column","remove-column","rename-column","retype-column","change-nullable","add-index","remove-index"]),
  manifest: new Set<ShapeOpType>(["add-entry","remove-entry","bump-version"]),
  doc: new Set<ShapeOpType>(["add-section","remove-section","rename-section","update-section"]),
  "structured-output": new Set<ShapeOpType>([]),
  script: new Set<ShapeOpType>(["add-param","remove-param","rename-param","retype-param","change-param-optional","reorder-params","change-return","add-field","remove-field","rename-field","retype-field","change-field-optional","add-generic","remove-generic","constrain-generic","add-extends","remove-extends","set-key","remove-key","rename-key","add-array-item","remove-array-item","add-var","remove-var","rename-var","change-default","add-section","remove-section","rename-section","update-section","add-table","remove-table","add-column","remove-column","rename-column","retype-column","change-nullable","add-index","remove-index","add-entry","remove-entry","update-entry","bump-version","update-checksum","add-export"]),
};

export function isValidOpForKind(kind: string, op: ShapeOpType): boolean {
  const valid = VALID_OPS_BY_KIND[kind];
  if (!valid) return false;
  return valid.has(op);
}

// ---------------------------------------------------------------------------
// ── SHAPE OP ────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface ShapeOpDag {
  op: ShapeOpType;
  target: string | null;
  to: string | null;
  position: number | null;
  required: boolean | null;
}

export interface ShapeOpSnapshot extends ShapeOpDag {
  from: string | null;
  breaking: boolean | null;
  severity: "error" | "warning" | "info" | null;
}

// ---------------------------------------------------------------------------
// ── SHAPE ───────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface ShapeCode { kind: CodeKind; ops: ShapeOpDag[]; description?: null; objective?: null; required_sections?: null; schema?: null }
export interface ShapeConfig { kind: ConfigKind; ops: ShapeOpDag[]; description?: null; objective?: null; required_sections?: null; schema?: null }
export interface ShapeDoc { kind: "doc"; ops?: null; description: string; objective: string; required_sections: string[]; schema?: null }
export interface ShapeStructuredOutput { kind: "structured-output"; ops?: null; description?: null; objective?: null; required_sections?: null; schema: Record<string, unknown> }
export interface ShapeNull { kind: null; ops?: null; description?: null; objective?: null; required_sections?: null; schema?: null }

export type Shape = ShapeCode | ShapeConfig | ShapeDoc | ShapeStructuredOutput | ShapeNull;

export interface ShapeCodeSnapshot extends Omit<ShapeCode, "ops"> { ops: ShapeOpSnapshot[] }
export interface ShapeConfigSnapshot extends Omit<ShapeConfig, "ops"> { ops: ShapeOpSnapshot[] }
export type ShapeSnapshot = ShapeCodeSnapshot | ShapeConfigSnapshot | ShapeDoc | ShapeStructuredOutput | ShapeNull;

// ---------------------------------------------------------------------------
// ── BLAST RADIUS + CONFLICT ─────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface BlastRadiusEntry {
  file: string;
  symbol: string;
  impact: "implements" | "calls" | "imports" | "extends" | "re-exports" | "overrides";
  consumer: "current" | "future";
}

export interface OperationConflict {
  detected: boolean;
  competing_op: string | null;
  op_key: string | null;
  resolution: "safe-merge" | "warning" | "error" | null;
}

// ---------------------------------------------------------------------------
// ── PROVIDER ────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface RetryConfig { retries: number; min_timeout: number; max_timeout: number; factor: number }

export interface ProviderConfig {
  type: ProviderType; model_id: string;
  env_secret: string | null; base_url: string | null;
  timeout_ms: number; retry_config: RetryConfig;
}

// ---------------------------------------------------------------------------
// ── DISPATCH LOG ────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface Turn { turn: number; input_tokens: number; output_tokens: number; t: string }
export interface DispatchResult { op_id: string; status: "complete" | "failed" | "skipped"; guard_result: GuardResult | null; guard_output: string | null; guard_ran_at: string | null }
export interface DispatchNote { level: "info" | "warn" | "error"; text: string }

export interface DispatchLogEntry {
  id: string; kind: DispatchKind;
  provider: "anthropic" | "openai" | "deepseek" | "google" | "local";
  model: string | null; agent: string; effort: EffortTier | null;
  started_at: string; completed_at: string | null;
  operations: string[]; turns: Turn[]; results: DispatchResult[]; notes: DispatchNote[];
}

// ---------------------------------------------------------------------------
// ── OPERATION ───────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface OperationDag {
  id: string; milestone: string; depends_on: string[];
  type: OperationType; action: OperationAction;
  file: string | null; symbol: string | null;
  provenance: Provenance | null; confidence: Confidence | null; audit_check: string | null;
  criteria: string[]; tool: string | null; args: Record<string, unknown> | null;
  guard: string | null; to_file: string | null; to_symbol: string | null;
  ki_estimate: number | null; ki_source: KiSource | null;
  authored_by: string; status: OperationStatus; shape: Shape | null;
}

export interface OperationSnapshot extends Omit<OperationDag, "shape"> {
  shape: ShapeSnapshot | null;
  dispatch_ids: string[]; attempt_count: number;
  guard_result: GuardResult | null; guard_output: string | null; guard_ran_at: string | null;
  blast_radius: BlastRadiusEntry[]; conflict: OperationConflict;
  tokens_actual: number | null;
}

// ---------------------------------------------------------------------------
// ── MILESTONE ───────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface MilestoneDag {
  description: string; rationale?: string; authored_by: string;
  pending: string | null; triggered_by: string | null;
  phase: string; depends_on: string[];
  agent: string | null; model: ModelTier | null; effort: EffortTier | null;
  two_stage: boolean; read_only: string[]; guard: string | null;
}

export interface CrossPlanDep { plan: string; milestone: string }

export type PairwiseOverlapMap = Record<string, number>;

export interface OpenQuestion {
  id: string; text: string; blocking: string;
  surfaced: boolean; raised_at_dispatch: string | null; raised_at_turn: number | null;
  answered: boolean; answer: string | null;
}

export interface MilestoneSnapshot extends MilestoneDag {
  context: string; wave: number; eligible: boolean; status: MilestoneStatus;
  started_at: string | null; completed_at: string | null;
  guard_result: MilestoneGuardResult | null; guard_output: string | null;
  artifacts: string[]; si_bytes: number;
  ki_estimate: number | null; tokens_estimated: number | null; tokens_actual: number | null;
}

// ---------------------------------------------------------------------------
// ── DAGJSON + SNAPSHOT ─────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface SentinelFanoutConfig { enabled: boolean; write_multiplier: number; read_multiplier: number; hit_probability: number }
export interface OptimizationConfig { sentinel_fanout: SentinelFanoutConfig; b_per_tier: Record<string, number | null>; context_window_per_tier: Record<string, number>; context_window_override: Record<string, number> | null; b_override: Record<string, number> | null }

export interface DagJson {
  schema_version: number; plan_kind: PlanKind;
  description: string; problem: string; approach: string;
  executor: string; executor_model?: ModelTier; executor_effort?: EffortTier;
  phases: string[]; terminal: string | string[];
  assumed_baseline?: string[] | Record<string, unknown>;
  cross_plan_deps?: CrossPlanDep[];
  optimization: OptimizationConfig; providers: Record<string, ProviderConfig>;
  effort_max_tokens: Record<string, number>;
  milestones: Record<string, MilestoneDag>;
  operations: OperationDag[] | Record<string, OperationDag>;
  dispatch_log: DispatchLogEntry[];
}

export interface SnapshotOptimization {
  sentinel_fanout: SentinelFanoutConfig;
  context_window_override: Record<string, number> | null; b_override: Record<string, number> | null;
  b_per_tier: Record<string, number | null>; b_eff_per_tier: Record<string, number | null>;
  context_window_per_tier: Record<string, number>;
}

export interface DagSnapshot {
  snapshot_at: string; snapshot_version: number; plan: string;
  schema_version: number; plan_kind: PlanKind;
  description: string; problem: string; approach: string;
  executor: string; executor_model?: ModelTier; executor_effort?: EffortTier;
  phases: string[]; terminal: string | string[];
  assumed_baseline?: string[] | Record<string, unknown>;
  cross_plan_deps?: CrossPlanDep[];
  optimization: SnapshotOptimization;
  milestones: Record<string, MilestoneSnapshot>;
  operations: OperationSnapshot[];
  pairwise_overlap: PairwiseOverlapMap;
  dispatch_units?: DispatchUnit[];
  open_questions: OpenQuestion[];
}

// ---------------------------------------------------------------------------
// ── DISPATCHUNIT ────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface DispatchUnit {
  id: string; milestones: string[]; operations: string[];
  model: ModelTier | null; effort: EffortTier | null; two_stage: boolean;
  provider: ProviderConfig | null; agent_name: string;
  mcp_servers: Record<string, unknown> | null;
  resolved_max_tokens: number | null; background: true;
  prompt: string | null; context_files: string[];
  si_bytes: number; tokens_estimated: number | null; fits_context_window: boolean;
  sentinel_role: SentinelRole | null;
  dispatch_log_id: string | null; remote_task_id: string | null;
  result: string | null; status: DispatchUnitStatus;
  started_at: string | null; completed_at: string | null; tokens_actual: number | null;
}

// ---------------------------------------------------------------------------
// ── VALIDATION + OPTIMIZER DEPS ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

export interface ValidationError { path: string; message: string; value?: unknown }
export interface ValidationResult { valid: boolean; errors: ValidationError[] }

export interface IOptimizerDeps {
  bPerTier: Record<string, number>;
  contextWindowPerTier: Record<string, number>;
  fileSizes?: (paths: string[]) => Map<string, number>;
  readFiles?: (paths: string[]) => Map<string, string>;
  dispatchLog?: DispatchLogEntry[];
}
