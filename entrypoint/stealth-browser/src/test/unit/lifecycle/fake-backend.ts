/**
 * An in-memory stand-in for the service-proxy transport a `createProxyReaperLink`
 * dials: `dialBackend` returns a `FakeConnection` whose frames are answered by
 * a handler (usually a real `createReaperHost`), and the test controls whether
 * the backend accepts connections and when it drops one. No socket.
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.15] [chrome-lifecycle.29]).
 */
import type { ReaperHost, RpcRequest, RpcResponse } from '../../../lib/lifecycle/reaper-host.js'

export interface DialOptionsSeen {
  socketPath: string
  backoff?: { giveUpAfterMs?: number }
  onConnect?: () => void
  onDisconnect?: () => void
  onDiagnostic?: (line: string) => void
}

export class FakeConnection {
  readonly sent: RpcRequest[] = []
  readonly notified: RpcRequest[] = []
  closed = false
  connected = false

  constructor(
    readonly backend: FakeBackend,
    readonly opts: DialOptionsSeen,
    readonly connectionId: string,
  ) {}

  async send(req: RpcRequest): Promise<RpcResponse> {
    this.sent.push(req)
    if (this.closed) return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32001, message: 'connection closed' } }
    if (!this.backend.accepting) {
      // Never connected within the give-up bound: the transport fast-fails with -32001.
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32001, message: 'backend unavailable' } }
    }
    if (!this.connected) {
      this.connected = true
      this.backend.host?.onClientConnect(this.connectionId)
      this.opts.onConnect?.()
    }
    const r = this.backend.host ? await this.backend.host.handler(req, { connectionId: this.connectionId }) : undefined
    return r ?? { jsonrpc: '2.0', id: req.id ?? null, result: null }
  }

  notify(req: RpcRequest): void {
    if (this.backend.notifyThrows) throw new Error('EPIPE: notify on a dead socket')
    this.notified.push(req)
    if (this.connected && !this.closed) void this.backend.host?.handler(req, { connectionId: this.connectionId })
  }

  isConnected(): boolean {
    return this.connected && !this.closed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.connected) this.backend.host?.onClientDisconnect(this.connectionId, 'end')
    this.connected = false
  }

  /** The backend closed this ESTABLISHED connection (host retired or crashed). */
  dropByBackend(): void {
    if (!this.connected || this.closed) return
    this.connected = false
    this.backend.host?.onClientDisconnect(this.connectionId, 'closed-by-backend')
    this.opts.onDisconnect?.()
  }
}

export class FakeBackend {
  /** The host serving the socket (null: nothing answers frames). */
  host: ReaperHost | null = null
  /** False: connections never come up (every send resolves -32001). */
  accepting = true
  notifyThrows = false
  readonly dials: FakeConnection[] = []
  private seq = 0

  /** Use as the `dialBackend` double. */
  dial = (opts: Record<string, unknown>): FakeConnection => {
    const c = new FakeConnection(this, opts as unknown as DialOptionsSeen, `conn-${++this.seq}`)
    this.dials.push(c)
    return c
  }

  /** Live (not closed) dials. */
  live(): FakeConnection[] {
    return this.dials.filter((d) => !d.closed)
  }

  /** The host retires: every established connection is dropped by the backend. */
  retire(): void {
    for (const d of this.dials) d.dropByBackend()
    this.host = null
  }
}
