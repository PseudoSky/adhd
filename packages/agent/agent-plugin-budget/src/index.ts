import { z } from 'zod';
import type {
  IHookRegistry,
  IEnforcementError,
  IToolWarning,
  Plugin,
  PluginContext,
  PluginFactory,
  ExecutionContext,
  PreModelRequestPayload,
  PostModelResponsePayload,
  PostToolCallPayload,
  TaskStartPayload,
  PreToolCallPayload,
  Message,
  ToolDefinition,
} from '@adhd/agent-base-types';
import { contextWindowFor } from '@adhd/agent-base-types';

// ── ISO8601 duration parser ──────────────────────────────────────────────────

// Supported tokens: P[n]Y[n]M[n]DT[n]H[n]M[n]S
// e.g. PT24H, PT1H30M, P1DT6H
function parseIsoDuration(dur: string): number {
  const re =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
  const m = dur.match(re);
  if (!m) throw new Error(`invalid ISO 8601 duration: ${dur}`);
  const [, y, M, d, h, min, s] = m;
  let ms = 0;
  if (y) ms += parseInt(y) * 365.25 * 86400_000;
  if (M) ms += parseInt(M) * 30.44 * 86400_000;
  if (d) ms += parseInt(d) * 86400_000;
  if (h) ms += parseInt(h) * 3600_000;
  if (min) ms += parseInt(min) * 60_000;
  if (s) ms += parseFloat(s) * 1000;
  return Math.round(ms);
}

// ── Cap schema ───────────────────────────────────────────────────────────────

// Field vocabulary (PLAN-run-control-v2 Packet B/C, BUG-AGENTMCP-009):
//   - 'context' — PEAK single-request input size (the high-water mark the model
//     actually saw, or the tools-aware estimate of the pending request), NOT
//     cumulative volume. Model-path only.
//   - 'inputTokens'/'outputTokens' — CUMULATIVE per-dimension volume (the
//     resource-burn axis); windowed caps on them express the old
//     maxTokensPer24h-class limits (owner ruling 3).
//   - 'errors'/'consecutiveErrors' — task-level ERROR BUDGET (Packet C): counted
//     at post:tool_call from the engine's isError flag, enforced on the tool
//     path only. Windowed/scoped errors are not expressible this wave (schema
//     rejects `window` and non-task `scope` — no task_usage column for errors).
// 'tokens' (cumulative input+output, misread as context size) is REMOVED —
// `assertNoLegacyTokensConfig` rejects it with an explicit migration message.
const FIELD_NAMES = [
  'context',
  'inputTokens',
  'outputTokens',
  'calls',
  'wallClock',
  'modelMs',
  'cost',
  'toolCalls',
  'errors',
  'consecutiveErrors',
  'responseSize',
] as const;

/**
 * Cap fields enforced exclusively at pre:tool_call. They must NEVER appear on
 * the model path: 'toolCalls' is per-tool; 'errors'/'consecutiveErrors'
 * (Packet C) are counted at post:tool_call — the only seam where the engine
 * exposes an error signal — and therefore can only be enforced at the next
 * tool call. `enforcePreModel` filters these out of the model-path cap set.
 */
const TOOL_PATH_ONLY_FIELDS = new Set(['toolCalls', 'errors', 'consecutiveErrors']);

/**
 * Cap schema. `maximum` is optional at the base level because a `context` cap may
 * instead use `contextWindowFraction` (0..1 of the model's true window); the
 * superRefine below enforces the cross-field invariants:
 *   - `context` requires EXACTLY ONE of `maximum` / `contextWindowFraction`;
 *   - `context` REJECTS `window` (a windowed PEAK is meaningless; windowed
 *     cumulative volume is expressible via `inputTokens`/`outputTokens` + `window`);
 *   - non-`context` fields REJECT `contextWindowFraction` and REQUIRE `maximum`;
 *   - `errors`/`consecutiveErrors` REJECT `window` and non-task `scope`
 *     (Packet C — windowed/scoped error budgets are not expressible this wave).
 */
const capSchema = z
  .object({
    field: z.enum(FIELD_NAMES),
    maximum: z.number().min(0).optional(),
    contextWindowFraction: z.number().min(0).max(1).optional(),
    window: z.string().optional(),
    scope: z.enum(['task', 'session', 'agent', 'global']).optional(),
    mode: z.enum(['warning', 'block']).optional(),
    message: z.string().optional(),
  })
  .superRefine((cap, ctx) => {
    if (cap.field === 'context') {
      const hasMaximum = cap.maximum !== undefined;
      const hasFraction = cap.contextWindowFraction !== undefined;
      if (hasMaximum === hasFraction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contextWindowFraction'],
          message:
            "cap field 'context' requires exactly one of 'maximum' or 'contextWindowFraction'",
        });
      }
      if (cap.window !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['window'],
          message:
            "cap field 'context' rejects 'window' — a windowed peak is meaningless; " +
            "windowed cumulative volume is expressible via 'inputTokens'/'outputTokens' + 'window'",
        });
      }
    } else {
      if (cap.field === 'errors' || cap.field === 'consecutiveErrors') {
        // Packet C (plan §3): the error budget is counted per-task in memory
        // from the engine's post:tool_call isError flag — there is no
        // task_usage column for errors, so windowed or session/agent/global
        // scoped error budgets are not expressible this wave. Rejecting them
        // here (schema error) prevents a silently mis-scoped cap.
        if (cap.window !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['window'],
            message: `cap field '${cap.field}' rejects 'window' — windowed error budgets are not expressible this wave`,
          });
        }
        if (cap.scope !== undefined && cap.scope !== 'task') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['scope'],
            message: `cap field '${cap.field}' is counted per-task in memory (no task_usage column) — only 'task' scope is expressible this wave`,
          });
        }
      }
      if (cap.contextWindowFraction !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contextWindowFraction'],
          message: `'contextWindowFraction' is only valid on cap field 'context' (got '${
            cap.field
          }')`,
        });
      }
      if (cap.maximum === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maximum'],
          message: `cap field '${cap.field}' requires a 'maximum'`,
        });
      }
    }
  });

export type Cap = z.infer<typeof capSchema>;

// ── Dimension config ─────────────────────────────────────────────────────────

const dimensionSchema = z.object({
  caps: z.array(capSchema).optional(),
  mode: z.enum(['warning', 'block']).optional(),
  costPerInputToken: z.number().min(0).optional(),
  costPerOutputToken: z.number().min(0).optional(),
  // Cache-weighted cost rates (BUG-AGENTMCP-008). Default = costPerInputToken when
  // unset, so a config without them bills every input token at the flat input rate —
  // byte-for-byte identical to the pre-fix behavior.
  costPerCacheReadToken: z.number().min(0).optional(),
  costPerCacheWriteToken: z.number().min(0).optional(),
  scope: z.enum(['task', 'session', 'agent', 'global']).optional(),
});

type DimensionConfig = z.infer<typeof dimensionSchema>;

/**
 * Tool-scoped cap dimensions REJECT 'context' (Packet B review finding, plan
 * §8.9): `enforcePreTool` filters 'context' out (there is no pending request to
 * estimate at tool-call time) and `enforcePreModel` cannot see tool overrides —
 * so a `{field:'context'}` cap placed in `tool.default`/`tool.overrides` was a
 * SILENT no-op. Reject it as a schema error, not a warning. A model-scope
 * `context` cap belongs in `defaults`/`agent`/`provider` (where it merges into
 * the model-path cap set).
 *
 * NOTE: `.partial()` must be applied BEFORE `.superRefine()` — Zod 4 rejects
 * `.partial()` on a schema that already carries refinements.
 */
const toolDimensionSchema = dimensionSchema
  .partial()
  .superRefine((dim, ctx) => {
    const caps = dim.caps ?? [];
    for (const [i, cap] of caps.entries()) {
      if (cap.field === 'context') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['caps', i, 'field'],
          message:
            "cap field 'context' is only valid at model scope — a tool-scoped 'context' cap is a silent no-op " +
            "(enforced on the model path, invisible to tool overrides); place it in 'defaults'/'agent'/'provider' instead",
        });
      }
    }
  });

// ── Full plugin config ───────────────────────────────────────────────────────

export const pluginConfigSchema = z.object({
  defaults: dimensionSchema.optional(),
  agent: z
    .object({
      default: dimensionSchema.optional(),
      overrides: z
        .record(z.string(), dimensionSchema.partial())
        .optional()
        .default({}),
    })
    .optional(),
  provider: z
    .object({
      default: dimensionSchema.optional(),
      overrides: z
        .record(z.string(), dimensionSchema.partial())
        .optional()
        .default({}),
    })
    .optional(),
  tool: z
    .object({
      default: toolDimensionSchema.optional(),
      overrides: z
        .record(z.string(), toolDimensionSchema)
        .optional()
        .default({}),
    })
    .optional(),
});

export type PluginConfig = z.input<typeof pluginConfigSchema>;

export const configSchema = z.object({}).passthrough();

// ── Backward compat: flat fields → caps ──────────────────────────────────────
//
// Packet B (BUG-AGENTMCP-009): `maxTotalTokens` is REMOVED (its field 'tokens' is
// gone — `assertNoLegacyTokensConfig` throws first); `maxTokensPer24h` is RETAINED
// (owner ruling 3) and re-expressed as a windowed cumulative `inputTokens` cap —
// the resource-burn axis the windowed vocabulary now lives on.

const FIELD_MAP: Record<string, { field: Cap['field']; window?: string }> = {
  maxInputTokens: { field: 'inputTokens' },
  maxOutputTokens: { field: 'outputTokens' },
  maxModelCalls: { field: 'calls' },
  maxWallClockMs: { field: 'wallClock' },
  maxModelMs: { field: 'modelMs' },
  maxCostUSD: { field: 'cost' },
  maxTokensPer24h: { field: 'inputTokens', window: 'PT24H' },
  maxCalls: { field: 'toolCalls' },
};

function flatFieldsToDimension(raw: Record<string, unknown>): DimensionConfig {
  const caps: Cap[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const mapping = FIELD_MAP[key];
    if (mapping && typeof value === 'number') {
      const cap: Cap = { field: mapping.field, maximum: value };
      if (mapping.window) cap.window = mapping.window;
      caps.push(cap);
    } else if (
      key === 'scope' ||
      key === 'mode' ||
      key === 'costPerInputToken' ||
      key === 'costPerOutputToken' ||
      key === 'costPerCacheReadToken' ||
      key === 'costPerCacheWriteToken' ||
      key === 'message'
    ) {
      result[key] = value;
    }
  }

  if (caps.length > 0) result['caps'] = caps;
  return dimensionSchema.parse(result);
}

/**
 * Packet B hard removal (owner ruling 1 — no deprecated alias): any config that
 * still uses the `tokens` cap field or the flat `maxTotalTokens` key fails with
 * an explicit migration message. `maxTokensPer24h` is deliberately NOT rejected —
 * it is re-expressed as a windowed cumulative `inputTokens` cap (ruling 3).
 *
 * Runs at the top of `normalizeConfig`, so it fires inside the plugin factory.
 * The loader catches factory throws and logs (loader.ts:227-233) — a legacy
 * config skips the plugin, never crashes the server.
 */
const LEGACY_TOKENS_MESSAGE = (where: string): string =>
  `legacy 'tokens' budget cap detected (${where}): cap field 'tokens' is removed; ` +
  `use 'context' (peak request input) or 'inputTokens'/'outputTokens' (windowed volume)`;

function assertNoLegacyTokensConfig(raw: unknown): void {
  const obj = (raw ?? {}) as Record<string, unknown>;

  // Flat format — legacy keys sit at the top level of the config object.
  if (typeof obj['maxTotalTokens'] === 'number') {
    throw new Error(LEGACY_TOKENS_MESSAGE("flat 'maxTotalTokens'"));
  }

  // Scan a single dimension block (may carry caps[] and/or nested flat keys).
  const scanDimension = (dim: unknown): void => {
    if (typeof dim !== 'object' || dim === null) return;
    const d = dim as Record<string, unknown>;
    if (typeof d['maxTotalTokens'] === 'number') {
      throw new Error(LEGACY_TOKENS_MESSAGE("structured 'maxTotalTokens'"));
    }
    const caps = d['caps'];
    if (Array.isArray(caps)) {
      for (const cap of caps) {
        if (
          typeof cap === 'object' &&
          cap !== null &&
          (cap as Record<string, unknown>)['field'] === 'tokens'
        ) {
          throw new Error(LEGACY_TOKENS_MESSAGE("caps[].field === 'tokens'"));
        }
      }
    }
  };

  // Scan an agent/provider/tool block: { default?, overrides? } of dimensions.
  const scanBlock = (block: unknown): void => {
    if (typeof block !== 'object' || block === null) return;
    const b = block as Record<string, unknown>;
    scanDimension(b);
    if ('default' in b) scanDimension(b['default']);
    const overrides = b['overrides'];
    if (typeof overrides === 'object' && overrides !== null) {
      for (const value of Object.values(overrides as Record<string, unknown>)) {
        scanDimension(value);
      }
    }
  };

  scanDimension(obj['defaults']);
  scanBlock(obj['agent']);
  scanBlock(obj['provider']);
  scanBlock(obj['tool']);
}

function normalizeConfig(raw: unknown): PluginConfig {
  assertNoLegacyTokensConfig(raw);
  const obj = raw as Record<string, unknown>;
  if (
    obj['defaults'] !== undefined ||
    obj['agent'] !== undefined ||
    obj['provider'] !== undefined ||
    obj['tool'] !== undefined
  ) {
    const parsed = pluginConfigSchema.parse(raw);
    return {
      defaults: parsed.defaults ?? dimensionSchema.parse({}),
      agent: parsed.agent ?? { overrides: {} },
      provider: parsed.provider ?? { overrides: {} },
      tool: parsed.tool ?? { overrides: {} },
    };
  }
  // Flat format → dimension
  return {
    defaults: flatFieldsToDimension(obj),
    agent: { overrides: {} },
    provider: { overrides: {} },
    tool: { overrides: {} },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnforcementError(
  limitName: string,
  limit: number,
  current: number,
  message?: string
): IEnforcementError {
  return {
    isEnforcementError: true as const,
    code: 'BUDGET_EXCEEDED',
    message:
      message ??
      `${limitName} limit is ${limit}, current value is ${Math.round(current)}`,
  };
}

function makeToolWarning(
  toolName: string,
  callId: string,
  message: string
): IToolWarning {
  return { isToolWarning: true, toolName, callId, message };
}

/**
 * Estimate the PENDING request's input size (tokens) from the messages + tool
 * definitions about to be sent to the model — the tools-aware estimator that
 * fixes BUG-ORCH-006 (the engine's local estimator historically undercounted by
 * ignoring the tools array). ~4 chars/token over the full serialized wire form:
 * message content + toolCall arguments + toolResults payloads + tool schemas.
 *
 * Used on the MODEL path as the early-catch half of the 'context' enforcement
 * value (owner ruling 4): `max(provider-reported peak, estimate)` — an oversized
 * request is caught pre-flight, not one response late.
 */
function estimateRequestContext(
  messages: readonly Message[],
  tools: readonly ToolDefinition[]
): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    for (const toolCall of message.toolCalls ?? []) {
      chars += JSON.stringify(toolCall.arguments ?? {}).length;
    }
    for (const toolResult of message.toolResults ?? []) {
      chars += JSON.stringify(toolResult.result ?? null).length;
    }
  }
  for (const tool of tools) {
    chars += JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).length;
  }
  return Math.ceil(chars / 4);
}

// ── In-memory accumulator ────────────────────────────────────────────────────

interface BudgetAccumulator {
  taskId: string;
  sessionId?: string;
  agentName: string;
  providerType: string;
  startedAtMs: number;
  // Per-class input accounting (BUG-AGENTMCP-008). Providers already split input into
  // uncached / cache-read / cache-creation at their boundary (normaliseAnthropicUsage /
  // normaliseOpenAIUsage — see BUG-ORCH-010/BUG-ORCH-009), so the classes are accumulated
  // separately to let cost weight each at its own rate. `inputTokens` is the DERIVED
  // total — the exact provider-neutral total the inputTokens/tokens caps always keyed
  // off (uncached + cacheRead + cacheCreation) — never a double-count of the cached
  // portion. The three classes always partition `inputTokens` exactly (a provider that
  // emits no split bills its entire total as uncached input).
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  // PEAK single-call input (tokens) across the task's model responses — the
  // 'context' cap's provider-reported high-water mark. NOT a sum: cumulative
  // input is billed volume, not context size (FINDING-ORCH-007 / PLAN-run-
  // control-v2 §1 — a cache-warm run re-reads history every turn, so cumulative
  // volume compounds while peak stays flat).
  peakContextTokens: number;
  modelCalls: number;
  totalModelMs: number;
  modelCallStartMs?: number;
  toolCalls: Map<string, number>;
  // Packet C — task-level ERROR BUDGET (plan §3): fed ONLY at post:tool_call
  // from the engine's isError flag (onPostToolCall), enforced on the tool path.
  // `errors` is cumulative; `consecutiveErrors` resets to 0 on any successful
  // tool call. Task scope only — windowed/scoped errors are not expressible
  // this wave (schema rejects both).
  errors: number;
  consecutiveErrors: number;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  /** MAX(peak_context_tokens) across the scope's task set (+ this task in-memory). */
  peakContextTokens: number;
}

// ── Plugin class ─────────────────────────────────────────────────────────────

class BudgetPlugin implements Plugin {
  readonly name = 'agent-mcp-budget';

  private readonly accumulators = new Map<string, BudgetAccumulator>();

  /**
   * Captured at install() — used to emit `budget:warning` / `budget:block`
   * notification events when a cap is exceeded. Optional: a plugin that never
   * sees install() (or is driven by a bare enforcement handler) emits nothing.
   */
  private hooks: IHookRegistry | undefined;

  constructor(
    private readonly db: unknown,
    private readonly cfg: PluginConfig,
    private readonly costPerInput = 0,
    private readonly costPerOutput = 0,
    private readonly costPerCacheRead = 0,
    private readonly costPerCacheWrite = 0
  ) {}

  install(hooks: IHookRegistry): void {
    this.hooks = hooks;
    hooks.register('task:start', (p) => {
      try {
        this.onTaskStart(p);
      } catch {
        /* observational */
      }
    });
    hooks.register('pre:model_request', (p) => {
      try {
        this.onPreModelRequest(p);
      } catch {
        /* observational */
      }
    });
    hooks.register('post:model_response', (p) => {
      try {
        this.onPostModelResponse(p);
      } catch {
        /* observational */
      }
    });
    hooks.register('post:tool_call', (p) => {
      try {
        this.onPostToolCall(p);
      } catch {
        /* observational */
      }
    });

    hooks.register('task:completed', (p) => {
      try {
        this.onTerminal(p.executionContext.taskId);
      } catch {
        /**/
      }
    });
    hooks.register('task:failed', (p) => {
      try {
        this.onTerminal(p.executionContext.taskId);
      } catch {
        /**/
      }
    });
    hooks.register('task:cancelled', (p) => {
      try {
        this.onTerminal(p.executionContext.taskId);
      } catch {
        /**/
      }
    });

    hooks.registerEnforcement('pre:model_request', (p) =>
      this.enforcePreModel(p)
    );
    hooks.registerEnforcement('pre:tool_call', (p) => this.enforcePreTool(p));
    hooks.register('transform:tool_result', (p) => {
      try {
        this.enforceResponseSize(p);
      } catch {
        /* observational — mutate only */
      }
    });
  }

  // ── Observational handlers ────────────────────────────────────────────────

  private onTaskStart(p: TaskStartPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    const providerType =
      p.executionContext.agentDefinition?.provider?.type ?? 'unknown';
    this.accumulators.set(taskId, {
      taskId,
      sessionId: sessionId ?? undefined,
      agentName,
      providerType,
      startedAtMs: Date.now(),
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      peakContextTokens: 0,
      modelCalls: 0,
      totalModelMs: 0,
      toolCalls: new Map(),
      errors: 0,
      consecutiveErrors: 0,
    });
  }

  private onPreModelRequest(p: PreModelRequestPayload): void {
    const acc = this.accumulators.get(p.executionContext.taskId);
    if (acc) acc.modelCallStartMs = Date.now();
  }

  private onPostModelResponse(p: PostModelResponsePayload): void {
    const acc = this.accumulators.get(p.executionContext.taskId);
    if (!acc) return;
    const usage = p.tokenUsage;
    if (usage) {
      // Per-class accumulation (BUG-AGENTMCP-008): providers already split input into
      // uncached / cache-read / cache-creation and emit `inputTokens` as their sum
      // (normaliseAnthropicUsage / normaliseOpenAIUsage). Each class is accumulated
      // separately so cost can weight it at its own rate. The classes always partition
      // the total exactly:
      //   - split present, total present  → uncached gets the residual (total − read −
      //     creation), which equals the emitted uncached count on consistent providers;
      //   - split present, total absent   → uncached is the emitted count, total derived
      //     as the class sum (guaranteed identical when the provider is consistent);
      //   - no split (legacy/3rd-party)   → the whole total bills as uncached input.
      // So with cache rates unset (default = input rate) cost is byte-for-byte identical
      // to the old flat formula, and inputTokens/tokens caps see exactly the same total
      // they always did.
      const total = usage.inputTokens ?? 0;
      const read = usage.cacheReadTokens ?? 0;
      const creation = usage.cacheCreationTokens ?? 0;
      const hasSplit =
        usage.uncachedInputTokens !== undefined ||
        usage.cacheReadTokens !== undefined ||
        usage.cacheCreationTokens !== undefined;
      const uncached = hasSplit
        ? (usage.uncachedInputTokens ?? Math.max(0, total - read - creation))
        : total;

      acc.uncachedInputTokens += uncached;
      acc.cacheReadTokens += read;
      acc.cacheCreationTokens += creation;
      // Derived total — never add the cache classes ON TOP of inputTokens (that was the
      // BUG-ORCH-010 double-count); inputTokens IS the sum of the three classes.
      acc.inputTokens += uncached + read + creation;
      acc.outputTokens += usage.outputTokens ?? 0;
      // PEAK, not sum — byte-identical to usage-plugin's peakContextTokens
      // (usage-plugin.ts:143,172-181): the provider-reported total input of this
      // call is what the model actually saw. Cumulative input must never feed
      // this (BUG-AGENTMCP-009 — cache-warm cumulative volume ≠ context size).
      acc.peakContextTokens = Math.max(acc.peakContextTokens, total);
    }
    acc.modelCalls += 1;
    if (acc.modelCallStartMs !== undefined) {
      acc.totalModelMs += Date.now() - acc.modelCallStartMs;
      acc.modelCallStartMs = undefined;
    }
  }

  private onTerminal(taskId: string): void {
    this.accumulators.delete(taskId);
  }

  /**
   * Packet C — error counters (plan §3): the ONLY place the error budget
   * changes. Fires at post:tool_call, which the orchestrator emits exclusively
   * for EXECUTED tools (orchestrator.ts Phase 2 map, post:tool_call emit). A
   * call soft-blocked by an IToolWarning at pre:tool_call is injected as a
   * warningResult and SKIPPED (orchestrator.ts:619-626, filter at 645-647) —
   * it never reaches Phase 2 and never emits post:tool_call. That is the
   * non-self-amplifying guarantee: a warning-mode errors cap's own warnings are
   * never counted, so the counter cannot feed itself.
   *
   * Thrown-errors-only (owner lean, plan §3): `isError` is true at this
   * boundary only when the tool's callTool THREW (orchestrator.ts:718);
   * error-shaped non-throwing results are indistinguishable from success here.
   */
  private onPostToolCall(p: PostToolCallPayload): void {
    const acc = this.accumulators.get(p.executionContext.taskId);
    if (!acc) return;
    if (p.isError) {
      acc.errors += 1;
      acc.consecutiveErrors += 1;
    } else {
      // A successful tool call breaks the consecutive-error streak.
      acc.consecutiveErrors = 0;
    }
  }

  // ── Config resolution ─────────────────────────────────────────────────────

  private mergeDim(dims: (DimensionConfig | undefined)[]): DimensionConfig {
    let merged: DimensionConfig = { caps: [] };
    for (const d of dims) {
      if (!d) continue;
      merged = {
        caps: [...(merged.caps ?? []), ...(d.caps ?? [])],
        mode: d.mode ?? merged.mode,
        costPerInputToken: d.costPerInputToken ?? merged.costPerInputToken,
        costPerOutputToken: d.costPerOutputToken ?? merged.costPerOutputToken,
        costPerCacheReadToken:
          d.costPerCacheReadToken ?? merged.costPerCacheReadToken,
        costPerCacheWriteToken:
          d.costPerCacheWriteToken ?? merged.costPerCacheWriteToken,
        scope: d.scope ?? merged.scope,
      };
    }
    return merged;
  }

  private resolveCaps(
    agentName: string,
    providerType: string,
    toolName?: string
  ): { caps: Cap[]; mode?: string; scope?: string } {
    const base = this.cfg.defaults;
    const agentDim = this.cfg.agent;
    const provDim = this.cfg.provider;
    const toolDim = this.cfg.tool;

    if (toolName) {
      const toolOverride = toolDim?.overrides?.[toolName];
      const merged = this.mergeDim([base, toolDim?.default, toolOverride]);
      return {
        caps: merged.caps ?? [],
        mode: merged.mode,
        scope: merged.scope,
      };
    }

    const agentOverride = agentDim?.overrides?.[agentName];
    const provOverride = provDim?.overrides?.[providerType];
    const merged = this.mergeDim([
      base,
      agentDim?.default,
      agentOverride,
      provDim?.default,
      provOverride,
    ]);
    return { caps: merged.caps ?? [], mode: merged.mode, scope: merged.scope };
  }

  // ── Scope-aware DB queries ────────────────────────────────────────────────

  private queryScopeTotals(
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
    scope: string
  ): UsageTotals {
    const acc = this.accumulators.get(taskId);
    const inMem = acc
      ? {
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          modelCalls: acc.modelCalls,
          peakContextTokens: acc.peakContextTokens,
        }
      : {
          inputTokens: 0,
          outputTokens: 0,
          modelCalls: 0,
          peakContextTokens: 0,
        };

    if (scope === 'task' || !this.db) return inMem;

    try {
      const db = this.db as {
        prepare: (sql: string) => {
          get: (
            ...args: unknown[]
          ) =>
            | { input: number; output: number; calls: number; peak?: number }
            | undefined;
        };
      };
      // NOTE (BUG-ORCH-010): input_tokens is already the provider-neutral total
      // (uncached + cache-read + cache-creation) — do not also SUM the cache columns
      // here, they are a subset of input_tokens, not additive.
      // `peak` = MAX(peak_context_tokens) over the scope's task set — the scoped
      // 'context' cap value (owner ruling, §5.2).
      let row:
        | { input: number; output: number; calls: number; peak?: number }
        | undefined;

      if (scope === 'session' && sessionId) {
        row = db
          .prepare(
            `SELECT
               COALESCE(SUM(tu.input_tokens), 0) AS input,
               COALESCE(SUM(tu.output_tokens), 0) AS output,
               COALESCE(SUM(tu.model_calls), 0) AS calls,
               COALESCE(MAX(tu.peak_context_tokens), 0) AS peak
             FROM task_usage tu
             JOIN tasks t ON tu.task_id = t.id
             WHERE t.session_id = ? AND tu.task_id != ?`
          )
          .get(sessionId, taskId) as typeof row;
      } else if (scope === 'agent') {
        row = db
          .prepare(
            `SELECT
               COALESCE(SUM(input_tokens), 0) AS input,
               COALESCE(SUM(output_tokens), 0) AS output,
               COALESCE(SUM(model_calls), 0) AS calls,
               COALESCE(MAX(peak_context_tokens), 0) AS peak
             FROM task_usage
             WHERE agent_name = ? AND task_id != ?`
          )
          .get(agentName, taskId) as typeof row;
      } else if (scope === 'global') {
        row = db
          .prepare(
            `SELECT
               COALESCE(SUM(input_tokens), 0) AS input,
               COALESCE(SUM(output_tokens), 0) AS output,
               COALESCE(SUM(model_calls), 0) AS calls,
               COALESCE(MAX(peak_context_tokens), 0) AS peak
             FROM task_usage
             WHERE task_id != ?`
          )
          .get(taskId) as typeof row;
      }

      if (row) {
        return {
          inputTokens: (row.input ?? 0) + inMem.inputTokens,
          outputTokens: (row.output ?? 0) + inMem.outputTokens,
          modelCalls: (row.calls ?? 0) + inMem.modelCalls,
          // Scoped context = MAX over the scope's task set of peak_context_tokens,
          // with the current task's in-memory peak folded in (it is a member of the
          // set; the queries above exclude it by `task_id != ?`).
          peakContextTokens: Math.max(row.peak ?? 0, inMem.peakContextTokens),
        };
      }
    } catch {
      /* fall through */
    }

    return inMem;
  }

  private queryWindowTokens(
    scope: string,
    id: string,
    windowMs: number,
    excludeTaskId?: string
  ): number {
    if (!this.db) return 0;
    try {
      const db = this.db as {
        prepare: (sql: string) => {
          get: (...args: unknown[]) => { total: number } | undefined;
        };
      };
      const since = new Date(Date.now() - windowMs).toISOString();

      let row: { total: number } | undefined;

      // NOTE (BUG-ORCH-010): `input_tokens` already IS the provider-neutral total
      // (uncached + cache-read + cache-creation summed at the provider boundary —
      // see normaliseAnthropicUsage / normaliseOpenAIUsage). Adding
      // cache_read_input_tokens/cache_creation_input_tokens on top here would
      // double-count the cached portion and trip a windowed 'tokens' cap
      // (e.g. maxTokensPer24h) far earlier than real usage.
      if (scope === 'session') {
        const excl = excludeTaskId ? ' AND tu.task_id != ?' : '';
        const params: unknown[] = [id, since];
        if (excludeTaskId) params.push(excludeTaskId);
        row = db
          .prepare(
            `SELECT COALESCE(SUM(tu.input_tokens + tu.output_tokens), 0) AS total
             FROM task_usage tu
             JOIN tasks t ON tu.task_id = t.id
             WHERE t.session_id = ? AND tu.created_at >= ?${excl}`
          )
          .get(...params) as typeof row;
      } else if (scope === 'agent') {
        const excl = excludeTaskId ? ' AND task_id != ?' : '';
        const params: unknown[] = [id, since];
        if (excludeTaskId) params.push(excludeTaskId);
        row = db
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
             FROM task_usage
             WHERE agent_name = ? AND created_at >= ?${excl}`
          )
          .get(...params) as typeof row;
      } else if (scope === 'global') {
        const excl = excludeTaskId ? ' AND task_id != ?' : '';
        const params: unknown[] = [since];
        if (excludeTaskId) params.push(excludeTaskId);
        row = db
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
             FROM task_usage
             WHERE created_at >= ?${excl}`
          )
          .get(...params) as typeof row;
      }

      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Generic cap evaluation ────────────────────────────────────────────────

  // ── Single-shot usage snapshot ──────────────────────────────────────────

  /**
   * Build a complete usage snapshot for the current enforcement event.
   *
   * Makes exactly `U + W` DB queries where:
   *   U = number of unique non-task scopes across all caps (0..3)
   *   W = number of unique (scope, window) pairs across all caps
   *
   * Independent of cap count, agent count, session count, or history depth.
   *
   * `requestEstimate` (tokens) is the tools-aware estimate of the PENDING
   * request, computed on the model path; it feeds the 'context' enforcement
   * value = max(provider-reported peak, estimate) per owner ruling 4.
   */
  private buildSnapshot(
    caps: Cap[],
    acc: BudgetAccumulator,
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
    dimScope?: string,
    requestEstimate = 0
  ): Record<string, number> {
    const snap: Record<string, number> = {};

    snap['inputTokens'] = acc.inputTokens;
    snap['outputTokens'] = acc.outputTokens;
    snap['calls'] = acc.modelCalls;
    snap['wallClock'] = Date.now() - acc.startedAtMs;
    snap['modelMs'] = acc.totalModelMs;
    // 'context' enforcement value — max of the provider-reported peak so far and
    // the tools-aware estimate of the request about to be sent (ruling 4: catch
    // early, reject one-request-lag).
    snap['context'] = Math.max(acc.peakContextTokens, requestEstimate);
    // Packet C — task-level error budget counters (fed ONLY at post:tool_call,
    // onPostToolCall). Task scope only: no task_usage column for errors, and
    // the schema rejects windowed/non-task-scoped error caps.
    snap['errors'] = acc.errors;
    snap['consecutiveErrors'] = acc.consecutiveErrors;
    // Cache-weighted cost (BUG-AGENTMCP-008): each input class bills at its own rate.
    // With costPerCacheReadToken/costPerCacheWriteToken unset (default = costPerInput),
    // this collapses to inputTokens × costPerInput + outputTokens × costPerOutput —
    // the exact flat formula that shipped before, byte-for-byte.
    snap['cost'] =
      acc.uncachedInputTokens * this.costPerInput +
      acc.cacheReadTokens * this.costPerCacheRead +
      acc.cacheCreationTokens * this.costPerCacheWrite +
      acc.outputTokens * this.costPerOutput;

    const uniqueScopes = new Set<string>();
    const uniqueWindows = new Map<
      string,
      { scope: string; windowMs: number }
    >();
    for (const cap of caps) {
      const scope = cap.scope ?? dimScope ?? 'task';
      if (scope !== 'task') uniqueScopes.add(scope);
      if (cap.window) {
        const key = `${scope}:${cap.window}`;
        if (!uniqueWindows.has(key)) {
          uniqueWindows.set(key, {
            scope,
            windowMs: parseIsoDuration(cap.window),
          });
        }
      }
    }

    for (const scope of uniqueScopes) {
      const t = this.queryScopeTotals(taskId, sessionId, agentName, scope);
      snap[`${scope}:inputTokens`] = t.inputTokens;
      snap[`${scope}:outputTokens`] = t.outputTokens;
      snap[`${scope}:calls`] = t.modelCalls;
      // Scoped 'context' = MAX(peak_context_tokens) across the task set; the
      // pending-request estimate also applies at scope level (the current task is
      // a member of the set).
      snap[`${scope}:context`] = Math.max(
        t.peakContextTokens,
        requestEstimate
      );
    }

    for (const [key, { scope, windowMs }] of uniqueWindows) {
      let scopeId = '';
      if (scope === 'session') scopeId = sessionId ?? '';
      else if (scope === 'agent') scopeId = agentName ?? '';
      snap[key] = this.queryWindowTokens(scope, scopeId, windowMs, taskId);
    }

    return snap;
  }

  private getSnapshotValue(
    snap: Record<string, number>,
    cap: Cap,
    dimScope?: string
  ): number {
    const scope = cap.scope ?? dimScope ?? 'task';
    // When cap has a window, historical data comes from the window query
    // (snap[`${scope}:${cap.window}`]). Scope-level totals already include
    // that same historical data — using them as base would double-count.
    let scopeKey: string;
    if (cap.window) {
      scopeKey = '';
    } else {
      scopeKey = scope !== 'task' ? `${scope}:` : '';
    }

    let base: number;
    switch (cap.field) {
      case 'inputTokens':
        base = snap[`${scopeKey}inputTokens`] ?? snap['inputTokens'];
        break;
      case 'outputTokens':
        base = snap[`${scopeKey}outputTokens`] ?? snap['outputTokens'];
        break;
      case 'context':
        // PEAK single-request input — the in-memory enforcement value computed in
        // buildSnapshot (max of provider-reported peak and the pending-request
        // estimate), or MAX(peak_context_tokens) for scoped caps. 'context' rejects
        // `window` at the schema level, so the windowed path below never fires here.
        base = snap[`${scopeKey}context`] ?? snap['context'];
        break;
      case 'calls':
        base = snap[`${scopeKey}calls`] ?? snap['calls'];
        break;
      case 'wallClock':
        base = snap['wallClock'];
        break;
      case 'modelMs':
        base = snap['modelMs'];
        break;
      case 'cost':
        base = snap['cost'];
        break;
      case 'toolCalls':
        base = 0; // resolved at enforcement time via toolName
        break;
      case 'errors':
        // Task-level in-memory counter only — no task_usage column for errors
        // (schema rejects `window` and non-task `scope`). Always the
        // unscoped value: a dimension-level scope cannot re-scope an error cap.
        base = snap['errors'];
        break;
      case 'consecutiveErrors':
        base = snap['consecutiveErrors'];
        break;
      default:
        base = 0;
    }

    if (cap.window) {
      base += snap[`${scope}:${cap.window}`] ?? 0;
    }

    return base;
  }

  /**
   * Emit a `budget:*` notification event for an exceeded cap. Pure notification
   * layer (owner ruling 7): HookRegistry.emit swallows handler errors and is a
   * no-op when no handler is registered, so emission can never affect
   * enforcement. `message` defaults to cap.message, then the standard
   * `"<field> limit is <limit>, current value is <current>"` string — the
   * same resolution `makeEnforcementError` uses, so the block event's message
   * always matches the error the orchestrator sees.
   *
   * `limit` is the RESOLVED cap limit (`maximum`, or the context-window-derived
   * limit for `contextWindowFraction` caps) — the payload must report the real
   * number the cap trips at, not an undefined `maximum`.
   */
  private async emitBudgetEvent(
    event: 'budget:warning' | 'budget:block',
    ctx: ExecutionContext,
    cap: Cap,
    current: number,
    limit: number,
    message?: string
  ): Promise<void> {
    if (!this.hooks) return;
    await this.hooks.emit(event, {
      executionContext: ctx,
      field: cap.field,
      maximum: limit,
      current,
      message:
        message ??
        cap.message ??
        `${cap.field} limit is ${limit}, current value is ${Math.round(
          current
        )}`,
    });
  }

  /**
   * Resolve a cap's numeric limit. A `context` cap configured via
   * `contextWindowFraction` has no `maximum`: the limit is
   * `contextWindowFor(modelId) * fraction` (128K fallback for unknown models).
   * Every other cap carries an explicit `maximum` (schema-enforced).
   */
  private resolveCapLimit(cap: Cap, ctx: ExecutionContext): number {
    if (cap.maximum !== undefined) return cap.maximum;
    const provider = ctx.agentDefinition.provider;
    return Math.floor(
      contextWindowFor(provider.model) * (cap.contextWindowFraction ?? 0)
    );
  }

  /**
   * Evaluate a single cap against the snapshot. Mode resolution matches the
   * tool path (`cap.mode ?? dimMode ?? 'warning'`, owner ruling 5): warning
   * (the default) emits `budget:warning` and resolves — the run continues;
   * block emits `budget:block` BEFORE throwing the enforcement error.
   */
  private async evaluateCap(
    cap: Cap,
    snap: Record<string, number>,
    ctx: ExecutionContext,
    dimMode?: string,
    dimScope?: string
  ): Promise<void> {
    const limit = this.resolveCapLimit(cap, ctx);
    const current = this.getSnapshotValue(snap, cap, dimScope);
    if (current < limit) return;
    const capMode = cap.mode ?? dimMode ?? 'warning';
    if (capMode === 'warning') {
      await this.emitBudgetEvent('budget:warning', ctx, cap, current, limit);
      return;
    }
    await this.emitBudgetEvent('budget:block', ctx, cap, current, limit);
    throw makeEnforcementError(cap.field, limit, current, cap.message);
  }

  // ── Enforcement: pre:model_request ────────────────────────────────────────

  private async enforcePreModel(p: PreModelRequestPayload): Promise<void> {
    const { taskId, sessionId, agentName } = p.executionContext;
    const providerType =
      p.executionContext.agentDefinition?.provider?.type ?? 'unknown';
    const acc = this.accumulators.get(taskId);
    if (!acc) return;

    const { caps, mode: dimMode, scope: dimScope } = this.resolveCaps(
      agentName,
      providerType
    );
    // Tool-path-only caps are excluded here: 'toolCalls' is per-tool; the
    // Packet C error budget ('errors'/'consecutiveErrors') is counted at
    // post:tool_call — the only place the error signal exists — and enforced
    // on the tool path only (plan §3 Packet C). 'context' (peak request) is
    // model-path-only and stays in the evaluated set.
    const modelCaps = caps.filter(
      (c) => !TOOL_PATH_ONLY_FIELDS.has(c.field)
    );
    if (modelCaps.length === 0) return;

    // One snapshot, one DB round-trip per unique scope/window. The tools-aware
    // estimate of the PENDING request feeds the 'context' enforcement value
    // (owner ruling 4 — catch early, reject one-request-lag).
    const snap = this.buildSnapshot(
      modelCaps,
      acc,
      taskId,
      sessionId,
      agentName,
      dimScope,
      estimateRequestContext(p.messages, p.tools)
    );
    for (const cap of modelCaps) {
      await this.evaluateCap(cap, snap, p.executionContext, dimMode, dimScope);
    }
  }

  // ── Enforcement: pre:tool_call ────────────────────────────────────────────

  private async enforcePreTool(p: PreToolCallPayload): Promise<void> {
    const { toolName, callId, executionContext } = p;
    const {
      caps,
      mode,
      scope: dimScope,
    } = this.resolveCaps(executionContext.agentName, '', toolName);
    const acc = this.accumulators.get(executionContext.taskId);
    if (!acc) return;

    // 'context' is peak-request — model path only (there is no pending request to
    // estimate at tool-call time). Exclude it from the tool path. The Packet C
    // error-budget fields ('errors'/'consecutiveErrors') PASS through here — they
    // are enforced on this path from the task-level counters fed at
    // post:tool_call (onPostToolCall); warning-by-default falls out of the
    // `cap.mode ?? mode ?? 'warning'` resolution below (owner ruling 5).
    const toolCaps = caps.filter((c) => c.field !== 'context');
    if (toolCaps.length === 0) return;

    const currentToolCalls = acc.toolCalls.get(toolName) ?? 0;
    const snap = this.buildSnapshot(
      toolCaps,
      acc,
      executionContext.taskId,
      executionContext.sessionId,
      executionContext.agentName,
      dimScope
    );

    for (const cap of toolCaps) {
      const limit = this.resolveCapLimit(cap, executionContext);
      const current =
        cap.field === 'toolCalls'
          ? currentToolCalls
          : this.getSnapshotValue(snap, cap, dimScope);
      if (current >= limit) {
        const msg =
          cap.message ??
          `tool "${toolName}": ${cap.field} limit is ${
            limit
          }, current value is ${Math.round(current)}`;
        const capMode = cap.mode ?? mode ?? 'warning';
        if (capMode === 'warning') {
          // Notification only — the IToolWarning soft-block stays the action.
          await this.emitBudgetEvent(
            'budget:warning',
            executionContext,
            cap,
            current,
            limit,
            msg
          );
          throw makeToolWarning(toolName, callId, msg);
        }
        // Notification only (owner ruling 7, symmetric with warning) — the
        // IEnforcementError throw stays the action.
        await this.emitBudgetEvent(
          'budget:block',
          executionContext,
          cap,
          current,
          limit,
          msg
        );
        throw makeEnforcementError(
          `tool:${toolName}:${cap.field}`,
          limit,
          current,
          cap.message
        );
      }
    }

    acc.toolCalls.set(toolName, currentToolCalls + 1);
  }

  // ── Enforcement: transform:tool_result (response size) ────────────────────

  private enforceResponseSize(p: PostToolCallPayload): void {
    const { toolName, result } = p;
    if (typeof result !== 'object' || result === null) return;

    const { caps, mode } = this.resolveCaps('', '', toolName);
    const sizeCaps = caps.filter((c) => c.field === 'responseSize');
    if (sizeCaps.length === 0) return;

    // Flatten text content from tool result
    const resultObj = result as Record<string, unknown>;
    const content = resultObj['content'];
    if (!Array.isArray(content)) return;

    let totalChars = 0;
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const p = part as Record<string, unknown>;
        if (p['type'] === 'text') {
          totalChars += ((p['text'] as string) ?? '').length;
        }
      }
    }

    for (const cap of sizeCaps) {
      // responseSize caps always carry an explicit `maximum` (schema-enforced);
      // resolveCapLimit just narrows the optional for TS.
      const limit = this.resolveCapLimit(cap, p.executionContext);
      if (totalChars <= limit) continue;

      const capMode = cap.mode ?? mode ?? 'warning';
      if (capMode === 'block') {
        resultObj['content'] = [
          {
            type: 'text',
            text:
              cap.message ??
              `Response size (${totalChars} chars) exceeds limit of ${limit}. Use offset/limit or shell paging tools instead.`,
          },
        ];
        p.isError = true;
      } else {
        let remaining = limit;
        const truncated: unknown[] = [];
        for (const part of content) {
          if (typeof part !== 'object' || part === null) {
            truncated.push(part);
            continue;
          }
          const p2 = part as Record<string, unknown>;
          if (p2['type'] !== 'text') {
            truncated.push(part);
            continue;
          }
          const text = (p2['text'] as string) ?? '';
          if (text.length <= remaining) {
            truncated.push(part);
            remaining -= text.length;
          } else {
            truncated.push({ type: 'text', text: text.slice(0, remaining) });
            break;
          }
        }
        truncated.push({
          type: 'text',
          text: `\n\n[truncated: response was ${totalChars} chars, limited to ${
            cap.maximum
          }. ${
            cap.message ??
            'Use offset/limit or shell paging tools for full content.'
          }]`,
        });
        resultObj['content'] = truncated;
      }
      break;
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const createPlugin: PluginFactory = ({ db, config }: PluginContext): Plugin => {
  const pluginCfg = normalizeConfig(config);
  const costIn = pluginCfg.defaults?.costPerInputToken ?? 0;
  const costOut = pluginCfg.defaults?.costPerOutputToken ?? 0;
  // Cache rates default to the flat input rate (BUG-AGENTMCP-008): a config that never
  // sets them bills every input token at costPerInputToken — exactly as before the fix.
  const costRead = pluginCfg.defaults?.costPerCacheReadToken ?? costIn;
  const costWrite = pluginCfg.defaults?.costPerCacheWriteToken ?? costIn;
  return new BudgetPlugin(db, pluginCfg, costIn, costOut, costRead, costWrite);
};

export default createPlugin;
export { createPlugin };
