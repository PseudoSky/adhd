/**
 * Deterministic {@link RetryClock} for fault tests: `sleep` parks on a latch that only `advance`
 * releases, so no retry/backoff ever waits on wall time (AGENTS.md section 7, rule 3).
 */
import { abortError, type RetryClock } from "../../providers/provider-failure.js";

interface IWaiter { at: number; resolve: () => void; reject: (e: Error) => void }

export class FakeClock implements RetryClock {
  t: number;
  /** Every requested sleep, in order. */
  readonly sleeps: number[] = [];
  private waiters: IWaiter[] = [];

  constructor(startMs = 1_800_000_000_000) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const w: IWaiter = { at: this.t + ms, resolve, reject };
      this.waiters.push(w);
      signal?.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(abortError(signal));
        },
        { once: true }
      );
    });
  }

  get sleeping(): number {
    return this.waiters.length;
  }

  /** Yield to the macrotask queue so every settled promise chain has run. */
  async flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Bounded wait (iteration-counted, not timed) until `n` sleepers are parked. */
  async untilSleeping(n: number): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (this.waiters.length >= n) return;
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error(`expected ${n} parked sleeper(s), have ${this.waiters.length}`);
  }

  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.waiters.filter((w) => w.at <= this.t);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) w.resolve();
    await this.flush();
  }

  /** Advance until `p` settles (jumping to the next sleeper each time); bounded. */
  async settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
    let done: PromiseSettledResult<T> | undefined;
    void p.then(
      (value) => { done = { status: "fulfilled", value }; },
      (reason: unknown) => { done = { status: "rejected", reason }; }
    );
    for (let i = 0; i < 50 && !done; i++) {
      await this.flush();
      if (done) break;
      const next = this.waiters.map((w) => w.at).sort((a, b) => a - b)[0];
      if (next === undefined) continue;
      await this.advance(Math.max(0, next - this.t));
    }
    if (!done) throw new Error("promise did not settle");
    return done;
  }
}
