/**
 * retry-policy.ts — bounded retry with full jitter + a three-state breaker
 * (D-A, Segment C).
 *
 * The composed policy is bounded in WALL-CLOCK (`budgetMs`), not merely in
 * attempt count. `graceMs` extends the FIRST attempt's deadline (the
 * cold-start window) BEFORE any retry — the fix for the measured
 * host-deadline-vs-cold-start gap — and is never multiplied per attempt.
 *
 * Dependency-free by design: the design named `cockatiel`, but repo policy
 * requires human approval for external tools and the required behaviour is
 * ~60 lines. Adopting `cockatiel` stays a separate, approval-gated decision.
 *
 * `rand`/`now`/`sleep` are injectable so tests use a seeded rand and a VIRTUAL
 * clock — NEVER a real sleep.
 */
import { ServiceNotReadyError } from './service-errors.js';

export interface IResiliencePolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  budgetMs: number;
  breakerFailureThreshold: number;
  breakerResetMs: number;
}

/** Full jitter: `rand() * min(maxMs, baseMs * 2**attempt)`. */
export function fullJitterDelay(
  attempt: number,
  p: Pick<IResiliencePolicy, 'baseMs' | 'maxMs'>,
  rand: () => number
): number {
  const capped = Math.min(p.maxMs, p.baseMs * 2 ** attempt);
  return Math.floor(rand() * capped);
}

export type IBreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly now: () => number;

  constructor(p: {
    failureThreshold: number;
    resetMs: number;
    now?: () => number;
  }) {
    this.failureThreshold = p.failureThreshold;
    this.resetMs = p.resetMs;
    this.now = p.now ?? (() => Date.now());
  }

  state(): IBreakerState {
    if (this.openedAt === undefined) return 'closed';
    if (this.now() - this.openedAt >= this.resetMs) return 'half-open';
    return 'open';
  }

  /** open → refuse (no attempt). closed/half-open → allow one. */
  tryPass(): boolean {
    const s = this.state();
    if (s === 'open') return false;
    if (s === 'half-open') this.probing = true;
    return true;
  }

  /** → closed. */
  onSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /** → open after threshold (or immediately on a failed half-open probe). */
  onFailure(): void {
    this.failures += 1;
    if (this.probing || this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
    this.probing = false;
  }
}

export interface IResilienceDeps {
  graceMs: number;
  rand: () => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Wraps the connect/handshake of ONE call. Applies `graceMs` to the FIRST
 * attempt's deadline (the cold-start window) BEFORE any retry, then retries
 * with full jitter inside a total `budgetMs`; refuses immediately when the
 * breaker is open. On budget exhaustion / open breaker → {@link ServiceNotReadyError}.
 */
export async function withResilience<T>(
  fn: (attempt: number, deadlineMs: number) => Promise<T>,
  p: IResiliencePolicy,
  breaker: CircuitBreaker,
  deps: IResilienceDeps
): Promise<T> {
  const start = deps.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < p.maxAttempts; attempt++) {
    if (!breaker.tryPass()) {
      throw new ServiceNotReadyError(
        breaker.state(),
        'circuit breaker open — refusing the attempt'
      );
    }
    if (deps.now() - start >= p.budgetMs) {
      throw new ServiceNotReadyError(
        'starting',
        `wall-clock budget ${p.budgetMs}ms exhausted after ${attempt} attempt(s)`
      );
    }
    const deadlineMs =
      attempt === 0 ? Math.min(deps.graceMs, p.budgetMs) : p.maxMs;
    try {
      const value = await fn(attempt, deadlineMs);
      breaker.onSuccess();
      return value;
    } catch (err) {
      lastError = err;
      breaker.onFailure();
      if (attempt === p.maxAttempts - 1) break;
      const delay = fullJitterDelay(attempt, p, deps.rand);
      if (deps.now() - start + delay > p.budgetMs) break;
      await deps.sleep(delay);
    }
  }
  if (lastError instanceof ServiceNotReadyError) throw lastError;
  throw new ServiceNotReadyError(
    breaker.state(),
    lastError instanceof Error ? lastError.message : String(lastError)
  );
}
