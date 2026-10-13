/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/reaper-host.ts
 *
 * The reaper host: the out-of-process owner of the idle-reap decision for one
 * CDP port. Pure — every effect (clock, CDP probes, history, kills, the
 * owner record) is an injected dependency, so the host is unit-tested by
 * calling `handler(req, { connectionId })` and the connection hooks directly,
 * with no socket. `reaper-entry.ts` wires it to the transport.
 *
 * Presence is one held connection per client: the registry is an in-memory
 * `Map<connectionId, client>` (no presence file, no lease, no heartbeat).
 * A client registers with `hello{pid, checkHistory}` (registration is NOT
 * activity), stamps `lastActivityAt` only through the `activity` notification
 * (host clock), and leaves through `release` or by disconnecting — a client
 * killed with `kill -9` disconnects when the kernel closes its socket, so it
 * is dropped at once (no pid polling, no pid-reuse exposure).
 *
 * JSON-RPC methods: `ping`, `hello`, `activity`, `release`, `reapIfIdle`,
 * `status`. The host ticks (every 5 s in production) with
 * `graceMs = shutdownGraceMs`; `reapIfIdle` evaluates with `graceMs = 0`
 * excluding the caller. Both use the single `decideReap` policy, and neither
 * path writes any client's `lastActivityAt` (livelock protection, F9).
 *
 * Ordered reap (F16), each step non-fatal and logged:
 * close every page target (allSettled) -> kill (a valid owner record: the
 * tracked group kill of that pid; else scope `port-occupant`: the port
 * occupant kill; scope `launched-only`: no kill) -> remove the owner record.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.3, CL5 CL6 CL16).
 */

import { decideReap, historyTierEnabled, isClientActive, type ClientView, type ReapDecision, type ReaperScope } from './reap-policy.js'
import { errorMessage } from './errors.js'

// ─── JSON-RPC shapes (structurally identical to the transport's) ─────────────

export type RpcId = string | number | null

export interface RpcRequest {
  jsonrpc: '2.0'
  id?: RpcId
  method: string
  params?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: RpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Per-connection identity handed to the handler by the transport. */
export interface RpcContext {
  readonly connectionId: string
}

export type DisconnectReason = 'end' | 'error' | 'closed-by-backend'

export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INVALID_REQUEST = -32600

// ─── Host contract ───────────────────────────────────────────────────────────

/** The launched-Chrome record (`<stateDir>/chrome-<port>.json`). */
export interface OwnerRecord {
  pid: number
  procStart: string | null
  port: number
  profileDir?: string
  launchedAt?: number
}

export interface ReaperHostDeps {
  port: number
  idleTimeoutMs: number
  shutdownGraceMs: number
  /** History tier when no client is connected. Default true. */
  checkHistoryDefault?: boolean
  /** Default 'port-occupant' (F19). */
  scope?: ReaperScope
  /** `status().siblingWarning` is true at or above this many connected clients. Default 4. */
  siblingThreshold?: number
  now: () => number
  /** One GET `/json/version`. */
  probeChrome: () => Promise<boolean>
  /** The http(s) page count (`countActiveWebPages`); `'unreachable'` or a rejection means proceed (F12). */
  countHttpPages: () => Promise<number | 'unreachable'>
  /** `HistoryClient.isRecentlyUsed(2)`; a throw means "unavailable" (proceed). */
  historyRecent: () => boolean
  owner: {
    read: () => OwnerRecord | null
    /** pid alive AND its start token equals `procStart` (`isSameProcess`). */
    isValid: (rec: OwnerRecord) => boolean
    remove: () => void
  }
  closeAllPageTargets: () => Promise<void>
  /** The tracked-launch group kill (`killProcessGroup`). */
  killProcessGroup: (pid: number) => Promise<void>
  /** The port-occupant kill (`killChrome(port)` with no tracked pid). */
  killChrome: (port: number) => Promise<void>
  logger?: (msg: string) => void
  /** Called on every `activity` (the retirer's `touch`). */
  onActivity?: () => void
}

export interface ReaperStatus {
  clients: number
  activeClients: number
  httpPages: number | 'unreachable'
  chromeUp: boolean
  ownerValid: boolean
  siblingWarning: boolean
  siblingThreshold: number
}

export interface ReapOutcome extends ReapDecision {
  /** True when the ordered reap ran. */
  reaped: boolean
}

export interface ReaperHost {
  handler(req: RpcRequest, ctx: RpcContext): Promise<RpcResponse | undefined>
  onClientConnect(connectionId: string): void
  onClientDisconnect(connectionId: string, reason: DisconnectReason): void
  /** One periodic evaluation with `graceMs = shutdownGraceMs`. */
  tick(): Promise<ReapOutcome>
  status(): Promise<ReaperStatus>
  /** Last probed Chrome reachability (synchronous, for the retirer's `isBusy`). */
  chromeReachable(): boolean
  /** Read-only snapshot of the registry. */
  clients(): ClientView[]
}

interface ClientEntry {
  pid: number | null
  checkHistory: boolean
  lastActivityAt: number | null
}

function ok(id: RpcId | undefined, result: unknown): RpcResponse | undefined {
  return id === undefined ? undefined : { jsonrpc: '2.0', id, result }
}

function fail(id: RpcId | undefined, code: number, message: string): RpcResponse | undefined {
  return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code, message } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** `hello` params: `{ pid: positive integer | null, checkHistory?: boolean }`; anything else is malformed. */
function parseHello(params: unknown): { pid: number | null; checkHistory: boolean | undefined } | null {
  if (!isRecord(params)) return null
  const { pid, checkHistory } = params
  const pidOk = pid === null || (typeof pid === 'number' && Number.isInteger(pid) && pid > 0)
  const chOk = checkHistory === undefined || typeof checkHistory === 'boolean'
  if (!pidOk || !chOk) return null
  return { pid: pid as number | null, checkHistory: checkHistory as boolean | undefined }
}

export function createReaperHost(deps: ReaperHostDeps): ReaperHost {
  const log = deps.logger ?? (() => undefined)
  const scope: ReaperScope = deps.scope ?? 'port-occupant'
  const checkHistoryDefault = deps.checkHistoryDefault ?? true
  const siblingThreshold = deps.siblingThreshold ?? 4
  const registry = new Map<string, ClientEntry>()
  let lastPinAt: number | null = deps.now()
  let chromeUp = false
  let reaping: Promise<ReapOutcome> | null = null

  const views = (): ClientView[] =>
    [...registry.entries()].map(([id, c]) => ({ id, pid: c.pid, checkHistory: c.checkHistory, lastActivityAt: c.lastActivityAt }))

  /** A client leaving while it still pinned Chrome starts the grace window now (N2). */
  const drop = (connectionId: string, why: string): void => {
    const c = registry.get(connectionId)
    if (!c) return
    registry.delete(connectionId)
    const now = deps.now()
    if (isClientActive({ id: connectionId, ...c }, now, deps.idleTimeoutMs)) lastPinAt = now
    log(`client ${connectionId} (pid ${c.pid ?? '?'}) left: ${why}`)
  }

  const ownerState = (): { rec: OwnerRecord | null; valid: boolean } => {
    let rec: OwnerRecord | null = null
    try {
      rec = deps.owner.read()
    } catch (e) {
      log(`owner record unreadable: ${errorMessage(e)}`)
    }
    let valid = false
    if (rec) {
      try {
        valid = deps.owner.isValid(rec)
      } catch (e) {
        log(`owner record check failed: ${errorMessage(e)}`)
      }
    }
    return { rec, valid }
  }

  const httpPages = async (): Promise<number | 'unreachable'> => {
    try {
      return await deps.countHttpPages()
    } catch {
      return 'unreachable'
    }
  }

  const history = (): boolean | 'unavailable' => {
    try {
      return deps.historyRecent()
    } catch {
      return 'unavailable'
    }
  }

  const probe = async (): Promise<boolean> => {
    try {
      chromeUp = await deps.probeChrome()
    } catch {
      chromeUp = false
    }
    return chromeUp
  }

  /** F16: close pages, then kill, then forget the record — every step runs even if an earlier one failed. */
  const orderedReap = async (rec: OwnerRecord | null, ownerValid: boolean): Promise<void> => {
    log('reaping idle Chrome: closing page targets')
    try {
      await deps.closeAllPageTargets()
    } catch (e) {
      log(`closing page targets failed: ${errorMessage(e)}`)
    }
    try {
      if (rec && ownerValid) {
        log(`killing the recorded Chrome process group ${rec.pid}`)
        await deps.killProcessGroup(rec.pid)
      } else if (scope === 'port-occupant') {
        log(`killing the occupant of port ${deps.port}`)
        await deps.killChrome(deps.port)
      }
    } catch (e) {
      log(`killing Chrome failed: ${errorMessage(e)}`)
    }
    try {
      deps.owner.remove()
    } catch (e) {
      log(`removing the owner record failed: ${errorMessage(e)}`)
    }
    chromeUp = false
  }

  const evaluate = async (graceMs: number, callerId?: string): Promise<ReapOutcome> => {
    if (reaping) return reaping
    const run = (async (): Promise<ReapOutcome> => {
      const up = await probe()
      if (!up) return { action: 'none', reaped: false }
      const { rec, valid } = ownerState()
      const clients = views()
      const decision = decideReap({
        now: deps.now(),
        clients,
        callerId,
        idleTimeoutMs: deps.idleTimeoutMs,
        graceMs,
        chromeUp: up,
        httpPageCount: await httpPages(),
        // The history database is only read when the tier is enabled.
        historyRecent: historyTierEnabled(clients, checkHistoryDefault) ? history() : false,
        checkHistoryDefault,
        scope,
        ownerValid: valid,
        lastPinAt,
      })
      if (decision.action === 'keep') lastPinAt = deps.now()
      if (decision.action !== 'reap') return { ...decision, reaped: false }
      await orderedReap(rec, valid)
      return { ...decision, reaped: true }
    })()
    reaping = run
    try {
      return await run
    } finally {
      reaping = null
    }
  }

  const status = async (): Promise<ReaperStatus> => {
    const now = deps.now()
    const clients = views()
    const up = await probe()
    return {
      clients: clients.length,
      activeClients: clients.filter((c) => isClientActive(c, now, deps.idleTimeoutMs)).length,
      httpPages: up ? await httpPages() : 0,
      chromeUp: up,
      ownerValid: ownerState().valid,
      siblingWarning: clients.length >= siblingThreshold,
      siblingThreshold,
    }
  }

  const handler = async (req: RpcRequest, ctx: RpcContext): Promise<RpcResponse | undefined> => {
    if (!isRecord(req) || typeof req.method !== 'string') {
      return fail((req as { id?: RpcId } | null)?.id ?? null, RPC_INVALID_REQUEST, 'invalid request')
    }
    const id = req.id
    switch (req.method) {
      case 'ping':
        return ok(id, 'pong')
      case 'hello': {
        const hello = parseHello(req.params)
        if (!hello) return fail(id, RPC_INVALID_PARAMS, 'hello expects { pid: number | null, checkHistory?: boolean }')
        const prev = registry.get(ctx.connectionId)
        registry.set(ctx.connectionId, {
          pid: hello.pid,
          checkHistory: hello.checkHistory ?? checkHistoryDefault,
          // Registration is not activity: keep an existing stamp, never create one.
          lastActivityAt: prev?.lastActivityAt ?? null,
        })
        log(`client ${ctx.connectionId} registered (pid ${hello.pid ?? '?'})`)
        return ok(id, { registered: true })
      }
      case 'activity': {
        const c = registry.get(ctx.connectionId)
        const now = deps.now()
        // An activity on an unknown connection (e.g. after a host restart) re-registers it.
        if (c) c.lastActivityAt = now
        else registry.set(ctx.connectionId, { pid: null, checkHistory: checkHistoryDefault, lastActivityAt: now })
        deps.onActivity?.()
        return ok(id, { ok: true })
      }
      case 'release':
        drop(ctx.connectionId, 'release')
        return ok(id, { released: true })
      case 'reapIfIdle': {
        const out = await evaluate(0, ctx.connectionId)
        return ok(id, out)
      }
      case 'status':
        return ok(id, await status())
      default:
        return fail(id, RPC_METHOD_NOT_FOUND, `unknown method ${req.method}`)
    }
  }

  return {
    handler,
    onClientConnect(connectionId: string): void {
      log(`client ${connectionId} connected`)
    },
    onClientDisconnect(connectionId: string, reason: DisconnectReason): void {
      drop(connectionId, `disconnect (${reason})`)
    },
    tick: () => evaluate(deps.shutdownGraceMs),
    status,
    chromeReachable: () => chromeUp,
    clients: views,
  }
}
