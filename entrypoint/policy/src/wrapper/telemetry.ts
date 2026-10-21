import { initTelemetry } from '@adhd/sox-telemetry';

/** Environment variable that turns telemetry off when set to `off` (D-24: on by default, disabled by configuration). */
export const TELEMETRY_ENV_VAR = 'ADHD_POLICY_TELEMETRY';

/** D-24: one log file rotates at 100 MB. A configuration value, not a feature toggle. */
export const TELEMETRY_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** D-24: log files older than 14 days are deleted. The target value; see {@link initPolicyTelemetry} for why it is not yet applied. */
export const TELEMETRY_RETENTION_DAYS = 14;

/** Configuration of {@link initPolicyTelemetry}. */
export interface IPolicyTelemetryConfig {
  /** `false` silences every record (`logSink: 'none'`). Default `true`. */
  readonly enabled?: boolean;
  /** Per-file rotation threshold in bytes. Default {@link TELEMETRY_MAX_FILE_BYTES}. */
  readonly maxFileBytes?: number;
}

/** Reads the telemetry configuration from the environment the mount passes in as data. */
export function telemetryConfigFromEnv(env: Readonly<Record<string, string | undefined>>): IPolicyTelemetryConfig {
  return { enabled: env[TELEMETRY_ENV_VAR]?.trim().toLowerCase() !== 'off' };
}

/**
 * Telemetry composition root: the tracing plugin emits through
 * `@adhd/sox-telemetry`, which drops every record (and warns once on stderr)
 * until `initTelemetry` has run. Call once per process, before any dispatch.
 * Failure is non-fatal: telemetry must never take the tool down.
 *
 * Metrics and event logs are on by default at full detail (D-24) and go to the
 * file sink; `config.enabled: false` selects the `none` sink. The per-file
 * rotation threshold is `config.maxFileBytes` (100 MB by default).
 *
 * The 14-day retention ({@link TELEMETRY_RETENTION_DAYS}) and the owner-only
 * `0600` file mode are not applied: `initTelemetry` forwards neither the sink's
 * `maxAgeDays` nor its `fileScope: 'per-process'` (the only mode that opens files
 * with `0600`) to `DurableJsonlSink`. Until it does, retention is the sink's
 * count-based default.
 *
 * @param role Whether this process is a one-shot command or a long-lived server.
 * @param config Optional switches; see {@link IPolicyTelemetryConfig}.
 */
export function initPolicyTelemetry(role: 'cli' | 'live-service', config: IPolicyTelemetryConfig = {}): void {
  try {
    initTelemetry({
      service: 'policy',
      role,
      logSink: config.enabled === false ? 'none' : 'file',
      maxBytes: config.maxFileBytes ?? TELEMETRY_MAX_FILE_BYTES,
    });
  } catch (error) {
    console.error(
      `[sox-telemetry] WARNING: initTelemetry failed (${error instanceof Error ? error.message : String(error)}); ` +
        'telemetry records will be silently dropped this process'
    );
  }
}
