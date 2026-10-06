import { z } from 'zod';

/**
 * Typed plugin config (values only — there is deliberately NO `enabled` switch:
 * tracing is default-on, adhd ADR-0001 / sox ADR-0013).
 *
 * Mirrors the agent-mcp FieldSpecs `tracing.service|logSink|logDir|captureArgs`
 * (env `ADHD_AGENT_TRACING_*`, wired in TRACE-4). Every field is optional so an
 * empty `{}` config — the zero-config default — is valid.
 */
export const configSchema = z
  .object({
    /** Telemetry `service` resource attribute; also the default log directory name. */
    service: z.string().min(1).default('agent-mcp'),
    /** Where records land. `file` persists to `logDir` (default `~/.adhd/sox-ecosystem/<service>/logs`). */
    logSink: z.enum(['file', 'stderr', 'none']).default('file'),
    /** Override of the file sink directory. */
    logDir: z.string().min(1).optional(),
    /** Record (truncated) tool arguments verbatim instead of only their sha256 digest. */
    captureArgs: z.boolean().default(false),
  })
  .strict();

/** The validated, defaulted config the plugin runs with. */
export type TracingConfig = z.output<typeof configSchema>;
/** What a caller may pass — every key optional. */
export type TracingConfigInput = z.input<typeof configSchema>;
