/**
 * Test world for the ChromeManager-level lifecycle specs: one simulated
 * machine with a scripted Chrome (reachability, launches, page targets,
 * history), an in-memory filesystem, a reaper host process per port
 * (`FakeReaperHub` over the real pure `createReaperHost`) and an ordered log of
 * every effect. No socket, no process, no real Chrome, port 9222 is never
 * contacted (every CDP probe reads `world.chromeUp`).
 *
 * `vi.mock` is hoisted per spec file, so each spec declares its mocks and
 * routes them here:
 *
 *   vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
 *   vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
 *   vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
 *   vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig()))
 *
 * This module imports nothing under src/lib (a mock factory that imported a
 * mocked module would cycle) and nothing from the test runner (the dependency
 * check treats non-spec files as package code): the spec passes its own `vi.fn`
 * in, and the manager/host builders live in `manager-clients.ts`.
 *
 * The service-proxy mock keeps the real pure `createCircuitBreaker` and
 * `createIdleRetirer`; only the I/O entry points (ensure, dial, serve, the
 * socket-dir check, the process identity reads) are replaced.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.22] [chrome-lifecycle.23]).
 */
import { MemFs } from '../mem-fs.js'

export const PORT = 9333
export const HOST = `127.0.0.1:${PORT}`
export const STATE_DIR = '/state/stealth-browser-501-9333'
export const IDLE = 1_000
export const GRACE = 500

export interface WorldPage {
  id: string
  url: string
}

export interface ManagerWorld {
  fs: MemFs
  chromeUp: boolean
  /** What the next launch does when Chrome is down. */
  launch: 'ok' | 'fail' | 'unreachable'
  nextPid: number
  /** Chrome processes started by `ensureChromeRunning`. */
  spawns: number
  /** Every `ensureChromeRunning` call. */
  ensureCalls: number
  /** Every CDP reachability probe. */
  probes: number
  pages: WorldPage[]
  /** Chrome answers /json/version but the page listing fails (CDP unreachable during the check). */
  listFails: boolean
  /** A recent history visit, or an Error for an unavailable history database. */
  history: boolean | Error
  /** pid -> start token of the live processes (owner-record validity). */
  procs: Map<number, string>
  /** Ordered effects: hide, close-pages, kill:<port> (local), host:close-pages, host:kill-group:<pid>, host:kill:<port>, host:remove-record. */
  events: string[]
  failHide: boolean
  failClose: boolean
  failKill: boolean
  /** `ensurePrivateSocketDir` refuses the state directory (E_UDS_DIR_UNSAFE). */
  dirUnsafe: boolean
}

function freshWorld(): ManagerWorld {
  const fs = new MemFs()
  fs.mkdirSync('/state', { recursive: true })
  fs.mkdirSync('/tmp', { recursive: true })
  return {
    fs,
    chromeUp: false,
    launch: 'ok',
    nextPid: 4100,
    spawns: 0,
    ensureCalls: 0,
    probes: 0,
    pages: [],
    listFails: false,
    history: false,
    procs: new Map(),
    events: [],
    failHide: false,
    failClose: false,
    failKill: false,
    dirUnsafe: false,
  }
}

/** The one world every mocked module reads. Reset it in `beforeEach`. */
export const world: ManagerWorld = freshWorld()

export function resetWorld(): ManagerWorld {
  Object.assign(world, freshWorld())
  return world
}

/** Chrome goes away (killed by another process, crashed, reaped). */
export function chromeGone(): void {
  world.chromeUp = false
  world.pages = []
}

function unsafeDirError(dir: string): Error {
  return Object.assign(new Error(`socket directory ${dir} is not private (foreign owner)`), { code: 'E_UDS_DIR_UNSAFE', reason: 'foreign', dir })
}

// ─── Module doubles ──────────────────────────────────────────────────────────

/** `node:fs` routed to the world's MemFs (read at call time, so `resetWorld` swaps it). */
export function fsModule(): Record<string, unknown> {
  const fs = () => world.fs
  const mod = {
    existsSync: (p: string) => fs().existsSync(p),
    readFileSync: (p: string) => fs().readFileSync(p),
    writeFileSync: (p: string, d: string, o?: { flag?: string; mode?: number }) => fs().writeFileSync(p, d, o),
    renameSync: (a: string, b: string) => fs().renameSync(a, b),
    unlinkSync: (p: string) => fs().unlinkSync(p),
    mkdirSync: (p: string, o?: { recursive?: boolean; mode?: number }) => fs().mkdirSync(p, o),
    openSync: (p: string, f: string, m?: number) => fs().openSync(p, f, m),
    closeSync: (fd: number) => fs().closeSync(fd),
    readdirSync: (p: string) => fs().readdirSync(p),
    statSync: (p: string) => fs().statSync(p),
  }
  return { ...mod, default: mod }
}

/**
 * The calling spec's `vi.fn` (so module functions are spies the spec can
 * assert on with `vi.mocked`), or the identity for plain functions.
 */
export type Spy = <T extends (...args: never[]) => unknown>(impl: T) => T

const plain: Spy = (impl) => impl

/** `cdp/browser.js`: launches and kills against the simulated Chrome. */
export function browserModule(spy: Spy = plain): Record<string, unknown> {
  return {
    ensureChromeRunning: spy(async (opts: { port?: number } = {}) => {
      const port = opts.port ?? 9222
      world.ensureCalls++
      if (world.chromeUp) return { pid: null, port, profileDir: '/profile' }
      if (world.launch === 'fail') throw new Error('Chrome binary not found at "/nowhere"')
      world.spawns++
      if (world.launch === 'unreachable') throw new Error(`Chrome did not start CDP on port ${port} within 10s`)
      const pid = world.nextPid++
      world.procs.set(pid, `start-${pid}`)
      world.chromeUp = true
      return { pid, port, profileDir: '/profile' }
    }),
    killChrome: spy(async (port = 9222) => {
      world.events.push(`kill:${port}`)
      if (world.failKill) throw new Error('kill EPERM')
      chromeGone()
    }),
    killProcessGroup: spy(async (pid: number) => {
      world.events.push(`kill-group:${pid}`)
      chromeGone()
    }),
  }
}

/** `cdp/targets.js`: CDP probes and page operations against the simulated Chrome. */
export function targetsModule(spy: Spy = plain): Record<string, unknown> {
  const list = async () => {
    if (!world.chromeUp || world.listFails) throw new Error('connect ECONNREFUSED')
    return world.pages.map((p) => ({ id: p.id, type: 'page', url: p.url, title: '', webSocketDebuggerUrl: `ws://127.0.0.1/${p.id}` }))
  }
  return {
    isChromeReachable: spy(async (_host: string) => {
      world.probes++
      return world.chromeUp
    }),
    hideAllWindows: spy(async (_host: string) => {
      world.events.push('hide')
      if (world.failHide) throw new Error('Browser.setWindowBounds failed')
    }),
    closeAllPageTargets: spy(async (_host: string) => {
      world.events.push('close-pages')
      if (world.failClose) throw new Error('close failed')
      world.pages = []
    }),
    listPageTargetsOnly: spy(list),
    listPageTargets: spy(list),
  }
}

export type EnsureBackendDouble = (opts: Record<string, unknown>) => Promise<{ disposition: string; detail: string; pid?: number; errorCode?: string }>

/**
 * The I/O entry points of `@adhd/sox-service-proxy`. `spModule` delegates to
 * these at call time, so a spec replaces one (`sp.ensureBackend = vi.fn(...)`)
 * to script or spy on it; `resetSp` restores the world-backed defaults.
 */
export interface SpDoubles {
  ensurePrivateSocketDir: (dir: string, opts?: unknown) => void
  readProcessStartToken: (pid: number) => string | null
  isSameProcess: (pid: number, token: string | null | undefined) => boolean
  ensureBackend: EnsureBackendDouble
  dialBackend: (opts: Record<string, unknown>) => unknown
  serveBackend: (opts: Record<string, unknown>) => Promise<unknown>
}

function defaultSp(): SpDoubles {
  return {
    ensurePrivateSocketDir: (dir) => {
      if (world.dirUnsafe) throw unsafeDirError(dir)
      world.fs.mkdirSync(dir, { recursive: true })
    },
    readProcessStartToken: (pid) => world.procs.get(pid) ?? null,
    isSameProcess: (pid, token) => token != null && world.procs.get(pid) === token,
    ensureBackend: async () => ({ disposition: 'failed', detail: 'no reaper backend in this spec' }),
    dialBackend: () => {
      throw new Error('dialBackend is not scripted in this spec')
    },
    serveBackend: async () => {
      throw new Error('serveBackend is not scripted in this spec')
    },
  }
}

export const sp: SpDoubles = defaultSp()

/** Restore the world-backed defaults of the service-proxy doubles. */
export function resetSp(): void {
  Object.assign(sp, defaultSp())
}

/** `@adhd/sox-service-proxy` with the pure parts real (breaker, retirer, constants) and the I/O replaced. */
export function spModule(orig: Record<string, unknown>): Record<string, unknown> {
  return {
    ...orig,
    ensurePrivateSocketDir: (dir: string, o?: unknown) => sp.ensurePrivateSocketDir(dir, o),
    readProcessStartToken: (pid: number) => sp.readProcessStartToken(pid),
    isSameProcess: (pid: number, token: string | null | undefined) => sp.isSameProcess(pid, token),
    ensureBackend: (o: Record<string, unknown>) => sp.ensureBackend(o),
    dialBackend: (o: Record<string, unknown>) => sp.dialBackend(o),
    serveBackend: (o: Record<string, unknown>) => sp.serveBackend(o),
  }
}

/** Open an http(s) page (a captcha window, a kept result page). */
export function openPage(url: string): void {
  world.pages.push({ id: `T${world.pages.length + 1}`, url })
}
