/**
 * Core-ops event logging (backlog c536ce29, segment W2; spec "Core-ops events").
 *
 * {@link registerOpsLog} subscribes to the engine's EXISTING observational hooks and writes one
 * structured record per lifecycle step to the `agent-mcp.ops` log channel. It reads payloads only:
 * it never alters a decision, never throws into the engine (the HookRegistry swallows handler
 * errors, and every handler here is additionally try/caught), and holds per-task / per-call state
 * only until the terminal event of that task / call.
 *
 * Events (field `event`):
 *  hook-derived: `session.created|closed`, `dispatch.delegate`, `task.start|completed|failed|cancelled`,
 *  `turn.start|end`, `tool.call`, `tool.denied`, `cap.trip`, `hitl.suspend|resume`, `provider.error`.
 *  server lifecycle (component `server`): `server.start` ({@link logServerStart}, process booted),
 *  `server.listening` ({@link logServerListening}, transport bound), `server.stop`
 *  ({@link logServerStop}, a stop was REQUESTED: `reason` + `signal`, emitted first) and
 *  `server.shutdown` ({@link logServerShutdown}, the transport finished closing: `duration_ms` of the
 *  close plus total `uptime_ms`). One signal stop yields exactly one `server.stop` then one
 *  `server.shutdown`; an embedder that closes without a signal yields `server.shutdown` alone.
 *  plugins: `plugin.load_failed` ({@link logPluginLoadFailed}, component `plugin`: a default or
 *  configured plugin was skipped at startup; carries `plugin`, `stage`, `reason`, `default`).
 *  pricing: `pricing.*` (see pricing/pull.ts).
 *
 * TRC-AC18: every record carries `component` (the event's domain prefix for hook events,
 * `server` for lifecycle events) alongside the channel envelope `level`, `event`, `pid`, `stream`.
 *
 * Correlation ids are explicit fields (`session_id`, `task_id`, `root_task_id`, `parent_task_id`,
 * `agent`, `turn`, `call_id`) rather than ambient context, because hooks fire from the engine's own
 * async frames. (`level`, `pid`, `service`, `stream` are reserved envelope keys of the channel.)
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { LogChannel } from "@adhd/agent-plugin-tracing";
import type { ExecutionContext, IHookRegistry } from "@adhd/agent-base-types";

import { getLogChannels } from "./wire/channels.js";

/** A channel, or a thunk resolving it lazily (so registration can precede channel creation). */
export type ChannelSource = LogChannel | (() => LogChannel);

const resolve = (src: ChannelSource): LogChannel => (typeof src === "function" ? src() : src);

/**
 * The `component` field of a hook-derived record: the domain prefix of its event name
 * (`task.*` -> `task`, `tool.denied` -> `tool`, `cap.trip` -> `cap`), so every ops record carries
 * `component` like the server records do (TRC-AC18).
 */
export const componentOf = (event: string): string => {
    const i = event.indexOf(".");
    return i < 0 ? event : event.slice(0, i);
};

/** The slice of {@link LogChannel} the hook handlers write through (adds `component`). */
type OpsEmitter = Pick<LogChannel, "logEvent">;

/** Per-task accumulator, dropped on the task's terminal event. */
interface ITaskState {
    readonly startedAt: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    turnStartedAt: number;
}

/** Milliseconds since `t0` on the monotonic clock, never negative. */
const since = (t0: number): number => Math.max(0, Math.round(performance.now() - t0));

/** Splits a qualified tool name `<server>__<tool>`; a bare name has an empty server. */
export function splitToolName(qualified: string): { server: string; tool: string } {
    const i = qualified.indexOf("__");
    return i < 0 ? { server: "", tool: qualified } : { server: qualified.slice(0, i), tool: qualified.slice(i + 2) };
}

/** sha256 hex of the JSON form of a tool's arguments (the arguments themselves are not logged). */
export function argsSha256(input: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(input) ?? "undefined";
    } catch {
        text = "[unserializable]";
    }
    return createHash("sha256").update(text).digest("hex");
}

/** The correlation ids every task-scoped record carries. */
function taskIds(ctx: ExecutionContext): Record<string, string | number | undefined> {
    return {
        session_id: ctx.sessionId,
        task_id: ctx.taskId,
        root_task_id: ctx.rootTaskId ?? ctx.taskId,
        parent_task_id: ctx.parentTaskId,
        agent: ctx.agentName,
    };
}

/** Text of a denial result (the allowlist server's message), bounded. */
function denialReason(result: unknown): string {
    const text = typeof result === "string" ? result : JSON.stringify(result) ?? "";
    const m = /Command not allowed:[^"\\\]}]*/.exec(text);
    return (m ? m[0] : text).slice(0, 500);
}

/**
 * Subscribes the ops events to `hooks`. Call once per HookRegistry, right after it is created.
 *
 * @param hooks   the engine's hook registry
 * @param channel the ops channel, or a thunk resolving it; defaults to the process-wide ops channel
 */
export function registerOpsLog(
    hooks: IHookRegistry,
    channel: ChannelSource = () => getLogChannels().ops
): void {
    const tasks = new Map<string, ITaskState>();
    const toolStart = new Map<string, number>();

    /** Runs `fn` against the live channel; swallows everything. */
    const safely = (fn: (ch: OpsEmitter) => void): void => {
        try {
            const live = resolve(channel);
            fn({
                logEvent: ((event: string, fields?: Record<string, unknown>, level?: string) =>
                    (live.logEvent as (e: string, f: Record<string, unknown>, l?: string) => void)(
                        event,
                        { component: componentOf(event), ...fields },
                        level
                    )) as LogChannel["logEvent"],
            });
        } catch {
            /* logging never takes the engine down */
        }
    };
    const state = (ctx: ExecutionContext): ITaskState => {
        let s = tasks.get(ctx.taskId);
        if (!s) {
            s = { startedAt: performance.now(), turns: 0, inputTokens: 0, outputTokens: 0, turnStartedAt: performance.now() };
            tasks.set(ctx.taskId, s);
        }
        return s;
    };
    const finish = (
        ctx: ExecutionContext,
        event: "task.completed" | "task.failed" | "task.cancelled",
        extra: Record<string, unknown>,
        level: "info" | "warn"
    ): void =>
        safely((ch) => {
            const s = state(ctx);
            tasks.delete(ctx.taskId);
            ch.logEvent(
                event,
                {
                    ...taskIds(ctx),
                    duration_ms: since(s.startedAt),
                    turns: s.turns,
                    input_tokens: s.inputTokens,
                    output_tokens: s.outputTokens,
                    ...extra,
                },
                level
            );
        });

    hooks.register("session:created", (p) =>
        safely((ch) =>
            ch.logEvent("session.created", {
                session_id: p.session.id,
                agent: p.session.agentName,
                agent_version: p.session.agentVersion,
            })
        )
    );
    hooks.register("session:closed", (p) =>
        safely((ch) => ch.logEvent("session.closed", { session_id: p.session.id, agent: p.session.agentName }))
    );

    hooks.register("task:start", (p) =>
        safely((ch) => {
            const ctx = p.executionContext;
            state(ctx);
            const provider = ctx.agentDefinition?.provider as { type?: string; model?: string } | undefined;
            ch.logEvent("task.start", {
                ...taskIds(ctx),
                provider: provider?.type,
                model: provider?.model,
                depth: ctx.recursionDepth,
                messages: p.messages.length,
            });
            if (ctx.parentTaskId) {
                ch.logEvent("dispatch.delegate", {
                    ...taskIds(ctx),
                    child_task_id: ctx.taskId,
                    depth: ctx.recursionDepth,
                });
            }
        })
    );
    hooks.register("task:completed", (p) =>
        finish(p.executionContext, "task.completed", { result_chars: p.result.length }, "info")
    );
    hooks.register("task:failed", (p) =>
        finish(p.executionContext, "task.failed", { error: p.error.slice(0, 1000) }, "warn")
    );
    hooks.register("task:cancelled", (p) => finish(p.executionContext, "task.cancelled", {}, "info"));

    hooks.register("pre:model_request", (p) =>
        safely((ch) => {
            const s = state(p.executionContext);
            s.turns += 1;
            s.turnStartedAt = performance.now();
            ch.logEvent("turn.start", {
                ...taskIds(p.executionContext),
                turn: s.turns,
                messages: p.messages.length,
                tools: p.tools.length,
            });
        })
    );
    hooks.register("post:model_response", (p) =>
        safely((ch) => {
            const s = state(p.executionContext);
            s.inputTokens += p.tokenUsage?.inputTokens ?? 0;
            s.outputTokens += p.tokenUsage?.outputTokens ?? 0;
            ch.logEvent("turn.end", {
                ...taskIds(p.executionContext),
                turn: s.turns,
                stop_reason: p.stopReason,
                tool_calls: p.toolCallCount,
                input_tokens: p.tokenUsage?.inputTokens,
                output_tokens: p.tokenUsage?.outputTokens,
                response_model: p.responseModel,
                compute_ms: Math.max(0, p.computeMs),
                duration_ms: since(s.turnStartedAt),
            });
        })
    );

    hooks.register("pre:tool_call", (p) => {
        toolStart.set(p.callId, performance.now());
    });
    hooks.register("post:tool_call", (p) =>
        safely((ch) => {
            const t0 = toolStart.get(p.callId);
            toolStart.delete(p.callId);
            const { server, tool } = splitToolName(p.toolName);
            const s = state(p.executionContext);
            const ids = { ...taskIds(p.executionContext), turn: s.turns, call_id: p.callId };
            ch.logEvent(
                "tool.call",
                {
                    ...ids,
                    server,
                    tool,
                    args_sha256: argsSha256(p.toolInput),
                    duration_ms: t0 === undefined ? 0 : since(t0),
                    is_error: p.isError,
                    is_denial: p.isDenial === true,
                    est_result_tokens: p.estResultTokens,
                },
                p.isError && !p.isDenial ? "warn" : "info"
            );
            if (p.isDenial) {
                ch.logEvent(
                    "tool.denied",
                    { ...ids, server, tool, rule: "allowlist", reason: denialReason(p.result) },
                    "warn"
                );
            }
        })
    );

    hooks.register("permission:decision", (p) => {
        if (p.resolution === "allow") return;
        safely((ch) =>
            ch.logEvent(
                "tool.denied",
                {
                    ...taskIds(p.executionContext),
                    call_id: p.callId,
                    server: p.server,
                    tool: p.tool,
                    rule: "permission",
                    action: p.action,
                    resolution: p.resolution,
                    reason: p.reason ?? `permission ${p.action} -> ${p.resolution}`,
                },
                "warn"
            )
        );
    });

    const budget = (kind: "budget.warning" | "budget.block") =>
        (p: { executionContext: ExecutionContext; field: string; maximum: number; current: number; message: string }) =>
            safely((ch) =>
                ch.logEvent(
                    "cap.trip",
                    {
                        ...taskIds(p.executionContext),
                        kind: "budget",
                        mode: kind === "budget.block" ? "block" : "warning",
                        field: p.field,
                        limit: p.maximum,
                        value: p.current,
                        message: p.message.slice(0, 500),
                    },
                    "warn"
                )
            );
    hooks.register("budget:warning", budget("budget.warning"));
    hooks.register("budget:block", budget("budget.block"));

    hooks.register("hitl:suspend", (p) =>
        safely((ch) =>
            ch.logEvent("hitl.suspend", {
                ...taskIds(p.executionContext),
                kind: p.kind,
                parked_task_id: p.parkedTaskId,
                escalated_from: p.escalatedFrom,
            })
        )
    );
    hooks.register("hitl:resume", (p) =>
        safely((ch) =>
            ch.logEvent("hitl.resume", {
                ...taskIds(p.executionContext),
                parked_task_id: p.parkedTaskId,
                outcome: p.outcome,
            })
        )
    );

    hooks.register("provider:failed", (p) =>
        safely((ch) =>
            ch.logEvent(
                "provider.error",
                {
                    ...(p.executionContext ? taskIds(p.executionContext) : { task_id: p.correlationId }),
                    provider: p.failure.providerType,
                    model: p.failure.wireModel,
                    failure_class: p.failure.class,
                    status: p.failure.status,
                    code: p.failure.providerErrorCode,
                    retryable: p.failure.retryable,
                    disposition: p.disposition,
                },
                "error"
            )
        )
    );
}

/** Facts `server.start` records. */
export interface IServerStartInfo {
    readonly transport: string;
    /** The host the MCP HTTP transport bound; `null` for stdio. */
    readonly bindHost: string | null;
    /** The MCP HTTP port; `null` for stdio. */
    readonly port: number | null;
    /** The SSE/gateway port when it bound. */
    readonly ssePort?: number | null;
    readonly instance: string;
    readonly version: string;
    readonly apiLog: "on" | "off";
    readonly spawnDepth?: number;
    /** The operational DB actually opened (ties the logs to the store). */
    readonly dbPath?: string | null;
    /** Which layer selected the store (`env|cascade|default`; BK6 de046157). */
    readonly storeSource?: string;
    /** Derived store mode (`production|custom`; BK6 de046157). */
    readonly storeMode?: string;
    /** The log directories in use (`resolveLogRoots()`). */
    readonly logRoots?: { readonly root: string; readonly api: string; readonly ops: string; readonly trace: string } | null;
}

/**
 * The file path of the better-sqlite3 database behind a drizzle handle (`:memory:`/`null` when it
 * cannot be determined). Reads `$client.name` (drizzle >= 0.3x) or `session.client.name`.
 */
export function dbPathOf(db: unknown): string | null {
    try {
        const d = db as { $client?: { name?: unknown }; session?: { client?: { name?: unknown } } };
        const name = d.$client?.name ?? d.session?.client?.name;
        return typeof name === "string" && name.length > 0 ? name : null;
    } catch {
        return null;
    }
}

/**
 * Emits `server.start`.
 *
 * @param info    what bound where
 * @param channel the ops channel; default: the process-wide one
 */
export function logServerStart(info: IServerStartInfo, channel: ChannelSource = () => getLogChannels().ops): void {
    try {
        resolve(channel).logEvent("server.start", {
            component: "server",
            transport: info.transport,
            bind_host: info.bindHost,
            port: info.port,
            sse_port: info.ssePort ?? null,
            instance: info.instance,
            version: info.version,
            node: process.version,
            spawn_depth: info.spawnDepth ?? 0,
            api_log: info.apiLog,
            db_path: info.dbPath ?? null,
            store_source: info.storeSource ?? null,
            store_mode: info.storeMode ?? null,
            log_roots: info.logRoots ?? null,
        });
    } catch {
        /* never throws */
    }
}

/**
 * Emits `server.stop`: a stop was requested (emitted before the close begins).
 *
 * @param info    why, and since when
 * @param channel the ops channel; default: the process-wide one
 */
export function logServerStop(
    info: { readonly reason: string; readonly signal?: string; readonly startedAtMs: number; readonly dbPath?: string | null },
    channel: ChannelSource = () => getLogChannels().ops
): void {
    try {
        resolve(channel).logEvent("server.stop", {
            component: "server",
            reason: info.reason,
            signal: info.signal ?? null,
            uptime_ms: Math.max(0, Date.now() - info.startedAtMs),
            db_path: info.dbPath ?? null,
        });
    } catch {
        /* never throws */
    }
}

/**
 * Emits `server.listening` once `startServer` has bound its transport: the facts a log reader
 * needs to find the process and tie it to its store (`db_path`).
 *
 * @param info    what bound where
 * @param channel the ops channel; default: the process-wide one
 */
export function logServerListening(
    info: { readonly transport: string; readonly bindHost: string | null; readonly port: number | null; readonly dbPath: string | null },
    channel: ChannelSource = () => getLogChannels().ops
): void {
    try {
        resolve(channel).logEvent("server.listening", {
            component: "server",
            transport: info.transport,
            bind_host: info.bindHost,
            port: info.port,
            db_path: info.dbPath,
        });
    } catch {
        /* never throws */
    }
}

/**
 * Emits `server.shutdown`: the transport finished closing. Pairs with the earlier `server.stop`
 * (which carries the signal/reason); this record carries completion facts only.
 *
 * @param info    which transport and store, when the process started and when the close began
 * @param channel the ops channel; default: the process-wide one
 */
export function logServerShutdown(
    info: { readonly transport: string; readonly dbPath: string | null; readonly startedAtMs: number; readonly closeStartedAtMs?: number },
    channel: ChannelSource = () => getLogChannels().ops
): void {
    try {
        resolve(channel).logEvent("server.shutdown", {
            component: "server",
            transport: info.transport,
            db_path: info.dbPath,
            duration_ms: Math.max(0, Date.now() - (info.closeStartedAtMs ?? Date.now())),
            uptime_ms: Math.max(0, Date.now() - info.startedAtMs),
        });
    } catch {
        /* never throws */
    }
}

/**
 * Emits `plugin.load_failed`: a plugin entry (default or operator-configured) was skipped at
 * startup, so its hooks are NOT registered (e.g. a missing tracing plugin means no spans).
 *
 * @param info    the module specifier, the load stage that failed, the cause, and whether the
 *                entry was a host default
 * @param channel the ops channel; default: the process-wide one
 */
export function logPluginLoadFailed(
    info: { readonly plugin: string; readonly stage: string; readonly reason: string; readonly isDefault: boolean },
    channel: ChannelSource = () => getLogChannels().ops
): void {
    try {
        resolve(channel).logEvent("plugin.load_failed", {
            component: "plugin",
            plugin: info.plugin,
            stage: info.stage,
            reason: info.reason,
            default: info.isDefault,
        });
    } catch {
        /* never throws */
    }
}
