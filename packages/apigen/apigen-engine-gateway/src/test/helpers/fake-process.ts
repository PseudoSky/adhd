// A fake IProcessHandle: no OS process, fully scripted. Output is buffered until a consumer
// subscribes (the same replay contract the real launcher honours), exit is an explicit event,
// and every kill / stdin write is recorded so tests assert on observable behaviour.

import type { IProcessHandle } from '../../lib/sources';

type ExitInfo = { code: number | null; signal: string | null };

function channel(): { push(chunk: string): void; subscribe(cb: (chunk: string) => void): void } {
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

export interface IFakeProcessOptions {
  /** SIGTERM does not end the process (only SIGKILL does). */
  readonly ignoreSigterm?: boolean;
  /** Called with every chunk written to stdin. */
  readonly onStdin?: (chunk: string, proc: FakeProcess) => void;
  /** Called once when stdin is ended. */
  readonly onStdinEnd?: (proc: FakeProcess) => void;
}

/** A scripted process: `handle` is what a launcher returns, the rest is the test's remote control. */
export class FakeProcess {
  readonly kills: string[] = [];
  readonly stdinChunks: string[] = [];
  stdinEnded = false;
  hasExited = false;
  readonly handle: IProcessHandle;
  private readonly out = channel();
  private readonly err = channel();
  private resolveExit!: (info: ExitInfo) => void;
  private readonly exitedPromise: Promise<ExitInfo>;

  constructor(private readonly options: IFakeProcessOptions = {}) {
    this.exitedPromise = new Promise<ExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
    this.handle = {
      stdin: {
        write: (chunk) => {
          this.stdinChunks.push(chunk);
          this.options.onStdin?.(chunk, this);
        },
        end: () => {
          if (this.stdinEnded) return;
          this.stdinEnded = true;
          this.options.onStdinEnd?.(this);
        },
      },
      onStdout: (cb) => this.out.subscribe(cb),
      onStderr: (cb) => this.err.subscribe(cb),
      exited: this.exitedPromise,
      kill: (signal = 'SIGTERM') => {
        this.kills.push(signal);
        if (signal === 'SIGKILL' || !this.options.ignoreSigterm) this.exit(null, signal);
      },
    };
  }

  /** Emit stdout text. */
  stdout(text: string): void {
    this.out.push(text);
  }

  /** Emit stderr text. */
  stderr(text: string): void {
    this.err.push(text);
  }

  /** End the process (idempotent). */
  exit(code: number | null, signal: string | null = null): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.resolveExit({ code, signal });
  }
}
