import type { Operation } from '@adhd/apigen-core-client';
import { commandBaseName, segmentOf } from './command-name';
import type { IProcessLauncher } from './process';

/** Per-stream capture cap (UTF-8 bytes). */
const OUTPUT_CAP_BYTES = 1024 * 1024;
/** Appended to a stream that exceeded the cap. */
export const TRUNCATION_MARKER = '\n[output truncated at 1 MiB]';

/** Result of one argv-fallback invocation. */
export interface IArgvResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Present when the process was terminated by a signal (including our own abort/timeout kill); `exitCode` is then -1. */
  signal?: string;
}

/** Default wall-clock limit for one argv invocation. */
export const DEFAULT_ARGV_TIMEOUT_MS = 120_000;
/** After SIGTERM, how long an aborted/timed-out process group gets before SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Options for {@link createArgvInvoker}. */
export interface IArgvInvokerOptions {
  /** Kills the process group when the invocation exceeds this many ms (default 120000; `0` disables). */
  readonly timeoutMs?: number;
  /** Default cancellation signal; a per-call signal passed to the invoker takes precedence. */
  readonly signal?: AbortSignal;
}

/**
 * D-07: the argv fallback for a `bin:` source. One `action` operation whose id is the
 * command's basename without extension (`touch`); input `{argv, cwd}` (`argv` excludes
 * the command, `cwd` is the working directory); output `{exitCode, stdout, stderr}`.
 * Pure construction: nothing is started (SRC-05 / PS-28).
 */
export function buildArgvOperation(command: string): { operation: Operation; fnName: string } {
  const fnName = commandBaseName(command);
  const seg = segmentOf(fnName);
  const operation: Operation = {
    id: fnName,
    host: 'ts',
    namespace: seg,
    path: [seg],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: {
      type: 'object',
      required: ['argv', 'cwd'],
      additionalProperties: false,
      properties: {
        argv: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
    },
    output: {
      type: 'object',
      required: ['exitCode', 'stdout', 'stderr'],
      additionalProperties: false,
      properties: {
        exitCode: { type: 'number' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        signal: { type: 'string' },
      },
    },
    envelope: {},
    typeText: null,
    hasCtx: false,
  };
  return { operation, fnName };
}

function capture(): { push(chunk: string): void; text(): string } {
  let text = '';
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const room = OUTPUT_CAP_BYTES - bytes;
      const size = Buffer.byteLength(chunk, 'utf8');
      if (size <= room) {
        text += chunk;
        bytes += size;
        return;
      }
      // Keep the largest prefix of whole characters that fits.
      let keep = Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8');
      if (keep.endsWith('�')) keep = keep.slice(0, -1);
      text += keep;
      bytes = OUTPUT_CAP_BYTES;
      truncated = true;
    },
    text: () => (truncated ? text + TRUNCATION_MARKER : text),
  };
}

/**
 * The invoker for the argv operation: starts `command` through `launcher` with
 * `{args: input.argv, cwd: input.cwd}`, collects stdout and stderr as UTF-8 strings
 * (1 MiB cap each; a capped stream ends with a truncation marker) and resolves with
 * `{exitCode: code ?? -1, stdout, stderr}` (plus `signal` when a signal ended the
 * process). The process starts when this function is called, never at construction or
 * extraction.
 *
 * Aborting the signal (the per-call `signal` argument, else `options.signal`) or exceeding
 * `options.timeoutMs` (default 120000) sends SIGTERM to the process (the launcher
 * signals the whole process group), then SIGKILL after a short grace; the result is
 * `exitCode: -1` with the terminating `signal`. A signal that is already aborted rejects
 * with its reason without starting anything.
 */
export function createArgvInvoker(
  command: string,
  launcher: IProcessLauncher,
  options: IArgvInvokerOptions = {}
): (input: { argv: string[]; cwd: string }, signal?: AbortSignal) => Promise<IArgvResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARGV_TIMEOUT_MS;
  return async (input, callSignal) => {
    if (!Array.isArray(input?.argv) || input.argv.some((a) => typeof a !== 'string')) {
      throw new TypeError('argv must be an array of strings');
    }
    if (typeof input.cwd !== 'string') {
      throw new TypeError('cwd must be a string');
    }
    const signal = callSignal ?? options.signal;
    signal?.throwIfAborted();
    const handle = await launcher.start({ command, args: input.argv, cwd: input.cwd });
    const out = capture();
    const err = capture();
    handle.onStdout((c) => out.push(c));
    handle.onStderr((c) => err.push(c));
    handle.stdin.end();

    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      handle.kill('SIGTERM');
      escalation ??= setTimeout(() => handle.kill('SIGKILL'), KILL_GRACE_MS);
      escalation.unref?.();
    };
    const timer = timeoutMs > 0 ? setTimeout(terminate, timeoutMs) : undefined;
    timer?.unref?.();
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    try {
      const { code, signal: ended } = await handle.exited;
      return {
        exitCode: code ?? -1,
        stdout: out.text(),
        stderr: err.text(),
        ...(ended ? { signal: ended } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
        handle.kill('SIGKILL'); // sweep any grandchild that outlived the group leader
      }
      signal?.removeEventListener('abort', terminate);
    }
  };
}
