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

// ── ISO8601 duration parser ──────────────────────────────────────────────────

// Supported tokens: P[n]Y[n]M[n]DT[n]H[n]M[n]S
// e.g. PT24H, PT1H30M, P1DT6H
function parseIsoDuration(dur: string): number {
  const re = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
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

const FIELD_NAMES = [
  'tokens', 'inputTokens', 'outputTokens',
  'calls', 'wallClock', 'modelMs', 'cost',
  'toolCalls',
] as const;

const capSchema = z.object({
  field: z.enum(FIELD_NAMES),
  maximum: z.number().min(0),
  window: z.string().optional(),
  scope: z.enum(['task', 'session', 'agent', 'global']).optional(),
  mode: z.enum(['warning', 'block']).optional(),
});

export type Cap = z.infer<typeof capSchema>;

// ── Dimension config ─────────────────────────────────────────────────────────

const dimensionSchema = z.object({
  caps: z.array(capSchema).optional(),
  mode: z.enum(['warning', 'block']).optional(),
  costPerInputToken: z.number().min(0).optional(),
  costPerOutputToken: z.number().min(0).optional(),
  scope: z.enum(['task', 'session', 'agent', 'global']).optional(),
});

type DimensionConfig = z.infer<typeof dimensionSchema>;

// ── Full plugin config ───────────────────────────────────────────────────────

export const pluginConfigSchema = z.object({
  defaults: dimensionSchema.optional(),
  agent: z.object({
    default: dimensionSchema.optional(),
    overrides: z.record(z.string(), dimensionSchema.partial()).optional().default({}),
  }).optional(),
  provider: z.object({
    default: dimensionSchema.optional(),
    overrides: z.record(z.string(), dimensionSchema.partial()).optional().default({}),
  }).optional(),
  tool: z.object({
    default: dimensionSchema.optional(),
    overrides: z.record(z.string(), dimensionSchema.partial()).optional().default({}),
  }).optional(),
});

export type PluginConfig = z.input<typeof pluginConfigSchema>;

export const configSchema = z.object({}).passthrough();

// ── Backward compat: flat fields → caps ──────────────────────────────────────

const FIELD_MAP: Record<string, { field: Cap['field']; window?: string }> = {
  maxInputTokens:  { field: 'inputTokens' },
  maxOutputTokens: { field: 'outputTokens' },
  maxTotalTokens:  { field: 'tokens' },
  maxModelCalls:   { field: 'calls' },
  maxWallClockMs:  { field: 'wallClock' },
  maxModelMs:      { field: 'modelMs' },
  maxCostUSD:      { field: 'cost' },
  maxTokensPer24h: { field: 'tokens', window: 'PT24H' },
  maxCalls:        { field: 'toolCalls' },
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
    } else if (key === 'scope' || key === 'mode' || key === 'costPerInputToken' || key === 'costPerOutputToken') {
      result[key] = value;
    }
  }

  if (caps.length > 0) result['caps'] = caps;
  return dimensionSchema.parse(result);
}

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
  toolCalls: Map<string, number>;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelCalls: number;
}

// ── Plugin class ─────────────────────────────────────────────────────────────

class BudgetPlugin implements Plugin {
  readonly name = 'agent-mcp-budget';

  private readonly accumulators = new Map<string, BudgetAccumulator>();

  constructor(
    private readonly db: unknown,
    private readonly cfg: PluginConfig,
    private readonly costPerInput = 0,
    private readonly costPerOutput = 0,
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
      toolCalls: new Map(),
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

  private mergeDim(dims: (DimensionConfig | undefined)[]): DimensionConfig {
    let merged: DimensionConfig = { caps: [] };
    for (const d of dims) {
      if (!d) continue;
      merged = {
        caps: [...(merged.caps ?? []), ...(d.caps ?? [])],
        mode: d.mode ?? merged.mode,
        costPerInputToken: d.costPerInputToken ?? merged.costPerInputToken,
        costPerOutputToken: d.costPerOutputToken ?? merged.costPerOutputToken,
        scope: d.scope ?? merged.scope,
      };
    }
    return merged;
  }

  private resolveCaps(
    agentName: string,
    providerType: string,
    toolName?: string,
  ): { caps: Cap[]; mode?: string } {
    const base = this.cfg.defaults;
    const agentDim = this.cfg.agent;
    const provDim = this.cfg.provider;
    const toolDim = this.cfg.tool;

    // Tool-specific path: only tool.default + tool.override (no agent/provider)
    if (toolName) {
      const toolOverride = toolDim?.overrides?.[toolName];
      const merged = this.mergeDim([
        base,
        toolDim?.default,
        toolOverride,
      ]);
      return { caps: merged.caps ?? [], mode: merged.mode };
    }

    // Model-level path: agent + provider defaults and overrides
    const agentOverride = agentDim?.overrides?.[agentName];
    const provOverride = provDim?.overrides?.[providerType];
    const merged = this.mergeDim([
      base,
      agentDim?.default,
      agentOverride,
      provDim?.default,
      provOverride,
    ]);
    return { caps: merged.caps ?? [], mode: merged.mode };
  }

  // ── Scope-aware DB queries ────────────────────────────────────────────────

  private queryScopeTotals(
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
    scope: string,
  ): UsageTotals {
    const acc = this.accumulators.get(taskId);
    const inMem = acc
      ? {
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          cacheTokens: acc.cacheTokens,
          modelCalls: acc.modelCalls,
        }
      : { inputTokens: 0, outputTokens: 0, cacheTokens: 0, modelCalls: 0 };

    if (scope === 'task' || !this.db) return inMem;

    try {
      const db = this.db as {
        prepare: (sql: string) => { get: (...args: unknown[]) => { input: number; output: number; cache: number; calls: number } | undefined };
      };
      let row: { input: number; output: number; cache: number; calls: number } | undefined;

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
      } else if (scope === 'global') {
        row = db
          .prepare(
            `SELECT
               COALESCE(SUM(input_tokens), 0) AS input,
               COALESCE(SUM(output_tokens), 0) AS output,
               COALESCE(SUM(COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)), 0) AS cache,
               COALESCE(SUM(model_calls), 0) AS calls
             FROM task_usage
             WHERE task_id != ?`
          )
          .get(taskId) as typeof row;
      }

      if (row) {
        return {
          inputTokens: (row.input ?? 0) + inMem.inputTokens,
          outputTokens: (row.output ?? 0) + inMem.outputTokens,
          cacheTokens: (row.cache ?? 0) + inMem.cacheTokens,
          modelCalls: (row.calls ?? 0) + inMem.modelCalls,
        };
      }
    } catch { /* fall through */ }

    return inMem;
  }

  private queryWindowTokens(
    scope: string,
    id: string,
    windowMs: number,
    excludeTaskId?: string,
  ): number {
    if (!this.db) return 0;
    try {
      const db = this.db as {
        prepare: (sql: string) => { get: (...args: unknown[]) => { total: number } | undefined };
      };
      const since = new Date(Date.now() - windowMs).toISOString();

      let row: { total: number } | undefined;

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
   */
  private buildSnapshot(
    caps: Cap[],
    acc: BudgetAccumulator,
    taskId: string,
    sessionId: string | undefined,
    agentName: string,
  ): Record<string, number> {
    const snap: Record<string, number> = {};

    snap['inputTokens'] = acc.inputTokens;
    snap['outputTokens'] = acc.outputTokens;
    snap['cacheTokens'] = acc.cacheTokens;
    snap['calls'] = acc.modelCalls;
    snap['wallClock'] = Date.now() - acc.startedAtMs;
    snap['modelMs'] = acc.totalModelMs;
    snap['cost'] =
      acc.inputTokens * this.costPerInput +
      acc.outputTokens * this.costPerOutput;

    const uniqueScopes = new Set<string>();
    const uniqueWindows = new Map<string, { scope: string; windowMs: number }>();
    for (const cap of caps) {
      const scope = cap.scope ?? 'task';
      if (scope !== 'task') uniqueScopes.add(scope);
      if (cap.window) {
        const key = `${scope}:${cap.window}`;
        if (!uniqueWindows.has(key)) {
          uniqueWindows.set(key, { scope, windowMs: parseIsoDuration(cap.window) });
        }
      }
    }

    for (const scope of uniqueScopes) {
      const t = this.queryScopeTotals(taskId, sessionId, agentName, scope);
      snap[`${scope}:inputTokens`] = t.inputTokens;
      snap[`${scope}:outputTokens`] = t.outputTokens;
      snap[`${scope}:calls`] = t.modelCalls;
    }

    for (const [key, { scope, windowMs }] of uniqueWindows) {
      let scopeId = '';
      if (scope === 'session') scopeId = sessionId ?? '';
      else if (scope === 'agent') scopeId = agentName ?? '';
      snap[key] = this.queryWindowTokens(scope, scopeId, windowMs, taskId);
    }

    return snap;
  }

  private getSnapshotValue(snap: Record<string, number>, cap: Cap, toolName?: string): number {
    const scope = cap.scope ?? 'task';
    const scopeKey = scope !== 'task' ? `${scope}:` : '';

    let base: number;
    switch (cap.field) {
      case 'inputTokens':
        base = snap[`${scopeKey}inputTokens`] ?? snap['inputTokens'];
        break;
      case 'outputTokens':
        base = snap[`${scopeKey}outputTokens`] ?? snap['outputTokens'];
        break;
      case 'tokens':
        base = (snap[`${scopeKey}inputTokens`] ?? snap['inputTokens'])
            + (snap[`${scopeKey}outputTokens`] ?? snap['outputTokens'])
            + snap['cacheTokens'];
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
      default:
        base = 0;
    }

    if (cap.window) {
      base += snap[`${scope}:${cap.window}`] ?? 0;
    }

    return base;
  }

  private evaluateCap(cap: Cap, snap: Record<string, number>, acc?: BudgetAccumulator, toolName?: string): void {
    const current = cap.field === 'toolCalls'
      ? (acc?.toolCalls.get(toolName ?? '') ?? 0)
      : this.getSnapshotValue(snap, cap, toolName);
    if (current >= cap.maximum) {
      throw makeEnforcementError(cap.field, cap.maximum, current);
    }
  }

  // ── Enforcement: pre:model_request ────────────────────────────────────────

  private enforcePreModel(p: PreModelRequestPayload): void {
    const { taskId, sessionId, agentName } = p.executionContext;
    const providerType = p.executionContext.agentDefinition?.provider?.type ?? 'unknown';
    const acc = this.accumulators.get(taskId);
    if (!acc) return;

    const { caps } = this.resolveCaps(agentName, providerType);
    const modelCaps = caps.filter(c => c.field !== 'toolCalls');
    if (modelCaps.length === 0) return;

    // One snapshot, one DB round-trip per unique scope/window
    const snap = this.buildSnapshot(modelCaps, acc, taskId, sessionId, agentName);
    for (const cap of modelCaps) {
      this.evaluateCap(cap, snap);
    }
  }

  // ── Enforcement: pre:tool_call ────────────────────────────────────────────

  private enforcePreTool(p: PreToolCallPayload): void {
    const { toolName, callId, executionContext } = p;
    const { caps, mode } = this.resolveCaps(executionContext.agentName, '', toolName);
    const acc = this.accumulators.get(executionContext.taskId);
    if (!acc) return;

    if (caps.length === 0) return;

    const currentToolCalls = acc.toolCalls.get(toolName) ?? 0;
    const snap = this.buildSnapshot(caps, acc, executionContext.taskId, undefined, executionContext.agentName);

    for (const cap of caps) {
      const current = cap.field === 'toolCalls'
        ? currentToolCalls
        : this.getSnapshotValue(snap, cap, toolName);
      if (current >= cap.maximum) {
        const msg = `tool "${toolName}": ${cap.field} limit is ${cap.maximum}, current value is ${Math.round(current)}`;
        const capMode = cap.mode ?? mode ?? 'warning';
        if (capMode === 'warning') {
          throw makeToolWarning(toolName, callId, msg);
        }
        throw makeEnforcementError(`tool:${toolName}:${cap.field}`, cap.maximum, current);
      }
    }

    acc.toolCalls.set(toolName, currentToolCalls + 1);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const createPlugin: PluginFactory = ({ db, config }: PluginContext): Plugin => {
  const pluginCfg = normalizeConfig(config);
  const costIn = pluginCfg.defaults?.costPerInputToken ?? 0;
  const costOut = pluginCfg.defaults?.costPerOutputToken ?? 0;
  return new BudgetPlugin(db, pluginCfg, costIn, costOut);
};

export default createPlugin;
export { createPlugin };
