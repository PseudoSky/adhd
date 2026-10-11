/**
 * Minimal MCP stdio client shared by the subprocess (e2e) suites of this package:
 * newline-delimited JSON-RPC over a child's stdio, bounded waits, process-group
 * teardown. Extracted from `shell-egress.e2e.test.ts` (0ba70e47) so the exit-status
 * suite (61358b6f) drives the real server the same way. Not part of the library
 * build (`src/test/**` is excluded from `tsconfig.lib.json`).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** SIGTERM -> SIGKILL escalation deadline for teardown. */
export const TEARDOWN_GRACE_MS = 5_000;

/** Minimal MCP stdio client: newline-delimited JSON-RPC, bounded waits. */
export class RpcClient {
  private buf = '';
  private pending = new Map<number, { res: (m: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stderr = '';
  /** stdout lines that were not valid JSON-RPC: kept for failure messages, otherwise ignored. */
  private readonly diagnostics: string[] = [];
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private hasExited = false;
  /** Set once the child can never answer again (spawn failure or exit); every request rejects with it. */
  private fatal?: Error;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise<void>((ok) => (this.resolveExited = ok));
    // Spawn failure (ENOENT/EACCES/...): Node emits 'error' and NEVER 'exit'.
    child.once('error', (err) => this.die(new Error(`failed to spawn server: ${err.message}`)));
    // One shared exit hook for the client's lifetime (no per-request listeners to leak).
    child.once('exit', (code, signal) => this.die(new Error(`server exited (${code ?? signal})`)));
    child.stdin.on('error', (err) => this.diagnostics.push(`stdin error: ${err.message}`));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (this.stderr += d));
    child.stdout.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === '') continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.diagnostics.push(line);
          continue;
        }
        if (msg && typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.res(msg);
          }
        }
      }
    });
  }
  private context(): string {
    return (
      `server stderr:\n${this.stderr}\nnon-JSON stdout lines:\n${this.diagnostics.join('\n')}`
    );
  }
  private die(err: Error): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.fatal = err;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.rej(new Error(`${err.message} before answering request #${id}; ${this.context()}`));
    }
    this.resolveExited();
  }
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.fatal) return Promise.reject(new Error(`${this.fatal.message}; cannot send ${method}; ${this.context()}`));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs}ms; ${this.context()}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  /** Signal the whole process group (srt wrapper + uvx/python/bwrap grandchildren); ESRCH ignored. */
  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }
  /** Await the wrapper's exit: SIGTERM the group, escalate to SIGKILL after a bounded deadline. */
  async close(): Promise<void> {
    if (this.hasExited) return; // spawn failure / already exited: no exit event will ever come
    this.child.stdin.end();
    this.signalGroup('SIGTERM');
    const timer = setTimeout(() => this.signalGroup('SIGKILL'), TEARDOWN_GRACE_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
