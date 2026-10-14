/**
 * P6 per-call timing. Pure helpers shared by the providers (time to first byte) and the
 * engine (overhead between model calls). Additive: nothing here changes a call's behaviour.
 */

/** Clock source; injectable so the helpers are deterministic under test. */
export type Clock = () => number;

/** Records when a model request started and when its first streamed byte/event arrived. */
export interface ITtfbProbe {
  /** Mark the request start (idempotent: only the first call counts). */
  start(): void;
  /** Mark the first streamed byte/event (idempotent; ignored before `start`). */
  firstByte(): void;
  /** Milliseconds from start to first byte, or undefined when either mark is missing. */
  ttfbMs(): number | undefined;
}

/**
 * Build a TTFB probe.
 *
 * @param now - clock source, defaults to `Date.now`.
 */
export function createTtfbProbe(now: Clock = Date.now): ITtfbProbe {
  let startedAt: number | undefined;
  let firstByteAt: number | undefined;
  return {
    start() {
      if (startedAt === undefined) startedAt = now();
    },
    firstByte() {
      if (startedAt !== undefined && firstByteAt === undefined) firstByteAt = now();
    },
    ttfbMs() {
      return startedAt === undefined || firstByteAt === undefined
        ? undefined
        : Math.max(0, firstByteAt - startedAt);
    },
  };
}

/**
 * Engine overhead for one model call: time between the previous model call ending and this
 * request starting (context assembly, tool execution, hooks, persistence). Undefined for the
 * first call of a task (nothing precedes it).
 *
 * @param previousCallEndedAt - epoch ms the previous model call returned, if any.
 * @param requestStartedAt - epoch ms this request started.
 */
export function computeOverheadMs(
  previousCallEndedAt: number | undefined,
  requestStartedAt: number
): number | undefined {
  if (previousCallEndedAt === undefined) return undefined;
  return Math.max(0, requestStartedAt - previousCallEndedAt);
}

/** The additive timing fields a `MODEL_RESPONSE` trace payload carries (snake_case, like the P6 contract). */
export interface ICallTiming {
  ttfb_ms?: number;
  overhead_ms?: number;
}

/**
 * Project the optional timings onto payload fields, omitting absent values so a payload without
 * timing is byte-identical to before.
 */
export function callTimingFields(ttfbMs: number | undefined, overheadMs: number | undefined): ICallTiming {
  return {
    ...(ttfbMs !== undefined ? { ttfb_ms: ttfbMs } : {}),
    ...(overheadMs !== undefined ? { overhead_ms: overheadMs } : {}),
  };
}
