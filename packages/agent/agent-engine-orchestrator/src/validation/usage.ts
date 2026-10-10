import { z } from "zod";

/**
 * DEBT-AGENTMCP-ACCOUNTING-001 (DESIGN.md §2) — `grain` picks which unit a
 * `usage_query` row represents. Turn is the base unit; task and session are pure
 * aggregations over turns. Default `'task'` preserves the pre-existing behavior for
 * callers that don't pass `grain` at all.
 */
export const usageGrainSchema = z.enum(["session", "task", "turn"]);
export type UsageGrain = z.infer<typeof usageGrainSchema>;

export const taskUsageInputSchema = z
  .object({
    task_id: z.string().optional(),
    root_task_id: z.string().optional(),
    agent_name: z.string().optional(),
    since: z.string().datetime().optional(),
    include_incomplete: z.boolean().default(false),
    limit: z.number().int().positive().max(500).default(50),
    group_by: z.enum(["agent", "model", "provider", "response_model"]).optional(),
    /**
     * Grain-based query path (DESIGN.md §2-§4), additive alongside `group_by` — not
     * a replacement. Mutually exclusive with `group_by` in practice: when both are
     * supplied, `group_by` wins (the legacy aggregate-by-key shape), since `grain`
     * only shapes un-grouped rows. Echoed back as a top-level `grain` key in the
     * `usageQueryByGrain` response so a consumer never has to infer what it got.
     */
    grain: usageGrainSchema.default("task"),
  })
  .optional();

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

export const groupedUsageRowSchema = z.object({
  key: z.string(),
  taskCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  cancelledCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
  /** Full-price (cache-miss) input. This — not inputTokens — drives real cost per group.
   * BUG-ORCH-009 follow-up: previously dropped from the grouped view. */
  uncachedInputTokens: z.number().int().nonnegative().nullable(),
  /** Reasoning tokens (reasoning models); billed as output. */
  reasoningTokens: z.number().int().nonnegative().nullable(),
  /** PEAK single-call input across the group (a MAX, not a SUM) — see peakContextTokens. */
  peakContextTokens: z.number().int().nonnegative().nullable(),
  /** 1f1c8598 S4b: sum of the priced portion of cost across the group (never NULL; 0 when nothing priced). */
  priced_cost_usd: z.number().nonnegative(),
  /** Tasks whose cost_status is `unpriced_model` or `partial` (0, not absent, when none). Legacy NULL-status rows are not counted. */
  unpriced_tasks: z.number().int().nonnegative(),
  /** Input+output tokens that could not be priced. */
  unpriced_tokens: z.number().int().nonnegative(),
  /** Distinct configured model ids behind the unpriced/partial tasks. */
  unpriced_models: z.array(z.string()),
});
export type GroupedUsageRow = z.infer<typeof groupedUsageRowSchema>;

export const usageSummarySchema = z.object({
  /** CUMULATIVE billed input across model calls. NOT a context size — see peakContextTokens. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
  /** Full-price (cache-miss) input. This — not inputTokens — is what actually drives cost. */
  uncachedInputTokens: z.number().int().nonnegative(),
  /** Discounted cache-hit input (~50x cheaper than a miss on deepseek-v4-flash). */
  cacheReadTokens: z.number().int().nonnegative(),
  /** Cache-write input (premium on Anthropic/OpenAI; free on DeepSeek/Gemini). */
  cacheCreationTokens: z.number().int().nonnegative(),
  /** Reasoning tokens (reasoning models); billed as output. */
  reasoningTokens: z.number().int().nonnegative(),
  /** PEAK single-call input — the real context high-water mark (a MAX, not a sum). */
  peakContextTokens: z.number().int().nonnegative(),
  /**
   * Estimated dollar cost (rate-card) summed over the rows in scope. null (never 0) when no row exists or any
   * contributing row could not be priced / measured — the same rule as the grain rows. (8333f755 AC4)
   */
  est_cost_usd: z.number().nullable(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const taskUsageReportSchema = z.object({
  direct: usageSummarySchema,
  subtree: usageSummarySchema,
  taskCount: z.number().int().positive(),
});

export type TaskUsageReport = z.infer<typeof taskUsageReportSchema>;

// ──────────────────────────────────────────────
// Grain-based usage rows (DESIGN.md §2-§4)
// ──────────────────────────────────────────────

/**
 * `context_size` is a MAX, never a SUM, across every grain — it always identifies
 * exactly which task's which model call produced it, even at session grain where
 * the aggregated rows span many tasks. `call_index` is 1-based, matching
 * `task_usage.peak_context_at`.
 */
export const contextSizeAtSchema = z.object({
  task_id: z.string(),
  call_index: z.number().int().positive().nullable(),
});
export type ContextSizeAt = z.infer<typeof contextSizeAtSchema>;

/** Context of one model call inside a folded response (claudecli), snake_case like the row. (debd934d) */
export const usageTurnContextSchema = z.object({
  /** Full-price (cache-miss) input of that call. */
  uncached_input_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  /** What the model saw on that call: uncached + cache_read + cache_creation. */
  context_tokens: z.number().int().nonnegative(),
});
export type UsageTurnContext = z.infer<typeof usageTurnContextSchema>;

/**
 * Same field set at every grain (DESIGN.md §3) — flattened, snake_case. Identity
 * fields (`task_id`, `root_task_id`, `agent_name`, `provider_type`, `model`,
 * `stop_reason`) are nullable because at `grain: 'session'` a session aggregates
 * many tasks (possibly many agents/models via delegation) with no single value to
 * report; only `session_id` + the 10 additive metrics + `context_size` /
 * `context_size_at` are guaranteed meaningful there. `call_index` is populated
 * (1-based) only at `grain: 'turn'`.
 */
export const usageRowSchema = z.object({
  session_id: z.string().nullable(),
  task_id: z.string().nullable(),
  root_task_id: z.string().nullable(),
  call_index: z.number().int().positive().nullable(),
  agent_name: z.string().nullable(),
  provider_type: z.string().nullable(),
  model: z.string().nullable(),
  created_at: z.string(),
  is_complete: z.boolean(),
  stop_reason: z.string().nullable(),

  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  uncached_input_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative(),
  model_calls: z.number().int().nonnegative(),
  compute_ms: z.number().int().nonnegative(),
  total_ms: z.number().int().nonnegative(),
  tool_call_est_result_tokens: z.number().int().nonnegative(),
  /** null (never 0) once any contributing turn's model has no rate-card entry. */
  est_cost_usd: z.number().nullable(),

  /** Provider-reported model that actually served the call(s); null when unreported or mixed. */
  response_model: z.string().nullable(),
  /**
   * `priced` | `unpriced_model` | `partial` | `unmeasured` (a run that spent resources but reported no usage:
   * zero tokens, est_cost_usd null — its cost is UNKNOWN, never $0); null on legacy rows ("provenance unknown")
   * or mixed-provenance session rows.
   */
  cost_status: z.string().nullable(),
  /** `vendor-direct` | `openrouter-estimate` | `owner-assumption`; null when unpriced / unknown / mixed. */
  cost_basis: z.string().nullable(),
  /** Price record that priced the (last priced) call; null when unpriced / unknown / session grain. */
  pricing_ref: z.string().nullable(),

  context_size: z.number().int().nonnegative(),
  context_size_at: contextSizeAtSchema,

  /** Status of the owning task (`completed` | `failed` | `cancelled` ...); null at session grain or when the task row is gone. (afa37093 AC4) */
  task_status: z.string().nullable(),
  /** The model the task was REQUESTED with (may be an alias such as `haiku`); `model` is the resolved id. null at session grain when mixed / on legacy rows. (8333f755 AC2) */
  requested_model: z.string().nullable(),
  /** Dollar cost the provider itself reported (claudecli `total_cost_usd`), summed; null when the provider reports none. Cross-check against est_cost_usd. (8333f755 AC1) */
  cli_reported_cost_usd: z.number().nullable(),
  /** The 1-hour-TTL SUBSET of cache_creation_tokens (billed at 2x vs 1.25x). null = not recorded (legacy row). (8333f755 AC3) */
  cache_creation_1h_tokens: z.number().int().nonnegative().nullable(),
  /**
   * Turn grain, folded responses (claudecli) only: context of the run's FIRST model call, whose
   * cost/context gate `context_size` (a max) cannot give. null for single-call responses (their own
   * input_tokens IS the first turn) and at task/session grain. (debd934d AC1)
   */
  first_turn: usageTurnContextSchema.nullable(),
  /** Turn grain, folded responses only: per-call breakdown, bounded (earliest first). null otherwise. (debd934d AC2) */
  per_turn: z.array(usageTurnContextSchema).nullable(),
  /** True when the run had more calls than `per_turn` carries. */
  per_turn_truncated: z.boolean(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

/** The 10 additive metrics + context, summed/maxed across every row in `rows`. */
export const usageGrainSummarySchema = z.object({
  row_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  uncached_input_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative(),
  model_calls: z.number().int().nonnegative(),
  compute_ms: z.number().int().nonnegative(),
  total_ms: z.number().int().nonnegative(),
  tool_call_est_result_tokens: z.number().int().nonnegative(),
  est_cost_usd: z.number().nullable(),
  /** Sum of the priced portion of cost; equals est_cost_usd when nothing is unpriced. Explains a null est_cost_usd. */
  priced_cost_usd: z.number().nonnegative(),
  /** Rows (tasks/sessions; at turn grain, distinct tasks) containing an unpriced turn. 0, not absent, when none. */
  unpriced_tasks: z.number().int().nonnegative(),
  /** Individual model calls that could not be priced (exact at every grain). */
  unpriced_turns: z.number().int().nonnegative(),
  /** Input+output tokens behind the unpriced turns. */
  unpriced_tokens: z.number().int().nonnegative(),
  /** Distinct configured model ids with at least one unpriced turn. */
  unpriced_models: z.array(z.string()),
  /** Distinct cost bases present among priced rows (e.g. vendor-direct, openrouter-estimate). */
  cost_bases: z.array(z.string()),
  /** Hours since the last successful price pull; null until a pull ledger row exists. */
  price_age_hours: z.number().nonnegative().nullable(),
  context_size: z.number().int().nonnegative(),
  context_size_at: contextSizeAtSchema.nullable(),
});
export type UsageGrainSummary = z.infer<typeof usageGrainSummarySchema>;

export const usageGrainResponseSchema = z.object({
  grain: usageGrainSchema,
  rows: z.array(usageRowSchema),
  summary: usageGrainSummarySchema,
});
export type UsageGrainResponse = z.infer<typeof usageGrainResponseSchema>;
