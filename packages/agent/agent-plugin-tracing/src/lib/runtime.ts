import { createHash } from 'node:crypto';
import { newTraceId } from '@adhd/sox-telemetry';
import type { OtelAttributes } from '@adhd/sox-telemetry';
import type { ExecutionContext } from '@adhd/agent-base-types';
import { TracingCounters } from './counters.js';
import { OpenSpan } from './spans.js';

/** Longest `captureArgs` payload recorded verbatim (characters). */
const MAX_CAPTURED_ARGS = 2000;

/** How many ended task ids are remembered (FIFO) so late events cannot resurrect their state. */
export const MAX_ENDED_TASKS = 4096;

interface ToolSpan {
  span: OpenSpan;
  startedAt: number;
  tool: string;
}

export interface TaskState {
  span?: OpenSpan;
  /** Monotonic ms of `task:start`; undefined for a task first seen mid-flight (no latency to report). */
  startedAt?: number;
  traceId: string;
  model?: { span: OpenSpan; startedAt: number };
  tools: Map<string, ToolSpan>;
}

/**
 * Mutable per-process tracing state shared by the event mappings: open spans keyed by the
 * operation that owns them, the trace-id table, and the metric counters.
 *
 * Trace correlation: every span of a delegation tree shares ONE `trace_id` (keyed by the root
 * task id); a session's own span has its own. Parent linkage is by the `agent.*_id`
 * attributes, because the substrate's span processor does not stamp `parent_span_id`
 * (spec open item (a)).
 */
export class TraceRuntime {
  readonly counters = new TracingCounters();
  readonly sessions = new Map<string, { span: OpenSpan; traceId: string }>();
  readonly tasks = new Map<string, TaskState>();
  /** `parkedTaskId` → when its `hitl:suspend` fired, so `hitl:resume` can attach `wait_ms`. */
  readonly suspendedAt = new Map<string, number>();
  private readonly traceIds = new Map<string, string>();
  /**
   * Ids of tasks that already reached a terminal (bounded, oldest evicted first). A late event for
   * one of these (`post:tool_call`, `permission:decision`, `hitl:resume` racing a cancel) must not
   * lazily recreate per-task state that nothing would ever delete.
   */
  private readonly ended = new Set<string>();

  constructor(
    readonly captureArgs: boolean,
    /** Invoked on every root/child task terminal so the host can persist a metrics snapshot. */
    private readonly onTaskTerminal: () => void = () => undefined
  ) {}

  /** Ask the host to write a metrics snapshot (never throws). */
  requestSnapshot(): void {
    try {
      this.onTaskTerminal();
    } catch {
      /* telemetry must never break a task */
    }
  }

  /** Monotonic milliseconds. */
  now(): number {
    return performance.now();
  }

  /**
   * The trace id for the delegation tree `ctx` belongs to (created on first sight). For a tree
   * whose root already ended the id is NOT cached — a late event still gets a trace id, but no
   * table entry that would outlive it.
   */
  traceFor(ctx: ExecutionContext): string {
    const root = ctx.rootTaskId ?? ctx.taskId;
    let id = this.traceIds.get(root);
    if (id === undefined) {
      id = newTraceId();
      if (!this.ended.has(root)) this.traceIds.set(root, id);
    }
    return id;
  }

  /** Forget a finished root task's trace id. */
  releaseTrace(ctx: ExecutionContext): void {
    if ((ctx.rootTaskId ?? ctx.taskId) === ctx.taskId) this.traceIds.delete(ctx.taskId);
  }

  /**
   * The task's state, created lazily so events for a task that began before install still trace.
   * Returns `undefined` for a task that has already ended: its late events are counted but never
   * resurrect state.
   */
  task(ctx: ExecutionContext): TaskState | undefined {
    let state = this.tasks.get(ctx.taskId);
    if (state === undefined) {
      if (this.ended.has(ctx.taskId)) return undefined;
      state = { traceId: this.traceFor(ctx), tools: new Map() };
      this.tasks.set(ctx.taskId, state);
    }
    return state;
  }

  /** Sizes of every per-process table — what a leak looks like (all zero once nothing is live). */
  stateSizes(): { sessions: number; tasks: number; traces: number; suspended: number; ended: number } {
    return {
      sessions: this.sessions.size,
      tasks: this.tasks.size,
      traces: this.traceIds.size,
      suspended: this.suspendedAt.size,
      ended: this.ended.size,
    };
  }

  /** State for a `task:start`: a (re)start clears any ended mark and records `startedAt`. */
  startTask(ctx: ExecutionContext): TaskState {
    this.ended.delete(ctx.taskId);
    const state = this.task(ctx) as TaskState; // not ended, so always defined
    state.startedAt = this.now();
    return state;
  }

  /** Mark `ctx`'s task terminal: drop its state and remember the id (bounded) against late events. */
  finishTask(ctx: ExecutionContext): void {
    this.tasks.delete(ctx.taskId);
    this.suspendedAt.delete(ctx.taskId);
    this.releaseTrace(ctx);
    this.ended.add(ctx.taskId);
    if (this.ended.size > MAX_ENDED_TASKS) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  /**
   * Close every span still open — tasks, their model/tool spans, sessions — as
   * `agent.outcome: "unclosed"` and release all per-process state. Called at dispose so a
   * shutdown never strands a `.start` record without a terminal one. Resolves once every
   * terminal record has reached the sink (so the caller may then close it).
   */
  closeAll(): Promise<void> {
    const closing: OpenSpan[] = [];
    const close = (span: OpenSpan | undefined): void => {
      if (span?.isOpen) {
        span.close({ attrs: { 'agent.outcome': 'unclosed' } });
        closing.push(span);
      }
    };
    for (const state of this.tasks.values()) {
      close(state.model?.span);
      for (const tool of state.tools.values()) close(tool.span);
      close(state.span);
    }
    for (const { span } of this.sessions.values()) close(span);
    this.tasks.clear();
    this.sessions.clear();
    this.suspendedAt.clear();
    this.traceIds.clear();
    this.ended.clear();
    return Promise.all(closing.map((s) => s.written)).then(() => undefined);
  }

  /** Identity attributes carried by every span of a task. */
  taskAttrs(ctx: ExecutionContext, traceId: string): OtelAttributes {
    const attrs: OtelAttributes = {
      trace_id: traceId,
      'agent.session_id': ctx.sessionId,
      'agent.task_id': ctx.taskId,
      'agent.root_task_id': ctx.rootTaskId ?? ctx.taskId,
      'agent.name': ctx.agentName,
      'agent.recursion_depth': ctx.recursionDepth,
    };
    if (ctx.parentTaskId !== undefined) attrs['agent.parent_task_id'] = ctx.parentTaskId;
    if (ctx.callingAgentName !== undefined) attrs['agent.calling_agent'] = ctx.callingAgentName;
    return attrs;
  }

  /** Tool arguments: always a sha256 digest; the (truncated) value itself only under `captureArgs`. */
  argAttrs(input: unknown): OtelAttributes {
    const json = safeJson(input);
    const attrs: OtelAttributes = {
      'agent.tool.args_sha256': `sha256:${createHash('sha256').update(json).digest('hex')}`,
    };
    if (this.captureArgs) attrs['agent.tool.args'] = json.slice(0, MAX_CAPTURED_ARGS);
    return attrs;
  }

  /** End every span still open under `taskId` (a task ended while a model/tool call was in flight). */
  closeDangling(state: TaskState): void {
    if (state.model?.span.isOpen) state.model.span.close({ attrs: { 'agent.outcome': 'unclosed' } });
    for (const tool of state.tools.values()) {
      tool.span.close({ attrs: { 'agent.outcome': 'unclosed' } });
    }
    state.model = undefined;
    state.tools.clear();
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}
