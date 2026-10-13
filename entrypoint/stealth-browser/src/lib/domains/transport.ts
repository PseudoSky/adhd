/**
 * stealth-browser/src/lib/domains/transport.ts — Shared CDP WebSocket transport.
 *
 * Wraps the common pattern: GET /json/version → open WS → wait for open → send command → receive response.
 * All domain services use this instead of duplicating WS logic.
 */

const CDP_TIMEOUT_MS = 10_000
const WS_OPEN = 1

/** Resolve once the socket is open; reject if it errors or closes first. */
function whenOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WS_OPEN) { resolve(); return }
    const onOpen = () => { cleanup(); resolve() }
    const onFail = () => { cleanup(); reject(new Error('CDP socket failed to open')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('CDP timeout')) }, CDP_TIMEOUT_MS)
    function cleanup(): void {
      clearTimeout(timer)
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onFail)
      ws.removeEventListener('close', onFail)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onFail)
    ws.addEventListener('close', onFail)
  })
}

export async function cdpCall<T = unknown>(
  host: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const res = await fetch(`http://${host}/json/version`)
    const v = (await res.json()) as Record<string, string>
    const ws = new WebSocket(v['webSocketDebuggerUrl'] as string)
    try {
      await whenOpen(ws)
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = Math.floor(Math.random() * 1_000_000)
        const handler = (ev: MessageEvent) => {
          const d = JSON.parse(String(ev.data)) as Record<string, unknown>
          if (d['id'] === id) {
            ws.removeEventListener('message', handler)
            clearTimeout(timer)
            if (d['error']) reject(new Error((d['error'] as Record<string, unknown>)['message'] as string))
            else resolve(d['result'])
          }
        }
        const timer = setTimeout(() => {
          ws.removeEventListener('message', handler)
          reject(new Error('CDP timeout'))
        }, CDP_TIMEOUT_MS)
        ws.addEventListener('message', handler)
        ws.send(JSON.stringify({ id, method, params }))
      })
      return result as T
    } finally {
      ws.close()
    }
  } catch {
    return null
  }
}
