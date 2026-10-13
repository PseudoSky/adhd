import { initTelemetry } from '@adhd/sox-telemetry';

/**
 * Telemetry composition root: the tracing plugin emits through
 * `@adhd/sox-telemetry`, which drops every record (and warns once on stderr)
 * until `initTelemetry` has run. Call once per process, before any dispatch.
 * Failure is non-fatal: telemetry must never take the tool down.
 */
export function initPolicyTelemetry(role: 'cli' | 'live-service'): void {
  try {
    initTelemetry({ service: 'policy', role, logSink: 'file' });
  } catch (error) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed (${error instanceof Error ? error.message : String(error)}); ` +
        'telemetry records will be silently dropped this process'
    );
  }
}
