/**
 * Shared scenario kit of the use-case specs (not a spec itself).
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.3]
 *
 * A `ChromeWorld` is the fake Chrome behind `fetch` (`/json/version`, `/json/list`) on ONE explicit port;
 * a request to the developer's default port 9222 is a test failure. `useProfileHome` points `HOME` at a
 * throwaway directory holding a built profile as the dedicated CDP profile. No socket, no process, no network.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeCdpServer, type CdpFixture } from '../fake-cdp.js'
import type { BuiltProfile } from '../profile-fixtures.js'
import type { ProcessProbe } from '../../../src/lib/cdp/browser.js'
import type { FakeProc } from '../fake-proc.js'
import { decideReap, type ClientView, type ReapOutcome } from '../../../src/lib/lifecycle/index.js'
import type { ReaperLink } from '../../../src/lib/lifecycle/reaper-link.js'
import type { ReaperStatus } from '../../../src/lib/lifecycle/reaper-host.js'
import type { LifecycleError } from '../../../src/lib/lifecycle/errors.js'
import { isActiveWebTarget } from '../../../src/lib/lifecycle/page-tier.js'

export interface FakeTab { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }

export class ChromeWorld {
  up = true
  tabs: FakeTab[] = []
  readonly requested: string[] = []
  private restoreWs: (() => void) | undefined
  server: FakeCdpServer | undefined
  private savedFetch: { value: typeof fetch } | undefined

  constructor(readonly port: number) {}

  get browserWs(): string { return `ws://127.0.0.1:${this.port}/devtools/browser/B1` }

  tab(id: string, url: string, title = id): FakeTab {
    return { id, type: 'page', url, title, webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${id}` }
  }

  /** Stub `fetch` as the fake Chrome. */
  installFetch(): void {
    this.savedFetch ??= { value: globalThis.fetch }
    this.requested.length = 0
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      this.requested.push(url)
      const u = new URL(url)
      if (u.port === '9222') throw new Error('a scenario reached the default Chrome port 9222')
      if (!this.up) throw new TypeError('fetch failed')
      if (u.port !== String(this.port)) throw new Error(`unexpected port ${u.port}`)
      if (u.pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: this.browserWs, Browser: 'Chrome/150.0.1', 'Protocol-Version': '1.3', 'User-Agent': 'Mozilla/5.0 Fake' })
      if (u.pathname === '/json/list') return Response.json(this.tabs)
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  }

  /** Serve `fixture` over the global WebSocket. */
  useCdp(fixture: CdpFixture, opts: { strict?: boolean } = {}): FakeCdpServer {
    this.restoreWs?.()
    this.server = new FakeCdpServer(fixture, { strict: false, ...opts })
    this.restoreWs = this.server.install()
    return this.server
  }

  dispose(): void {
    this.restoreWs?.()
    this.restoreWs = undefined
    this.server = undefined
    if (this.savedFetch) globalThis.fetch = this.savedFetch.value
    this.savedFetch = undefined
  }
}

/** Make `HOME` a throwaway directory whose dedicated CDP profile is `profile`; returns a restore function. */
export function useProfileHome(profile: BuiltProfile): { home: string; profileDir: string; restore(): void } {
  const home = mkdtempSync(join(tmpdir(), 'stealth-usecase-home-'))
  const profileDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome-CDP')
  mkdirSync(join(home, 'Library', 'Application Support', 'Google'), { recursive: true })
  renameSync(profile.root, profileDir)
  const saved = process.env['HOME']
  process.env['HOME'] = home
  return {
    home,
    profileDir,
    restore() {
      if (saved === undefined) delete process.env['HOME']
      else process.env['HOME'] = saved
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** A throwaway directory, removed by the returned cleanup. */
export function tempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `stealth-usecase-${prefix}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A global WebSocket that opens and then never answers a command (a hung Chrome). Returns the restore function. */
export function installSilentWebSocket(): () => void {
  const g = globalThis as { WebSocket?: unknown }
  const had = Object.prototype.hasOwnProperty.call(g, 'WebSocket')
  const previous = g.WebSocket
  class SilentSocket {
    readyState = 0
    private readonly handlers = new Map<string, Array<(ev: unknown) => void>>()
    constructor(readonly url: string) {
      queueMicrotask(() => { this.readyState = 1; this.fire('open') })
    }
    addEventListener(type: string, fn: (ev: unknown) => void): void { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]) }
    removeEventListener(): void { /* not needed */ }
    send(): void { /* a hung Chrome never answers */ }
    close(): void { this.readyState = 3; this.fire('close') }
    private fire(type: string): void { for (const fn of this.handlers.get(type) ?? []) fn({}) }
  }
  g.WebSocket = SilentSocket
  return () => {
    if (had) g.WebSocket = previous
    else delete g.WebSocket
  }
}

/** The machine of a launch scenario: a fake process table, a fake Chrome and a probe that sees only the fake processes. */

export interface LaunchRig {
  proc: FakeProc
  world: ChromeWorld
  /** The spawn implementation to return from a mocked spawn of the Chrome binary. */
  spawn(command: string, args: string[], opts: Record<string, unknown>): FakeChild
  probe: ProcessProbe
  /** Spawned Chrome processes, oldest first. */
  launched(): Array<{ pid: number; args: string[] }>
  /** How a spawned Chrome behaves: it answers CDP at once (default), never, or fails to spawn with this errno. */
  behaviour: 'answers' | 'silent' | { errno: string }
}

export interface FakeChild {
  pid: number
  unref(): void
  once(event: string, fn: (e: Error) => void): FakeChild
}

export function makeLaunchRig(proc: FakeProc, world: ChromeWorld): LaunchRig {
  const argsOf = new Map<number, string[]>()
  const rig: LaunchRig = {
    proc,
    world,
    behaviour: 'answers',
    spawn(command, args, opts) {
      const child = proc.spawn(command, args, opts)
      argsOf.set(child.pid, [command, ...args])
      let onError: ((e: Error) => void) | undefined
      if (typeof rig.behaviour === 'object') {
        const errno = rig.behaviour.errno
        queueMicrotask(() => onError?.(Object.assign(new Error(`spawn ${command} ${errno}`), { code: errno })))
      } else if (rig.behaviour === 'answers') {
        world.up = true
      }
      const fake: FakeChild = {
        pid: child.pid,
        unref: () => undefined,
        once(event, fn) {
          if (event === 'error') onError = fn
          return fake
        },
      }
      return fake
    },
    probe: {
      listeners: () => (world.up ? [...argsOf.keys()].filter((pid) => proc.pidAlive(pid)) : []),
      commandLine: (pid) => argsOf.get(pid)?.join(' ') ?? null,
      groupOf: (pid) => pid,
    },
    launched: () => [...argsOf.entries()].map(([pid, a]) => ({ pid, args: a.slice(1) })),
  }
  return rig
}


/**
 * The reaper host of one port, simulated: a `ReaperLink` whose soft reap runs the REAL `lifecycle.decideReap`
 * over the fake Chrome's tabs, the other clients and the profile history, and closes the fake Chrome on `reap`.
 */
export class PolicyReaperLink implements ReaperLink {
  up = false
  activities = 0
  readonly decisions: ReapOutcome[] = []

  constructor(
    private readonly world: ChromeWorld,
    private readonly history: () => boolean | 'unavailable',
    private readonly otherClients: () => ClientView[] = () => [],
  ) {}

  /** The most recent reap decision, or undefined before the first. */
  lastDecision(): ReapOutcome | undefined { return this.decisions[this.decisions.length - 1] }

  private httpPages(): number { return this.world.tabs.filter((t) => isActiveWebTarget(t.url)).length }

  async ensureAndHello(): Promise<boolean> { this.up = true; return true }
  activity(): void { this.activities += 1 }
  isUp(): boolean { return this.up }
  lastError(): LifecycleError | null { return null }
  async release(): Promise<void> { this.up = false }

  async reapIfIdle(): Promise<ReapOutcome | null> {
    const decision = decideReap({
      now: Date.now(), clients: this.otherClients(), idleTimeoutMs: 120_000, graceMs: 0, chromeUp: this.world.up,
      httpPageCount: this.httpPages(), historyRecent: this.history(), checkHistoryDefault: true,
      scope: 'port-occupant', ownerValid: true, lastPinAt: null,
    })
    const outcome: ReapOutcome = { ...decision, reaped: decision.action === 'reap' }
    if (outcome.reaped) { this.world.up = false; this.world.tabs = [] }
    this.decisions.push(outcome)
    return outcome
  }

  async status(): Promise<ReaperStatus> {
    return { clients: 1 + this.otherClients().length, activeClients: 1, httpPages: this.httpPages(), chromeUp: this.world.up, ownerValid: true, siblingWarning: false, siblingThreshold: 5 }
  }
}

/** Wrap the installed global WebSocket so every socket closes before it opens (a Chrome that refuses the page socket). */
export function refuseWebSocketOpen(): void {
  const g = globalThis as unknown as { WebSocket: (url: string) => { close(): void } }
  const bound = g.WebSocket
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = function Refusing(url: string) {
    const ws = bound(url)
    ws.close()
    return ws
  }
}
