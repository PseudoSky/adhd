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

/**
 * Environment variables a started process inherits by default. Everything else in the
 * parent environment (tokens, cloud credentials, ...) is withheld; a caller that needs
 * more passes it through `spec.env`.
 */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SHELL'] as const;

function childEnvironment(spec: IProcessSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...spec.env };
}

/** Signal the child's whole process group when it leads one (POSIX `detached`), else just the child. */
function signalTree(child: ChildProcess, grouped: boolean, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (grouped && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // the group is already gone or not signalable; fall through to the direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

function wrap(child: ChildProcess, grouped: boolean): IProcessHandle {
  const out = bufferedChannel();
  const err = bufferedChannel();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => out.push(c));
  child.stderr?.on('data', (c: string) => err.push(c));
  // A child that exits before reading stdin raises EPIPE; the exit status already reports it.
  child.stdin?.on('error', () => undefined);
  // Spawn succeeded; later 'error' events (a failed kill, a stream fault) must never be unhandled.
  child.on('error', () => undefined);
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
    kill: (signal = 'SIGTERM') => signalTree(child, grouped, signal),
  };
}

/**
 * Default launcher: `child_process.spawn` with `shell: false`, piped stdio and an
 * allowlisted environment (`PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL`) overlaid by
 * `spec.env`. On POSIX the child leads its own process group and `kill` signals the whole
 * group, so grandchildren die with it. Rejects `SourceError('spawn-failed')` when the
 * process cannot be started (for example the command does not exist).
 */
export const nodeProcessLauncher: IProcessLauncher = {
  start(spec) {
    return new Promise<IProcessHandle>((resolve, reject) => {
      let child: ChildProcess;
      const grouped = process.platform !== 'win32';
      try {
        child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: childEnvironment(spec),
          shell: false,
          detached: grouped,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new SourceError('spawn-failed', `cannot start ${spec.command}: ${(e as Error).message}`));
        return;
      }
      child.once('error', (e) =>
        reject(new SourceError('spawn-failed', `cannot start ${spec.command}: ${e.message}`))
      );
      child.once('spawn', () => resolve(wrap(child, grouped)));
    });
  },
};
