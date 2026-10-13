/**
 * Test world for the reaper host: a scripted Chrome (reachability, http pages,
 * history), an owner record, a manual host clock and an ordered event log of
 * every effect the host performs. No socket, no process, no real Chrome.
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.5] [chrome-lifecycle.16]).
 */
import { createReaperHost, type OwnerRecord, type ReaperHost, type ReaperHostDeps, type RpcResponse } from '../../../lib/lifecycle/reaper-host.js'

export interface HostWorld {
  now: number
  chromeUp: boolean
  /** A number of http(s) pages, or an Error to simulate an unreachable CDP during the check. */
  httpPages: number | Error
  /** A recent visit, or an Error to simulate an unavailable history database. */
  history: boolean | Error
  owner: OwnerRecord | null
  ownerValid: boolean
  /** Ordered effects: close-pages, kill-group:<pid>, kill-port:<port>, remove-record. */
  events: string[]
  logs: string[]
  /** Number of history reads (the tier is skipped entirely when disabled). */
  historyReads: number
  activityTouches: number
}

export const PORT = 9333
export const IDLE = 120_000
export const GRACE = 30_000

export interface HostHarness {
  world: HostWorld
  host: ReaperHost
  deps: ReaperHostDeps
  /** A JSON-RPC request from `conn` (id 1 unless given). */
  call(conn: string, method: string, params?: unknown, id?: number): Promise<RpcResponse | undefined>
  /** A JSON-RPC notification (no id) from `conn`. */
  notify(conn: string, method: string, params?: unknown): Promise<RpcResponse | undefined>
  /** Connect + hello. */
  join(conn: string, pid: number, checkHistory?: boolean): Promise<void>
  advance(ms: number): void
}

export function makeHost(overrides: Partial<ReaperHostDeps> = {}, init: Partial<HostWorld> = {}): HostHarness {
  const world: HostWorld = {
    now: 1_000_000,
    chromeUp: true,
    httpPages: 0,
    history: false,
    owner: null,
    ownerValid: false,
    events: [],
    logs: [],
    historyReads: 0,
    activityTouches: 0,
    ...init,
  }
  const deps: ReaperHostDeps = {
    port: PORT,
    idleTimeoutMs: IDLE,
    shutdownGraceMs: GRACE,
    now: () => world.now,
    probeChrome: async () => world.chromeUp,
    countHttpPages: async () => {
      if (world.httpPages instanceof Error) throw world.httpPages
      return world.httpPages
    },
    historyRecent: () => {
      world.historyReads++
      if (world.history instanceof Error) throw world.history
      return world.history
    },
    owner: {
      read: () => world.owner,
      isValid: () => world.ownerValid,
      remove: () => {
        world.events.push('remove-record')
        world.owner = null
      },
    },
    closeAllPageTargets: async () => {
      world.events.push('close-pages')
    },
    killProcessGroup: async (pid: number) => {
      world.events.push(`kill-group:${pid}`)
      world.chromeUp = false
    },
    killChrome: async (port: number) => {
      world.events.push(`kill-port:${port}`)
      world.chromeUp = false
    },
    logger: (m: string) => world.logs.push(m),
    onActivity: () => {
      world.activityTouches++
    },
    ...overrides,
  }
  const host = createReaperHost(deps)
  const call = (conn: string, method: string, params?: unknown, id = 1) =>
    host.handler({ jsonrpc: '2.0', id, method, params }, { connectionId: conn })
  const notify = (conn: string, method: string, params?: unknown) =>
    host.handler({ jsonrpc: '2.0', method, params }, { connectionId: conn })
  return {
    world,
    host,
    deps,
    call,
    notify,
    async join(conn: string, pid: number, checkHistory?: boolean) {
      host.onClientConnect(conn)
      await call(conn, 'hello', checkHistory === undefined ? { pid } : { pid, checkHistory })
    },
    advance(ms: number) {
      world.now += ms
    },
  }
}

/** The `result` of a response, asserting there was no error. */
export function resultOf<T = Record<string, unknown>>(r: RpcResponse | undefined): T {
  if (!r) throw new Error('expected a response, got none (notification?)')
  if (r.error) throw new Error(`expected a result, got error ${r.error.code} ${r.error.message}`)
  return r.result as T
}
