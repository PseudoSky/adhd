import { z } from 'zod';
import type {
  IHookRegistry,
  IEnforcementError,
  Plugin,
  PluginContext,
  PluginFactory,
  PreModelRequestPayload,
  PostModelResponsePayload,
  TaskStartPayload,
} from '@adhd/agent-mcp-types';

// ── Config schema ─────────────────────────────────────────────────────────────

export const configSchema = z.object({
  /**
   * Accumulation scope for multi-task limits.
   * - "task"    — in-memory only; zero DB reads; resets on each new task (default)
   * - "session" — sums token usage across all tasks in the same session
   * - "agent"   — sums token usage across all tasks run by the same agent
   */
  scope: z.enum(['task', 'session', 'agent']).default('task'),

  /** Max input tokens (per scope). */
  maxInputTokens: z.number().int().positive().optional(),
  /** Max output tokens (per scope). */
  maxOutputTokens: z.number().int().positive().optional(),
  /** Max total tokens = input + output + cache tokens (per scope). */
  maxTotalTokens: z.number().int().positive().optional(),
  /** Max number of model (LLM) calls (per scope). */
  maxModelCalls: z.number().int().positive().optional(),
  /** Max wall-clock time in ms from task:start to next pre:model_request. */
  maxWallClockMs: z.number().int().positive().optional(),
  /** Max cumulative LLM call time in ms (sum of pre→post model response durations). */
  maxModelMs: z.number().int().positive().optional(),

  /** Max estimated cost in USD. Requires costPerInputToken + costPerOutputToken. */
  maxCostUSD: z.number().positive().optional(),
  /** Cost per input token in USD (e.g. 0.000003 for $3/M tokens). */
  costPerInputToken: z.number().min(0).default(0),
  /** Cost per output token in USD (e.g. 0.000015 for $15/M tokens). */
  costPerOutputToken: z.number().min(0).default(0),
});

export type BudgetConfig = z.infer<typeof configSchema>;

// ── In-memory accumulator ─────────────────────────────────────────────────────

interface BudgetAccumulator {
  taskId: string;
  sessionId?: string;
  agentName: string;
  startedAtMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelCalls: number;
  totalModelMs: number;
  modelCallStartMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnforcementError(
  limitName: string,
  limit: number,
  current: number
): IEnforcementError {
  return {
    isEnforcementError: true as const,
    code: 'BUDGET_EXCEEDED',
    message: `BUDGET_EXCEEDED: ${limitName} limit is ${limit}, current value is ${Math.round(
      current
    )}`,
  };
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelCalls: number;
}

// ── Plugin class ──────────────────────────────────────────────────────────────

class BudgetPlugin implements Plugin {
  readonly name = 'agent-mcp-budget';

  private readonly accumulators = new Map<string, BudgetAccumulator>();

  constructor(
    private readonly db: unknown,
    private readonly cfg: BudgetConfig
  ) {}

  install(hooks: IHookRegistry): void {
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

    // Enforcement — throws propagate (no try/catch wrapper)
    hooks.registerEnforcement('pre:model_request', (p) => this.enforce(p));
  }

  // ── Observational handlers ────────────────────────────────────────────────

  private onTaskStart(p: TaskStartPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    this.accumulators.set(taskId, {
      taskId,
      sessionId: sessionId ?? undefined,
      agentName,
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

  // ── Enforcement ───────────────────────────────────────────────────────────

  private enforce(p: PreModelRequestPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    const acc = this.accumulators.get(taskId);
    if (!acc) return;

    const totals = this.resolveTotals(
      acc,
      taskId,
      sessionId ?? undefined,
      agentName
    );
    const wallClockMs = Date.now() - acc.startedAtMs;
    const totalTokens =
      totals.inputTokens + totals.outputTokens + totals.cacheTokens;
    const estimatedCost =
      totals.inputTokens * this.cfg.costPerInputToken +
      totals.outputTokens * this.cfg.costPerOutputToken;

    const c = this.cfg;
    if (
      c.maxInputTokens !== undefined &&
      totals.inputTokens >= c.maxInputTokens
    )
      throw makeEnforcementError(
        'maxInputTokens',
        c.maxInputTokens,
        totals.inputTokens
      );
    if (
      c.maxOutputTokens !== undefined &&
      totals.outputTokens >= c.maxOutputTokens
    )
      throw makeEnforcementError(
        'maxOutputTokens',
        c.maxOutputTokens,
        totals.outputTokens
      );
    if (c.maxTotalTokens !== undefined && totalTokens >= c.maxTotalTokens)
      throw makeEnforcementError(
        'maxTotalTokens',
        c.maxTotalTokens,
        totalTokens
      );
    if (c.maxModelCalls !== undefined && totals.modelCalls >= c.maxModelCalls)
      throw makeEnforcementError(
        'maxModelCalls',
        c.maxModelCalls,
        totals.modelCalls
      );
    if (c.maxWallClockMs !== undefined && wallClockMs >= c.maxWallClockMs)
      throw makeEnforcementError(
        'maxWallClockMs',
        c.maxWallClockMs,
        wallClockMs
      );
    if (c.maxModelMs !== undefined && acc.totalModelMs >= c.maxModelMs)
      throw makeEnforcementError('maxModelMs', c.maxModelMs, acc.totalModelMs);
    if (c.maxCostUSD !== undefined && estimatedCost >= c.maxCostUSD)
      throw makeEnforcementError('maxCostUSD', c.maxCostUSD, estimatedCost);
  }

  /**
   * Resolve token/call totals for the configured scope.
   *
   * Task scope: in-memory accumulator only.
   * Session/agent scope: DB total for prior tasks in scope + accumulator for
   *   current task. We exclude the current task from the DB query to avoid
   *   double-counting (UsagePlugin UPSERTs prior turns; current turn is
   *   in-memory only).
   */
  private resolveTotals(
    acc: BudgetAccumulator,
    taskId: string,
    sessionId: string | undefined,
    agentName: string
  ): UsageTotals {
    if (this.cfg.scope === 'task' || !this.db) {
      return {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheTokens: acc.cacheTokens,
        modelCalls: acc.modelCalls,
      };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = this.db as any;
      let row:
        | { input: number; output: number; cache: number; calls: number }
        | undefined;

      if (this.cfg.scope === 'session' && sessionId) {
        row = db
          .prepare(
            `
                    SELECT
                        COALESCE(SUM(tu.input_tokens), 0) AS input,
                        COALESCE(SUM(tu.output_tokens), 0) AS output,
                        COALESCE(SUM(COALESCE(tu.cache_read_input_tokens,0) + COALESCE(tu.cache_creation_input_tokens,0)), 0) AS cache,
                        COALESCE(SUM(tu.model_calls), 0) AS calls
                    FROM task_usage tu
                    JOIN tasks t ON tu.task_id = t.id
                    WHERE t.session_id = ? AND tu.task_id != ?
                `
          )
          .get(sessionId, taskId) as typeof row;
      } else if (this.cfg.scope === 'agent') {
        row = db
          .prepare(
            `
                    SELECT
                        COALESCE(SUM(input_tokens), 0) AS input,
                        COALESCE(SUM(output_tokens), 0) AS output,
                        COALESCE(SUM(COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)), 0) AS cache,
                        COALESCE(SUM(model_calls), 0) AS calls
                    FROM task_usage
                    WHERE agent_name = ? AND task_id != ?
                `
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
  return new BudgetPlugin(db, config as BudgetConfig);
};

export default createPlugin;
export { createPlugin };
