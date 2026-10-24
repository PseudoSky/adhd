/**
 * stealth-core-browser/src/lib/domains/transport.ts — Shared CDP WebSocket transport.
 *
 * Wraps the common pattern: GET /json/version → open WS → wait for open → send command → receive response.
 * All domain services use this instead of duplicating WS logic. The socket itself is owned by
 * CdpSession (cdp/session.ts), the single WebSocket opener under src/lib.
 *
 * Entry points:
 *  - `cdpCall` / `cdpBrowserSession`: browser-level commands (Browser.*, SystemInfo.*, Memory.*, Target.*).
 *  - `cdpPageCall` / `cdpPageSession`: page-level commands (Page.*, Network.*, Performance.*). The browser
 *    WebSocket does not serve those domains, so the call first attaches to the target with
 *    `Target.attachToTarget { flatten: true }` and sends every command with the returned `sessionId`; the
 *    commands take no `targetId`.
 *
 * Failures are typed, never swallowed: the version fetch honours the shared 5 s HTTP deadline (CDP_TIMEOUT),
 * a non-2xx answer is CDP_BAD_RESPONSE, a debugger URL that points away from `host` is refused (the same
 * `assertSameEndpoint` check targets.ts applies), a socket that does not open is CDP_CONNECT_FAILED, a
 * protocol error is CDP_REMOTE_ERROR, and a reply that does not come within 10 s is CDP_TIMEOUT. A target
 * Chrome does not know is TARGET_NOT_FOUND.
 *
 * Defect 3 (port-fixes.4): nothing is sent until the socket is open. CdpSession.connect resolves only
 * once the socket's `open` event fires (readyState OPEN) and rejects on error, early close, or the
 * 10 s deadline passed below; send() is reached only after that.
 */
import { CdpSession } from '../cdp/session.js'
import { getRawVersion, listPageTargets } from '../cdp/targets.js'
import { StealthCoreBrowserError } from '../../errors.js'

const CDP_TIMEOUT_MS = 10_000

/** True when Chrome's protocol error says the target (or session) it was asked about does not exist. */
function isUnknownTarget(err: unknown): boolean {
  return err instanceof StealthCoreBrowserError && err.code === 'CDP_REMOTE_ERROR' && /no (target|session) with given id/i.test(err.message)
}

/** A command sender bound to one open connection (and, for page sessions, one attached target). */
export type CdpSend = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Re-type an unknown-target protocol error as TARGET_NOT_FOUND; every other error passes through unchanged. */
function retype(err: unknown, host: string, method: string, targetId?: string): unknown {
  if (!isUnknownTarget(err)) return err
  return StealthCoreBrowserError.of('TARGET_NOT_FOUND', (err as Error).message, { cause: err, detail: { host, method, ...(targetId !== undefined ? { targetId } : {}) } })
}

/** Open one verified browser connection, hand it to `fn`, and close it on every path. */
async function withBrowserConnection<R>(host: string, fn: (session: CdpSession) => Promise<R>): Promise<R> {
  const version = await getRawVersion(host)
  const session = new CdpSession()
  try {
    await session.connect(version.webSocketDebuggerUrl, CDP_TIMEOUT_MS)
    return await fn(session)
  } finally {
    session.close()
  }
}

/** Run several browser-level commands on one short-lived connection. Throws a typed StealthCoreBrowserError. */
export async function cdpBrowserSession<R>(host: string, fn: (send: CdpSend) => Promise<R>): Promise<R> {
  return withBrowserConnection(host, (session) => fn(async <T,>(method: string, params: Record<string, unknown> = {}) => {
    try {
      return (await session.send(method, params, CDP_TIMEOUT_MS)) as T
    } catch (err) {
      throw retype(err, host, method, typeof params['targetId'] === 'string' ? params['targetId'] : undefined)
    }
  }))
}

/**
 * Run several page-level commands against `targetId` on one connection: attach with a flattened session and
 * route every command through the returned sessionId. Throws a typed StealthCoreBrowserError.
 */
export async function cdpPageSession<R>(host: string, targetId: string, fn: (send: CdpSend) => Promise<R>): Promise<R> {
  return withBrowserConnection(host, async (session) => {
    let sessionId: string
    try {
      sessionId = (await session.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, CDP_TIMEOUT_MS)).sessionId
    } catch (err) {
      throw retype(err, host, 'Target.attachToTarget', targetId)
    }
    return fn(async <T,>(method: string, params: Record<string, unknown> = {}) => {
      try {
        return (await session.send(method, params, CDP_TIMEOUT_MS, sessionId)) as T
      } catch (err) {
        throw retype(err, host, method, targetId)
      }
    })
  })
}

/** Run one browser-level command. Throws a typed StealthCoreBrowserError on any failure. */
export async function cdpCall<T = unknown>(host: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return cdpBrowserSession(host, (send) => send<T>(method, params))
}

/** Run one page-level command against `targetId`. Throws a typed StealthCoreBrowserError on any failure. */
export async function cdpPageCall<T = unknown>(host: string, targetId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return cdpPageSession(host, targetId, (send) => send<T>(method, params))
}

/** The id of the first open page, or `targetId` when given. Throws TARGET_NOT_FOUND when Chrome has no open page. */
export async function resolvePageTarget(host: string, targetId?: string): Promise<string> {
  if (targetId !== undefined) return targetId
  const first = (await listPageTargets(host)).find((t) => t.type === 'page')
  if (!first) {
    throw StealthCoreBrowserError.of('TARGET_NOT_FOUND', `Chrome on ${host} has no open page to attach to`, { detail: { cdpHost: host } })
  }
  return first.id
}
