/**
 * optimize.ts — greedy dispatch-unit packer (milestone optimizer-core).
 *
 * GREEDY PACKER ONLY, per docs/plan/dispatch-production/dag.json milestones
 * ["optimizer-core"]:
 *   1. Partition eligible milestones by shape.kind family AND model tier — never
 *      mixed in one DispatchUnit.
 *   2. Within each partition, sort by ki_estimate ascending.
 *   3. Fill each unit until the tier's effective context window W is reached
 *      ("next-fit" packing — see greedyFillPartition).
 *   4. Hard-reject any unit (including a lone milestone) whose own tokens_estimated
 *      exceeds W: excluded from the returned array entirely — "hard-reject" reads
 *      literally here, so optimize() never emits a unit that violates the window,
 *      not even flagged via fits_context_window: false (see greedyFillPartition below).
 *   5. computeTokensNaive() — the Σ(B + ki_estimate) "no packing, no caching"
 *      comparison baseline (SCOPE.md §F4), exposed as a named export rather than
 *      written onto snapshot.optimization (see computeTokensNaive below for why:
 *      SnapshotOptimization has no field for it).
 *
 * The 4-algorithm cascade (Bitmask DP / Tree DP / Simulated Annealing / HLFET)
 * from the PoC is explicitly OUT OF SCOPE — deferred to milestone
 * optimizer-algorithms. Sentinel-Fanout role assignment is likewise deferred
 * (not named anywhere in optimizer-core.2's shape.ops).
 *
 * PURE computation: no fs/path/node imports. File sizes flow through
 * deps.fileSizes (batched once per optimize() call) with graceful degradation
 * to 0 when undefined — see size-tokens.ts.
 */
import type {
  DagSnapshot,
  DispatchUnit,
  IOptimizerDeps,
  KindFamily,
  ModelTier,
  OperationSnapshot,
} from '@adhd/dispatch-base-spec';

import { lookupFileSizes, siBytesAsTokens } from './size-tokens.js';

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Milestones this optimizer will consider for packing: topologically eligible
 * (D-07: pending == null, all deps complete, no dep failed) AND not already
 * dispatched.
 *
 * The `status === 'pending'` half is deliberately stricter than the PoC's own
 * `eligible === true` filter. D-07 defines `eligible` purely from a milestone's
 * OWN `pending` field and its UPSTREAM deps' statuses — it says nothing about
 * the milestone's own status. That means a milestone that has already gone
 * `complete` can still read `eligible: true` (nothing flips it back to false).
 * SCOPE.md's own Open Decision #4 says optimize() "must be called again after
 * each dispatch closes (re-eligibility)" — i.e. repeated calls are the intended
 * operating pattern. Without this extra filter, a second call would re-pack and
 * re-dispatch already-completed milestones forever.
 *
 * This also has the convenient side effect of making precedence-aware packing
 * unnecessary: if X depends on Y, X can only be eligible once Y is `complete`
 * — and a `complete` Y is excluded by this same filter. So two milestones with
 * a direct dependency edge can never both appear in the candidate set at once,
 * and greedyFillPartition doesn't need an enforcePrecedenceConstraint pass.
 */
function selectPackableMilestones(snapshot: DagSnapshot): string[] {
  return Object.keys(snapshot.milestones).filter((slug) => {
    const m = snapshot.milestones[slug];
    return m !== undefined && m.eligible === true && m.status === 'pending';
  });
}

// ---------------------------------------------------------------------------
// Kind family classification
// ---------------------------------------------------------------------------

/**
 * Determine the KindFamily for a milestone by examining its operations.
 * Source: SCOPE.md §N2 step 2.
 */
function getMilestoneKindFamily(milestoneOps: OperationSnapshot[]): KindFamily {
  if (milestoneOps.length === 0) return 'tool-call';

  // guard-only milestones (all ops are tool-call)
  if (milestoneOps.every((op) => op.type === 'tool-call')) {
    return 'tool-call';
  }

  // Find first generative op with a shape.kind
  for (const op of milestoneOps) {
    if (op.type !== 'generative' || !op.shape || op.shape.kind === null)
      continue;
    const kind = op.shape.kind;
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
      return 'code-config';
    }
    if (kind === 'doc') return 'doc';
    if (kind === 'structured-output') return 'structured';
  }

  // Default: code-config (most common)
  return 'code-config';
}

// ---------------------------------------------------------------------------
// Resolve agent name (strip namespace prefix)
// ---------------------------------------------------------------------------

/**
 * Strip namespace prefix from agent slug.
 * "workflow:workflow-researcher" → "workflow-researcher"
 * "plan-orchestrator" → "plan-orchestrator"
 */
function resolveAgentName(agentSlug: string | null): string {
  if (!agentSlug) return '';
  const colonIdx = agentSlug.indexOf(':');
  return colonIdx >= 0 ? agentSlug.slice(colonIdx + 1) : agentSlug;
}

// ---------------------------------------------------------------------------
// Compile prompt
// ---------------------------------------------------------------------------

/**
 * Compile a structured prompt for a dispatch unit.
 *
 * Returns null if all ops in the unit are type: "tool-call" (no model call needed).
 * Source: SCOPE.md §N2 step 6.
 */
function compilePrompt(
  packedSlugs: string[],
  milestones: DagSnapshot['milestones'],
  opsSnapshot: OperationSnapshot[]
): string | null {
  let allToolCall = true;
  const parts: string[] = [];

  for (const slug of packedSlugs) {
    const m = milestones[slug];
    if (m === undefined) continue;

    const milestoneOps = opsSnapshot.filter(
      (op) => op.milestone === slug && op.action !== 'guard'
    );

    if (milestoneOps.some((op) => op.type === 'generative')) {
      allToolCall = false;
    }

    parts.push(`## Milestone: ${slug}`);
    parts.push(m.description);
    if (m.rationale) parts.push(`\n*Rationale:* ${m.rationale}`);

    parts.push('\n### Operations:');
    for (const op of milestoneOps) {
      const filePart = op.file ? ` ${op.file}` : '';
      const symbolPart = op.symbol ? ` (${op.symbol})` : '';
      parts.push(`- [${op.id}] ${op.action}${filePart}${symbolPart}`);

      if (op.shape && op.shape.kind !== null) {
        const shape = op.shape;

        if (shape.kind === 'doc') {
          parts.push(`  Description: ${shape.description}`);
          parts.push(`  Objective: ${shape.objective}`);
          if (shape.required_sections && shape.required_sections.length > 0) {
            parts.push(
              `  Required sections: ${shape.required_sections.join(', ')}`
            );
          }
        } else if (shape.kind === 'structured-output') {
          parts.push(
            '  Schema:\n' +
            JSON.stringify(shape.schema, null, 2)
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n')
          );
        } else if ('ops' in shape && Array.isArray(shape.ops)) {
          for (const sop of shape.ops) {
            const toStr = sop.to !== null ? ` → ${sop.to}` : '';
            const targetStr = sop.target !== null ? ` "${sop.target}"` : '';
            parts.push(`    - ${sop.op}${targetStr}${toStr}`);
          }
        }
      }
    }

    const guard = m.guard;
    parts.push(`\n### Guard: ${guard ?? 'none'}`);
    parts.push('');
  }

  if (allToolCall) return null;
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// B / W resolution (per model tier, with deps fallback beyond the snapshot)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective base cost for a model tier: b_eff_per_tier wins, then
 * raw b_per_tier, then deps.bPerTier (in case optimize() is ever called with a
 * snapshot that wasn't built with these same deps). Null (not 0) when truly
 * unresolvable — a null model, or a tier absent everywhere — so callers can
 * tell "known zero cost" apart from "unknown cost" (mirrors assembleDispatchUnit
 * in the PoC, which treats a null model as "cannot compute tokens_estimated").
 */
function resolveB(
  model: ModelTier | null,
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): number | null {
  if (model === null) return null;
  const bEff = snapshot.optimization.b_eff_per_tier[model];
  if (bEff !== null && bEff !== undefined) return bEff;
  const bRaw = snapshot.optimization.b_per_tier[model];
  if (bRaw !== null && bRaw !== undefined) return bRaw;
  const bDeps = deps.bPerTier[model];
  return bDeps !== undefined ? bDeps : null;
}

/**
 * Resolve the effective context window for a model tier: snapshot wins, then
 * deps.contextWindowPerTier, then +Infinity (no known constraint — never
 * reject on a genuinely unresolvable window; mirrors the PoC's `?? Infinity`).
 */
function resolveContextWindow(
  model: ModelTier | null,
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): number {
  if (model === null) return Number.POSITIVE_INFINITY;
  const w = snapshot.optimization.context_window_per_tier[model];
  if (w !== undefined) return w;
  const wDeps = deps.contextWindowPerTier[model];
  return wDeps !== undefined ? wDeps : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Packing context — bundles the read-only inputs every helper below needs
// ---------------------------------------------------------------------------

interface PackContext {
  snapshot: DagSnapshot;
  deps: IOptimizerDeps;
  sizeMap: Map<string, number>;
  opsByMilestone: Map<string, OperationSnapshot[]>;
}

/** context_files for a batch: milestone context path + read_only[] + op.file, unioned. */
function collectContextFiles(packedSlugs: string[], ctx: PackContext): string[] {
  const set = new Set<string>();
  for (const slug of packedSlugs) {
    const m = ctx.snapshot.milestones[slug];
    if (m === undefined) continue;
    set.add(m.context);
    for (const f of m.read_only) set.add(f);
    for (const op of ctx.opsByMilestone.get(slug) ?? []) {
      if (op.file) set.add(op.file);
    }
  }
  return Array.from(set);
}

/** tokens_estimated for a candidate batch under a resolved model tier. */
function computeBatchTokensEstimated(
  packedSlugs: string[],
  model: ModelTier | null,
  ctx: PackContext
): number | null {
  const bEff = resolveB(model, ctx.snapshot, ctx.deps);
  if (bEff === null) return null;

  const contextFiles = collectContextFiles(packedSlugs, ctx);
  const siBytes = contextFiles.reduce(
    (acc, f) => acc + (ctx.sizeMap.get(f) ?? 0),
    0
  );
  const siTokens = siBytesAsTokens(siBytes);
  const kiSum = packedSlugs.reduce(
    (acc, slug) => acc + (ctx.snapshot.milestones[slug]?.ki_estimate ?? 0),
    0
  );

  return bEff + siTokens + kiSum;
}

// ---------------------------------------------------------------------------
// Greedy fill (next-fit): sort ki_estimate ascending, fill until W, open next
// ---------------------------------------------------------------------------

/**
 * Greedily pack one partition's milestones into batches.
 *
 * "next-fit" bin packing: walk milestones in ki_estimate-ascending order,
 * keep appending to the currently-open batch while it still fits under W;
 * the moment appending would exceed W, close the current batch and open a
 * new one starting with the milestone that didn't fit.
 *
 * Hard window constraint: after the walk, any resulting batch (including a
 * lone milestone) whose own tokens_estimated still exceeds W is dropped from
 * the result — see the module docstring for why this rejects rather than
 * flags. A null tokens_estimated (B unresolvable for this tier) is treated
 * as "fits" — consistent with fits_context_window's own null-handling
 * convention in the PoC (assembleDispatchUnit: `tokens_estimated !== null ?
 * tokens_estimated <= contextWindow : true`).
 */
function greedyFillPartition(
  partSlugs: string[],
  model: ModelTier | null,
  ctx: PackContext
): string[][] {
  const W = resolveContextWindow(model, ctx.snapshot, ctx.deps);

  const sorted = [...partSlugs].sort((a, b) => {
    const ka = ctx.snapshot.milestones[a]?.ki_estimate ?? 0;
    const kb = ctx.snapshot.milestones[b]?.ki_estimate ?? 0;
    return ka - kb || a.localeCompare(b);
  });

  const batches: string[][] = [];
  let current: string[] = [];

  for (const slug of sorted) {
    const candidate = [...current, slug];
    const tokens = computeBatchTokensEstimated(candidate, model, ctx);
    const overflows = tokens !== null && tokens > W;

    if (overflows && current.length > 0) {
      batches.push(current);
      current = [slug];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);

  // Hard-reject: a batch (possibly a lone milestone) that still doesn't fit
  // on its own is excluded entirely rather than emitted as a violation.
  return batches.filter((batch) => {
    const tokens = computeBatchTokensEstimated(batch, model, ctx);
    return tokens === null || tokens <= W;
  });
}

// ---------------------------------------------------------------------------
// Assemble DispatchUnit
// ---------------------------------------------------------------------------

/**
 * Build a single DispatchUnit from a batch of packed milestone slugs.
 * Source: SCOPE.md §N2 step 6 (assembleDispatchUnit in the PoC).
 *
 * `provider` and `resolved_max_tokens` are always null here: both require
 * dag.providers / dag.effort_max_tokens, which live on DagJson — not on
 * DagSnapshot or IOptimizerDeps, neither of which optimize() can see past.
 * Both fields are nullable on DispatchUnit specifically to support staged
 * resolution; orchestrator-core (milestone, depends_on: optimizer-core) is
 * the first component downstream that holds the full DagJson and can fill
 * them in.
 *
 * `sentinel_role` is likewise always null — Sentinel-Fanout role assignment
 * isn't named in optimizer-core.2's shape.ops and is left for a later pass.
 */
function assembleUnit(
  packedSlugs: string[],
  unitIndex: number,
  model: ModelTier | null,
  ctx: PackContext
): DispatchUnit {
  const primarySlug = packedSlugs[0] ?? '';
  const primaryM = ctx.snapshot.milestones[primarySlug];
  const effort = primaryM?.effort ?? null;

  const operationIds: string[] = [];
  for (const slug of packedSlugs) {
    for (const op of ctx.opsByMilestone.get(slug) ?? []) {
      operationIds.push(op.id);
    }
  }

  const context_files = collectContextFiles(packedSlugs, ctx);
  const si_bytes = context_files.reduce(
    (acc, f) => acc + (ctx.sizeMap.get(f) ?? 0),
    0
  );

  const bEff = resolveB(model, ctx.snapshot, ctx.deps);
  const kiSum = packedSlugs.reduce(
    (acc, slug) => acc + (ctx.snapshot.milestones[slug]?.ki_estimate ?? 0),
    0
  );
  const tokens_estimated =
    bEff !== null ? bEff + siBytesAsTokens(si_bytes) + kiSum : null;

  const W = resolveContextWindow(model, ctx.snapshot, ctx.deps);
  const fits_context_window =
    tokens_estimated !== null ? tokens_estimated <= W : true;

  const agent_name = resolveAgentName(primaryM?.agent ?? null);
  const prompt = compilePrompt(packedSlugs, ctx.snapshot.milestones, ctx.snapshot.operations);

  return {
    id: `${primarySlug}.dispatch.${unitIndex}`,
    milestones: packedSlugs,
    operations: operationIds,
    model,
    effort,
    two_stage: primaryM?.two_stage ?? false,
    provider: null,
    agent_name,
    mcp_servers: null,
    resolved_max_tokens: null,
    background: true,
    prompt,
    context_files,
    si_bytes,
    tokens_estimated,
    fits_context_window,
    sentinel_role: null,
    dispatch_log_id: null,
    remote_task_id: null,
    result: null,
    status: 'pending',
    started_at: null,
    completed_at: null,
    tokens_actual: null,
  };
}

// ---------------------------------------------------------------------------
// optimize()
// ---------------------------------------------------------------------------

/**
 * Compute the greedy dispatch plan for the current scheduling cycle.
 *
 * Input: DagSnapshot — fully computed from snapshot().
 * Output: DispatchUnit[] — one unit per batch assignment. Never mixes
 *   shape.kind families or model tiers within one unit. Never contains a
 *   unit whose tokens_estimated exceeds the tier's context window.
 *
 * Does not mutate the input snapshot.
 */
export function optimize(
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): DispatchUnit[] {
  const packableSlugs = selectPackableMilestones(snapshot);
  if (packableSlugs.length === 0) return [];

  // Build op index (exclude synthesized guard ops), reused by every helper below.
  const opsByMilestone = new Map<string, OperationSnapshot[]>();
  for (const op of snapshot.operations) {
    if (op.action === 'guard') continue;
    const list = opsByMilestone.get(op.milestone) ?? [];
    list.push(op);
    opsByMilestone.set(op.milestone, list);
  }

  // Partition by "family:model" — never mixed within one unit (D-11 equivalent).
  const partitions = new Map<string, string[]>();
  for (const slug of packableSlugs) {
    const m = snapshot.milestones[slug];
    if (m === undefined) continue;
    const family = getMilestoneKindFamily(opsByMilestone.get(slug) ?? []);
    const modelKey = m.model ?? '_null';
    const partKey = `${family}:${modelKey}`;
    const list = partitions.get(partKey) ?? [];
    list.push(slug);
    partitions.set(partKey, list);
  }

  // Batch-resolve file sizes for every context file across every candidate
  // milestone in a single deps.fileSizes call (context path + read_only[] +
  // op.file — a superset of what snapshot() already sized, since context/
  // read_only paths aren't "artifacts").
  const filePaths = new Set<string>();
  for (const slug of packableSlugs) {
    const m = snapshot.milestones[slug];
    if (m === undefined) continue;
    filePaths.add(m.context);
    for (const f of m.read_only) filePaths.add(f);
    for (const op of opsByMilestone.get(slug) ?? []) {
      if (op.file) filePaths.add(op.file);
    }
  }
  const sizeMap = lookupFileSizes(Array.from(filePaths), deps);

  const ctx: PackContext = { snapshot, deps, sizeMap, opsByMilestone };

  const units: DispatchUnit[] = [];
  let unitCounter = 0;

  // Deterministic partition order
  const partitionKeys = Array.from(partitions.keys()).sort();
  for (const partKey of partitionKeys) {
    const partSlugs = partitions.get(partKey);
    if (partSlugs === undefined) continue;

    const modelKey = partKey.slice(partKey.indexOf(':') + 1);
    const model: ModelTier | null =
      modelKey !== '_null' ? (modelKey as ModelTier) : null;

    const batches = greedyFillPartition(partSlugs, model, ctx);
    for (const batch of batches) {
      units.push(assembleUnit(batch, unitCounter++, model, ctx));
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// computeTokensNaive() — F4 comparison baseline
// ---------------------------------------------------------------------------

/**
 * Naive baseline (SCOPE.md §F4): one milestone = one agent call, no packing,
 * no Sentinel-Fanout caching.
 *
 *   tokens_naive = Σ (b_per_tier[model] + ki_estimate) for each packable milestone
 *
 * Deliberately uses the RAW b_per_tier (not b_eff_per_tier) — the point of
 * this baseline is "what would it cost with zero optimization applied",
 * which specifically means no caching benefit either.
 *
 * The optimizer-core.2 shape.ops entry says to "emit tokens_naive... into
 * the snapshot's optimization block" — but SnapshotOptimization (types.ts)
 * has no tokens_naive field, and optimize()'s return type is fixed at
 * DispatchUnit[], so there's no type-safe way to attach it to the snapshot
 * from inside this module without either mutating the input (breaking the
 * "does not mutate its input" contract) or editing @adhd/dispatch-base-spec
 * (outside this milestone's file scope). This named export is the type-safe
 * alternative: the value is computed, testable, and available to any caller
 * that wants "packed vs naive". Adding a `tokens_naive` field to
 * SnapshotOptimization belongs to a future @adhd/dispatch-base-spec change, not
 * this file.
 */
export function computeTokensNaive(
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): number {
  let total = 0;
  for (const slug of selectPackableMilestones(snapshot)) {
    const m = snapshot.milestones[slug];
    if (m === undefined) continue;
    const b = resolveRawB(m.model, snapshot, deps) ?? 0;
    total += b + (m.ki_estimate ?? 0);
  }
  return total;
}

/** Raw (non-effective) B for tokens_naive: dag/snapshot b_per_tier, then deps fallback. */
function resolveRawB(
  model: ModelTier | null,
  snapshot: DagSnapshot,
  deps: IOptimizerDeps
): number | null {
  if (model === null) return null;
  const bRaw = snapshot.optimization.b_per_tier[model];
  if (bRaw !== null && bRaw !== undefined) return bRaw;
  const bDeps = deps.bPerTier[model];
  return bDeps !== undefined ? bDeps : null;
}
