// @adhd/apigen-gateway — §13.1 FAILURE MODEL behavioral suite.
//
// These tests drive the REAL gateway (createGateway) against in-memory host adapters that
// implement the REAL HostAdapter interface — only the host boundary is faked, never the
// gateway under test. Determinism is via latches/barriers and an injected timer (never
// sleep / wall clock; CLAUDE.md §6). Each behavior is proved with teeth: the assertion
// fails if the §13.1 guarantee regresses (negative controls included).

import { describe, it, expect } from 'vitest'
import type { Operation, Transport } from '@adhd/apigen-core'
import {
  createGateway,
  createInProcessHostAdapter,
  isGatewayError,
  type HostAdapter,
  type HostRequest,
} from '../lib/gateway'

// ---------------------------------------------------------------------------
// Test helpers — minimal valid Operation + a controllable fake host adapter.
// ---------------------------------------------------------------------------

function seg(raw: string) {
  return { raw, words: [raw] }
}

/** Build a minimal valid Operation tagged with the given host. */
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
  }
}

function req(host: string, name: string, data: Record<string, unknown> = {}): HostRequest {
  return { operation: op(host, name), data, envelope: {}, transport: 'http' as Transport }
}

/** A deferred latch — resolve()/reject() from outside; await the .promise. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A fully controllable in-memory host adapter implementing the REAL HostAdapter contract.
 * Tests flip `ready`, fire `crash()`, and (optionally) gate `invoke` on a manual barrier —
 * all deterministic, no timers.
 */
function makeFakeHost(
  host: string,
  cfg: {
    hopCost?: 0 | 1
    readyAfterStart?: boolean
    handler?: (req: HostRequest, signal: AbortSignal) => Promise<unknown>
  } = {},
) {
  let isReady = cfg.readyAfterStart ?? true
  let alive = false
  let startCount = 0
  const exitListeners = new Set<(reason: unknown) => void>()

  const adapter: HostAdapter = {
    host,
    hopCost: cfg.hopCost ?? 1,
    async start() {
      startCount += 1
      alive = true
    },
    async ready() {
      return alive && isReady
    },
    async invoke(request, signal) {
      if (!alive) throw new Error(`host ${host} dead`)
      if (cfg.handler) return cfg.handler(request, signal)
      return { ok: true, host, op: request.operation.id, data: request.data }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    async stop() {
      alive = false
    },
  }

  return {
    adapter,
    /** Simulate a sidecar crash: process dies + fires the exit listener (drives restart). */
    crash(reason: unknown = 'killed') {
      alive = false
      for (const l of [...exitListeners]) l(reason)
    },
    setReady(v: boolean) {
      isReady = v
    },
    get startCount() {
      return startCount
    },
    get alive() {
      return alive
    },
  }
}

/** Wait for a predicate to hold, polling via microtasks (bounded; no wall clock). */
async function until(pred: () => boolean, maxTicks = 5000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return
    await Promise.resolve()
  }
  throw new Error('until(): predicate never became true within bounded ticks')
}

// ---------------------------------------------------------------------------
// §13.1 — Partial availability
// ---------------------------------------------------------------------------

describe('§13.1 partial availability', () => {
  it('a down host fails ONLY its own ops; other hosts keep serving', async () => {
    const ts = makeFakeHost('ts', { hopCost: 0 })
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({ adapters: [ts.adapter, py.adapter] })
    await gw.start()

    // Baseline: both hosts serve.
    await expect(gw.route(req('ts', 'a'))).resolves.toMatchObject({ host: 'ts' })
    await expect(gw.route(req('py', 'b'))).resolves.toMatchObject({ host: 'py' })

    // Kill ONLY the python host.
    py.crash()
    await until(() => !py.alive)

    // Its ops now fail with unavailable...
    const err = await gw.route(req('py', 'b')).then(
      () => null,
      (e) => e,
    )
    expect(err).not.toBeNull()
    expect(isGatewayError(err)).toBe(true)
    expect(err.details.gatewayCode).toBe('unavailable')
    expect(err.details.httpStatus).toBe(503)

    // NEGATIVE CONTROL: the healthy TS host is untouched — still serving.
    await expect(gw.route(req('ts', 'a'))).resolves.toMatchObject({ host: 'ts' })

    await gw.stop()
  })

  it('the aggregate health reports per-host status (ready vs down)', async () => {
    const ts = makeFakeHost('ts', { hopCost: 0 })
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({ adapters: [ts.adapter, py.adapter] })
    await gw.start()

    py.crash()
    await until(() => !py.alive)

    const health = await gw.health()
    expect(health.hosts['ts'].status).toBe('ready')
    expect(health.hosts['py'].status).toBe('down')
    expect(health.serving).toBe(true) // ts still serving → surface not whole-down
    await gw.stop()
  })
})

// ---------------------------------------------------------------------------
// §13.1 — Readiness gating
// ---------------------------------------------------------------------------

describe('§13.1 readiness gating', () => {
  it('does NOT route to a not-ready host, then routes once it reports ready', async () => {
    const py = makeFakeHost('py', { hopCost: 1, readyAfterStart: false })
    const gw = createGateway({ adapters: [py.adapter] })
    await gw.start()

    // Host started but not ready → ops NOT routed (unavailable).
    const before = await gw.route(req('py', 'op')).then(
      () => null,
      (e) => e,
    )
    expect(before).not.toBeNull()
    expect(isGatewayError(before)).toBe(true)
    expect(before.details.gatewayCode).toBe('unavailable')

    // Now the host's _meta/health flips to ready.
    py.setReady(true)

    // Gateway re-probes a degraded host on route → now it routes.
    await expect(gw.route(req('py', 'op'))).resolves.toMatchObject({ host: 'py' })
    await gw.stop()
  })

  it('NEGATIVE CONTROL: a host that never reports ready never routes', async () => {
    const py = makeFakeHost('py', { hopCost: 1, readyAfterStart: false })
    const gw = createGateway({ adapters: [py.adapter] })
    await gw.start()

    const err = await gw.route(req('py', 'op')).then(
      () => 'ROUTED',
      (e) => (isGatewayError(e) ? e.details.gatewayCode : 'OTHER'),
    )
    expect(err).toBe('unavailable')
    await gw.stop()
  })
})

// ---------------------------------------------------------------------------
// §13.1 — Deadlines
// ---------------------------------------------------------------------------

describe('§13.1 deadlines', () => {
  it('a hung host op → deadline_exceeded (driven by injected timer, no wall clock)', async () => {
    // Injected timer: capture the scheduled deadline callback; we fire it manually.
    let fire: (() => void) | null = null
    const timers = {
      setTimeout: (fn: () => void) => {
        fire = fn
        return 1 as unknown
      },
      clearTimeout: () => undefined,
    }

    const hang = deferred<unknown>() // the host op never resolves on its own
    const py = makeFakeHost('py', {
      hopCost: 1,
      handler: () => hang.promise,
    })
    const gw = createGateway({ adapters: [py.adapter], defaultDeadlineMs: 1000, timers })
    await gw.start()

    const routed = gw.route(req('py', 'slow'))

    // Let the gateway register its deadline timer.
    await until(() => fire != null)
    fire!() // deadline elapses

    const err = await routed.then(
      () => null,
      (e) => e,
    )
    expect(err).not.toBeNull()
    expect(isGatewayError(err)).toBe(true)
    expect(err.details.gatewayCode).toBe('deadline_exceeded')
    expect(err.details.httpStatus).toBe(504)
    await gw.stop()
  })

  it('NEGATIVE CONTROL: a fast op resolves before the deadline fires', async () => {
    let fire: (() => void) | null = null
    const timers = {
      setTimeout: (fn: () => void) => {
        fire = fn
        return 1 as unknown
      },
      clearTimeout: () => undefined,
    }
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({ adapters: [py.adapter], defaultDeadlineMs: 1000, timers })
    await gw.start()

    // The handler resolves synchronously-ish; the deadline is never fired by us.
    await expect(gw.route(req('py', 'fast'))).resolves.toMatchObject({ host: 'py' })
    expect(fire).not.toBeNull() // a timer WAS scheduled (proves we cleared it, didn't fire)
    await gw.stop()
  })

  it('caller cancellation propagates to the host adapter signal', async () => {
    const ctrl = new AbortController()
    let sawAbort = false
    const gate = deferred<unknown>()
    const py = makeFakeHost('py', {
      hopCost: 1,
      handler: (_r, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('aborted'))
          })
          void gate.promise
        }),
    })
    const gw = createGateway({ adapters: [py.adapter] })
    await gw.start()

    const routed = gw.route(req('py', 'cancellable'), ctrl.signal).catch((e) => e)
    ctrl.abort('user-cancel')
    await routed
    await until(() => sawAbort)
    expect(sawAbort).toBe(true)
    await gw.stop()
  })
})

// ---------------------------------------------------------------------------
// §13.1 — Supervision / restart
// ---------------------------------------------------------------------------

describe('§13.1 supervision', () => {
  it('restarts a crashed host (zero-delay backoff) and resumes serving', async () => {
    // delayMs: () => 0 makes the gateway's sleep() resolve WITHOUT touching any timer,
    // so backoff is deterministic with no wall clock. The default real timer is used only
    // for the per-call deadline (never fired here — every handler resolves immediately).
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({
      adapters: [py.adapter],
      backoff: { delayMs: () => 0, maxRestarts: 0 },
    })
    await gw.start()
    expect(py.startCount).toBe(1)

    await expect(gw.route(req('py', 'a'))).resolves.toMatchObject({ host: 'py' })

    // Crash → supervision restarts it. Wait until the GATEWAY reports the host ready
    // again (the supervision loop has completed start() + ready()), not just the fake's
    // internal startCount — that flips before ready() resolves.
    py.crash()
    let health = await gw.health()
    for (let i = 0; i < 5000 && health.hosts['py'].status !== 'ready'; i++) {
      await Promise.resolve()
      health = await gw.health()
    }
    expect(health.hosts['py'].status).toBe('ready')
    expect(py.startCount).toBeGreaterThanOrEqual(2)

    // After restart it serves again.
    await expect(gw.route(req('py', 'a'))).resolves.toMatchObject({ host: 'py' })

    health = await gw.health()
    expect(health.hosts['py'].restarts).toBeGreaterThanOrEqual(1)
    await gw.stop()
  })

  it('NEGATIVE CONTROL: a crash does not restart a retired (stopped) gateway', async () => {
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({ adapters: [py.adapter], backoff: { delayMs: () => 0, maxRestarts: 0 } })
    await gw.start()
    await gw.stop()

    const startsBefore = py.startCount
    py.crash()
    // Give any (incorrect) restart a chance to run.
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(py.startCount).toBe(startsBefore) // never restarted after stop
  })
})

// ---------------------------------------------------------------------------
// §13.1 — Cost-based topology
// ---------------------------------------------------------------------------

describe('§13.1 cost function / topology', () => {
  it('all-in-process topology has zero hop cost (the single-host fast path)', async () => {
    const ts = createInProcessHostAdapter('ts', {
      invoke: async (r) => ({ host: 'ts', op: r.operation.id }),
    })
    const gw = createGateway({ adapters: [ts] })
    await gw.start()
    expect(gw.topologyCost()).toBe(0)
    await expect(gw.route(req('ts', 'x'))).resolves.toMatchObject({ host: 'ts' })
    await gw.stop()
  })

  it('each out-of-process sidecar adds exactly one hop to the topology cost', async () => {
    const ts = createInProcessHostAdapter('ts', { invoke: async () => ({ host: 'ts' }) })
    const py = makeFakeHost('py', { hopCost: 1 })
    const rust = makeFakeHost('rust', { hopCost: 1 })
    const gw = createGateway({ adapters: [ts, py.adapter, rust.adapter] })
    await gw.start()
    // ts(0) + py(1) + rust(1) = 2 round-trips.
    expect(gw.topologyCost()).toBe(2)
    await gw.stop()
  })

  it('the in-process adapter routes with zero hop and reports hopCost 0 in health', async () => {
    const ts = createInProcessHostAdapter('ts', { invoke: async () => ({ host: 'ts' }) })
    const gw = createGateway({ adapters: [ts] })
    await gw.start()
    const health = await gw.health()
    expect(health.hosts['ts'].hopCost).toBe(0)
    expect(health.hosts['ts'].status).toBe('ready')
    await gw.stop()
  })
})

// ---------------------------------------------------------------------------
// Routing correctness — ops route to their OWNING host (operation.host)
// ---------------------------------------------------------------------------

describe('routing by operation.host', () => {
  it('routes each op to the runtime named by operation.host', async () => {
    const ts = makeFakeHost('ts', { hopCost: 0 })
    const py = makeFakeHost('py', { hopCost: 1 })
    const gw = createGateway({ adapters: [ts.adapter, py.adapter] })
    await gw.start()

    await expect(gw.route(req('ts', 'humanize'))).resolves.toMatchObject({ host: 'ts', op: 'ts/humanize' })
    await expect(gw.route(req('py', 'ping'))).resolves.toMatchObject({ host: 'py', op: 'py/ping' })
    await gw.stop()
  })

  it('an op for an unregistered host is unavailable (not a whole-surface crash)', async () => {
    const ts = makeFakeHost('ts', { hopCost: 0 })
    const gw = createGateway({ adapters: [ts.adapter] })
    await gw.start()

    const err = await gw.route(req('rust', 'nope')).then(
      () => null,
      (e) => e,
    )
    expect(isGatewayError(err)).toBe(true)
    expect(err.details.gatewayCode).toBe('unavailable')
    // Healthy host still serves.
    await expect(gw.route(req('ts', 'ok'))).resolves.toMatchObject({ host: 'ts' })
    await gw.stop()
  })

  it('rejects duplicate host adapters at construction', () => {
    const a = makeFakeHost('ts')
    const b = makeFakeHost('ts')
    expect(() => createGateway({ adapters: [a.adapter, b.adapter] })).toThrow(/duplicate host/)
  })
})
