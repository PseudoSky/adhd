import type { ExecutionContext, HookEvent, HookEventMap, IHookRegistry, ProviderFailure } from '@adhd/agent-base-types';
import { createRedactor, newTraceId } from '@adhd/sox-telemetry';
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
 * `TracingPluginOptions.extraMappings` — or appending them to {@link CORE_MAPPINGS} — with no change
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
  const state = rt.startTask(ctx);
  rt.counters.taskStarted(ctx.recursionDepth, ctx.parentTaskId !== undefined);
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
  // A second terminal for a task that already ended (cancel racing completion) is dropped: the
  // first one is the task's outcome, and counting both would double-book it.
  if (state === undefined) return;
  rt.closeDangling(state);
  const attrs: OtelAttributes = { 'agent.outcome': kind };
  if (state.span !== undefined) {
    state.span.close(error === undefined ? { attrs } : { attrs, error });
  } else {
    // No `task:start` seen (task began before install): still record the terminal as a span.
    const point = openSpan('agent.task', { ...rt.taskAttrs(ctx, state.traceId), 'agent.partial': true }, state.traceId);
    point.close(error === undefined ? { attrs } : { attrs, error });
  }
  // No `task:start` seen ⇒ no start time ⇒ no honest latency: skip the observation.
  rt.counters.taskEnded(kind, state.startedAt === undefined ? undefined : rt.now() - state.startedAt);
  rt.finishTask(ctx);
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
  if (state === undefined) return; // task already ended: opening a span now would never close
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
  const open = state?.model;
  if (state !== undefined) state.model = undefined;
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

/** Close the task's open model-call span as an ERROR (`agent.model_call.error`), once. */
/**
 * Provider SDK errors can embed key fragments ("Incorrect API key provided: sk-..."). Every error
 * string that becomes span error text goes through the shared sox-telemetry redactor first
 * (c536ce29 FIX-L3), so the trace sink never holds a credential the log channels would have scrubbed.
 */
const errorRedactor = createRedactor();

function failModelCall(rt: TraceRuntime, ctx: ExecutionContext | undefined, error: string, attrs: OtelAttributes): void {
  if (ctx === undefined) return;
  const state = rt.task(ctx);
  const open = state?.model;
  if (state === undefined || open === undefined) return;
  state.model = undefined;
  open.span.close({ attrs: { ...attrs, 'agent.outcome': 'error' }, error: errorRedactor.redactValue(error) });
  rt.counters.modelCall(0, 0, rt.now() - open.startedAt);
}

/** A point record for an event whose `executionContext` may be absent (trip-level events). */
function pointFor(
  rt: TraceRuntime,
  name: string,
  ctx: ExecutionContext | undefined,
  attrs: OtelAttributes
): void {
  const traceId = ctx === undefined ? newTraceId() : rt.traceFor(ctx);
  pointSpan(name, { ...(ctx === undefined ? { trace_id: traceId } : rt.taskAttrs(ctx, traceId)), ...attrs }, traceId);
}

const failureAttrs = (f: ProviderFailure): OtelAttributes => ({
  'agent.provider.type': f.providerType,
  'agent.provider.model': f.wireModel,
  'agent.provider.failure_class': f.class,
  'agent.provider.failure_scope': f.scope,
  'agent.provider.retryable': f.retryable,
  ...(f.status !== undefined ? { 'agent.provider.status': f.status } : {}),
});

// c536ce29 TRC-AC25: a terminal provider failure closes the open model call as an ERROR (never
// left open / never "unclosed"); the decorator emits this before the orchestrator throws.
const providerFailed = defineMapping('provider:failed', (p, rt) => {
  failModelCall(rt, p.executionContext, `provider ${p.failure.class}: ${p.failure.message}`, {
    ...failureAttrs(p.failure),
    'agent.provider.disposition': p.disposition,
  });
});
const providerAttemptFailed = defineMapping('provider:attempt_failed', (p, rt) =>
  pointFor(rt, 'agent.provider.attempt_failed', p.executionContext, {
    ...failureAttrs(p.failure),
    'agent.provider.attempt': p.attempt,
    'agent.provider.disposition': p.disposition,
  })
);
const providerTripped = defineMapping('provider:tripped', (p, rt) =>
  pointFor(rt, 'agent.provider.tripped', p.executionContext, {
    ...failureAttrs(p.failure),
    'agent.provider.trip_key': p.trip.key,
  })
);
const providerRecovered = defineMapping('provider:recovered', (p, rt) =>
  pointFor(rt, 'agent.provider.recovered', p.executionContext, {
    ...failureAttrs(p.failure),
    'agent.provider.trip_key': p.trip.key,
    'agent.provider.recovery_reason': p.reason,
  })
);

// c536ce29 TRC-AC26: budget notifications become records. A `block` is emitted from the
// pre:model_request enforcement, after the model span opened and before any provider call, so it
// also closes that span as an error.
const budgetAttrs = (p: { field: string; maximum: number; current: number; message: string }): OtelAttributes => ({
  'agent.budget.field': p.field,
  'agent.budget.maximum': p.maximum,
  'agent.budget.current': p.current,
  'agent.budget.message': p.message,
});
const budgetWarning = defineMapping('budget:warning', (p, rt) =>
  pointFor(rt, 'agent.budget.warning', p.executionContext, budgetAttrs(p))
);
const budgetBlock = defineMapping('budget:block', (p, rt) => {
  pointFor(rt, 'agent.budget.block', p.executionContext, budgetAttrs(p));
  failModelCall(rt, p.executionContext, `budget blocked: ${p.message}`, budgetAttrs(p));
});

const toolRequest = defineMapping('pre:tool_call', (p, rt) => {
  const ctx = p.executionContext;
  const state = rt.task(ctx);
  if (state === undefined) return; // task already ended: opening a span now would never close
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
  const open = state?.tools.get(p.callId);
  state?.tools.delete(p.callId);
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
  providerFailed,
  providerAttemptFailed,
  providerTripped,
  providerRecovered,
  budgetWarning,
  budgetBlock,
  toolRequest,
  toolResponse,
  permissionDecision,
  hitlSuspend,
  hitlResume,
];
