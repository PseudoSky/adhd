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
//
// Only the host boundary (HostAdapter) is faked. The gateway under test is real. Start
// latches are deferred promises released by the test, so there are no sleeps and no wall
// clock. The fake's `alive` flag models the child process: start() sets it, stop() clears it.
//
// Not a regression guard on its own: the normal start()->stop() single-stop path already
// passed before the fix and is kept here as a no-regression check.

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

/**
 * Fake host adapter. `startGate`, when given, holds start() until the test releases it,
 * which lets a test place a start in flight at a chosen point. `startError`, when given,
 * makes start() reject instead of spawning the child.
 */
function makeHost(
  host: string,
  cfg: { startGate?: Promise<void>; startError?: unknown } = {}
) {
  let alive = false;
  let stopCount = 0;
  let startCount = 0;
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
    onExit() {
      return () => undefined;
    },
    async stop() {
      stopCount += 1;
      alive = false;
    },
  };
  return {
    adapter,
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

  // Negative control: the failing host is itself torn down too, so no host is left
  // with a live child after a partial start.
  it('NEGATIVE CONTROL: the failing host is stopped as well, not only its siblings', async () => {
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
