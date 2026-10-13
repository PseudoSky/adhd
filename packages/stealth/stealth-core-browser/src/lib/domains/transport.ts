/**
 * stealth-core-browser/src/lib/domains/transport.ts — Shared CDP WebSocket transport.
 *
 * Wraps the common pattern: GET /json/version → open WS → wait for open → send command → receive response.
 * All domain services use this instead of duplicating WS logic. The socket itself is owned by
 * CdpSession (cdp/session.ts), the single WebSocket opener under src/lib.
 *
 * Defect 3 (port-fixes.4): nothing is sent until the socket is open. CdpSession.connect resolves only
 * once the socket's `open` event fires (readyState OPEN) and rejects on error, early close, or the
 * 10 s deadline passed below; send() is reached only after that, and any rejection becomes null.
 */
import { CdpSession } from '../cdp/session.js'

const CDP_TIMEOUT_MS = 10_000

export async function cdpCall<T = unknown>(
  host: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const session = new CdpSession()
  try {
    const res = await fetch(`http://${host}/json/version`)
    const v = (await res.json()) as Record<string, string>
    await session.connect(v['webSocketDebuggerUrl'] as string, CDP_TIMEOUT_MS)
    return (await session.send(method, params, CDP_TIMEOUT_MS)) as T
  } catch {
    return null
  } finally {
    session.close()
  }
}
