/**
 * @adhd/stealth-browser — src/lib/cdp/session.ts
 *
 * Raw CDP WebSocket session with event support.
 *
 * Based on the CdpSession pattern from cdp-capture (reverse-apis) and
 * the simplified version in scratch-agent-search.
 *
 * Supports:
 *   - send(method, params) — command/response
 *   - on(method, handler)  — event subscription
 *   - off(method)          — unsubscribe
 *   - Auto-timeout on sends (default 30s)
 *   - Connection lifecycle (connect/close)
 */

type CdpResponse = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }
type CdpEvent = { method: string; params: Record<string, unknown> }
type CdpMessage = CdpResponse | CdpEvent

export class CdpSession {
  private nextId = 1
  private pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  /** Multiple handlers per event method. Was `Map<string, handler>`, which made
   *  a second `on()` for the same method silently replace the first (BACKLOG
   *  B-003) — fatal for composition, since `awaitPageSettled` and any capture
   *  code both need `Network.loadingFinished`. */
  private handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  private _ws: WebSocket | null = null
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  /** Connect to a CDP WebSocket endpoint. */
  async connect(wsUrl: string): Promise<void> {
    this._ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      const ws = this._ws!
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
    })

    this._connected = true

    this._ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage

      // Command response
      if ('id' in msg && typeof msg.id === 'number') {
        const cb = this.pending.get(msg.id)
        if (cb) {
          this.pending.delete(msg.id)
          if (msg.error) cb.reject(new Error(msg.error.message))
          else cb.resolve(msg.result ?? {})
        }
        return
      }

      // Event — dispatch to every subscriber; one throwing must not starve the rest
      const event = msg as CdpEvent
      const subs = this.handlers.get(event.method)
      if (subs) for (const handler of [...subs]) {
        try { handler(event.params) } catch { /* a bad subscriber isn't the session's problem */ }
      }
    })

    this._ws.addEventListener('close', () => {
      this._connected = false
      // Reject all pending
      for (const [, cb] of this.pending) cb.reject(new Error('WebSocket closed'))
      this.pending.clear()
    })
  }

  /**
   * Send a CDP command and wait for the response.
   * @param method CDP method name (e.g. 'Page.navigate')
   * @param params Method parameters
   * @param timeoutMs Optional timeout (default 30_000)
   */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this._ws || !this._connected) {
        reject(new Error('CdpSession not connected'))
        return
      }

      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method} after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r as T) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })

      try {
        this._ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP send failed: ${(err as Error).message}`))
      }
    })
  }

  /**
   * Subscribe to a CDP event. Multiple handlers per method are supported and
   * all are called; subscribing does not displace an existing subscriber.
   * @param method Event name (e.g. 'Network.requestWillBeSent')
   * @param handler Called with event params on each occurrence
   * @returns an unsubscribe function for just this handler
   */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let subs = this.handlers.get(method)
    if (!subs) { subs = new Set(); this.handlers.set(method, subs) }
    subs.add(handler)
    return () => this.off(method, handler)
  }

  /**
   * Unsubscribe from a CDP event.
   * @param handler Omit to remove ALL handlers for `method` (legacy behavior);
   *                pass one to remove only that handler.
   */
  off(method: string, handler?: (params: Record<string, unknown>) => void): void {
    if (!handler) { this.handlers.delete(method); return }
    const subs = this.handlers.get(method)
    if (!subs) return
    subs.delete(handler)
    if (subs.size === 0) this.handlers.delete(method)
  }

  /** Close the WebSocket connection. */
  close(): void {
    this._connected = false
    try { this._ws?.close() } catch { /* ignore */ }
    for (const [, cb] of this.pending) cb.reject(new Error('Session closed'))
    this.pending.clear()
    this.handlers.clear()
  }
}

/** Random integer between min and max (inclusive). */
export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Human-like pause: 600-1800ms. */
export function humanPause(): Promise<void> {
  return new Promise((r) => setTimeout(r, rand(600, 1800)))
}

/** Short pause: 300-900ms. */
export function shortPause(): Promise<void> {
  return new Promise((r) => setTimeout(r, rand(300, 900)))
}
