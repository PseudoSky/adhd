import { z } from 'zod';
import type {
  IHookRegistry,
  IEnforcementError,
  IToolWarning,
  Plugin,
  PluginContext,
  PluginFactory,
  PreModelRequestPayload,
  PostModelResponsePayload,
  TaskStartPayload,
  PreToolCallPayload,
} from '@adhd/agent-mcp-types';

// ── Budget-fields schema (shared by all dimensions) ──────────────────────────

const budgetFieldsSchema = z.object({
  scope: z.enum(['task', 'session', 'agent']).default('task'),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
  maxModelMs: z.number().int().positive().optional(),
  maxCostUSD: z.number().positive().optional(),
  costPerInputToken: z.number().min(0).default(0),
  costPerOutputToken: z.number().min(0).default(0),
  maxTokensPer24h: z.number().int().positive().optional(),
});

export type BudgetFields = z.infer<typeof budgetFieldsSchema>;

// ── Tool-specific fields (extends budget fields with mode + maxCalls) ────────

const toolFieldsSchema = budgetFieldsSchema.extend({
  mode: z.enum(['warning', 'block']).default('warning'),
  maxCalls: z.number().int().min(0).optional(),
});

type ToolFields = z.infer<typeof toolFieldsSchema>;

// ── Full plugin config ───────────────────────────────────────────────────────

export const pluginConfigSchema = z.object({
  defaults: budgetFieldsSchema.optional(),
  agent: z.object({
    default: budgetFieldsSchema.partial().optional(),
    overrides: z.record(z.string(), budgetFieldsSchema.partial()).optional().default({}),
  }).optional(),
  provider: z.object({
    default: budgetFieldsSchema.partial().optional(),
    overrides: z.record(z.string(), budgetFieldsSchema.partial()).optional().default({}),
  }).optional(),
  tool: z.object({
    default: toolFieldsSchema.partial().optional(),
    overrides: z.record(z.string(), toolFieldsSchema.partial()).optional().default({}),
  }).optional(),
});

export type PluginConfig = z.infer<typeof pluginConfigSchema>;

/**
 * Config schema for server-side validation.
 * Accepts any object — the raw config is passed through to the factory where
 * normalizeConfig handles both flat (legacy) and multi-dimension formats.
 */
export const configSchema = z.object({}).passthrough();

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeConfig(raw: unknown): PluginConfig {
  const obj = raw as Record<string, unknown>;
  if (
    obj['defaults'] !== undefined ||
    obj['agent'] !== undefined ||
    obj['provider'] !== undefined ||
    obj['tool'] !== undefined
  ) {
    const parsed = pluginConfigSchema.parse(raw);
    return {
      defaults: parsed.defaults ?? budgetFieldsSchema.parse({}),
      agent: parsed.agent ?? { default: undefined, overrides: {} },
      provider: parsed.provider ?? { default: undefined, overrides: {} },
      tool: parsed.tool ?? { default: undefined, overrides: {} },
    };
  }
  return {
    defaults: budgetFieldsSchema.parse(raw),
    agent: { default: undefined, overrides: {} },
    provider: { default: undefined, overrides: {} },
    tool: { default: undefined, overrides: {} },
  };
}

function makeEnforcementError(limitName: string, limit: number, current: number): IEnforcementError {
  return {
    isEnforcementError: true as const,
    code: 'BUDGET_EXCEEDED',
    message: `${limitName} limit is ${limit}, current value is ${Math.round(current)}`,
  };
}

function makeToolWarning(toolName: string, callId: string, message: string): IToolWarning {
  return { isToolWarning: true, toolName, callId, message };
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelCalls: number;
}

// ── In-memory accumulator ────────────────────────────────────────────────────

interface BudgetAccumulator {
  taskId: string;
  sessionId?: string;
  agentName: string;
  providerType: string;
  startedAtMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelCalls: number;
  totalModelMs: number;
  modelCallStartMs?: number;
}

// ── Plugin class ─────────────────────────────────────────────────────────────

class BudgetPlugin implements Plugin {
  readonly name = 'agent-mcp-budget';

  private readonly accumulators = new Map<string, BudgetAccumulator>();

  constructor(
    private readonly db: unknown,
    private readonly cfg: PluginConfig,
  ) {}

  install(hooks: IHookRegistry): void {
    hooks.register('task:start', (p) => {
      try { this.onTaskStart(p); } catch { /* observational */ }
    });
    hooks.register('pre:model_request', (p) => {
      try { this.onPreModelRequest(p); } catch { /* observational */ }
    });
    hooks.register('post:model_response', (p) => {
      try { this.onPostModelResponse(p); } catch { /* observational */ }
    });
    hooks.register('task:completed', (p) => {
      try { this.onTerminal(p.executionContext.taskId); } catch { /**/ }
    });
    hooks.register('task:failed', (p) => {
      try { this.onTerminal(p.executionContext.taskId); } catch { /**/ }
    });
    hooks.register('task:cancelled', (p) => {
      try { this.onTerminal(p.executionContext.taskId); } catch { /**/ }
    });

    hooks.registerEnforcement('pre:model_request', (p) => this.enforcePreModel(p));
    hooks.registerEnforcement('pre:tool_call', (p) => this.enforcePreTool(p));
  }

  // ── Observational handlers ────────────────────────────────────────────────

  private onTaskStart(p: TaskStartPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    const providerType = p.executionContext.agentDefinition?.provider?.type ?? 'unknown';
    this.accumulators.set(taskId, {
      taskId,
      sessionId: sessionId ?? undefined,
      agentName,
      providerType,
      startedAtMs: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      modelCalls: 0,
      totalModelMs: 0,
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
      acc.inputTokens += usage.inputTokens ?? 0;
      acc.outputTokens += usage.outputTokens ?? 0;
      acc.cacheTokens +=
        (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
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

  // ── Config resolution ─────────────────────────────────────────────────────

  private resolveAgentConfig(agentName: string): BudgetFields {
    const agentCfg = this.cfg.agent!;
    const base = this.cfg.defaults!;
    const dim = agentCfg.default;
    const override = agentCfg.overrides[agentName];
    let merged = { ...base };
    if (dim) merged = { ...merged, ...dim };
    if (override) merged = { ...merged, ...override };
    return merged as BudgetFields;
  }

  private resolveProviderConfig(providerType: string): BudgetFields {
    const provCfg = this.cfg.provider!;
    const base = this.cfg.defaults!;
    const dim = provCfg.default;
    const override = provCfg.overrides[providerType];
    let merged = { ...base };
    if (dim) merged = { ...merged, ...dim };
    if (override) merged = { ...merged, ...override };
    return merged as BudgetFields;
  }

  private resolveToolConfig(toolName: string): ToolFields {
    const toolCfg = this.cfg.tool!;
    const base = this.cfg.defaults!;
    const dim = toolCfg.default;
    const override = toolCfg.overrides[toolName];
    let merged = { ...base };
    if (dim) merged = { ...merged, ...dim };
    if (override) merged = { ...merged, ...override };
    return merged as ToolFields;
  }

  // ── Enforcement: pre:model_request (agent / provider / time) ──────────────

  private enforcePreModel(p: PreModelRequestPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    const providerType = p.executionContext.agentDefinition?.provider?.type ?? 'unknown';
    const acc = this.accumulators.get(taskId);
    if (!acc) return;

    const agentCfg = this.resolveAgentConfig(agentName);
    const providerCfg = this.resolveProviderConfig(providerType);

    // Check agent-level limits
    this.checkLimits(agentCfg, acc, taskId, sessionId, agentName);

    // Check provider-level limits (merged atop agent + defaults)
    this.checkLimits(providerCfg, acc, taskId, sessionId, agentName);
  }

  private checkLimits(
    c: BudgetFields,
    acc: BudgetAccumulator,
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
  ): void {
    const totals = this.resolveTotals(acc, taskId, sessionId, agentName, c.scope);
    const wallClockMs = Date.now() - acc.startedAtMs;
    const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheTokens;
    const estimatedCost =
      totals.inputTokens * c.costPerInputToken +
      totals.outputTokens * c.costPerOutputToken;

    if (c.maxInputTokens !== undefined && totals.inputTokens >= c.maxInputTokens)
      throw makeEnforcementError('maxInputTokens', c.maxInputTokens, totals.inputTokens);
    if (c.maxOutputTokens !== undefined && totals.outputTokens >= c.maxOutputTokens)
      throw makeEnforcementError('maxOutputTokens', c.maxOutputTokens, totals.outputTokens);
    if (c.maxTotalTokens !== undefined && totalTokens >= c.maxTotalTokens)
      throw makeEnforcementError('maxTotalTokens', c.maxTotalTokens, totalTokens);
    if (c.maxModelCalls !== undefined && totals.modelCalls >= c.maxModelCalls)
      throw makeEnforcementError('maxModelCalls', c.maxModelCalls, totals.modelCalls);
    if (c.maxWallClockMs !== undefined && wallClockMs >= c.maxWallClockMs)
      throw makeEnforcementError('maxWallClockMs', c.maxWallClockMs, wallClockMs);
    if (c.maxModelMs !== undefined && acc.totalModelMs >= c.maxModelMs)
      throw makeEnforcementError('maxModelMs', c.maxModelMs, acc.totalModelMs);
    if (c.maxCostUSD !== undefined && estimatedCost >= c.maxCostUSD)
      throw makeEnforcementError('maxCostUSD', c.maxCostUSD, estimatedCost);

    // 24h rolling window
    if (c.maxTokensPer24h !== undefined && this.db) {
      const tokens24h = this.queryTokens24h(agentName, sessionId, c.scope);
      if (totalTokens + tokens24h >= c.maxTokensPer24h)
        throw makeEnforcementError('maxTokensPer24h', c.maxTokensPer24h, totalTokens + tokens24h);
    }
  }

  // ── Enforcement: pre:tool_call (tool-level limits) ───────────────────────

  private enforcePreTool(p: PreToolCallPayload): void {
    const { toolName, callId } = p;
    const c = this.resolveToolConfig(toolName);

    if (c.maxCalls !== undefined) {
      // Count tool calls from the accumulator and DB
      const toolCallCount = this.countToolCalls(p.executionContext.taskId, toolName);
      if (toolCallCount >= c.maxCalls) {
        const msg = `tool "${toolName}": maxCalls limit is ${c.maxCalls}, current value is ${toolCallCount}`;
        if (c.mode === 'warning') {
          throw makeToolWarning(toolName, callId, msg);
        }
        throw makeEnforcementError(`tool:${toolName}:maxCalls`, c.maxCalls, toolCallCount);
      }
    }

    if (c.maxTotalTokens !== undefined) {
      const acc = this.accumulators.get(p.executionContext.taskId);
      if (acc) {
        const totalTokens = acc.inputTokens + acc.outputTokens + acc.cacheTokens;
        if (totalTokens >= c.maxTotalTokens) {
          const msg = `tool "${toolName}": maxTotalTokens limit is ${c.maxTotalTokens}`;
          if (c.mode === 'warning') {
            throw makeToolWarning(toolName, callId, msg);
          }
          throw makeEnforcementError(`tool:${toolName}:maxTotalTokens`, c.maxTotalTokens, totalTokens);
        }
      }
    }
  }

  // ── Tool call counting ───────────────────────────────────────────────────

  /**
   * Count how many times a tool has been called in the current task.
   * In-memory only for now (task scope).
   */
  private countToolCalls(
    _taskId: string,
    _toolName: string,
  ): number {
    // TODO: add proper per-tool call tracking (extend accumulator or query
    // task_events for TOOL_CALL events).
    return 0;
  }

  // ── 24h rolling window query ─────────────────────────────────────────────

  private queryTokens24h(
    agentName: string,
    sessionId: string | undefined,
    scope: string,
  ): number {
    try {
      const db = this.db as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let row: { total: number } | undefined;

      if (scope === 'session' && sessionId) {
        row = db
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
             FROM task_usage
             WHERE session_id = ? AND created_at >= ?`
          )
          .get(sessionId, since) as { total: number } | undefined;
      } else if (scope === 'agent') {
        row = db
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
             FROM task_usage
             WHERE agent_name = ? AND created_at >= ?`
          )
          .get(agentName, since) as { total: number } | undefined;
      }

      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Scope-aware totals ───────────────────────────────────────────────────

  private resolveTotals(
    acc: BudgetAccumulator,
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
    scope: string,
  ): UsageTotals {
    if (scope === 'task' || !this.db) {
      return {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheTokens: acc.cacheTokens,
        modelCalls: acc.modelCalls,
      };
    }

    try {
      const db = this.db as {
        prepare: (sql: string) => { get: (...args: unknown[]) => { input: number; output: number; cache: number; calls: number } | undefined };
      };
      let row:
        | { input: number; output: number; cache: number; calls: number }
        | undefined;

      if (scope === 'session' && sessionId) {
        row = db
          .prepare(
            `SELECT
               COALESCE(SUM(tu.input_tokens), 0) AS input,
               COALESCE(SUM(tu.output_tokens), 0) AS output,
               COALESCE(SUM(COALESCE(tu.cache_read_input_tokens,0) + COALESCE(tu.cache_creation_input_tokens,0)), 0) AS cache,
               COALESCE(SUM(tu.model_calls), 0) AS calls
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
               COALESCE(SUM(COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)), 0) AS cache,
               COALESCE(SUM(model_calls), 0) AS calls
             FROM task_usage
             WHERE agent_name = ? AND task_id != ?`
          )
          .get(agentName, taskId) as typeof row;
      }

      if (row) {
        return {
          inputTokens: (row.input ?? 0) + acc.inputTokens,
          outputTokens: (row.output ?? 0) + acc.outputTokens,
          cacheTokens: (row.cache ?? 0) + acc.cacheTokens,
          modelCalls: (row.calls ?? 0) + acc.modelCalls,
        };
      }
    } catch {
      // DB query failed — fall back to in-memory
    }

    return {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheTokens: acc.cacheTokens,
      modelCalls: acc.modelCalls,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const createPlugin: PluginFactory = ({ db, config }: PluginContext): Plugin => {
  const pluginCfg = normalizeConfig(config);
  return new BudgetPlugin(db, pluginCfg);
};

export default createPlugin;
export { createPlugin };
