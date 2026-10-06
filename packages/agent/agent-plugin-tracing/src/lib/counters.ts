/** Count / sum / max accumulator for a latency series (milliseconds). */
export interface LatencySeries {
  count: number;
  sum_ms: number;
  max_ms: number;
}

/** The `agent_tracing` section of `metrics.snapshot`. Rates are derived by the reader, never stored. */
export interface TracingSnapshot {
  sessions: { created: number; closed: number };
  tasks: { started: number; completed: number; failed: number; cancelled: number };
  model_calls: number;
  tool_calls: { total: number; errors: number };
  by_tool: Record<string, { calls: number; errors: number }>;
  tokens: { input: number; output: number };
  permission: { allow: number; ask: number; deny: number };
  ask_outcomes: { suspend: number; escalate: number; deny: number };
  hitl: { suspend: number; resume: number; by_outcome: Record<string, number> };
  delegations: number;
  delegation_depth_max: number;
  latency_ms: { task: LatencySeries; model_call: LatencySeries; tool_call: LatencySeries };
}

/** Distinct tool names tracked individually; the rest fold into `_other` (bounded cardinality). */
const MAX_TOOLS = 256;

const series = (): LatencySeries => ({ count: 0, sum_ms: 0, max_ms: 0 });

/** In-memory counters backing the `agent_tracing` snapshot section. */
export class TracingCounters {
  private data: TracingSnapshot = TracingCounters.empty();

  static empty(): TracingSnapshot {
    return {
      sessions: { created: 0, closed: 0 },
      tasks: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      model_calls: 0,
      tool_calls: { total: 0, errors: 0 },
      by_tool: {},
      tokens: { input: 0, output: 0 },
      permission: { allow: 0, ask: 0, deny: 0 },
      ask_outcomes: { suspend: 0, escalate: 0, deny: 0 },
      hitl: { suspend: 0, resume: 0, by_outcome: {} },
      delegations: 0,
      delegation_depth_max: 0,
      latency_ms: { task: series(), model_call: series(), tool_call: series() },
    };
  }

  sessionCreated(): void {
    this.data.sessions.created++;
  }
  sessionClosed(): void {
    this.data.sessions.closed++;
  }

  taskStarted(depth: number, delegated: boolean): void {
    this.data.tasks.started++;
    if (delegated) this.data.delegations++;
    if (depth > this.data.delegation_depth_max) this.data.delegation_depth_max = depth;
  }
  taskEnded(kind: 'completed' | 'failed' | 'cancelled', ms: number | undefined): void {
    this.data.tasks[kind]++;
    if (ms !== undefined) this.observe(this.data.latency_ms.task, ms);
  }

  modelCall(input: number, output: number, ms: number | undefined): void {
    this.data.model_calls++;
    this.data.tokens.input += input;
    this.data.tokens.output += output;
    if (ms !== undefined) this.observe(this.data.latency_ms.model_call, ms);
  }

  toolCall(tool: string, isError: boolean, ms: number | undefined): void {
    this.data.tool_calls.total++;
    if (isError) this.data.tool_calls.errors++;
    const key = tool in this.data.by_tool || Object.keys(this.data.by_tool).length < MAX_TOOLS ? tool : '_other';
    const row = (this.data.by_tool[key] ??= { calls: 0, errors: 0 });
    row.calls++;
    if (isError) row.errors++;
    if (ms !== undefined) this.observe(this.data.latency_ms.tool_call, ms);
  }

  permission(action: 'allow' | 'ask' | 'deny', resolution: 'allow' | 'suspend' | 'escalate' | 'deny'): void {
    this.data.permission[action]++;
    if (action === 'ask' && resolution !== 'allow') this.data.ask_outcomes[resolution]++;
  }

  hitlSuspend(): void {
    this.data.hitl.suspend++;
  }
  hitlResume(outcome: string): void {
    this.data.hitl.resume++;
    this.data.hitl.by_outcome[outcome] = (this.data.hitl.by_outcome[outcome] ?? 0) + 1;
  }

  /** A deep copy — the host serialises it into the snapshot record. */
  snapshot(): TracingSnapshot {
    return structuredClone(this.data);
  }

  private observe(s: LatencySeries, ms: number): void {
    s.count++;
    s.sum_ms += ms;
    if (ms > s.max_ms) s.max_ms = ms;
  }
}
