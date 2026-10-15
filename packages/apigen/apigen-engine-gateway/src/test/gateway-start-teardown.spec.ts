// guards: gateway start() leaves sibling hosts running after a partial failure, restarts after stop, or mishandles stop during start and supervision backoff
// tier: S
// cites: 78b1c1d6, fcd20c30 (regression)
//
// @adhd/apigen-gateway — start() partial-failure, restart-after-stop, and stop-during-start.
//
// Header (author-regression, one defect per block):
//   - item 78b1c1d6 (fix pre-state 5cec12fa): start() must settle every bringUp and tear
//     down every host when any one host fails. Pre-fix: Promise.all left siblings running.
//     Tier S (unit; in-process createGateway over fake HostAdapters). Fidelity-gap: N/A (tier S).
//     regression:78b1c1d6
//   - item fcd20c30 (fix pre-state 977e0ca6): a stopped or failed gateway cannot restart, and
//     a start in flight during stop() gets exactly one owed post-start adapter.stop().
//     Tier S (unit). Fidelity-gap: N/A (tier S). regression:fcd20c30
//   - item fcd20c30, owed-stop hardening (fix pre-state 16b53560, the committed gateway.ts
//     before owedStopsAfterStart became max(owed, startsInFlight) and the owed
//     adapter.stop() in startAdapter's finally was guarded): a failing owed stop must never
//     replace the start's own outcome, and repeated stop() during one start owes one stop.
//     Tier S (unit). Fidelity-gap: N/A (tier S). regression:fcd20c30
//   - item fcd20c30, supervision cancel: stop() while a supervision backoff timer is pending
//     cancels the timer and no restart follows. Tier S (unit). Fidelity-gap: N/A (tier S).
//     regression:fcd20c30
//
// Only the host boundary (HostAdapter) is faked. The gateway under test is real. Start
// latches are deferred promises released by the test, so there are no sleeps and no wall
// clock. The fake's `alive` flag models the child process: start() sets it, stop() clears it.
// The supervision backoff delay is made nonzero through the existing public options
// (GatewayOptions.backoff.delayMs and GatewayOptions.timers); the test owns a manual clock
// and fires timers itself.
//
// Per-test red expectations (pending user hold, see "red:" below):
//   - the repeated-stop test (b) is a no-regression guard: the owed counter is internal and
//     the over-count it fixes is not observable through the public surface, so it pins the
//     observable consequence (stop count, final dead state, settle result) and is green
//     before and after the fix.
//   - tests (c) and the success-path variant are red at 16b53560 (stop error replaces the
//     start outcome).
//   - the backoff-cancel test (a) guards teardown's cancelBackoff call: it asserts the pending
//     timer is cleared by stop(); it is red if cancelBackoff is removed.
//   - the normal start()->stop() single-stop path passed before the fix and is kept as a
//     no-regression check for the fcd20c30 "exactly one adapter.stop per host" criterion.
//
// red: pending (user hold) — the suite was not executed when these tests were authored.

import { describe, it, expect } from 'vitest';
import type { Operation, Transport } from '@adhd/apigen-core-client';
import { createGateway, type HostAdapter, type HostRequest } from '../lib/gateway';

function seg(raw: string) {
  return { raw, words: [raw] };
}

function op(host: string, name: string): Operation {
  return {
    id: `${host}/${name}`,
    host,
    namespace: seg(host),
    path: [seg(name)],
    kind: 'query',
    async: true,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}

function req(host: string, name: string): HostRequest {
  return {
    operation: op(host, name),
    data: {},
    envelope: {},
    transport: 'http' as Transport,
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Manual timer clock injected through GatewayOptions.timers; the test fires timers itself. */
function makeClock() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h: unknown): void => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
    /** Timers that were scheduled and not cleared. */
    pending: () => timers.filter((t) => !t.cleared),
    /** Fires every still-pending timer, as the real clock would at expiry. */
    fireAll: () => {
      for (const t of timers.filter((x) => !x.cleared)) t.fn();
    },
  };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fake host adapter. `startGate`, when given, holds start() until the test releases it,
 * which lets a test place a start in flight at a chosen point. `startError`, when given,
 * makes start() reject instead of spawning the child. `stopErrorFromCall`, when given,
 * makes adapter.stop() reject from that 1-based call number onward (the child is still
 * marked dead). `crash()` fires the listeners registered through onExit.
 */
function makeHost(
  host: string,
  cfg: { startGate?: Promise<void>; startError?: unknown; stopErrorFromCall?: number; stopError?: unknown } = {}
) {
  let alive = false;
  let stopCount = 0;
  let startCount = 0;
  const exitListeners: ((reason: unknown) => void)[] = [];
  const adapter: HostAdapter = {
    host,
    hopCost: 1,
    async start() {
      startCount += 1;
      if (cfg.startGate) await cfg.startGate;
      if (cfg.startError !== undefined) throw cfg.startError;
      alive = true;
    },
    async ready() {
      return alive;
    },
    async invoke(request) {
      if (!alive) throw new Error(`host ${host} dead`);
      return { ok: true, op: request.operation.id };
    },
    onExit(listener) {
      exitListeners.push(listener);
      return () => {
        const i = exitListeners.indexOf(listener);
        if (i >= 0) exitListeners.splice(i, 1);
      };
    },
    async stop() {
      stopCount += 1;
      alive = false;
      if (cfg.stopErrorFromCall !== undefined && stopCount >= cfg.stopErrorFromCall) {
        throw cfg.stopError ?? new Error(`host ${host} stop failed`);
      }
    },
  };
  return {
    adapter,
    crash() {
      alive = false;
      for (const l of [...exitListeners]) l('crash');
    },
    get alive() {
      return alive;
    },
    get stopCount() {
      return stopCount;
    },
    get startCount() {
      return startCount;
    },
  };
}

describe('start() partial failure tears down the started siblings (78b1c1d6)', () => {
  // Failure mode: one host's start rejects while a sibling's start succeeds. Pre-fix,
  // Promise.all rejected immediately and the sibling kept running with no handle to stop
  // it. AC: start failure on one host tears down the others.
  it('a start failure on one host stops the sibling that started, and rethrows the original error', async () => {
    const boom = new Error('host b failed to start');
    const aGate = deferred();
    const a = makeHost('a', { startGate: aGate.promise });
    const b = makeHost('b', { startError: boom });
    const gw = createGateway({ adapters: [a.adapter, b.adapter] });

    const started = gw.start();
    // Let host a's start settle only after start() is already in flight.
    aGate.resolve();

    await expect(started).rejects.toBe(boom);
    expect(a.alive).toBe(false);
    expect(a.stopCount).toBe(1);
  });

  // Item 78b1c1d6, AC: start failure tears down every host. The failing host is itself torn
  // down too (a rejected start may still have spawned a child), so no host is left with a
  // live child after a partial start. Red at 5cec12fa: no teardown at all.
  it('the failing host is stopped as well, not only its siblings', async () => {
    const boom = new Error('host b failed to start');
    const a = makeHost('a');
    const b = makeHost('b', { startError: boom });
    const gw = createGateway({ adapters: [a.adapter, b.adapter] });

    await expect(gw.start()).rejects.toBe(boom);
    expect(b.stopCount).toBe(1);
    expect(a.alive).toBe(false);
  });
});

describe('a stopped or failed gateway cannot be restarted (fcd20c30)', () => {
  // Failure mode: start() after stop() resolves with every host silently down. AC: restart
  // after stop rejects.
  it('start() after stop() rejects with "gateway is stopped"', async () => {
    const a = makeHost('a');
    const gw = createGateway({ adapters: [a.adapter] });

    await gw.start();
    await gw.stop();

    await expect(gw.start()).rejects.toThrow(/gateway is stopped/);
  });

  // Failure mode: a start that failed leaves the gateway stopped; a retry on the same
  // object must not resolve as if the hosts came up.
  it('start() after a failed start() rejects with "gateway is stopped"', async () => {
    const boom = new Error('host b failed to start');
    const a = makeHost('a');
    const b = makeHost('b', { startError: boom });
    const gw = createGateway({ adapters: [a.adapter, b.adapter] });

    await expect(gw.start()).rejects.toBe(boom);
    await expect(gw.start()).rejects.toThrow(/gateway is stopped/);
  });
});

describe('stop() racing a pending start stops the child once it starts (fcd20c30)', () => {
  // Failure mode: stop() runs while start() is awaiting the adapter. The child spawns
  // after stop()'s adapter.stop() already returned, so it is orphaned. AC: stop() racing a
  // pending start stops the child once started.
  it('a start that settles after stop() leaves no live child', async () => {
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stopped = gw.stop();
    // The start is still in flight when stop() runs; now let it spawn its child.
    gate.resolve();

    await Promise.all([started, stopped]);
    expect(a.startCount).toBe(1);
    expect(a.alive).toBe(false);
  });

  // AC: exactly one owed post-start stop. One stop from stop()'s teardown plus one owed
  // stop for the in-flight start, so two calls in total and no more.
  it('the racing start gets exactly one owed post-start stop (two adapter.stop calls total)', async () => {
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stopped = gw.stop();
    gate.resolve();

    await Promise.all([started, stopped]);
    expect(a.stopCount).toBe(2);
  });
});

describe('stop() racing a pending start: settle result, repeated stop, owed-stop failure (fcd20c30)', () => {
  // AC: the racing start settles deterministically. The start's own work succeeded; the
  // owed stop retires the child, readiness is not published for a retired host, and
  // start() RESOLVES. A later start() is rejected as stopped.
  it('the racing start() resolves after a concurrent stop(), leaves the host down, and a later start() rejects', async () => {
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stopped = gw.stop();
    gate.resolve();

    await expect(started).resolves.toBeUndefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(a.alive).toBe(false);
    const health = await gw.health();
    expect(health.hosts['a'].status).toBe('down');
    expect(health.serving).toBe(false);
    await expect(gw.start()).rejects.toThrow(/gateway is stopped/);
  });

  // AC: repeated stop() during ONE in-flight start owes one post-start stop, not one per
  // stop() call. Each stop() still performs its own adapter.stop(), so with three stop()
  // calls the total is 3 + 1 owed = 4 and the child is dead. The owed counter itself is
  // internal; this pins its observable consequence. Guard test: green before the fix too.
  it('three stop() calls during one in-flight start leave exactly one owed stop and a clean state', async () => {
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stops = [gw.stop(), gw.stop(), gw.stop()];
    gate.resolve();

    await expect(started).resolves.toBeUndefined();
    await Promise.all(stops);
    expect(a.startCount).toBe(1);
    expect(a.stopCount).toBe(4);
    expect(a.alive).toBe(false);
    const health = await gw.health();
    expect(health.hosts['a'].status).toBe('down');
  });

  // Failure mode: the owed adapter.stop() in startAdapter's finally rejects and, being
  // awaited in a finally block, replaces the original start error, so the caller sees a
  // stop failure instead of why the start failed. Red at 16b53560.
  it('an owed adapter.stop() that rejects does not replace the original start error', async () => {
    const boom = new Error('host a failed to start');
    const stopBoom = new Error('host a stop failed');
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise, startError: boom, stopErrorFromCall: 2, stopError: stopBoom });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stopped = gw.stop();
    gate.resolve();

    await expect(started).rejects.toBe(boom);
    await expect(stopped).resolves.toBeUndefined();
  });

  // Success path: the start itself succeeded; a failing owed stop must not turn it into a
  // rejection. start() resolves and the host is not routable. Red at 16b53560.
  it('an owed adapter.stop() that rejects after a successful start leaves start() resolved and the host down', async () => {
    const stopBoom = new Error('host a stop failed');
    const gate = deferred();
    const a = makeHost('a', { startGate: gate.promise, stopErrorFromCall: 2, stopError: stopBoom });
    const gw = createGateway({ adapters: [a.adapter] });

    const started = gw.start();
    const stopped = gw.stop();
    gate.resolve();

    await expect(started).resolves.toBeUndefined();
    await expect(stopped).resolves.toBeUndefined();
    const health = await gw.health();
    expect(health.hosts['a'].status).toBe('down');
  });
});

describe('stop() while a supervision backoff timer is pending (fcd20c30)', () => {
  // Failure mode: a crashed host sits in its restart backoff sleep; stop() must cancel that
  // timer so no restart is scheduled for a host that has been stopped. The nonzero delay is
  // set through GatewayOptions.backoff.delayMs and the manual clock through
  // GatewayOptions.timers, both public.
  it('stop() clears the pending restart timer and no restart follows', async () => {
    const clock = makeClock();
    const a = makeHost('a');
    const gw = createGateway({
      adapters: [a.adapter],
      backoff: { delayMs: () => 250, maxRestarts: 0 },
      timers: clock.timers,
    });
    await gw.start();
    expect(a.startCount).toBe(1);

    a.crash();
    await flush();
    // The supervisor is asleep on its backoff timer (250 ms). The route deadline timer is
    // not scheduled here, so this is the only pending timer.
    expect(clock.pending().map((t) => t.ms)).toEqual([250]);

    await gw.stop();
    expect(clock.pending()).toHaveLength(0);

    // Even if the clock advanced now, nothing may restart the host.
    clock.fireAll();
    await flush();
    expect(a.startCount).toBe(1);
    expect(a.alive).toBe(false);
    const health = await gw.health();
    expect(health.hosts['a'].status).toBe('down');
  });
});

describe('normal start/stop path (no-regression guard, not red pre-fix)', () => {
  // AC: normal start/stop calls adapter.stop exactly once. This is the no-owed-stop
  // path: nothing was in flight during stop(), so no extra post-start stop may run.
  it('start() then stop() calls adapter.stop exactly once per host', async () => {
    const a = makeHost('a');
    const b = makeHost('b');
    const gw = createGateway({ adapters: [a.adapter, b.adapter] });

    await gw.start();
    await gw.stop();

    expect(a.stopCount).toBe(1);
    expect(b.stopCount).toBe(1);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });
});
