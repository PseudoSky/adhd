/**
 * retry-policy.spec.ts — AC3 (grace window + full jitter + bounded budget)
 * and AC6 (typed failure, breaker refusal, half-open recovery).
 *
 * All timing is a VIRTUAL clock via injected `now`/`sleep`; a seeded `rand`
 * makes jitter deterministic. There is no real sleep anywhere in this file.
 */
import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  fullJitterDelay,
  withResilience,
  type IResiliencePolicy,
} from './retry-policy.js';
import { ServiceNotReadyError } from './service-errors.js';

function virtualDeps(): {
  deps: { graceMs: number; rand: () => number; now: () => number; sleep: (ms: number) => Promise<void> };
  setNow: (n: number) => void;
  getNow: () => number;
} {
  let now = 0;
  return {
    deps: {
      graceMs: 20000,
      rand: () => 1,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    },
    setNow: (n) => {
      now = n;
    },
    getNow: () => now,
  };
}

const POLICY: IResiliencePolicy = {
  maxAttempts: 3,
  baseMs: 100,
  maxMs: 5000,
  budgetMs: 60000,
  breakerFailureThreshold: 3,
  breakerResetMs: 30000,
};

describe('fullJitterDelay', () => {
  it('is rand() * min(maxMs, baseMs * 2**attempt), deterministic under a seeded rand', () => {
    expect(fullJitterDelay(0, POLICY, () => 1)).toBe(100);
    expect(fullJitterDelay(1, POLICY, () => 1)).toBe(200);
    expect(fullJitterDelay(0, POLICY, () => 0)).toBe(0);
    expect(fullJitterDelay(20, POLICY, () => 1)).toBe(5000); // capped at maxMs
  });
});

describe('withResilience (AC3)', () => {
  it('applies graceMs to the FIRST attempt so a cold start succeeds', async () => {
    const { deps } = virtualDeps();
    const calls: Array<{ attempt: number; deadlineMs: number }> = [];
    const connect = async (attempt: number, deadlineMs: number): Promise<string> => {
      calls.push({ attempt, deadlineMs });
      if (deadlineMs >= 20000) return 'ok';
      throw new Error('slow start exceeded deadline');
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetMs: 30000,
      now: deps.now,
    });
    await expect(
      withResilience(connect, POLICY, breaker, deps)
    ).resolves.toBe('ok');
    expect(calls[0]).toEqual({ attempt: 0, deadlineMs: 20000 });
    expect(deps.now()).toBe(0); // no retry, no sleep
  });

  it('NEGATIVE CONTROL: without the grace window the same slow start fails', async () => {
    const { deps } = virtualDeps();
    const noGrace = { ...deps, graceMs: 0 };
    const calls: Array<{ attempt: number; deadlineMs: number }> = [];
    const connect = async (attempt: number, deadlineMs: number): Promise<string> => {
      calls.push({ attempt, deadlineMs });
      throw new Error('slow start exceeded deadline');
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      resetMs: 30000,
      now: noGrace.now,
    });
    await expect(
      withResilience(connect, POLICY, breaker, noGrace)
    ).rejects.toBeInstanceOf(ServiceNotReadyError);
    // Every attempt got a deadline far below the cold-start need.
    expect(calls.every((c) => c.deadlineMs < 20000)).toBe(true);
  });

  it('stays bounded in wall-clock by budgetMs', async () => {
    const { deps, getNow } = virtualDeps();
    const policy: IResiliencePolicy = { ...POLICY, maxAttempts: 10, budgetMs: 1500 };
    const alwaysFails = async (): Promise<string> => {
      throw new Error('nope');
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 100,
      resetMs: 30000,
      now: deps.now,
    });
    await expect(
      withResilience(alwaysFails, policy, breaker, deps)
    ).rejects.toBeInstanceOf(ServiceNotReadyError);
    expect(getNow()).toBeLessThanOrEqual(policy.budgetMs);
  });
});

describe('CircuitBreaker (AC6)', () => {
  it('opens after the threshold, refuses while open, recovers half-open', async () => {
    let now = 0;
    const deps = {
      graceMs: 100,
      rand: () => 0.5,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetMs: 1000,
      now: () => now,
    });
    const policy: IResiliencePolicy = {
      maxAttempts: 1,
      baseMs: 10,
      maxMs: 20,
      budgetMs: 10000,
      breakerFailureThreshold: 2,
      breakerResetMs: 1000,
    };
    const fail = async (): Promise<string> => {
      throw new Error('transport dropped');
    };
    const ok = async (): Promise<string> => 'reconnected';

    // A mid-session drop surfaces a typed failure; after the threshold the
    // breaker opens.
    await expect(withResilience(fail, policy, breaker, deps)).rejects.toBeInstanceOf(
      ServiceNotReadyError
    );
    await expect(withResilience(fail, policy, breaker, deps)).rejects.toBeInstanceOf(
      ServiceNotReadyError
    );
    expect(breaker.state()).toBe('open');

    // While open it refuses IMMEDIATELY (no attempt, no hang).
    await expect(withResilience(ok, policy, breaker, deps)).rejects.toBeInstanceOf(
      ServiceNotReadyError
    );

    // Past resetMs it is half-open; the next call reconnects and closes.
    now += 1000;
    expect(breaker.state()).toBe('half-open');
    await expect(withResilience(ok, policy, breaker, deps)).resolves.toBe(
      'reconnected'
    );
    expect(breaker.state()).toBe('closed');
  });
});
