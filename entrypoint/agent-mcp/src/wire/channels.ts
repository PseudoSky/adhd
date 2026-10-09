/**
 * Log-channel creation for agent-mcp (backlog c536ce29, segment W2).
 *
 * Two per-process JSONL channels from the sox-telemetry log-channel build (consumed ONLY through
 * `@adhd/agent-plugin-tracing`'s re-exports):
 *
 *  - `agent-mcp.api` — raw wire records (`logRaw`), hybrid durability (records <= 64 KiB are written
 *    synchronously, larger ones go through the bounded queue). Skipped entirely when
 *    `logging.api = off`.
 *  - `agent-mcp.ops` — structured core-ops events and the persisted pino lines, `sync` durability
 *    (zero loss on `kill -9`). Always on.
 *
 * Directories come from {@link resolveLogRoots} (the `@adhd/environment` cascade), never hard-coded.
 * Files are `<component>-<UTC date>.<logging.instanceLabel>.<pid>[...].jsonl[.gz]`: one writer per
 * file, so concurrent processes (ADR-0012) never share an open file. All filesystem writes happen
 * inside the library; this module only reads (a writability pre-check).
 *
 * Nothing here throws: a channel that cannot be opened degrades to an inert channel and the failure
 * is reported ONCE on stderr, so a bad log directory never prevents the server from starting.
 */
import { accessSync, constants, statSync } from "node:fs";
import { dirname } from "node:path";

import {
    createLogChannel,
    createRedactor,
    type LogChannel,
    type Redactor,
} from "@adhd/agent-plugin-tracing";

import { env, resolveLogRoots, type AgentMcpConfig, type LogRoots } from "../config.js";
import { attachOpsDestination } from "../logger.js";

/** The `logging.*` slice of the resolved config that channel creation reads. */
export type LoggingConfig = AgentMcpConfig["logging"];

/** Channel component names (the file-name prefixes). */
export const API_COMPONENT = "agent-mcp.api";
/** See {@link API_COMPONENT}. */
export const OPS_COMPONENT = "agent-mcp.ops";

const KIB = 1024;
/** Records up to this size are written synchronously by the hybrid api channel. */
const API_SYNC_MAX_BYTES = 64 * KIB;

/** Env variable NAMES whose values are credentials: their values are registered as secrets. */
const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|AUTH)/i;

/** The pair of channels plus the facts callers need to report on them. */
export interface IAgentMcpChannels {
    /** Raw wire records. Inert when {@link apiEnabled} is false or the directory is unusable. */
    readonly api: LogChannel;
    /** Core-ops events. Inert only when its directory is unusable. */
    readonly ops: LogChannel;
    /** `logging.api === 'on'` AND the api channel opened. */
    readonly apiEnabled: boolean;
    /** True when the ops channel is a real, writable channel. */
    readonly opsEnabled: boolean;
    /** The resolved roots the channels were created from. */
    readonly roots: LogRoots;
    /** The ONE redactor shared by both channels. */
    readonly redactor: Redactor;
    /** Human-readable reasons a channel degraded to inert (empty on the happy path). */
    readonly failures: readonly string[];
    /** Registers a secret value with both channels. */
    registerSecret(value: string): void;
    /** Drains both channels. */
    flush(): Promise<void>;
    /** Drains and closes both channels. */
    close(): Promise<void>;
}

/** Options for {@link createLogChannels}; all default to the process-wide resolved values. */
export interface ICreateLogChannelsOptions {
    readonly roots?: LogRoots;
    readonly logging?: LoggingConfig;
    /** Credential VALUES to scrub from every record. Default: {@link collectKnownSecrets}. */
    readonly knownSecrets?: readonly string[];
    /** Override the shared redactor (tests use `identityRedactor` as a negative control). */
    readonly redactor?: Redactor;
    /** Where the one-shot degradation notice goes. Default: `process.stderr`. */
    readonly stderr?: { write(chunk: string): unknown };
}

/** An inert channel: every call is a no-op. Lets call sites avoid branching on "is logging on". */
export function noopLogChannel(): LogChannel {
    return {
        logEvent: () => undefined,
        logRaw: () => undefined,
        destination: () => ({ write: () => undefined }),
        registerSecret: () => undefined,
        flush: async () => undefined,
        close: async () => undefined,
        stats: () => ({ written: 0, dropped: 0, serializeErrors: 0, rotated: 0, floodTripped: false }),
    };
}

/**
 * Credential values present in the environment. Only the VALUES are returned (for scrubbing);
 * the names are what callers may log. Short values (< 8 chars) are returned too — the redactor
 * itself ignores them.
 *
 * @param source environment to scan; defaults to `process.env`
 */
export function collectKnownSecrets(source: NodeJS.ProcessEnv = process.env): string[] {
    const out = new Set<string>();
    for (const [name, value] of Object.entries(source)) {
        if (value && SECRET_ENV_NAME.test(name)) out.add(value);
    }
    return [...out];
}

/**
 * Why `dir` cannot be created/written, or `undefined` when it can. Read-only: walks up to the
 * nearest existing ancestor, which must be a writable directory.
 */
function unusableReason(dir: string): string | undefined {
    let probe = dir;
    for (;;) {
        try {
            const st = statSync(probe);
            if (!st.isDirectory()) return `${probe} exists and is not a directory`;
            accessSync(probe, constants.W_OK);
            return undefined;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                return `${probe}: ${(err as Error).message}`;
            }
            const parent = dirname(probe);
            if (parent === probe) return `${dir}: no existing ancestor directory`;
            probe = parent;
        }
    }
}

/**
 * Creates the api + ops channels. Never throws; see the module header for degradation rules.
 *
 * @param opts roots/config/secrets; defaults come from the live environment
 */
export function createLogChannels(opts: ICreateLogChannelsOptions = {}): IAgentMcpChannels {
    const failures: string[] = [];
    const stderr = opts.stderr ?? process.stderr;
    const report = (component: string, reason: string): void => {
        failures.push(`${component}: ${reason}`);
        try {
            stderr.write(`[agent-mcp] log channel '${component}' disabled: ${reason}\n`);
        } catch {
            /* stderr itself failed — nothing left to do */
        }
    };

    let roots: LogRoots;
    let logging: LoggingConfig;
    try {
        roots = opts.roots ?? resolveLogRoots();
        logging = opts.logging ?? env.config.logging;
    } catch (err) {
        // Environment resolution itself failed: nothing to write to. Degrade, never throw.
        report("agent-mcp", `log roots could not be resolved (${(err as Error).message})`);
        const inert = noopLogChannel();
        return {
            api: inert,
            ops: inert,
            apiEnabled: false,
            opsEnabled: false,
            roots: { root: "", api: "", ops: "", trace: "", temp: "" },
            redactor: opts.redactor ?? createRedactor(),
            failures,
            registerSecret: () => undefined,
            flush: async () => undefined,
            close: async () => undefined,
        };
    }

    const redactor =
        opts.redactor ?? createRedactor({ knownSecrets: opts.knownSecrets ?? collectKnownSecrets() });

    const open = (
        component: string,
        dir: string,
        build: () => LogChannel
    ): LogChannel | undefined => {
        const bad = unusableReason(dir);
        if (bad !== undefined) {
            report(component, bad);
            return undefined;
        }
        try {
            return build();
        } catch (err) {
            report(component, (err as Error).message);
            return undefined;
        }
    };

    const ops = open(OPS_COMPONENT, roots.ops, () =>
        createLogChannel({
            dir: roots.ops,
            component: OPS_COMPONENT,
            fileLabel: logging.instanceLabel,
            durability: { mode: "sync" },
            maxBytes: logging.opsRotateBytes,
            maxAgeDays: logging.opsRetentionDays,
            maxDirBytes: logging.opsMaxDirBytes,
            redactor,
        })
    );

    const apiRequested = logging.api === "on";
    const api = apiRequested
        ? open(API_COMPONENT, roots.api, () =>
              createLogChannel({
                  dir: roots.api,
                  component: API_COMPONENT,
                  fileLabel: logging.instanceLabel,
                  durability: { mode: "hybrid", syncMaxBytes: API_SYNC_MAX_BYTES },
                  maxBytes: logging.apiRotateBytes,
                  maxAgeDays: logging.apiRetentionDays,
                  maxDirBytes: logging.apiMaxDirBytes,
                  bodyMaxBytes: logging.apiBodyMaxBytes,
                  floodBreaker: {
                      windowMs: logging.floodWindowSeconds * 1000,
                      maxBytes: logging.floodMaxBytes,
                  },
                  redactor,
              })
          )
        : undefined;

    const opsChannel = ops ?? noopLogChannel();
    const apiChannel = api ?? noopLogChannel();

    if (ops) {
        ops.logEvent("log.channel_open", {
            component: OPS_COMPONENT,
            dir: roots.ops,
            label: logging.instanceLabel,
            api_log: api ? "on" : "off",
        });
        // A sync channel that could not persist its first record is unusable (ENOSPC, EROFS, ...).
        if (ops.stats().written === 0) report(OPS_COMPONENT, `first write to ${roots.ops} failed`);
    }
    if (!apiRequested) {
        opsChannel.logEvent(
            "log.disabled",
            { channel_name: "api", reason: "logging.api=off", config_key: "logging.api" },
            "warn"
        );
    }

    return {
        api: apiChannel,
        ops: opsChannel,
        apiEnabled: api !== undefined,
        opsEnabled: ops !== undefined,
        roots,
        redactor,
        failures,
        registerSecret(value: string): void {
            try {
                redactor.registerSecret(value);
            } catch {
                /* never throws */
            }
        },
        async flush(): Promise<void> {
            await Promise.all([apiChannel.flush(), opsChannel.flush()]);
        },
        async close(): Promise<void> {
            await Promise.all([apiChannel.close(), opsChannel.close()]);
        },
    };
}

let current: IAgentMcpChannels | undefined;

/**
 * The process-wide channels installed by {@link initLogChannels}. Before init (or after close) this
 * is an inert pair, so any call site may log unconditionally.
 */
export function getLogChannels(): IAgentMcpChannels {
    return current ?? INERT;
}

const INERT: IAgentMcpChannels = (() => {
    const inert = noopLogChannel();
    return {
        api: inert,
        ops: inert,
        apiEnabled: false,
        opsEnabled: false,
        roots: { root: "", api: "", ops: "", trace: "", temp: "" },
        redactor: createRedactor(),
        failures: [],
        registerSecret: () => undefined,
        flush: async () => undefined,
        close: async () => undefined,
    };
})();

/**
 * Creates the channels from the live environment, installs them process-wide and late-attaches the
 * ops channel to the pino {@link logger}. Idempotent per process (a second call returns the first
 * result). Never throws.
 *
 * @param opts forwarded to {@link createLogChannels}
 */
export function initLogChannels(opts: ICreateLogChannelsOptions = {}): IAgentMcpChannels {
    if (current) return current;
    const channels = createLogChannels(opts);
    current = channels;
    if (channels.opsEnabled) attachOpsDestination(channels.ops.destination());
    return channels;
}

/**
 * Detaches the ops channel from the logger, drains and closes both channels and clears the
 * process-wide install. Never throws.
 */
export async function closeLogChannels(): Promise<void> {
    const channels = current;
    current = undefined;
    attachOpsDestination(undefined);
    try {
        await channels?.close();
    } catch {
        /* never throws */
    }
}
