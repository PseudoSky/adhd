// @adhd/apigen-gateway — the sidecar gateway for a mixed-host `run` (SPEC §13 / §13.1).
//
// A mixed-host `run` is a distributed system: the user points `adhd-apigen run` at
// sources written in different languages (`humanize.ts ping.rs`), and the CLI merges
// them into one descriptor whose operations are tagged with their owning `host`. The
// gateway presents ONE transport surface and routes each operation to the runtime that
// owns it — TS ops in-process (zero hop), Python/Rust ops to an out-of-process sidecar
// over local IPC (one round-trip).
//
// This module implements the §13.1 FAILURE MODEL — the load-bearing contract that makes
// a polyglot `run` safe in production:
//
//   1. Partial availability  — a down host fails ONLY its own ops (`unavailable` / 503);
//                              every other host keeps serving. Never whole-surface down.
//   2. Readiness gating       — a host's ops route ONLY after it reports ready via its
//                              `_meta/health` mount (startup-ordering safe).
//   3. Supervision/restart    — the gateway spawns, monitors and restarts crashed sidecars
//                              with backoff; a crash is isolated to that host.
//   4. Deadlines & cancel     — every cross-host op carries a deadline; a hung sidecar →
//                              `deadline_exceeded`; cancellation propagates over IPC.
//   5. Cost-based topology     — in-process host = zero hop; out-of-process = one IPC
//                              round-trip. The cost is exposed per route so the CLI's
//                              "simplest viable topology" selector can minimise it.
//
// The host-adapter boundary (`HostAdapter`) is the integration seam: the in-process TS
// adapter lives here; the real out-of-process Python adapter (`python-host` state) and a
// fake/in-memory adapter (tests) implement the SAME interface and drop straight in.

import { ApiError } from '@adhd/apigen-errors'
import type { Operation, Transport } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// §13.1 / §9 — gateway-level error codes
// ---------------------------------------------------------------------------
//
// SPEC §13.1 references two §9 codes — `unavailable` (HTTP 503 / gRPC UNAVAILABLE)
// and `deadline_exceeded` (HTTP 504 / gRPC DEADLINE_EXCEEDED) — that the gateway raises
// for cross-host failures. They are gateway/distributed-system concerns, so they are
// defined here and surfaced as `ApiError` instances (the shared error class) carrying a
// `gatewayCode` detail; transport adapters map them to 503/504 the same way they map the
// core taxonomy. Defined locally to keep the gateway within its package boundary.

/** The distributed-system error codes the gateway raises (SPEC §13.1). */
export const GATEWAY_ERROR_CODES = ['unavailable', 'deadline_exceeded'] as const

/** String-union type for the gateway error codes. */
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number]

/** code → HTTP status (SPEC §9.1: unavailable = 503, deadline_exceeded = 504). */
export const GATEWAY_HTTP_STATUS: Record<GatewayErrorCode, number> = {
  unavailable: 503,
  deadline_exceeded: 504,
} as const

/** code → gRPC status name (SPEC §9.1). */
export const GATEWAY_GRPC_CODE: Record<GatewayErrorCode, string> = {
  unavailable: 'UNAVAILABLE',
  deadline_exceeded: 'DEADLINE_EXCEEDED',
} as const

/**
 * Structured detail attached to a gateway `ApiError` so transport adapters can read
 * the distributed-system code and host without string-matching the message.
 */
export interface GatewayErrorDetail {
  /** The §13.1 code: `unavailable` or `deadline_exceeded`. */
  gatewayCode: GatewayErrorCode
  /** The host whose op failed. */
  host: string
  /** The operation id that was being routed. */
  operationId: string
  /** Suggested HTTP status for the transport adapter. */
  httpStatus: number
  /** Suggested gRPC status name for the transport adapter. */
  grpcCode: string
}

/**
 * Build the `ApiError` raised when a host is not serving (down / not-ready / restarting).
 * Maps to the core `internal` taxonomy slot but carries the real §13.1 `unavailable`
 * code in `details.gatewayCode` (and a 503 hint) — the shared `ApiError` type has no
 * `unavailable` member, so the gateway code travels in `details`.
 */
export function makeUnavailableError(host: string, operationId: string, reason: string): ApiError {
  const detail: GatewayErrorDetail = {
    gatewayCode: 'unavailable',
    host,
    operationId,
    httpStatus: GATEWAY_HTTP_STATUS.unavailable,
    grpcCode: GATEWAY_GRPC_CODE.unavailable,
  }
  return new ApiError('internal', `host '${host}' unavailable: ${reason}`, detail)
}

/**
 * Build the `ApiError` raised when a cross-host op exceeds its deadline (SPEC §13.1).
 * Carries the real `deadline_exceeded` code + a 504 hint in `details`.
 */
export function makeDeadlineExceededError(host: string, operationId: string, deadlineMs: number): ApiError {
  const detail: GatewayErrorDetail = {
    gatewayCode: 'deadline_exceeded',
    host,
    operationId,
    httpStatus: GATEWAY_HTTP_STATUS.deadline_exceeded,
    grpcCode: GATEWAY_GRPC_CODE.deadline_exceeded,
  }
  return new ApiError('internal', `op '${operationId}' on host '${host}' exceeded ${deadlineMs}ms deadline`, detail)
}

/** Type guard: was this `ApiError` raised by the gateway failure model? */
export function isGatewayError(err: unknown): err is ApiError & { details: GatewayErrorDetail } {
  if (!(err instanceof ApiError) || err.details == null || typeof err.details !== 'object') return false
  const d = err.details as Partial<GatewayErrorDetail>
  return d.gatewayCode === 'unavailable' || d.gatewayCode === 'deadline_exceeded'
}

// ---------------------------------------------------------------------------
// §13.1 — per-host status (mirrors the aggregate `_meta/health` shape)
// ---------------------------------------------------------------------------

/**
 * A host's status as reported by the gateway's aggregate `_meta/health` (SPEC §13.1):
 *
 *  - `ready`    — the sidecar reported ready via its `_meta/health` mount; ops route.
 *  - `degraded` — the host is up but its readiness probe is failing (ops do NOT route).
 *  - `down`     — the host crashed / is not spawned / is restarting; ops do NOT route.
 */
export type HostStatus = 'ready' | 'degraded' | 'down'

// ---------------------------------------------------------------------------
// §14.4 — the host-adapter boundary (the integration seam)
// ---------------------------------------------------------------------------

/**
 * The single request the gateway forwards to a host runtime over its IPC.
 *
 * Mirrors the cross-host-portable subset of a core `Call`: the operation, the bare domain
 * `data`, the metadata `envelope`, and the transport tag. `signal` and the deadline are
 * handled by the gateway around the adapter call — they do not cross the IPC boundary as
 * part of this struct (the adapter receives `signal` as a separate argument so it can
 * propagate cancellation natively).
 */
export interface HostRequest {
  /** The operation being invoked (carries `operation.host` → routing key). */
  operation: Operation
  /** Bare domain params (the `data`-wrapper dissolved; ctx excluded). */
  data: Record<string, unknown>
  /** Transport-native side-channel metadata (session, auth, …). */
  envelope: Record<string, unknown>
  /** Which transport delivered the original call. */
  transport: Transport
}

/**
 * A host runtime as seen by the gateway (SPEC §14.4 "gateway adapter").
 *
 * This is the ONE seam every host language plugs into. The in-process TS adapter
 * ({@link createInProcessHostAdapter}) calls the runtime directly (zero hop); the
 * out-of-process Python adapter (the `python-host` state) spawns a subprocess and speaks
 * the IPC (one round-trip); the in-memory fake (tests) closes over a map. The gateway is
 * written ONLY against this interface — it never knows which kind it routes to.
 */
export interface HostAdapter {
  /** The host tag this adapter serves (matches `operation.host`). */
  readonly host: string

  /**
   * Routing cost of this host, in IPC round-trips per op (SPEC §13.1 cost function):
   *  - `0` — in-process (zero hop; the TS fast path).
   *  - `1` — out-of-process sidecar (serialize → IPC → deserialize).
   * The CLI's "simplest viable topology" selector minimises the sum of these.
   */
  readonly hopCost: 0 | 1

  /**
   * Bring the host up (spawn the sidecar / initialise the in-process runtime). Resolves
   * when the process exists — NOT when it is ready. Readiness is reported separately via
   * {@link ready}. Idempotent: calling `start()` on an already-started adapter is a no-op.
   */
  start(): Promise<void>

  /**
   * Readiness probe — the gateway calls this to learn whether the host's `_meta/health`
   * mount reports ready (SPEC §13.1). The gateway routes the host's ops ONLY when this
   * resolves `true`. Must not throw; a failed probe resolves `false`.
   */
  ready(): Promise<boolean>

  /**
   * Forward a single operation to the host runtime and return its result.
   *
   * The gateway wraps this in the deadline timer and cancellation wiring — the adapter
   * receives `signal` so it can abort native work (HTTP abort / kill the in-flight IPC).
   * The adapter MUST reject if the host process has died mid-call (the gateway maps that
   * to `unavailable` and triggers supervision/restart).
   */
  invoke(req: HostRequest, signal: AbortSignal): Promise<unknown>

  /**
   * Register a one-shot listener fired when the host process exits unexpectedly (crash).
   * The gateway uses this to drive supervision/restart (SPEC §13.1). In-process adapters
   * that cannot crash may install a no-op. Returns an unsubscribe function.
   */
  onExit(listener: (reason: unknown) => void): () => void

  /** Tear the host down gracefully (kill the sidecar / release resources). */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// In-process (TS) host adapter — the zero-hop fast path
// ---------------------------------------------------------------------------

/**
 * The runtime contract the in-process adapter calls — the TS harness's `invoke`, reduced
 * to the cross-host-portable shape. The real `@adhd/apigen-ts-runtime` harness satisfies
 * this; tests pass a plain function.
 */
export interface InProcessRuntime {
  invoke(req: HostRequest, signal: AbortSignal): Promise<unknown>
}

/**
 * Create the in-process host adapter (SPEC §13.1 single-host fast path / zero hop).
 *
 * Wraps a same-process runtime so the gateway can treat the local TS host identically to
 * a remote sidecar — but every call is a direct function invocation (`hopCost: 0`). An
 * in-process runtime cannot "crash" the way a subprocess can, so `onExit` is a no-op and
 * `ready()` returns the supplied readiness flag (default: ready once started).
 */
export function createInProcessHostAdapter(
  host: string,
  runtime: InProcessRuntime,
  opts: { readyWhenStarted?: boolean } = {},
): HostAdapter {
  let started = false
  const readyWhenStarted = opts.readyWhenStarted ?? true
  return {
    host,
    hopCost: 0,
    async start() {
      started = true
    },
    async ready() {
      return started && readyWhenStarted
    },
    async invoke(req, signal) {
      if (!started) throw makeUnavailableError(host, req.operation.id, 'not started')
      return runtime.invoke(req, signal)
    },
    onExit() {
      // In-process runtimes do not crash independently of the gateway process.
      return () => undefined
    },
    async stop() {
      started = false
    },
  }
}

// ---------------------------------------------------------------------------
// Supervision — restart-with-backoff policy
// ---------------------------------------------------------------------------

/**
 * Backoff policy for restarting a crashed sidecar (SPEC §13.1 supervision).
 * Exponential with a cap; the gateway sleeps `delayMs(attempt)` between restart attempts.
 */
export interface BackoffPolicy {
  /** Delay before restart attempt `n` (1-based). */
  delayMs(attempt: number): number
  /** Max consecutive restart attempts before the host is parked `down` (0 = unlimited). */
  maxRestarts: number
}

/** Default exponential backoff: 50ms · 2^(n-1), capped at 5s, unlimited restarts. */
export const defaultBackoff: BackoffPolicy = {
  delayMs(attempt: number): number {
    return Math.min(50 * 2 ** (attempt - 1), 5000)
  },
  maxRestarts: 0,
}

// ---------------------------------------------------------------------------
// Gateway options
// ---------------------------------------------------------------------------

/** Construction options for {@link createGateway}. */
export interface GatewayOptions {
  /** The host adapters to route to, keyed by `operation.host`. */
  adapters: HostAdapter[]
  /** Default per-call deadline in ms when the call carries no signal-derived deadline. */
  defaultDeadlineMs?: number
  /** Restart-with-backoff policy for crashed sidecars (default: {@link defaultBackoff}). */
  backoff?: BackoffPolicy
  /**
   * Injectable timer hooks — let tests drive deadlines deterministically without wall
   * clock. Defaults to real `setTimeout`/`clearTimeout`. (CLAUDE.md §6: deterministic,
   * no `sleep`.)
   */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

/** Per-host snapshot in the aggregate `_meta/health` report (SPEC §13.1). */
export interface HostHealth {
  host: string
  status: HostStatus
  /** Routing cost in IPC hops (SPEC §13.1 cost function). */
  hopCost: 0 | 1
  /** Consecutive crash-restart attempts since last healthy (supervision telemetry). */
  restarts: number
}

/** The gateway's aggregate `_meta/health` payload (SPEC §13.1: per-host status). */
export interface GatewayHealth {
  /** Per-host status, keyed by host tag. */
  hosts: Record<string, HostHealth>
  /** True when at least one host is `ready` (the surface can serve something). */
  serving: boolean
}

/**
 * The gateway surface presented to a transport adapter. The transport calls `route()`
 * once per inbound request; the gateway picks the owning host and applies the full §13.1
 * failure model around the adapter call.
 */
export interface Gateway {
  /** Spawn + begin supervising every host. Resolves once all `start()` calls settle. */
  start(): Promise<void>

  /**
   * Route one operation to its owning host and return the result (SPEC §13).
   * Applies readiness gating, deadline, cancellation and partial-availability mapping.
   * @throws ApiError(`unavailable`) when the host is not serving.
   * @throws ApiError(`deadline_exceeded`) when the deadline elapses.
   */
  route(req: HostRequest, signal?: AbortSignal): Promise<unknown>

  /** The aggregate `_meta/health` report (SPEC §13.1 per-host status). */
  health(): Promise<GatewayHealth>

  /** The total routing cost (sum of hop costs) — drives topology selection (SPEC §13.1). */
  topologyCost(): number

  /** Shut every host down and stop supervision. */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// The gateway implementation
// ---------------------------------------------------------------------------

interface HostEntry {
  adapter: HostAdapter
  status: HostStatus
  restarts: number
  /** Unsubscribe from the adapter's exit listener. */
  unsubscribe: () => void
  /** True once the gateway has been stopped — suppresses further restarts. */
  retired: boolean
}

/**
 * Create the sidecar gateway (SPEC §13 / §13.1).
 *
 * The gateway routes every operation to the host named by `operation.host`, applying the
 * normative failure model:
 *  - **partial availability** — an op for a `down`/`degraded` host throws `unavailable`;
 *    other hosts keep serving (one host's failure never affects another's route).
 *  - **readiness gating** — an op routes only when its host's `ready()` probe passed.
 *  - **deadline** — each route is raced against its deadline → `deadline_exceeded`.
 *  - **supervision** — a host's `onExit` triggers a restart-with-backoff loop; the
 *    gateway process stays up and the host returns to `ready` after a successful restart.
 */
export function createGateway(opts: GatewayOptions): Gateway {
  const defaultDeadlineMs = opts.defaultDeadlineMs ?? 30_000
  const backoff = opts.backoff ?? defaultBackoff
  const timers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }

  const hosts = new Map<string, HostEntry>()

  for (const adapter of opts.adapters) {
    if (hosts.has(adapter.host)) {
      throw new Error(`apigen-gateway: duplicate host adapter '${adapter.host}'`)
    }
    hosts.set(adapter.host, {
      adapter,
      status: 'down',
      restarts: 0,
      unsubscribe: () => undefined,
      retired: false,
    })
  }

  /** Sleep helper using the injected timer (deterministic in tests). */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve()
        return
      }
      timers.setTimeout(resolve, ms)
    })
  }

  /**
   * Bring a single host up: start it, wire crash supervision, then poll readiness.
   * Sets `entry.status` to `ready` once the host's `_meta/health` reports ready
   * (SPEC §13.1 readiness gating).
   */
  async function bringUp(entry: HostEntry): Promise<void> {
    if (entry.retired) return
    // (Re)wire the crash listener BEFORE starting so a fast crash is not missed.
    entry.unsubscribe()
    entry.unsubscribe = entry.adapter.onExit((reason) => {
      void supervise(entry, reason)
    })

    await entry.adapter.start()

    // Readiness gating: a host is `down` until its health probe reports ready.
    let isReady = false
    try {
      isReady = await entry.adapter.ready()
    } catch {
      isReady = false
    }
    if (entry.retired) return
    entry.status = isReady ? 'ready' : 'degraded'
  }

  /**
   * Supervision loop (SPEC §13.1): on a host crash, mark it `down`, then restart it with
   * backoff until it reports ready again — keeping the gateway process up the whole time.
   * A crash in one host never touches another host's entry.
   */
  async function supervise(entry: HostEntry, _reason: unknown): Promise<void> {
    if (entry.retired) return
    entry.status = 'down'

    let attempt = 0
    while (!entry.retired) {
      attempt += 1
      entry.restarts += 1
      if (backoff.maxRestarts > 0 && attempt > backoff.maxRestarts) {
        // Give up: leave the host parked `down`; its ops keep returning `unavailable`.
        entry.status = 'down'
        return
      }
      await sleep(backoff.delayMs(attempt))
      if (entry.retired) return
      try {
        await entry.adapter.start()
        const ok = await entry.adapter.ready()
        if (entry.retired) return
        if (ok) {
          entry.status = 'ready'
          return
        }
        entry.status = 'degraded'
      } catch {
        entry.status = 'down'
        // loop and retry with the next backoff delay
      }
    }
  }

  /**
   * Refresh a host's readiness from its `_meta/health` probe (SPEC §13.1). Lets a host
   * that came up `degraded` flip to `ready` once its probe passes — without a crash.
   * Never downgrades a `down` host (that path is owned by supervision).
   */
  async function refreshReadiness(entry: HostEntry): Promise<void> {
    if (entry.retired || entry.status === 'down') return
    let ok = false
    try {
      ok = await entry.adapter.ready()
    } catch {
      ok = false
    }
    entry.status = ok ? 'ready' : 'degraded'
  }

  /**
   * Race a host invocation against its deadline (SPEC §13.1). Resolves with the result,
   * or rejects with `deadline_exceeded` when the timer wins. The deadline timer fires the
   * shared `AbortController` so the adapter can cancel its in-flight IPC.
   */
  function invokeWithDeadline(
    entry: HostEntry,
    req: HostRequest,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      const ctrl = new AbortController()

      // Propagate caller cancellation → adapter signal.
      const onAbort = () => ctrl.abort(signal.reason)
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })

      const timer = timers.setTimeout(() => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        ctrl.abort('deadline')
        reject(makeDeadlineExceededError(entry.adapter.host, req.operation.id, deadlineMs))
      }, deadlineMs)

      entry.adapter.invoke(req, ctrl.signal).then(
        (value) => {
          if (settled) return
          settled = true
          timers.clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          timers.clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          // A rejection after the host died → unavailable (partial availability).
          if (entry.status !== 'ready' && !isGatewayError(err)) {
            reject(makeUnavailableError(entry.adapter.host, req.operation.id, 'host not serving'))
          } else {
            reject(err)
          }
        },
      )
    })
  }

  return {
    async start() {
      await Promise.all([...hosts.values()].map((entry) => bringUp(entry)))
    },

    async route(req, signal) {
      const host = req.operation.host
      const entry = hosts.get(host)
      // No adapter for this host → unavailable (partial availability, not whole-surface).
      if (entry == null) {
        throw makeUnavailableError(host, req.operation.id, 'no adapter registered for host')
      }

      // Readiness gating: a degraded host may have become ready — re-probe before routing.
      if (entry.status === 'degraded') {
        await refreshReadiness(entry)
      }

      // Partial availability: a not-`ready` host fails ONLY its own ops.
      if (entry.status !== 'ready') {
        throw makeUnavailableError(host, req.operation.id, `host status '${entry.status}'`)
      }

      const callerSignal = signal ?? new AbortController().signal
      return invokeWithDeadline(entry, req, callerSignal, defaultDeadlineMs)
    },

    async health() {
      const out: Record<string, HostHealth> = {}
      let serving = false
      // Refresh readiness for non-down hosts so the report is current.
      await Promise.all(
        [...hosts.values()].map(async (entry) => {
          if (entry.status === 'degraded') await refreshReadiness(entry)
          if (entry.status === 'ready') serving = true
          out[entry.adapter.host] = {
            host: entry.adapter.host,
            status: entry.status,
            hopCost: entry.adapter.hopCost,
            restarts: entry.restarts,
          }
        }),
      )
      return { hosts: out, serving }
    },

    topologyCost() {
      // SPEC §13.1 cost function: sum of per-host hop costs. All in-process (0) → 0
      // (the single-host fast path); each out-of-process sidecar adds one hop.
      let cost = 0
      for (const entry of hosts.values()) cost += entry.adapter.hopCost
      return cost
    },

    async stop() {
      await Promise.all(
        [...hosts.values()].map(async (entry) => {
          entry.retired = true
          entry.unsubscribe()
          entry.status = 'down'
          await entry.adapter.stop()
        }),
      )
    },
  }
}
