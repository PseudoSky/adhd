import type { Plugin, Call, Next, Result, Chunk, File } from '@adhd/apigen-core-client';
import { withSpan, log, newTraceId, currentTraceId, withTrace } from '@adhd/sox-telemetry';
import type { OtelSpanHandle } from '@adhd/sox-telemetry';

/**
 * Options for {@link makeTracingPlugin}.
 *
 * Layer plugins receive no opts at call time — `LayerCapability.layer` is invoked with only
 * `(call, next)` — so configuration is a factory, exactly as `makeLoggerPlugin` does it.
 */
export interface TracingOptions {
  /** Span / record name prefix. Default: `'apigen'`. */
  serviceName?: string;
  /**
   * Extra attribute keys copied verbatim from `call.envelope` onto each span. Default: `[]`
   * (only the built-in attrs `apigen.op`, `apigen.transport`, `trace_id` are emitted).
   */
  envelopeAttrs?: readonly string[];
}

/**
 * Per-call trace handle, seeded into `call.ctx`. The class is the ctx token: domain code reads
 * it back with `call.ctx.get(TraceHandle)`.
 */
export class TraceHandle {
  constructor(
    /** Correlation id shared by every span of one logical request. */
    readonly traceId: string,
    /** Span name — `${serviceName}.${operation.id}`. */
    readonly spanName: string,
    /** Epoch millis at which the span opened. */
    readonly startedAt: number
  ) {}

  /**
   * Add attributes to the live span from domain code — opt-in. A no-op when the operation is
   * not currently inside a unary span (e.g. before the downstream resolved, or for a streaming
   * call, which is logged rather than spanned).
   */
  annotate(fields: Record<string, unknown>): void {
    const span = boundSpans.get(this);
    if (span === undefined) return;
    span.setAttributes(toOtelAttributes(fields));
  }
}

/**
 * WeakMap from a live {@link TraceHandle} to the OTel span it is bound to for the duration of a
 * unary call. Populated on span entry, cleared in `finally`. Keeps `TraceHandle`'s public shape
 * exactly the spec's (`traceId`/`spanName`/`startedAt`/`annotate`) with no extra public members.
 */
const boundSpans = new WeakMap<TraceHandle, OtelSpanHandle>();

/** A value is a stream iff it is a non-null object exposing `Symbol.asyncIterator`. */
function isAsyncIterable(value: unknown): value is AsyncIterable<Chunk> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/** Keep only the attribute types the OTel attribute contract admits (string | number | boolean). */
function toOtelAttributes(
  fields: Record<string, unknown>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Copy only the requested keys that are actually present on the envelope. */
function pickEnvelope(
  envelope: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = envelope[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Best-effort human-readable message for an arbitrary thrown value (never `{}` for an Error). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Unary branch — wrap the downstream promise in an OTel span. `withSpan` writes the
 * `<spanName>.start` record BEFORE invoking the body (so a hang is visible) and the
 * `<spanName>.finish` / `<spanName>.error` record on completion. We additionally emit an
 * `apigen.op.error` record and re-throw — the layer never swallows.
 */
function traceUnary(
  downstream: Promise<Result>,
  spanName: string,
  attrs: Record<string, unknown>,
  handle: TraceHandle
): Promise<Result> {
  return withSpan(spanName, toOtelAttributes(attrs), async (span) => {
    boundSpans.set(handle, span);
    try {
      return await downstream;
    } catch (err) {
      log.error('apigen.op.error', {
        ...attrs,
        span: spanName,
        duration_ms: Date.now() - handle.startedAt,
        err: errMessage(err),
      });
      throw err;
    } finally {
      boundSpans.delete(handle);
    }
  });
}

/**
 * Streaming branch — `withSpan` cannot await an iterable, so the `.start` record is emitted
 * synchronously on entry and an async-generator wrapper yields each chunk unchanged, then
 * emits `.finish` with the chunk count (or `.error` and re-throws).
 */
function traceStream(
  downstream: AsyncIterable<Chunk>,
  spanName: string,
  attrs: Record<string, unknown>
): AsyncIterable<Chunk> {
  log.info(`${spanName}.start`, { ...attrs });
  return (async function* traced(): AsyncGenerator<Chunk> {
    const startedAt = Date.now();
    let chunks = 0;
    try {
      for await (const chunk of downstream) {
        chunks += 1;
        yield chunk;
      }
      log.info(`${spanName}.finish`, {
        ...attrs,
        chunks,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      log.error(`${spanName}.error`, {
        ...attrs,
        chunks,
        duration_ms: Date.now() - startedAt,
        err: errMessage(err),
      });
      throw err;
    }
  })();
}

/**
 * Build the tracing layer for a given configuration. The returned layer calls `next()` exactly
 * once and returns its resolved value (or iterable) unchanged, wrapping it in a span.
 */
export function makeTraceLayer(
  opts: TracingOptions = {}
): (call: Call, next: Next) => Promise<Result> | AsyncIterable<Chunk> {
  const serviceName = opts.serviceName ?? 'apigen';
  const envelopeAttrs = opts.envelopeAttrs ?? [];

  return (call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk> => {
    const spanName = `${serviceName}.${call.operation.id}`;
    const traceId = currentTraceId() ?? newTraceId();
    const startedAt = Date.now();
    const handle = new TraceHandle(traceId, spanName, startedAt);

    // Seed the per-call trace handle so downstream layers / domain code can correlate + annotate.
    call.ctx.set(TraceHandle, handle);

    const attrs: Record<string, unknown> = {
      'apigen.op': call.operation.id,
      'apigen.transport': call.transport,
      trace_id: traceId,
      ...pickEnvelope(call.envelope, envelopeAttrs),
    };

    // Run the whole downstream inside the trace context so nested spans share the trace_id.
    return withTrace(traceId, () => {
      const downstream = next();
      return isAsyncIterable(downstream)
        ? traceStream(downstream, spanName, attrs)
        : traceUnary(downstream, spanName, attrs, handle);
    });
  };
}

/**
 * Tracing plugin.
 *
 * Implemented as a **Layer** capability — a single layer instruments every transport (http, grpc,
 * mcp, cli) because they all dispatch through one composed invoker. The `target` capability is
 * declared but emits nothing (`generate()` returns `[]`), so `--type tracing` resolves to a valid
 * no-op rather than an error — the same precedent as `apigen-plugin-logger`.
 */
export const tracingPlugin: Plugin<TracingOptions> = {
  id: 'tracing',
  description:
    'Layer plugin: emits one OTel span per dispatched operation (op id, transport, outcome, duration) to the sox-telemetry JSONL sink, correlated by trace_id.',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      serviceName: {
        type: 'string',
        description: 'Span / record name prefix. Default: apigen.',
      },
      envelopeAttrs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra envelope keys copied verbatim onto each span. Default: [].',
      },
    },
    additionalProperties: false,
  },
  capabilities: {
    // Declared so `--type tracing` resolves instead of erroring; emits NOTHING — parity with
    // logger's `generate() { return [] }`.
    target: {
      name: 'tracing',
      generate(): File[] {
        return [];
      },
    },
    layer: {
      layer: makeTraceLayer(),
    },
  },
};

/** Configured factory — rebuilds the layer with `opts` (logger precedent). */
export function makeTracingPlugin(opts: TracingOptions = {}): Plugin<TracingOptions> {
  return {
    ...tracingPlugin,
    capabilities: {
      ...tracingPlugin.capabilities,
      layer: { layer: makeTraceLayer(opts) },
    },
  };
}

export default tracingPlugin;
