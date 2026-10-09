/**
 * `tracedSpawn` — raw child-process wire logging (backlog c536ce29, segment W1).
 *
 * Wraps a `child_process.spawn` implementation. For every child it writes to the api channel:
 *
 *  - `spawn.start`   command, args, env variable NAMES only (never values), cwd, pid
 *  - `spawn.stdin`   one record per chunk written to the child's stdin (bounded captured body)
 *  - `spawn.stdout` / `spawn.stderr`  one record per chunk the consumer receives (bounded body)
 *  - `spawn.exit`    code, signal, duration_ms (process exited)
 *  - `spawn.close`   stdio drained: code, signal and exact whole-stream digests
 *                    (`stdout_bytes/stdout_sha256`, `stderr_bytes/stderr_sha256`)
 *  - `spawn.error`   spawn failure (`ENOENT`, ...) with duration
 *
 * The returned `ChildProcess` is the real one. Observation is passive: stdout/stderr/exit/error
 * are observed by wrapping `emit` (never by adding `'data'`/`'error'` listeners, which would put
 * the streams into flowing mode or swallow an unhandled `'error'`), and stdin is observed by
 * wrapping `write` on the instance. Consequently a stream nobody reads is also not logged, and
 * the child's behaviour is exactly that of the unwrapped call. Secrets in args are scrubbed by the
 * channel's redactor at the sink. Nothing here ever throws into the caller.
 */
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import { BodyCapture, captureBody, currentLogContext, type LogChannel } from "@adhd/agent-plugin-tracing";

import {
    DEFAULT_BODY_MAX_BYTES,
    describeError,
    emitRaw,
    isInertChannel,
    newCallId,
    resolveChannel,
    safely,
    type ChannelSource,
    type IWireOptions,
} from "./traced-fetch.js";

type SpawnFn = typeof nodeSpawn;

function toBytes(chunk: unknown, encoding?: unknown): Uint8Array | undefined {
    if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    if (chunk instanceof Uint8Array) return chunk;
    return undefined;
}

/**
 * Wraps `spawnImpl` so each child's lifecycle and stdio are logged raw.
 *
 * @param channel the api channel (or lazy resolver); default the process-wide api channel
 * @param spawnImpl the spawn to wrap; default `child_process.spawn` (imported lazily)
 * @param opts capture options
 */
export function tracedSpawn(channel: ChannelSource, spawnImpl: SpawnFn, opts: IWireOptions = {}): SpawnFn {
    const maxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
    const impl = function tracedSpawnImpl(...args: unknown[]): ChildProcess {
        const real = spawnImpl as unknown as (...a: unknown[]) => ChildProcess;
        let ch: LogChannel;
        try {
            ch = resolveChannel(channel);
        } catch {
            return real(...args);
        }
        if (isInertChannel(ch)) return real(...args);

        const command = String(args[0]);
        const argv = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
        const options = (Array.isArray(args[1]) ? args[2] : args[1]) as { env?: NodeJS.ProcessEnv; cwd?: unknown } | undefined;
        const callId = newCallId();
        const ctx = { ...currentLogContext() };
        const startedAt = Date.now();

        let child: ChildProcess;
        try {
            child = real(...args);
        } catch (err) {
            emitRaw(ch, ctx, "spawn.error", { call_id: callId, command, args: argv, duration_ms: Date.now() - startedAt, ...describeError(err) });
            throw err;
        }

        safely(() => {
            const envNames = Object.keys(options?.env ?? process.env).sort();
            emitRaw(ch, ctx, "spawn.start", {
                call_id: callId,
                pid: child.pid,
                command,
                args: argv,
                env_names: envNames,
                env_inherited: options?.env === undefined,
                cwd: options?.cwd === undefined ? process.cwd() : String(options.cwd),
            });
        });

        const totals = { stdout: new BodyCapture({ maxBytes: 0 }), stderr: new BodyCapture({ maxBytes: 0 }) };
        let exited = false;

        // Passive stdin observation: record each write, then call the original untouched.
        safely(() => {
            const stdin = child.stdin;
            if (!stdin) return;
            const originalWrite = stdin.write;
            stdin.write = function patchedWrite(this: typeof stdin, ...wargs: unknown[]): boolean {
                safely(() => {
                    const bytes = toBytes(wargs[0], typeof wargs[1] === "string" ? wargs[1] : undefined);
                    if (bytes) emitRaw(ch, ctx, "spawn.stdin", { call_id: callId, body: captureBody(bytes, { maxBytes }) });
                });
                return (originalWrite as (...a: unknown[]) => boolean).apply(this, wargs);
            } as typeof stdin.write;
        });

        // Passive stdout/stderr observation: wrap emit('data') so the streams' flow state is untouched.
        for (const name of ["stdout", "stderr"] as const) {
            safely(() => {
                const stream = child[name];
                if (!stream) return;
                const originalEmit = stream.emit;
                stream.emit = function patchedEmit(this: typeof stream, event: string | symbol, ...eargs: unknown[]): boolean {
                    if (event === "data") {
                        safely(() => {
                            const bytes = toBytes(eargs[0]);
                            if (!bytes) return;
                            totals[name].append(bytes);
                            emitRaw(ch, ctx, `spawn.${name}`, { call_id: callId, body: captureBody(bytes, { maxBytes }) });
                        });
                    }
                    return (originalEmit as (...a: unknown[]) => boolean).call(this, event, ...eargs);
                } as typeof stream.emit;
            });
        }

        // Passive exit/error observation via emit (an extra 'error' listener would suppress throws).
        safely(() => {
            const originalEmit = child.emit;
            child.emit = function patchedChildEmit(this: ChildProcess, event: string | symbol, ...eargs: unknown[]): boolean {
                safely(() => {
                    if (event === "exit" && !exited) {
                        exited = true;
                        emitRaw(ch, ctx, "spawn.exit", {
                            call_id: callId,
                            pid: child.pid,
                            code: typeof eargs[0] === "number" ? eargs[0] : null,
                            signal: typeof eargs[1] === "string" ? eargs[1] : null,
                            duration_ms: Date.now() - startedAt,
                        });
                    } else if (event === "close") {
                        const out = totals.stdout.finish();
                        const err = totals.stderr.finish();
                        emitRaw(ch, ctx, "spawn.close", {
                            call_id: callId,
                            pid: child.pid,
                            code: typeof eargs[0] === "number" ? eargs[0] : null,
                            signal: typeof eargs[1] === "string" ? eargs[1] : null,
                            duration_ms: Date.now() - startedAt,
                            stdout_bytes: out.body_bytes,
                            stdout_sha256: out.body_sha256,
                            stderr_bytes: err.body_bytes,
                            stderr_sha256: err.body_sha256,
                        });
                    } else if (event === "error") {
                        emitRaw(ch, ctx, "spawn.error", {
                            call_id: callId,
                            command,
                            args: argv,
                            duration_ms: Date.now() - startedAt,
                            ...describeError(eargs[0]),
                        });
                    }
                });
                return (originalEmit as (...a: unknown[]) => boolean).call(this, event, ...eargs);
            } as typeof child.emit;
        });

        return child;
    };
    return impl as unknown as SpawnFn;
}
