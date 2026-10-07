import { withSpan, withTrace } from '@adhd/sox-telemetry';
import type { OtelAttributes } from '@adhd/sox-telemetry';

/** How a span ends: optional final attributes, and an error message to record an `.error`. */
export interface SpanOutcome {
  attrs?: OtelAttributes;
  /** When set the span ends as `<name>.error` carrying this message; otherwise `<name>.finish`. */
  error?: string;
}

/**
 * One durable span whose start and end are separate hook events.
 *
 * `withSpan` wraps a single async function, but agent operations are bracketed by two
 * independent hook callbacks (`pre:tool_call` … `post:tool_call`). The span body therefore
 * awaits a deferred promise that {@link OpenSpan.close} settles — so the `.start` record is
 * durable the moment the operation begins (hang-visible) and the `.finish`/`.error` record is
 * written when the closing hook fires.
 *
 * `close()` is idempotent: a span ends exactly once however many terminal paths reach it.
 */
export class OpenSpan {
  private settled = false;

  constructor(private readonly settle: (outcome: SpanOutcome) => void) {}

  get isOpen(): boolean {
    return !this.settled;
  }

  close(outcome: SpanOutcome = {}): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(outcome);
  }
}

/**
 * Open a span under `traceId`. Never throws and never rejects: a failing telemetry substrate
 * (unwritable sink, SDK failure) must not be able to break an agent task, so every failure
 * path here degrades to "this span was not recorded".
 */
export function openSpan(name: string, attrs: OtelAttributes, traceId: string): OpenSpan {
  let settle: (outcome: SpanOutcome) => void = () => undefined;
  const done = new Promise<SpanOutcome>((resolve) => {
    settle = resolve;
  });
  try {
    withTrace(traceId, () => {
      withSpan(name, attrs, async (span) => {
        const outcome = await done;
        if (outcome.attrs !== undefined) span.setAttributes(outcome.attrs);
        // withSpan records `<name>.error` when its body throws; the rejection is expected.
        if (outcome.error !== undefined) throw new Error(outcome.error);
      }).catch(() => undefined);
    });
  } catch {
    /* telemetry must never break a task */
  }
  return new OpenSpan(settle);
}

/** An instantaneous operation: a span that starts and finishes immediately. */
export function pointSpan(name: string, attrs: OtelAttributes, traceId: string): void {
  openSpan(name, attrs, traceId).close();
}
