// Import path: initTelemetry from '@adhd/sox-telemetry'
// (same call shape as entrypoint/backlog/src/index.ts). Telemetry SERVICE
// `stealth-search` is distinct from the apigen namespace `adhd` (tracing.ts).
import { initTelemetry } from '@adhd/sox-telemetry';

export type SearchTelemetryRole = 'cli' | 'live-service';

export interface SearchTelemetryOptions {
  readonly role: SearchTelemetryRole;
  readonly logDir?: string;
}

let warned = false;

/**
 * The single telemetry composition root: call once per bin before the first
 * dispatch. Failure is non-fatal and warned once on stderr; without telemetry
 * the tracing plugin writes to a no-op sink.
 */
export function initSearchTelemetry(opts: SearchTelemetryOptions): void {
  try {
    initTelemetry({
      service: 'stealth-search',
      role: opts.role,
      logSink: 'file',
      ...(opts.logDir ? { logDir: opts.logDir } : {}),
    });
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `[sox-telemetry] WARNING: initTelemetry failed (${
          err instanceof Error ? err.message : String(err)
        }); telemetry records will be silently dropped this process`
      );
    }
  }
}
