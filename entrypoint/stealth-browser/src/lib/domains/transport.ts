/**
 * adhd/domains/transport.ts — Shared CDP WebSocket transport.
 *
 * Wraps the common pattern: GET /json/version → open WS → send command → receive response.
 * All domain services use this instead of duplicating WS logic.
 */

export async function cdpCall<T = unknown>(
  host: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const res = await fetch(`http://${host}/json/version`)
    const v = (await res.json()) as Record<string, string>
    const ws = new WebSocket(v.webSocketDebuggerUrl)
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = Math.floor(Math.random() * 1_000_000)
        ws.send(JSON.stringify({ id, method, params }))
        const handler = (ev: MessageEvent) => {
          const d = JSON.parse(String(ev.data)) as Record<string, unknown>
          if (d.id === id) {
            ws.removeEventListener('message', handler)
            if (d.error) reject(new Error((d.error as Record<string, unknown>).message as string))
            else resolve(d.result)
          }
        }
        ws.addEventListener('message', handler)
        setTimeout(() => {
          ws.removeEventListener('message', handler)
          reject(new Error('CDP timeout'))
        }, 10_000)
      })
      return result as T
    } finally {
      ws.close()
    }
  } catch {
    return null
  }
}
