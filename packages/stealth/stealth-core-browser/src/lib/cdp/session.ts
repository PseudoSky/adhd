/**
 * @adhd/stealth-core-browser — src/lib/cdp/session.ts
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

import { StealthCoreBrowserError } from '../../errors.js'

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
  /**
   * Called when an event subscriber throws. The throw never reaches the other subscribers or the socket
   * (one bad handler must not starve the rest), but it is not silent: the default writes one stderr line
   * naming the event and the message.
   */
  onHandlerError: (method: string, err: unknown) => void = (method, err) => {
    console.error(`[@adhd/stealth-core-browser] a CDP subscriber for ${method} threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  get connected(): boolean {
    return this._connected
  }

  /**
   * Connect to a CDP WebSocket endpoint.
   * @param wsUrl WebSocket debugger URL
   * @param timeoutMs Optional open deadline; omitted means wait indefinitely. On
   *        timeout, error, or a close before open the socket is closed and the
   *        promise rejects.
   */
  async connect(wsUrl: string, timeoutMs?: number): Promise<void> {
    const ws = new WebSocket(wsUrl)
    this._ws = ws

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const settle = (err?: StealthCoreBrowserError): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (err) {
          try { ws.close() } catch { /* ignore */ }
          reject(err)
        } else resolve()
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => settle(StealthCoreBrowserError.of('CDP_CONNECT_FAILED', `WebSocket open timeout after ${timeoutMs}ms`, { detail: { wsUrl, timeoutMs } })), timeoutMs)
      }
      ws.addEventListener('open', () => settle(), { once: true })
      ws.addEventListener('error', () => settle(StealthCoreBrowserError.of('CDP_CONNECT_FAILED', 'WebSocket connection failed', { detail: { wsUrl } })), { once: true })
      // A close before open is a failed connect, never a hang.
      ws.addEventListener('close', () => settle(StealthCoreBrowserError.of('CDP_CONNECT_FAILED', 'WebSocket connection failed', { detail: { wsUrl } })), { once: true })
    })

    this._connected = true

    this._ws.addEventListener('message', (ev) => {
      let msg: CdpMessage
      try {
        const parsed: unknown = JSON.parse(String(ev.data))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('the frame is not a JSON object')
        msg = parsed as CdpMessage
      } catch (err) {
        // A frame that is not a CDP message means the endpoint is broken or hostile: fail closed with a typed
        // error for every command in flight and drop the connection, instead of throwing inside the listener.
        const cause = err instanceof Error ? err.message : String(err)
        for (const [, cb] of this.pending) cb.reject(StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `the CDP endpoint sent a malformed frame (${cause})`, { cause: err, detail: { reason: 'malformed-frame' } }))
        this.pending.clear()
        this._connected = false
        try { this._ws?.close() } catch { /* already closing */ }
        return
      }

      // Command response
      if ('id' in msg && typeof msg.id === 'number') {
        const cb = this.pending.get(msg.id)
        if (cb) {
          this.pending.delete(msg.id)
          if (msg.error) cb.reject(StealthCoreBrowserError.of('CDP_REMOTE_ERROR', msg.error.message, { detail: { remoteCode: msg.error.code } }))
          else cb.resolve(msg.result ?? {})
        }
        return
      }

      // Event — dispatch to every subscriber; one throwing must not starve the rest
      const event = msg as CdpEvent
      const subs = this.handlers.get(event.method)
      if (subs) for (const handler of [...subs]) {
        try { handler(event.params) } catch (err) { this.onHandlerError(event.method, err) }
      }
    })

    this._ws.addEventListener('close', () => {
      this._connected = false
      // Reject all pending
      for (const [, cb] of this.pending) cb.reject(StealthCoreBrowserError.of('CDP_SESSION_CLOSED', 'WebSocket closed'))
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
        reject(StealthCoreBrowserError.of('CDP_NOT_CONNECTED', 'CdpSession not connected', { detail: { method } }))
        return
      }

      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(StealthCoreBrowserError.of('CDP_TIMEOUT', `CDP timeout: ${method} after ${timeoutMs}ms`, { detail: { method, timeoutMs } }))
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
        reject(StealthCoreBrowserError.of('CDP_SEND_FAILED', `CDP send failed: ${(err as Error).message}`, { cause: err, detail: { method } }))
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
    for (const [, cb] of this.pending) cb.reject(StealthCoreBrowserError.of('CDP_SESSION_CLOSED', 'Session closed'))
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
