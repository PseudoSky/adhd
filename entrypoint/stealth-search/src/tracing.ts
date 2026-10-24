// Import path: withSpan, withTrace, identityAttributes from '@adhd/sox-telemetry'.
// Same span contract as @adhd/apigen-plugin-tracing (`makeTracingPlugin({ serviceName: 'adhd' })`), minus its
// extra `${serviceName}.op.error` record: that record carries the literal key `op` instead of an operation id, so
// a failing call would log two error events. Here a failing call records exactly one `adhd.<op>.error`.
import type { Call, Next, Plugin, Result } from '@adhd/apigen-core-client';
import {
  currentTraceId,
  identityAttributes,
  newTraceId,
  otelReady,
  toOtelAttributes,
  withSpan,
  withTrace,
} from '@adhd/sox-telemetry';

/** The apigen namespace of every span name and attribute key (`adhd.<op>.start|finish|error`). */
const NAMESPACE = 'adhd';

/** The hosts that dispatch a call. */
export type TraceTransport = 'cli' | 'mcp';

function errorAttributes(err: unknown): Record<string, string> {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? { error_code: code } : {};
}

/**
 * Run `body` inside the `adhd.<opId>` span: `.start` is written before the body runs, `.finish` or one `.error`
 * after it. The error record carries the typed error's `code` as `error_code`. The error is re-thrown unchanged.
 */
export async function traceOperation<R>(opId: string, transport: string, body: () => Promise<R>): Promise<R> {
  // OTel brings itself up asynchronously after initTelemetry; a span opened before then would be dropped silently.
  await otelReady();
  const traceId = currentTraceId() ?? newTraceId();
  const attrs: Record<string, unknown> = {
    [`${NAMESPACE}.op`]: opId,
    [`${NAMESPACE}.transport`]: transport,
    trace_id: traceId,
    ...identityAttributes(),
  };
  return await withTrace(traceId, () =>
    withSpan(`${NAMESPACE}.${opId}`, toOtelAttributes(attrs), async (span) => {
      try {
        return await body();
      } catch (err) {
        span.setAttributes(errorAttributes(err));
        throw err;
      }
    })
  );
}

/**
 * Record a call the host refused before it could dispatch (a rejected flag): the same `adhd.<opId>` start and
 * error pair a failing dispatch writes. The error is swallowed here; the caller re-throws its own copy.
 */
export async function traceRejection(opId: string, transport: TraceTransport, err: unknown): Promise<void> {
  await traceOperation(opId, transport, () => Promise.reject(err)).catch(() => undefined);
}

/**
 * The ONE tracing plugin for every stealth-search host (cli, mcp). Namespace `adhd` => records
 * `adhd.<op>.start|finish|error`. The plugin package's own `apigen` namespace is never used.
 */
export const tracingPlugin = {
  id: 'tracing',
  description:
    'Layer plugin: one adhd.<op> span per dispatched operation (op id, transport, outcome, duration) with a single error record carrying the error code.',
  language: 'ts',
  capabilities: {
    layer: {
      layer: (call: Call, next: Next): Promise<Result> =>
        traceOperation(call.operation.id, call.transport, () => Promise.resolve(next()) as Promise<Result>),
    },
  },
} as unknown as Plugin;
