import type { ExecutionContext, HookEvent, HookEventMap, IHookRegistry } from '@adhd/agent-base-types';
import { newTraceId } from '@adhd/sox-telemetry';
import type { OtelAttributes } from '@adhd/sox-telemetry';
import { openSpan, pointSpan } from './spans.js';
import type { TraceRuntime } from './runtime.js';

/**
 * One hook event → its tracing behaviour.
 *
 * `handle` is declared with METHOD syntax on purpose: method parameters are bivariant, which is
 * what lets a heterogeneous `readonly AnyEventMapping[]` table hold `EventMapping<'task:start'>`
 * and `EventMapping<'hitl:resume'>` side by side with no casts.
 */
export interface EventMapping<E extends HookEvent = HookEvent> {
  readonly event: E;
  handle(payload: HookEventMap[E], runtime: TraceRuntime): void;
}

/** Any mapping over any hook event — the element type of a subscription table. */
export type AnyEventMapping = { [E in HookEvent]: EventMapping<E> }[HookEvent];

/**
 * Register one mapping on the host registry, isolating its handler: an observational handler
 * must never fail a task, whatever the telemetry substrate does.
 */
export function subscribe<E extends HookEvent>(
  hooks: IHookRegistry,
  mapping: EventMapping<E>,
  runtime: TraceRuntime
): void {
  hooks.register(mapping.event, (payload) => {
    try {
      mapping.handle(payload, runtime);
    } catch {
      /* swallowed — see above */
    }
  });
}

/** Identity helper that infers `E` from the event key. */
export function defineMapping<E extends HookEvent>(
  event: E,
  handle: (payload: HookEventMap[E], runtime: TraceRuntime) => void
): EventMapping<E> {
  return { event, handle };
}

/**
 * Build a mapping that records an instantaneous span (`<spanName>.start` + `.finish`) for an
 * event whose payload carries an `executionContext`.
 *
 * This is the extension seam: the provider-failure event family
 * (`<domain>:attempt_failed|failed|tripped|recovered`, `isFailureEventKey`) is added later by
 * generating one `pointSpanMapping` per member key and passing them as
 * `TracingOptions.extraMappings` — or appending them to {@link CORE_MAPPINGS} — with no change
 * to the subscription loop, the counters, or the span machinery.
 */
export function pointSpanMapping<E extends HookEvent>(
  event: E,
  spanName: string,
  attrsFor: (payload: HookEventMap[E]) => OtelAttributes,
  executionContextOf: (payload: HookEventMap[E]) => ExecutionContext
): EventMapping<E> {
  return defineMapping(event, (payload, rt) => {
    const ctx = executionContextOf(payload);
    const traceId = rt.traceFor(ctx);
    pointSpan(spanName, { ...rt.taskAttrs(ctx, traceId), ...attrsFor(payload) }, traceId);
  });
}

const sessionMapping = defineMapping('session:created', ({ session }, rt) => {
  rt.counters.sessionCreated();
  const traceId = newTraceId();
  const span = openSpan(
    'agent.session',
    { trace_id: traceId, 'agent.session_id': session.id, 'agent.name': session.agentName },
    traceId
  );
  rt.sessions.set(session.id, { span, traceId });
});

const sessionClosedMapping = defineMapping('session:closed', ({ session }, rt) => {
  rt.counters.sessionClosed();
  const open = rt.sessions.get(session.id);
  rt.sessions.delete(session.id);
  if (open !== undefined) {
    open.span.close({ attrs: { 'agent.outcome': 'closed' } });
    return;
  }
  // Closed a session this process never saw open (created before install, or by another
  // process): record the close as an instantaneous, explicitly-partial span.
  const traceId = newTraceId();
  pointSpan(
    'agent.session',
    {
      trace_id: traceId,
      'agent.session_id': session.id,
      'agent.name': session.agentName,
      'agent.outcome': 'closed',
      'agent.partial': true,
    },
    traceId
  );
});

const taskStart = defineMapping('task:start', ({ executionContext: ctx }, rt) => {
  const state = rt.task(ctx);
  rt.counters.taskStarted(ctx.recursionDepth, ctx.parentTaskId !== undefined);
  state.startedAt = rt.now();
  state.span = openSpan('agent.task', rt.taskAttrs(ctx, state.traceId), state.traceId);
});

/** Shared terminal handling for completed / failed / cancelled. */
function endTask(
  rt: TraceRuntime,
  ctx: ExecutionContext,
  kind: 'completed' | 'failed' | 'cancelled',
  error?: string
): void {
  const state = rt.task(ctx);
  rt.closeDangling(state);
  const attrs: OtelAttributes = { 'agent.outcome': kind };
  if (state.span !== undefined) {
    state.span.close(error === undefined ? { attrs } : { attrs, error });
  } else {
    // No `task:start` seen (task began before install): still record the terminal as a span.
    const point = openSpan('agent.task', { ...rt.taskAttrs(ctx, state.traceId), 'agent.partial': true }, state.traceId);
    point.close(error === undefined ? { attrs } : { attrs, error });
  }
  rt.counters.taskEnded(kind, rt.now() - state.startedAt);
  rt.tasks.delete(ctx.taskId);
  rt.releaseTrace(ctx);
  rt.requestSnapshot();
}

const taskCompleted = defineMapping('task:completed', ({ executionContext }, rt) =>
  endTask(rt, executionContext, 'completed')
);
const taskFailed = defineMapping('task:failed', ({ executionContext, error }, rt) =>
  endTask(rt, executionContext, 'failed', error)
);
const taskCancelled = defineMapping('task:cancelled', ({ executionContext }, rt) =>
  endTask(rt, executionContext, 'cancelled')
);

const modelRequest = defineMapping('pre:model_request', (p, rt) => {
  const ctx = p.executionContext;
  const state = rt.task(ctx);
  state.model?.span.close({ attrs: { 'agent.outcome': 'unclosed' } });
  const span = openSpan(
    'agent.model_call',
    {
      ...rt.taskAttrs(ctx, state.traceId),
      'agent.model_call.messages': p.messages.length,
      'agent.model_call.tools': p.tools.length,
    },
    state.traceId
  );
  state.model = { span, startedAt: rt.now() };
});

const modelResponse = defineMapping('post:model_response', (p, rt) => {
  const state = rt.task(p.executionContext);
  const input = p.tokenUsage?.inputTokens ?? 0;
  const output = p.tokenUsage?.outputTokens ?? 0;
  const open = state.model;
  state.model = undefined;
  open?.span.close({
    attrs: {
      'agent.model_call.stop_reason': p.stopReason,
      'agent.model_call.tool_calls': p.toolCallCount,
      'agent.model_call.input_tokens': input,
      'agent.model_call.output_tokens': output,
      'agent.model_call.compute_ms': p.computeMs,
    },
  });
  rt.counters.modelCall(input, output, open === undefined ? undefined : rt.now() - open.startedAt);
});

const toolRequest = defineMapping('pre:tool_call', (p, rt) => {
  const ctx = p.executionContext;
  const state = rt.task(ctx);
  const span = openSpan(
    'agent.tool_call',
    {
      ...rt.taskAttrs(ctx, state.traceId),
      'agent.tool.name': p.toolName,
      'agent.tool.call_id': p.callId,
      ...rt.argAttrs(p.toolInput),
    },
    state.traceId
  );
  state.tools.set(p.callId, { span, startedAt: rt.now(), tool: p.toolName });
});

const toolResponse = defineMapping('post:tool_call', (p, rt) => {
  const state = rt.task(p.executionContext);
  const open = state.tools.get(p.callId);
  state.tools.delete(p.callId);
  const attrs: OtelAttributes = {
    'agent.tool.is_error': p.isError,
    'agent.tool.est_result_tokens': p.estResultTokens,
  };
  open?.span.close(p.isError ? { attrs, error: `tool ${p.toolName} returned an error result` } : { attrs });
  rt.counters.toolCall(p.toolName, p.isError, open === undefined ? undefined : rt.now() - open.startedAt);
});

const permissionDecision = defineMapping('permission:decision', (p, rt) => {
  rt.counters.permission(p.action, p.resolution);
  const ctx = p.executionContext;
  const traceId = rt.traceFor(ctx);
  const attrs: OtelAttributes = {
    ...rt.taskAttrs(ctx, traceId),
    'agent.permission.server': p.server,
    'agent.permission.tool': p.tool,
    'agent.permission.call_id': p.callId,
    'agent.permission.action': p.action,
    'agent.permission.resolution': p.resolution,
  };
  if (p.reason !== undefined) attrs['agent.permission.reason'] = p.reason;
  pointSpan('agent.permission.decision', attrs, traceId);
});

const hitlSuspend = defineMapping('hitl:suspend', (p, rt) => {
  rt.counters.hitlSuspend();
  rt.suspendedAt.set(p.parkedTaskId, rt.now());
  const ctx = p.executionContext;
  const traceId = rt.traceFor(ctx);
  const attrs: OtelAttributes = {
    ...rt.taskAttrs(ctx, traceId),
    'agent.hitl.kind': p.kind,
    'agent.hitl.parked_task_id': p.parkedTaskId,
  };
  if (p.escalatedFrom !== undefined) attrs['agent.hitl.escalated_from'] = p.escalatedFrom;
  pointSpan('agent.hitl.suspend', attrs, traceId);
});

const hitlResume = defineMapping('hitl:resume', (p, rt) => {
  rt.counters.hitlResume(p.outcome);
  const since = rt.suspendedAt.get(p.parkedTaskId);
  rt.suspendedAt.delete(p.parkedTaskId);
  const ctx = p.executionContext;
  const traceId = rt.traceFor(ctx);
  const attrs: OtelAttributes = {
    ...rt.taskAttrs(ctx, traceId),
    'agent.hitl.parked_task_id': p.parkedTaskId,
    'agent.hitl.outcome': p.outcome,
  };
  if (since !== undefined) attrs['agent.hitl.wait_ms'] = Math.round(rt.now() - since);
  pointSpan('agent.hitl.resume', attrs, traceId);
});

/**
 * The core subscription table — the ONLY place event→span knowledge lives. The plugin's
 * `install()` walks this table (plus `extraMappings`), so supporting a new event is a new row,
 * never a new code path.
 */
export const CORE_MAPPINGS: readonly AnyEventMapping[] = [
  sessionMapping,
  sessionClosedMapping,
  taskStart,
  taskCompleted,
  taskFailed,
  taskCancelled,
  modelRequest,
  modelResponse,
  toolRequest,
  toolResponse,
  permissionDecision,
  hitlSuspend,
  hitlResume,
];
