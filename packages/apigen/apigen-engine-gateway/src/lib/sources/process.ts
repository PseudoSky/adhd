import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { SourceError } from './types';

/** What to start. `command` is a name or path; `args` are passed as an array (never through a shell). */
export interface IProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** A started process. Output callbacks replay anything produced before registration. */
export interface IProcessHandle {
  readonly stdin: { write(chunk: string): void; end(): void };
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

/** The port a sandbox implements to confine upstream processes. Rejects `SourceError('spawn-failed')`. */
export interface IProcessLauncher {
  start(spec: IProcessSpec): Promise<IProcessHandle>;
}

/** A line-agnostic output channel that buffers until a consumer registers. */
function bufferedChannel(): { push(chunk: string): void; subscribe(cb: (chunk: string) => void): void } {
  const pending: string[] = [];
  let sink: ((chunk: string) => void) | undefined;
  return {
    push(chunk) {
      if (sink) sink(chunk);
      else pending.push(chunk);
    },
    subscribe(cb) {
      sink = cb;
      for (const chunk of pending.splice(0)) cb(chunk);
    },
  };
}

function wrap(child: ChildProcess): IProcessHandle {
  const out = bufferedChannel();
  const err = bufferedChannel();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => out.push(c));
  child.stderr?.on('data', (c: string) => err.push(c));
  // A child that exits before reading stdin raises EPIPE; the exit status already reports it.
  child.stdin?.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    // 'close' (not 'exit') fires after the stdio streams are drained, so no output is lost.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    stdin: {
      write: (chunk) => {
        child.stdin?.write(chunk);
      },
      end: () => {
        child.stdin?.end();
      },
    },
    onStdout: (cb) => out.subscribe(cb),
    onStderr: (cb) => err.subscribe(cb),
    exited,
    kill: (signal = 'SIGTERM') => {
      child.kill(signal);
    },
  };
}

/**
 * Default launcher: `child_process.spawn` with `shell: false`, piped stdio and
 * `env = process.env` overlaid by `spec.env`. Rejects `SourceError('spawn-failed')`
 * when the process cannot be started (for example the command does not exist).
 */
export const nodeProcessLauncher: IProcessLauncher = {
  start(spec) {
    return new Promise<IProcessHandle>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new SourceError('spawn-failed', `cannot start ${spec.command}: ${(e as Error).message}`));
        return;
      }
      child.once('error', (e) =>
        reject(new SourceError('spawn-failed', `cannot start ${spec.command}: ${e.message}`))
      );
      child.once('spawn', () => resolve(wrap(child)));
    });
  },
};
