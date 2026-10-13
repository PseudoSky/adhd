/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/launch-breaker.ts
 *
 * The launch circuit breaker (N4): 3 failed launches within 60 s open the
 * breaker for 30 s, during which `ready()` fails fast with
 * LAUNCH_CIRCUIT_OPEN (carrying `retryAfterMs`) WITHOUT spawning; after the
 * cool-off exactly one probe launch is let through; a success closes it.
 *
 * The state machine is the service proxy's `createCircuitBreaker`; the state is
 * shared across processes through the stealth-owned `FileBreakerStore`
 * (`<stateDir>/breaker-<port>.json`, atomic rename). The store is best effort:
 * a lost update only under-counts by one, and a throwing store degrades the
 * breaker to in-memory state (it is not presence and not a lease).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.1 3.3, CL17).
 */

import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { errorMessage, lifecycleErrors } from './errors.js'
import { createCircuitBreaker, type BreakerState, type BreakerStore, type CircuitBreaker } from './sp.js'

export const LAUNCH_FAILURE_THRESHOLD = 3
export const LAUNCH_WINDOW_MS = 60_000
export const LAUNCH_COOLDOWN_MS = 30_000

export interface BreakerFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, opts?: { mode?: number }): void
  renameSync(from: string, to: string): void
}

export function breakerPath(stateDir: string, port: number): string {
  return join(stateDir, `breaker-${port}.json`)
}

function isState(v: unknown): v is BreakerState {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  const numOrNull = (x: unknown) => x === null || typeof x === 'number'
  const recent = s['recent']
  return typeof s['consecutive'] === 'number' && Array.isArray(recent) && recent.every((n) => typeof n === 'number') && numOrNull(s['openedAt']) && numOrNull(s['probeStartedAt'])
}

/** `BreakerStore` over one JSON file. `load` never throws; `save` writes temp + rename. */
export class FileBreakerStore implements BreakerStore {
  constructor(
    readonly path: string,
    private readonly fs: BreakerFs = nodeFs as unknown as BreakerFs,
  ) {}

  load(): BreakerState | null {
    try {
      const v: unknown = JSON.parse(this.fs.readFileSync(this.path, 'utf8'))
      return isState(v) ? v : null
    } catch {
      return null
    }
  }

  save(state: BreakerState): void {
    const tmp = `${this.path}.${process.pid}.tmp`
    this.fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    this.fs.renameSync(tmp, this.path)
  }
}

export interface LaunchBreakerOptions {
  port: number
  /** The private state dir; omitted (degraded) means an in-memory breaker. */
  stateDir?: string
  fs?: BreakerFs
  now?: () => number
  logger?: (msg: string) => void
}

export interface LaunchBreaker {
  /** Throws LAUNCH_CIRCUIT_OPEN (with `retryAfterMs`) while open; returns otherwise. */
  assertClosed(): void
  recordSuccess(): void
  recordFailure(): void
  /** Non-throwing view for `status()`. */
  state(): { open: boolean; retryAfterMs?: number }
}

export function createLaunchBreaker(opts: LaunchBreakerOptions): LaunchBreaker {
  const log = opts.logger ?? (() => undefined)
  const now = opts.now ?? Date.now
  /** In-memory view of the last open period (used when there is no shared store). */
  let openUntil: number | null = null
  const store = opts.stateDir === undefined ? undefined : new FileBreakerStore(breakerPath(opts.stateDir, opts.port), opts.fs)
  const breaker: CircuitBreaker = createCircuitBreaker({
    failureThreshold: LAUNCH_FAILURE_THRESHOLD,
    windowMs: LAUNCH_WINDOW_MS,
    cooldownMs: LAUNCH_COOLDOWN_MS,
    ...(store ? { store } : {}),
    now,
    onEvent: (e) => {
      if (e.type === 'opened') openUntil = now() + e.retryAfterMs
      else if (e.type === 'closed') openUntil = null
      if (e.type === 'store-failed') log(`launch breaker store failed (in-memory from now on): ${errorMessage(e.error)}`)
      else if (e.type === 'opened') log(`launch breaker opened: Chrome failed to launch ${LAUNCH_FAILURE_THRESHOLD} times in ${LAUNCH_WINDOW_MS / 1000} s`)
    },
  })
  return {
    assertClosed(): void {
      const c = breaker.check()
      if (c.open) throw lifecycleErrors.circuitOpen(opts.port, c.retryAfterMs)
    },
    recordSuccess: () => breaker.recordSuccess(),
    recordFailure: () => breaker.recordFailure(),
    state(): { open: boolean; retryAfterMs?: number } {
      // Peek without consuming the half-open probe: read the stored state directly.
      const s = store?.load()
      let until = openUntil
      if (s) until = s.openedAt === null ? null : s.openedAt + LAUNCH_COOLDOWN_MS
      const left = until === null ? 0 : until - now()
      return left > 0 ? { open: true, retryAfterMs: left } : { open: false }
    },
  }
}
