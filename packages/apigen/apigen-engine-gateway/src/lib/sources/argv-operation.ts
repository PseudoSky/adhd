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
 * `{exitCode: code ?? -1, stdout, stderr}`. The process starts when this function is
 * called, never at construction or extraction.
 */
export function createArgvInvoker(
  command: string,
  launcher: IProcessLauncher
): (input: { argv: string[]; cwd: string }) => Promise<IArgvResult> {
  return async (input) => {
    if (!Array.isArray(input?.argv) || input.argv.some((a) => typeof a !== 'string')) {
      throw new TypeError('argv must be an array of strings');
    }
    if (typeof input.cwd !== 'string') {
      throw new TypeError('cwd must be a string');
    }
    const handle = await launcher.start({ command, args: input.argv, cwd: input.cwd });
    const out = capture();
    const err = capture();
    handle.onStdout((c) => out.push(c));
    handle.onStderr((c) => err.push(c));
    handle.stdin.end();
    const { code } = await handle.exited;
    return { exitCode: code ?? -1, stdout: out.text(), stderr: err.text() };
  };
}
