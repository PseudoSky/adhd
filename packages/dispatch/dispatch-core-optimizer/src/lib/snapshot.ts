/**
 * snapshot.ts — computes the fully-derived DagSnapshot from a dag.json document.
 *
 * Ported from docs/plan/dispatch-optimizer/src/compiler.ts §snapshot() (SCOPE.md §N1).
 * PURE computation: no fs/path/node imports anywhere in this module. Every file-size
 * lookup goes through `deps.fileSizes` (batched once per snapshot() call) with graceful
 * degradation to 0 when undefined — see size-tokens.ts.
 *
 * Two deliberate departures from the PoC, both scoped to this milestone (optimizer-core):
 *   1. `snapshot(dag, deps)` takes an IOptimizerDeps second argument. `deps.bPerTier` /
 *      `deps.contextWindowPerTier` are cold-start defaults used whenever the dag's own
 *      `optimization.b_per_tier[tier]` is null or `context_window_per_tier[tier]` is
 *      absent — see resolveBPerTier / resolveContextWindowPerTier below. The RESOLVED
 *      values (not the raw, possibly-null dag values) are what get stored back onto
 *      `snapshot.optimization`, so the snapshot is self-describing for any downstream
 *      reader that doesn't also have `deps` in hand.
 *   2. The PoC computed `validateSnapshot(snap)` and discarded the result (a no-op —
 *      dead code, since the returned ValidationResult was never inspected). This port
 *      calls `assertValidSnapshot(snap)` instead, so a self-inconsistent snapshot throws
 *      instead of silently shipping. See PUBLICATION for how this was verified safe.
 *
 * Neither `snapshot()` nor `topoSortMilestones()` mutates its input.
 */
import type {
  DagJson,
  DagSnapshot,
  EffortTier,
  IOptimizerDeps,
  MilestoneDag,
  MilestoneSnapshot,
  MilestoneStatus,
  OpenQuestion,
  OperationDag,
  OperationSnapshot,
  PairwiseOverlapMap,
  Shape,
  ShapeOpDag,
  ShapeOpSnapshot,
  ShapeSnapshot,
  SnapshotOptimization,
} from '@adhd/dispatch-spec';
import { WRITE_CLASS_ACTIONS, assertValidSnapshot } from '@adhd/dispatch-spec';

import { lookupFileSizes, siBytesAsTokens } from './size-tokens.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Effort-tier ki_estimate heuristic for doc kind (§C3). */
const DOC_KI_BY_EFFORT: Record<string, number> = {
  low: 600,
  medium: 1000,
  high: 2000,
};

/** Write-class actions whose `file` target becomes an artifact. */
const WRITE_ACTIONS: ReadonlySet<string> = WRITE_CLASS_ACTIONS;

// ---------------------------------------------------------------------------
// §C3 — ki_estimate heuristics
// ---------------------------------------------------------------------------

/**
 * Count the number of top-level fields in a JSON Schema object.
 * Used for structured-output ki_estimate = fieldCount × 50.
 */
function countSchemaFields(schema: Record<string, unknown>): number {
  const props =
    (schema['properties'] as Record<string, unknown> | undefined) ?? {};
  return Object.keys(props).length || Object.keys(schema).length;
}

/**
 * Derive a ki_estimate for an operation when op.ki_estimate is null.
 * Source: SCOPE.md §C3.
 */
function deriveKiEstimate(
  op: OperationDag,
  milestoneEffort: EffortTier | null
): number {
  // tool-call operations have zero output tokens by definition (D-03)
  if (op.type === 'tool-call') return 0;

  const shape = op.shape;
  if (!shape || shape.kind === null) return 0;

  const kind = shape.kind;

  // code kinds: ops.length × 200
  if (
    kind === 'function' ||
    kind === 'interface' ||
    kind === 'type' ||
    kind === 'class' ||
    kind === 'enum' ||
    kind === 'const' ||
    kind === 'script'
  ) {
    const ops = 'ops' in shape && Array.isArray(shape.ops) ? shape.ops : [];
    return ops.length * 200;
  }

  // config kinds: ops.length × 100
  if (
    kind === 'config' ||
    kind === 'env' ||
    kind === 'schema' ||
    kind === 'manifest'
  ) {
    const ops = 'ops' in shape && Array.isArray(shape.ops) ? shape.ops : [];
    return ops.length * 100;
  }

  // doc kind: effort-tier heuristic
  if (kind === 'doc') {
    const effort = milestoneEffort ?? 'medium';
    return DOC_KI_BY_EFFORT[effort] ?? 1000;
  }

  // structured-output: schema field count × 50
  if (kind === 'structured-output') {
    const schema = 'schema' in shape && shape.schema ? shape.schema : {};
    return countSchemaFields(schema as Record<string, unknown>) * 50;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Cold-start dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolve b_per_tier: the dag's own authored value wins per-tier; deps.bPerTier
 * (the cold-start default) fills in whenever the dag's value is null or the tier
 * is simply absent from the dag's record. Union of both key sets.
 */
function resolveBPerTier(
  dagB: Record<string, number | null>,
  depsB: Record<string, number>
): Record<string, number | null> {
  const tiers = new Set([...Object.keys(dagB), ...Object.keys(depsB)]);
  const result: Record<string, number | null> = {};
  for (const tier of tiers) {
    const dagValue = dagB[tier];
    result[tier] =
      dagValue !== null && dagValue !== undefined
        ? dagValue
        : (depsB[tier] ?? null);
  }
  return result;
}

/**
 * Resolve context_window_per_tier: the dag's own value wins per-tier; deps.
 * contextWindowPerTier fills in whenever the tier is absent from the dag's record.
 */
function resolveContextWindowPerTier(
  dagW: Record<string, number>,
  depsW: Record<string, number>
): Record<string, number> {
  const tiers = new Set([...Object.keys(dagW), ...Object.keys(depsW)]);
  const result: Record<string, number> = {};
  for (const tier of tiers) {
    const value = dagW[tier] ?? depsW[tier];
    if (value === undefined) {
      throw new TypeError(
        `Model tier "${tier}" not found in dag or deps context_window_per_tier`
      );
    }
    result[tier] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Topological sort with cycle detection
// ---------------------------------------------------------------------------

/**
 * Topologically sort milestone slugs and assign wave numbers.
 * Uses Kahn's algorithm (BFS) for O(V+E).
 *
 * Wave 0: nodes with empty depends_on.
 * Wave N: 1 + max(wave of deps).
 * Ties within a wave are broken by slug (lexicographic) for determinism.
 *
 * @throws {Error} if a cycle is detected, including the cycle path.
 */
export function topoSortMilestones(milestones: Record<string, MilestoneDag>): {
  order: string[];
  waves: Map<string, number>;
} {
  const slugs = Object.keys(milestones);
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const slug of slugs) {
    if (!inDegree.has(slug)) inDegree.set(slug, 0);
    if (!children.has(slug)) children.set(slug, []);
  }

  for (const slug of slugs) {
    const deps = milestones[slug]?.depends_on ?? [];
    for (const dep of deps) {
      const ch = children.get(dep);
      if (ch !== undefined) ch.push(slug);
      inDegree.set(slug, (inDegree.get(slug) ?? 0) + 1);
    }
  }

  const waves = new Map<string, number>();
  const order: string[] = [];

  // Initialize queue with wave-0 nodes, sorted for determinism
  let queue: string[] = slugs
    .filter((s) => (inDegree.get(s) ?? 0) === 0)
    .sort();

  for (const s of queue) {
    waves.set(s, 0);
  }

  while (queue.length > 0) {
    const next: string[] = [];

    for (const slug of queue) {
      order.push(slug);
      const ch = (children.get(slug) ?? []).slice().sort();
      for (const child of ch) {
        const newDegree = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, newDegree);

        // Wave of child = 1 + max(wave of each dep)
        const parentWave = waves.get(slug) ?? 0;
        const currentChildWave = waves.get(child) ?? 0;
        waves.set(child, Math.max(currentChildWave, parentWave + 1));

        if (newDegree === 0) {
          next.push(child);
        }
      }
    }

    queue = next.sort();
  }

  if (order.length !== slugs.length) {
    // Cycle detected — identify which nodes were not visited
    const visited = new Set(order);
    const cycle = slugs.filter((s) => !visited.has(s));
    throw new Error(
      `snapshot(): cycle detected in milestone depends_on graph. ` +
      `Nodes involved: [${cycle.join(', ')}]`
    );
  }

  return { order, waves };
}

// ---------------------------------------------------------------------------
// Dispatch-log scanning helpers
// ---------------------------------------------------------------------------

/**
 * Find dispatch log entries that mention at least one op belonging to the given
 * milestone slug.
 */
function dispatchesForMilestone(
  log: DagJson['dispatch_log'],
  milestoneOps: string[]
): DagJson['dispatch_log'] {
  if (milestoneOps.length === 0) return [];
  const opSet = new Set(milestoneOps);
  return log.filter((entry) =>
    entry.operations.some((opId) => opSet.has(opId))
  );
}

/**
 * Find dispatch log entries that include a specific op id.
 */
function dispatchesForOp(
  log: DagJson['dispatch_log'],
  opId: string
): DagJson['dispatch_log'] {
  return log.filter((entry) => entry.operations.includes(opId));
}

// ---------------------------------------------------------------------------
// Milestone status derivation
// ---------------------------------------------------------------------------

/**
 * Derive milestone status from ops + dispatch_log.
 * Source: SCOPE.md §N1 step 4, PROPOSED_DAG_STRUCTURE.md status derivation rules.
 */
function deriveMilestoneStatus(
  slug: string,
  dag: MilestoneDag,
  milestoneOpIds: string[],
  log: DagJson['dispatch_log'],
  depStatuses: MilestoneStatus[]
): MilestoneStatus {
  const guardOpId = `${slug}.guard`;
  const allOpIds = [...milestoneOpIds, guardOpId];

  // Gather all results across all dispatch entries for this milestone's ops
  const entries = dispatchesForMilestone(log, allOpIds);

  // complete: guard op in dispatch_log has guard_result == "pass"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (result.op_id === guardOpId && result.guard_result === 'pass') {
        return 'complete';
      }
    }
  }

  // failed: any op result for this milestone has status == "failed"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (allOpIds.includes(result.op_id) && result.status === 'failed') {
        return 'failed';
      }
    }
  }

  // in_progress: any op result has status == "in_progress"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (
        allOpIds.includes(result.op_id) &&
        // "in_progress" is not a dispatch_log result status (only complete/failed/skipped)
        // but orchestrators may write it; guard defensively
        (result.status as string) === 'in_progress'
      ) {
        return 'in_progress';
      }
    }
  }

  // pending-surfaced: pending != null AND all deps are complete
  const allDepsComplete =
    depStatuses.length === 0 || depStatuses.every((s) => s === 'complete');

  if (dag.pending !== null && allDepsComplete) {
    return 'pending-surfaced';
  }

  // pending: all other cases
  return 'pending';
}

// ---------------------------------------------------------------------------
// Guard result derivation (per milestone)
// ---------------------------------------------------------------------------

interface GuardInfo {
  guard_result: 'pass' | 'fail' | 'pending';
  guard_output: string | null;
  completed_at: string | null;
}

function deriveGuardResult(
  slug: string,
  log: DagJson['dispatch_log']
): GuardInfo {
  const guardOpId = `${slug}.guard`;

  let latestGuardResult: 'pass' | 'fail' | null = null;
  let latestGuardOutput: string | null = null;
  let completedAt: string | null = null;

  for (const entry of log) {
    if (!entry.operations.includes(guardOpId)) continue;
    for (const result of entry.results) {
      if (result.op_id !== guardOpId) continue;
      if (result.guard_result !== null) {
        latestGuardResult = result.guard_result;
        latestGuardOutput = result.guard_output;
        if (result.guard_result === 'pass') {
          completedAt = result.guard_ran_at;
        }
      }
    }
  }

  if (latestGuardResult !== null) {
    return {
      guard_result: latestGuardResult,
      guard_output: latestGuardOutput,
      completed_at: completedAt,
    };
  }

  return { guard_result: 'pending', guard_output: null, completed_at: null };
}

// ---------------------------------------------------------------------------
// Artifact derivation
// ---------------------------------------------------------------------------

/**
 * Derive the artifact file list for a milestone: union of op.file for write-class
 * actions plus op.to_file for "move" actions.
 */
function deriveArtifacts(ops: OperationDag[]): string[] {
  const set = new Set<string>();
  for (const op of ops) {
    if (op.action === 'move' && op.to_file) {
      set.add(op.to_file);
    } else if (WRITE_ACTIONS.has(op.action) && op.file) {
      set.add(op.file);
    }
  }
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Operation snapshot derivation
// ---------------------------------------------------------------------------

/**
 * Enrich an authored OperationDag into an OperationSnapshot with derived fields.
 */
function buildOperationSnapshot(
  op: OperationDag,
  milestoneEffort: EffortTier | null,
  log: DagJson['dispatch_log']
): OperationSnapshot {
  const dispatches = dispatchesForOp(log, op.id);
  const dispatch_ids = dispatches.map((d) => d.id);

  // guard_result: latest non-null guard result for this op
  let guard_result: 'pass' | 'fail' | null = null;
  let guard_output: string | null = null;
  let guard_ran_at: string | null = null;

  for (const entry of dispatches) {
    for (const result of entry.results) {
      if (result.op_id === op.id && result.guard_result !== null) {
        guard_result = result.guard_result;
        guard_output = result.guard_output;
        guard_ran_at = result.guard_ran_at;
      }
    }
  }

  // ki_estimate: use authored value if present; apply heuristic otherwise
  const ki_estimate =
    op.ki_estimate !== null && op.ki_estimate !== undefined
      ? op.ki_estimate
      : deriveKiEstimate(op, milestoneEffort);

  // Enrich shape ops with derived stub fields
  const enrichedShape = enrichShape(op.shape);

  return {
    ...op,
    ki_estimate,
    shape: enrichedShape,
    dispatch_ids,
    // TODO: stubbed as 0 — op-level attempt_count requires per-op dispatch log scan
    attempt_count: 0,
    guard_result,
    guard_output,
    guard_ran_at,
    // TODO: stubbed — requires gitnexus_impact MCP call (future work)
    blast_radius: [],
    // TODO: stubbed — requires same-wave op-key collision scan (future work)
    conflict: {
      detected: false,
      competing_op: null,
      op_key: null,
      resolution: null,
    },
    // TODO: stubbed — requires ki_estimate share prorating across dispatch totals
    tokens_actual: null,
  };
}

/**
 * Enrich a Shape by adding derived stub fields to shape ops.
 */
function enrichShape(shape: Shape | null | undefined): ShapeSnapshot | null {
  if (!shape) return null;
  if (shape.kind === null) return shape as ShapeSnapshot;

  const kind = shape.kind;

  if (
    kind === 'function' ||
    kind === 'interface' ||
    kind === 'type' ||
    kind === 'class' ||
    kind === 'enum' ||
    kind === 'const' ||
    kind === 'script' ||
    kind === 'config' ||
    kind === 'env' ||
    kind === 'schema' ||
    kind === 'manifest'
  ) {
    const ops: ShapeOpSnapshot[] = (
      'ops' in shape && Array.isArray(shape.ops) ? shape.ops : []
    ).map((sop: ShapeOpDag) => ({
      ...sop,
      // TODO: from/breaking/severity require AST read + gitnexus (future work)
      from: null,
      breaking: null,
      severity: null,
    }));
    return { ...(shape as object), ops } as ShapeSnapshot;
  }

  // doc and structured-output have no ops to enrich
  return shape as ShapeSnapshot;
}

// ---------------------------------------------------------------------------
// Synthesized guard operation
// ---------------------------------------------------------------------------

/**
 * Synthesize a guard op for a milestone: id = "<slug>.guard", depends on all
 * other authored ops in the milestone. Required by PROPOSED_DAG_STRUCTURE.md.
 */
function synthesizeGuardOp(
  slug: string,
  dag: MilestoneDag,
  milestoneOpIds: string[],
  log: DagJson['dispatch_log']
): OperationSnapshot {
  const guardId = `${slug}.guard`;
  const dispatches = dispatchesForOp(log, guardId);
  const dispatch_ids = dispatches.map((d) => d.id);

  let guard_result: 'pass' | 'fail' | null = null;
  let guard_output: string | null = null;
  let guard_ran_at: string | null = null;

  for (const entry of dispatches) {
    for (const result of entry.results) {
      if (result.op_id === guardId && result.guard_result !== null) {
        guard_result = result.guard_result;
        guard_output = result.guard_output;
        guard_ran_at = result.guard_ran_at;
      }
    }
  }

  return {
    id: guardId,
    milestone: slug,
    depends_on: milestoneOpIds,
    type: 'tool-call',
    action: 'guard',
    file: null,
    symbol: null,
    provenance: null,
    confidence: null,
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: dag.guard ?? null,
    to_file: null,
    to_symbol: null,
    ki_estimate: 0,
    ki_source: null,
    authored_by: 'synthesized',
    status: 'pending',
    shape: null,
    dispatch_ids,
    attempt_count: 0,
    guard_result,
    guard_output,
    guard_ran_at,
    blast_radius: [],
    conflict: {
      detected: false,
      competing_op: null,
      op_key: null,
      resolution: null,
    },
    tokens_actual: null,
  };
}

// ---------------------------------------------------------------------------
// b_eff_per_tier computation
// ---------------------------------------------------------------------------

/**
 * Compute effective base cost per tier under prompt caching.
 * b_eff = b × ((1 − p) × w + p × r)
 * Source: SCOPE.md §A1.
 */
function computeBEff(
  bPerTier: Record<string, number | null>,
  sentinelConfig: {
    enabled: boolean;
    write_multiplier: number;
    read_multiplier: number;
    hit_probability: number;
  }
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const {
    write_multiplier: w,
    read_multiplier: r,
    hit_probability: p,
  } = sentinelConfig;

  for (const [tier, b] of Object.entries(bPerTier)) {
    if (b === null) {
      result[tier] = null;
    } else {
      result[tier] = Math.round(b * ((1 - p) * w + p * r));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// pairwise_overlap computation
// ---------------------------------------------------------------------------

/**
 * Build the pairwise overlap map across all milestone pairs.
 * Source: SCOPE.md §C2, DECISIONS.md D-09.
 *
 * Key format: "${slugA}:${slugB}" where slugA < slugB alphabetically.
 *
 * For each pair:
 *   - Prospective: files in intersection of op.file targets; bytes = sizeOf(f) if exists else 0.
 *   - Actual: after both complete, size the intersection of artifacts.
 */
function buildPairwiseOverlap(
  milestoneOps: Map<string, OperationDag[]>,
  milestoneStatuses: Map<string, MilestoneStatus>,
  sizeOf: (filePath: string) => number
): PairwiseOverlapMap {
  const slugs = Array.from(milestoneOps.keys());
  const result: PairwiseOverlapMap = {};

  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const slugA = slugs[i];
      const slugB = slugs[j];
      if (slugA === undefined || slugB === undefined) continue;

      // Stable key: lower slug alphabetically comes first
      const [keyA, keyB] = slugA < slugB ? [slugA, slugB] : [slugB, slugA];
      const key = `${keyA}:${keyB}`;

      const opsA = milestoneOps.get(slugA) ?? [];
      const opsB = milestoneOps.get(slugB) ?? [];

      const filesA = new Set(
        opsA.map((op) => op.file).filter((f): f is string => f !== null)
      );
      const filesB = new Set(
        opsB.map((op) => op.file).filter((f): f is string => f !== null)
      );

      const intersection = Array.from(filesA).filter((f) => filesB.has(f));

      if (intersection.length === 0) continue;

      const statusA = milestoneStatuses.get(slugA) ?? 'pending';
      const statusB = milestoneStatuses.get(slugB) ?? 'pending';
      const bothComplete = statusA === 'complete' && statusB === 'complete';

      let bytes = 0;
      for (const f of intersection) {
        bytes += bothComplete ? sizeOf(f) : 0;
      }

      result[key] = bytes;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Normalize operations from dag (array or Record)
// ---------------------------------------------------------------------------

function normalizeOperations(raw: DagJson['operations']): OperationDag[] {
  const ops: OperationDag[] = Array.isArray(raw) ? raw : Object.values(raw);
  // Back-compat: dags authored before the `type` field was introduced default
  // to "generative". A missing `type` treated as "tool-call" would silently
  // produce null prompts for every milestone (the bug this fixes).
  return ops.map((op) =>
    op.type === undefined ? { ...op, type: 'generative' as const } : op
  );
}

// ---------------------------------------------------------------------------
// snapshot()
// ---------------------------------------------------------------------------

/**
 * Compute the fully-derived DagSnapshot from a dag.json document.
 *
 * Computation order (per SCOPE.md §N1):
 *   1. Copy dag-level fields verbatim; resolve b_per_tier / context_window_per_tier
 *      cold-start defaults from deps.
 *   2. Compute b_eff_per_tier.
 *   3. Topological sort → assign wave numbers.
 *   4. Per-milestone derived fields.
 *   5. Per-operation derived fields.
 *   6. pairwise_overlap.
 *   7. open_questions.
 *
 * Does not mutate the input dag.
 *
 * @throws {Error} if a dependency cycle is detected, or if the computed snapshot
 *   fails structural validation (assertValidSnapshot).
 */
export function snapshot(dag: DagJson, deps: IOptimizerDeps): DagSnapshot {
  const now = new Date().toISOString();

  // deps.dispatchLog, when provided, represents fresher in-memory dispatch results
  // that haven't been flushed back into dag.dispatch_log yet.
  const dispatchLog = deps.dispatchLog ?? dag.dispatch_log;

  // Step 1 — Copy dag-level fields; resolve cold-start defaults
  const sentinelFanout = dag.optimization.sentinel_fanout;
  const bPerTier = resolveBPerTier(dag.optimization.b_per_tier, deps.bPerTier);
  const contextWindowPerTier = resolveContextWindowPerTier(
    dag.optimization.context_window_per_tier,
    deps.contextWindowPerTier
  );

  // Step 2 — Compute b_eff_per_tier (from the RESOLVED bPerTier, so cold-start
  // defaults actually participate in the cost model instead of being dead weight)
  const bEff = computeBEff(bPerTier, sentinelFanout);

  // Step 3 — Topological sort
  const { waves } = topoSortMilestones(dag.milestones);

  // Normalize operations
  const opsArray = normalizeOperations(dag.operations);

  // Group operations by milestone
  const opsByMilestone = new Map<string, OperationDag[]>();
  for (const op of opsArray) {
    const list = opsByMilestone.get(op.milestone) ?? [];
    list.push(op);
    opsByMilestone.set(op.milestone, list);
  }

  // Batch-collect every file path that might need sizing (artifacts + pairwise-
  // overlap candidates are both drawn from op.file / op.to_file) and resolve them
  // in a single deps.fileSizes call.
  const filePaths = new Set<string>();
  for (const op of opsArray) {
    if (op.file) filePaths.add(op.file);
    if (op.action === 'move' && op.to_file) filePaths.add(op.to_file);
  }
  const fileSizeMap = lookupFileSizes(Array.from(filePaths), deps);
  const sizeOf = (f: string): number => fileSizeMap.get(f) ?? 0;

  // Step 4 — Per-milestone derived fields (two passes: statuses first, full snapshot second)

  // Pass 4a: compute statuses (needed for overlap + questions)
  const milestoneStatuses = new Map<string, MilestoneStatus>();

  // Process in topological order so parent statuses are available for children
  const topoSlugs = Array.from(waves.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([slug]) => slug);

  for (const slug of topoSlugs) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined) continue;

    const milestoneOpIds = (opsByMilestone.get(slug) ?? []).map((op) => op.id);

    const depStatuses = dagM.depends_on.map(
      (dep) => milestoneStatuses.get(dep) ?? 'pending'
    );

    const status = deriveMilestoneStatus(
      slug,
      dagM,
      milestoneOpIds,
      dispatchLog,
      depStatuses
    );
    milestoneStatuses.set(slug, status);
  }

  // Pass 4b: build full MilestoneSnapshot objects
  const milestones: Record<string, MilestoneSnapshot> = {};
  const allOpsSnapshot: OperationSnapshot[] = [];

  for (const slug of topoSlugs) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined) continue;

    const wave = waves.get(slug) ?? 0;
    const milestoneOps = opsByMilestone.get(slug) ?? [];
    const milestoneOpIds = milestoneOps.map((op) => op.id);

    const status = milestoneStatuses.get(slug) ?? 'pending';

    // D-07: eligible = pending==null AND all deps complete AND no dep failed
    const depStatuses = dagM.depends_on.map(
      (dep) => milestoneStatuses.get(dep) ?? 'pending'
    );
    const allDepsComplete =
      dagM.depends_on.length === 0 ||
      depStatuses.every((s) => s === 'complete');
    const noDepFailed = depStatuses.every((s) => s !== 'failed');
    const eligible = dagM.pending === null && allDepsComplete && noDepFailed;

    // started_at: min started_at across all dispatch log entries for this milestone
    const relatedDispatches = dispatchesForMilestone(dispatchLog, [
      ...milestoneOpIds,
      `${slug}.guard`,
    ]);
    const started_at =
      relatedDispatches.length > 0
        ? (relatedDispatches.map((d) => d.started_at).sort()[0] ?? null)
        : null;

    // guard_result / guard_output / completed_at
    let guardResult: 'pass' | 'fail' | 'pending' | null;
    let guardOutput: string | null;
    let completedAt: string | null;

    if (dagM.guard) {
      const gi = deriveGuardResult(slug, dispatchLog);
      guardResult = gi.guard_result;
      guardOutput = gi.guard_output;
      completedAt = gi.completed_at;
    } else {
      guardResult = null;
      guardOutput = null;
      completedAt = null;
    }

    // artifacts
    const artifacts = deriveArtifacts(milestoneOps);

    // si_bytes: sum sizes of artifacts
    const si_bytes = artifacts.reduce((acc, f) => acc + sizeOf(f), 0);

    // ki_estimate per op
    const enrichedOps: OperationSnapshot[] = milestoneOps.map((op) =>
      buildOperationSnapshot(op, dagM.effort, dispatchLog)
    );

    // ki_estimate for milestone: sum enriched ki_estimates
    let ki_estimate: number | null = null;
    let kiSum = 0;
    let anyNullKi = false;
    for (const op of enrichedOps) {
      if (op.ki_estimate === null) {
        anyNullKi = true;
        break;
      }
      kiSum += op.ki_estimate;
    }
    if (!anyNullKi) ki_estimate = kiSum;

    // tokens_estimated: b_eff_per_tier[model] + si_bytes_as_tokens + ki_estimate
    let tokens_estimated: number | null = null;
    const model = dagM.model;
    if (model !== null && ki_estimate !== null) {
      const bEffForModel = bEff[model] ?? null;
      if (bEffForModel !== null) {
        const siTokens = siBytesAsTokens(si_bytes);
        tokens_estimated = bEffForModel + siTokens + ki_estimate;
      }
    }

    // tokens_actual: sum turn tokens from completed dispatches for this milestone
    let tokens_actual: number | null = null;
    const completedDispatches = relatedDispatches.filter(
      (d) =>
        d.completed_at !== null &&
        d.results.length > 0 &&
        d.results.every(
          (r) => r.status === 'complete' || r.status === 'skipped'
        )
    );
    if (completedDispatches.length > 0) {
      tokens_actual = completedDispatches.reduce((sum, d) => {
        return (
          sum +
          d.turns.reduce((ts, t) => ts + t.input_tokens + t.output_tokens, 0)
        );
      }, 0);
    }

    // Synthesize guard op
    const guardOp = synthesizeGuardOp(
      slug,
      dagM,
      milestoneOpIds,
      dispatchLog
    );
    allOpsSnapshot.push(...enrichedOps, guardOp);

    // Build the milestone snapshot — use conditional spreads for optional fields
    // (required by exactOptionalPropertyTypes)
    milestones[slug] = {
      description: dagM.description,
      ...(dagM.rationale !== undefined ? { rationale: dagM.rationale } : {}),
      authored_by: dagM.authored_by,
      pending: dagM.pending,
      triggered_by: dagM.triggered_by,
      phase: dagM.phase,
      depends_on: dagM.depends_on,
      agent: dagM.agent,
      model: dagM.model,
      effort: dagM.effort,
      two_stage: dagM.two_stage,
      read_only: dagM.read_only,
      guard: dagM.guard,
      context: `contexts/${slug}.md`,
      wave,
      eligible,
      status,
      started_at,
      completed_at: completedAt,
      guard_result: guardResult,
      guard_output: guardOutput,
      artifacts,
      si_bytes,
      ki_estimate,
      tokens_estimated,
      tokens_actual,
    };
  }

  // Step 6 — pairwise_overlap
  const pairwiseOverlap = buildPairwiseOverlap(
    opsByMilestone,
    milestoneStatuses,
    sizeOf
  );

  // Step 7 — open_questions
  const open_questions = buildOpenQuestions(dag, milestones);

  // Build optimization block for snapshot — RESOLVED values (cold-start defaults
  // applied), so the snapshot is self-describing without needing deps again.
  const tokens_naive: number = (() => {
    let total = 0;
    for (const m of Object.values(milestones)) {
      if (m.eligible && m.status === 'pending' && m.model !== null) {
        const b = bPerTier[m.model] ?? deps.bPerTier[m.model] ?? 0;
        total += b + (m.ki_estimate ?? 0);
      }
    }
    return total;
  })();
  const optimization: SnapshotOptimization = {
    tokens_naive,
    sentinel_fanout: sentinelFanout,
    context_window_override: dag.optimization.context_window_override,
    b_override: dag.optimization.b_override,
    b_per_tier: bPerTier,
    b_eff_per_tier: bEff,
    context_window_per_tier: contextWindowPerTier,
  };

  // Use conditional spreads for optional top-level fields (exactOptionalPropertyTypes)
  const snap: DagSnapshot = {
    snapshot_at: now,
    snapshot_version: 1, // callers may increment if persisting
    plan: '', // caller sets this from directory name
    schema_version: dag.schema_version,
    plan_kind: dag.plan_kind,
    description: dag.description,
    problem: dag.problem,
    approach: dag.approach,
    executor: dag.executor,
    ...(dag.executor_model !== undefined
      ? { executor_model: dag.executor_model }
      : {}),
    ...(dag.executor_effort !== undefined
      ? { executor_effort: dag.executor_effort }
      : {}),
    phases: [...dag.phases],
    terminal: dag.terminal,
    ...(dag.assumed_baseline !== undefined
      ? { assumed_baseline: dag.assumed_baseline }
      : {}),
    optimization,
    milestones,
    operations: allOpsSnapshot,
    pairwise_overlap: pairwiseOverlap,
    open_questions,
  };

  assertValidSnapshot(snap);
  return snap;
}

// ---------------------------------------------------------------------------
// open_questions builder
// ---------------------------------------------------------------------------

function buildOpenQuestions(
  dag: DagJson,
  milestones: Record<string, MilestoneSnapshot>
): OpenQuestion[] {
  const questions: OpenQuestion[] = [];

  for (const [slug, m] of Object.entries(milestones)) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined || dagM.pending === null) continue;

    const surfaced = m.status === 'pending-surfaced';

    questions.push({
      id: `q:${slug}`,
      text: dagM.pending,
      blocking: slug,
      surfaced,
      // TODO: scan dispatch_log notes for the turn/dispatch where question appeared
      raised_at_dispatch: null,
      raised_at_turn: null,
      answered: false,
      answer: null,
    });
  }

  return questions;
}
