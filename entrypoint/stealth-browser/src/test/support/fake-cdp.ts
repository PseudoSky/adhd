/**
 * In-memory Chrome DevTools Protocol server for the unit lane.
 * Ticket 8468f7b1 · criteria [cdp-test-harness.1] [cdp-test-harness.2]
 *
 * No socket, no subprocess, no Chrome: `install()` replaces the global
 * `WebSocket` (the same effect as vi.stubGlobal, restored by the returned function) with a `FakeWebSocket` that talks to a
 * `FakeCdpServer`. The server is a small protocol state machine: a client
 * command is answered by `id`, exactly as CDP does, according to a fixture's
 * ordered steps (`when` subset-match, `reply`, then `emit` events in order,
 * each optionally delayed by `delayMs` on the (fake) timer clock).
 *
 * Step selection: the first not-yet-used step whose `when` matches; once every
 * matching step has been used the last match answers again, so a repeated
 * command (Network.enable on each of two tabs) keeps working.
 *
 * Fixture honesty: `meta.origin` is `synthetic-protocol-conformant` until a
 * dev-only recorder replaces them with `recorded` captures.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CdpFixtureStep {
  /** Subset match on the client command: method equal, every key in params deep-equal. */
  when: { method: string; params?: Record<string, unknown> }
  /** Default result `{}`. */
  reply?: { result?: Record<string, unknown>; error?: { code: number; message: string } }
  /** Events pushed after the reply, in order. */
  emit?: Array<{ method: string; params: Record<string, unknown>; delayMs?: number }>
}

export interface CdpFixture {
  meta: { name: string; origin: 'recorded' | 'synthetic-protocol-conformant'; chromeVersion?: string }
  steps: CdpFixtureStep[]
}

type Listener = (ev: { data?: string; code?: number }) => void

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** True when every key of `want` deep-equals the same key of `have` (arrays and scalars compare whole). */
function subsetMatch(want: unknown, have: unknown): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) {
    return JSON.stringify(want) === JSON.stringify(have)
  }
  if (have === null || typeof have !== 'object') return false
  return Object.entries(want as Record<string, unknown>).every(([k, v]) =>
    subsetMatch(v, (have as Record<string, unknown>)[k]),
  )
}

export class FakeWebSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED

  readyState = CONNECTING
  private listeners = new Map<string, Array<{ fn: Listener; once: boolean }>>()

  constructor(
    readonly url: string,
    private readonly server: FakeCdpServer,
  ) {
    server._register(this)
    // CDP clients see `open` on a later tick, never synchronously from the constructor.
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this.dispatch('open', {})
    })
  }

  addEventListener(type: string, fn: Listener, opts?: boolean | { once?: boolean }): void {
    const once = typeof opts === 'object' && opts !== null && opts.once === true
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once }])
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn))
  }

  send(raw: string): void {
    if (this.readyState !== OPEN) throw new Error(`FakeWebSocket.send in readyState ${this.readyState}`)
    this.server._handleCommand(this, JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> })
  }

  close(code = 1000): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    this.readyState = CLOSING
    queueMicrotask(() => this._finishClose(code))
  }

  /** @internal server → client frame. */
  _deliver(frame: Record<string, unknown>): void {
    if (this.readyState !== OPEN) return
    this.dispatch('message', { data: JSON.stringify(frame) })
  }

  /** @internal */
  _finishClose(code: number): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.dispatch('close', { code })
  }

  private dispatch(type: string, ev: { data?: string; code?: number }): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) {
      if (l.once) this.removeEventListener(type, l.fn)
      l.fn(ev)
    }
  }
}

export class FakeCdpServer {
  readonly received: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  readonly unexpected: string[] = []
  private readonly sockets: FakeWebSocket[] = []
  private readonly used = new Set<number>()
  private opened = 0
  private readonly strict: boolean

  constructor(
    private readonly fixture: CdpFixture,
    opts: { strict?: boolean } = {},
  ) {
    this.strict = opts.strict ?? true
  }

  /** Stub the global WebSocket; returns the restore function. */
  install(): () => void {
    const bind = (url: string): FakeWebSocket => new FakeWebSocket(url, this)
    const BoundSocket = Object.assign(function BoundSocket(url: string) {
      return bind(url)
    } as unknown as typeof WebSocket, { CONNECTING, OPEN, CLOSING, CLOSED })
    const g = globalThis as { WebSocket?: unknown }
    const had = Object.prototype.hasOwnProperty.call(g, 'WebSocket')
    const previous = g.WebSocket
    g.WebSocket = BoundSocket
    return () => {
      if (had) g.WebSocket = previous
      else delete g.WebSocket
    }
  }

  /** Number of sockets ever opened against this server (leak assertions). */
  openCount(): number {
    return this.opened
  }

  /** Push an event to every open socket right now, bypassing the fixture. */
  emitNow(method: string, params: Record<string, unknown>): void {
    for (const s of this.sockets) s._deliver({ method, params })
  }

  /** Simulate Chrome dying: every open socket fires `close`. */
  closeFromServer(code = 1006): void {
    for (const s of this.sockets) s._finishClose(code)
  }

  /** @internal */
  _register(ws: FakeWebSocket): void {
    this.opened += 1
    this.sockets.push(ws)
  }

  /** @internal */
  _handleCommand(ws: FakeWebSocket, cmd: { id: number; method: string; params?: Record<string, unknown> }): void {
    const params = cmd.params ?? {}
    this.received.push({ id: cmd.id, method: cmd.method, params })
    const matches = this.fixture.steps
      .map((step, i) => ({ step, i }))
      .filter(({ step }) => step.when.method === cmd.method && subsetMatch(step.when.params ?? {}, params))
    const pick = matches.find((m) => !this.used.has(m.i)) ?? matches[matches.length - 1]
    queueMicrotask(() => {
      if (!pick) {
        this.unexpected.push(cmd.method)
        if (this.strict) {
          ws._deliver({ id: cmd.id, error: { code: -32601, message: `'${cmd.method}' wasn't found` } })
        } else {
          ws._deliver({ id: cmd.id, result: {} })
        }
        return
      }
      this.used.add(pick.i)
      const { reply, emit } = pick.step
      if (reply?.error) ws._deliver({ id: cmd.id, error: reply.error })
      else ws._deliver({ id: cmd.id, result: reply?.result ?? {} })
      for (const ev of emit ?? []) {
        const frame = { method: ev.method, params: ev.params }
        if (ev.delayMs && ev.delayMs > 0) setTimeout(() => ws._deliver(frame), ev.delayMs)
        else ws._deliver(frame)
      }
    })
  }
}

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'cdp')

/** Read `src/test/fixtures/cdp/<name>.cdp.json`. */
export function loadFixture(name: string): CdpFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.cdp.json`), 'utf8')) as CdpFixture
}
