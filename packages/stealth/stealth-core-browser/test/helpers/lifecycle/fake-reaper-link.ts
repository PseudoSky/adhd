/**
 * The unit-test substitute for the one lifecycle seam, `ReaperLink`.
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.22]).
 *
 * `FakeReaperHub` stands in for the reaper host PROCESS of one port: it owns a
 * real `createReaperHost` (the same pure host the production entry serves) and
 * plays the transport — connection ids, connect/disconnect hooks, a host that
 * retires or cannot be started. `FakeReaperLink` is one client's held
 * connection to it. No socket, no process: the manager tests substitute these
 * through `ChromeManagerOptions.link`.
 */
import { lifecycleErrors, type LifecycleError } from '../../../src/lib/lifecycle/errors.js'
import type { ReaperLink } from '../../../src/lib/lifecycle/reaper-link.js'
import type { ReapOutcome, ReaperHost, ReaperStatus, RpcResponse } from '../../../src/lib/lifecycle/reaper-host.js'

export interface FakeHubOptions {
  /** Builds a fresh host (called on the first ensure and after every retire). */
  makeHost: () => ReaperHost
}

export class FakeReaperHub {
  host: ReaperHost | null = null
  /** False: `ensure` fails (e.g. the state dir is unsafe, E_UDS_DIR_UNSAFE). */
  available = true
  /** The CDP port this hub's host serves (only used in error messages). */
  port = 9333
  /** How many times a host was started (spawned). */
  spawns = 0
  private seq = 0
  private readonly links = new Set<FakeReaperLink>()

  constructor(private readonly opts: FakeHubOptions) {}

  /** The transport side of `ensureBackend`: start a host if none runs. */
  ensure(): boolean {
    if (!this.available) return false
    if (!this.host) {
      this.host = this.opts.makeHost()
      this.spawns++
    }
    return true
  }

  /** @internal accept one connection. */
  connect(link: FakeReaperLink): string {
    const id = `c${++this.seq}`
    this.links.add(link)
    this.host?.onClientConnect(id)
    return id
  }

  /** @internal a connection closed. */
  disconnect(link: FakeReaperLink, id: string, reason: 'end' | 'error' | 'closed-by-backend' = 'end'): void {
    this.links.delete(link)
    this.host?.onClientDisconnect(id, reason)
  }

  /** The host retires (Chrome gone + orphan window): every held connection is closed by the backend. */
  retire(): void {
    const links = [...this.links]
    for (const l of links) l._droppedByHost()
    this.host = null
  }

  async rpc(id: string, method: string, params?: unknown, notification = false): Promise<RpcResponse | undefined> {
    if (!this.host) return undefined
    return this.host.handler(notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: 1, method, params }, { connectionId: id })
  }
}

export class FakeReaperLink implements ReaperLink {
  ensureCalls = 0
  activityCalls = 0
  releaseCalls = 0
  reapCalls = 0
  /** Make the next operations reject/throw (a broken transport). */
  broken = false
  private conn: string | null = null
  private failure: LifecycleError | null = null

  constructor(
    readonly hub: FakeReaperHub,
    readonly hello: { pid: number; checkHistory: boolean },
  ) {}

  get connectionId(): string | null {
    return this.conn
  }

  async ensureAndHello(): Promise<boolean> {
    this.ensureCalls++
    if (this.broken) return this.fail(new Error('fake transport broken'))
    if (this.conn) return true
    if (!this.hub.ensure()) return this.fail(Object.assign(new Error('socket directory is not private'), { code: 'E_UDS_DIR_UNSAFE' }))
    this.conn = this.hub.connect(this)
    await this.hub.rpc(this.conn, 'hello', this.hello)
    this.failure = null
    return true
  }

  lastError(): LifecycleError | null {
    return this.failure
  }

  private fail(cause: Error): false {
    this.failure = lifecycleErrors.reaperUnavailable(this.hub.port, cause)
    return false
  }

  activity(): void {
    this.activityCalls++
    if (this.broken) throw new Error('fake transport broken')
    if (this.conn) void this.hub.rpc(this.conn, 'activity', undefined, true)
  }

  async reapIfIdle(): Promise<ReapOutcome | null> {
    this.reapCalls++
    if (this.broken) throw new Error('fake transport broken')
    if (!this.conn) return null
    const r = await this.hub.rpc(this.conn, 'reapIfIdle')
    return (r?.result as ReapOutcome | undefined) ?? null
  }

  async release(): Promise<void> {
    this.releaseCalls++
    if (this.broken) throw new Error('fake transport broken')
    if (!this.conn) return
    const id = this.conn
    this.conn = null
    await this.hub.rpc(id, 'release')
    this.hub.disconnect(this, id)
  }

  async status(): Promise<ReaperStatus | null> {
    if (this.broken) throw new Error('fake transport broken')
    if (!this.conn) return null
    const r = await this.hub.rpc(this.conn, 'status')
    return (r?.result as ReaperStatus | undefined) ?? null
  }

  isUp(): boolean {
    return this.conn !== null
  }

  /** The client process is killed with kill -9: the kernel closes its socket, no release is sent. */
  kill9(): void {
    if (!this.conn) return
    const id = this.conn
    this.conn = null
    this.hub.disconnect(this, id, 'end')
  }

  /** @internal the host closed this connection (retire). */
  _droppedByHost(): void {
    if (!this.conn) return
    const id = this.conn
    this.conn = null
    this.hub.disconnect(this, id, 'closed-by-backend')
  }
}
