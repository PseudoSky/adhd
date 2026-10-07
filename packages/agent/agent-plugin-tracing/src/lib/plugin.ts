import { currentRuntimeState, initTelemetry, otelReady as currentOtelReady, registerSnapshotSection, resolveProcessRole, snapshotMetrics } from '@adhd/sox-telemetry';
import type { TelemetryHandle } from '@adhd/sox-telemetry';
import type { IHookRegistry, Plugin, PluginContext } from '@adhd/agent-base-types';
import { configSchema } from './config.js';
import type { TracingConfig } from './config.js';
import { CORE_MAPPINGS, subscribe } from './mappings.js';
import type { AnyEventMapping } from './mappings.js';
import { TraceRuntime } from './runtime.js';
import { SnapshotThrottle } from './snapshot-throttle.js';
import type { SnapshotThrottleDeps } from './snapshot-throttle.js';
import type { TracingSnapshot } from './counters.js';

/** Plugin name as registered with the host. */
export const PLUGIN_NAME = 'agent-plugin-tracing';
/** Name of the metrics snapshot section this plugin contributes. */
export const SNAPSHOT_SECTION = 'agent_tracing';

/** Construction options beyond the validated config. */
export interface TracingPluginOptions {
  /**
   * Replace the whole subscription table (default {@link CORE_MAPPINGS}). Hosts and tests use it to
   * trace a subset of operations.
   */
  mappings?: readonly AnyEventMapping[];
  /**
   * Additional event→span rows appended to {@link CORE_MAPPINGS}. This is how a new event family
   * (e.g. the provider-failure `<domain>:attempt_failed|failed|tripped|recovered` keys) is
   * traced without restructuring the plugin — see `pointSpanMapping`.
   */
  extraMappings?: readonly AnyEventMapping[];
  /**
   * Tune or replace the `metrics.snapshot` rate limiter (default: one activity snapshot per
   * 5 s, trailing write coalesced). Tests inject a fake clock/timer/writer.
   */
  snapshot?: Partial<SnapshotThrottleDeps>;
}

/** `service` the telemetry runtime reports until some composition root calls `initTelemetry`. */
const UNINITIALISED_SERVICE = 'unlabeled';

/**
 * The runtime state object of the telemetry configuration a tracing plugin last closed. A closed
 * configuration is not removed from the runtime (sox-telemetry keeps it until the next
 * `initTelemetry`), so identity — not `service` — is what tells "someone else's live provider"
 * apart from "my own, already disposed one".
 */
let closedRuntimeState: object | undefined;

/**
 * Traces every agent operation observed through the hook registry into `@adhd/sox-telemetry`:
 * one durable span (start + finish/error) per session, task, model call, tool call, permission
 * decision and HITL suspend/resume, plus an `agent_tracing` metrics snapshot section.
 *
 * Purely observational: every handler is isolated, and a failing telemetry substrate degrades
 * to "not recorded" — it can never fail a task.
 */
export class TracingPlugin implements Plugin {
  readonly name = PLUGIN_NAME;
  /** The telemetry handle `install()` created (undefined until installed, or if init failed). */
  telemetry: TelemetryHandle | undefined;
  /**
   * True when `install()` found a telemetry provider this process had already initialised (the
   * host, another plugin, an embedding app) and reused it instead of calling `initTelemetry` again.
   * One provider per process: the adopted provider is never reconfigured and never closed by
   * `dispose()`; `service` / `logSink` / `logDir` from this plugin's config do not apply to it.
   */
  adoptedExistingTelemetry = false;
  private readonly runtime: TraceRuntime;
  private unregisterSnapshot: (() => void) | undefined;
  private readonly throttle: SnapshotThrottle;

  constructor(
    private readonly config: TracingConfig,
    private readonly options: TracingPluginOptions = {}
  ) {
    this.throttle = new SnapshotThrottle({
      write: () => snapshotMetrics('activity'),
      ...options.snapshot,
    });
    this.runtime = new TraceRuntime(config.captureArgs, () => this.throttle.request());
  }

  /** Sizes of the plugin's per-process state tables (diagnostics / leak assertions). */
  stateSizes(): ReturnType<TraceRuntime['stateSizes']> {
    return this.runtime.stateSizes();
  }

  /** Write a `metrics.snapshot` now (bypassing the rate limit) and resolve once it is written. */
  flushSnapshot(): Promise<void> {
    return this.throttle.flush();
  }

  /** Where the process's durable sink writes (adopted or owned); `null` when no file sink is configured. */
  logFilePath(): string | null {
    return currentRuntimeState().sink?.plannedPath() ?? null;
  }

  async install(hooks: IHookRegistry): Promise<void> {
    const existing = currentRuntimeState();
    this.adoptedExistingTelemetry = existing.service !== UNINITIALISED_SERVICE && existing !== closedRuntimeState;
    try {
      if (!this.adoptedExistingTelemetry) {
        this.telemetry = initTelemetry({
          service: this.config.service,
          role: resolveProcessRole('live-service'),
          logSink: this.config.logSink,
          ...(this.config.logDir !== undefined ? { logDir: this.config.logDir } : {}),
        });
      }
      // The OTel SDK loads asynchronously; wait so the first span is not lost to bring-up.
      await (this.telemetry?.otelReady() ?? currentOtelReady());
    } catch {
      /* telemetry must never prevent the host from starting */
    }
    try {
      this.unregisterSnapshot = registerSnapshotSection(SNAPSHOT_SECTION, () => ({ ...this.runtime.counters.snapshot() }));
    } catch {
      /* ditto */
    }
    for (const mapping of [...(this.options.mappings ?? CORE_MAPPINGS), ...(this.options.extraMappings ?? [])]) {
      subscribe(hooks, mapping, this.runtime);
    }
  }

  /** Current counters (the same object shape written to `metrics.snapshot.sections.agent_tracing`). */
  counters(): TracingSnapshot {
    return this.runtime.counters.snapshot();
  }

  /**
   * Shut down: persist any coalesced metrics snapshot, close every still-open session/task/
   * model/tool span with `agent.outcome: "unclosed"` (releasing the per-process tables), detach
   * the snapshot section, then close the telemetry handle this plugin created. Resolves once
   * the terminal records have reached the sink.
   */
  async dispose(): Promise<void> {
    await this.throttle.dispose();
    await this.runtime.closeAll();
    this.unregisterSnapshot?.();
    this.unregisterSnapshot = undefined;
    if (this.telemetry !== undefined) {
      closedRuntimeState = currentRuntimeState();
      this.telemetry.close();
      this.telemetry = undefined;
    }
  }
}

/**
 * Plugin factory — the `default` / `createPlugin` export the host loader calls. The loader has
 * already validated `ctx.config` against {@link configSchema}; it is parsed again here so a
 * direct caller (tests, embedders) gets the same defaults and the same rejection of bad config.
 */
export function createPlugin(ctx: PluginContext, options?: TracingPluginOptions): TracingPlugin {
  return new TracingPlugin(configSchema.parse(ctx.config), options);
}
