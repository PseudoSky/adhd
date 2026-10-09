import pino from "pino";
import { env } from "./config.js";

/** A write-only line sink (the shape of a sox-telemetry `LogChannel#destination()`). */
export interface IOpsDestination {
    write(chunk: string): void;
}

/** Options for {@link createAgentLogger}; every field defaults to the process-wide value. */
export interface ICreateAgentLoggerOptions {
    /** Where the human-facing lines go. Default: fd 2 (stderr). Tests inject a collector. */
    readonly stderr?: { write(chunk: string): unknown };
    /** pino level. Default: `env.config.logging.level`. */
    readonly level?: string;
    /** `instance` base field. Default: `env.instanceId`. */
    readonly instance?: string;
}

/** The logger plus the late-attach seam for the persistent ops channel. */
export interface IAgentLogger {
    readonly logger: pino.Logger;
    /**
     * Attach (or, with `undefined`, detach) the persistent ops destination. The logger works from
     * the first import — before any channel exists — and every line logged after the attach lands
     * in BOTH stderr and the channel. Never throws.
     */
    attachOpsDestination(dest: IOpsDestination | undefined): void;
}

/**
 * Builds a pino logger whose output fans out to stderr (behaviour unchanged: same JSON lines,
 * same level) and, once attached, to the persistent `ops/` log channel (backlog c536ce29).
 * stdout is never written: the stdio MCP transport owns it.
 *
 * Every multistream entry is opened at `trace`; the logger's own `level` is the single filter, so
 * a `debug` line reaches stderr exactly when it did before the ops channel existed.
 */
export function createAgentLogger(opts: ICreateAgentLoggerOptions = {}): IAgentLogger {
    let ops: IOpsDestination | undefined;
    const opsStream = {
        write(chunk: string): void {
            try {
                ops?.write(chunk);
            } catch {
                /* the ops channel never takes the process (or the request path) down */
            }
        },
    };
    const stderr = opts.stderr ?? pino.destination(2);
    const logger = pino(
        {
            level: opts.level ?? env.config.logging.level,
            base: {
                service: "agent-mcp",
                instance: opts.instance ?? env.instanceId,
                pid: process.pid,
            },
        },
        pino.multistream([
            { level: "trace", stream: stderr as NodeJS.WritableStream },
            { level: "trace", stream: opsStream as unknown as NodeJS.WritableStream },
        ])
    );
    return {
        logger,
        attachOpsDestination(dest) {
            ops = dest;
        },
    };
}

const instance = createAgentLogger();

export const logger = instance.logger;

/** Late-attach the persistent ops destination to the process-wide {@link logger}. */
export const attachOpsDestination = instance.attachOpsDestination;
