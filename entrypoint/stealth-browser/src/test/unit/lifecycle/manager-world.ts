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
 *   vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule())
 *   vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule())
 *   vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig()))
 *
 * This module imports nothing under src/lib (a mock factory that imported a
 * mocked module would cycle); the manager/host builders live in
 * `manager-clients.ts`.
 *
 * The service-proxy mock keeps the real pure `createCircuitBreaker` and
 * `createIdleRetirer`; only the I/O entry points (ensure, dial, serve, the
 * socket-dir check, the process identity reads) are replaced.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.22] [chrome-lifecycle.23]).
 */
import { vi } from 'vitest'
import { MemFs } from '../../support/mem-fs.js'

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

/** `cdp/browser.js`: launches and kills against the simulated Chrome. */
export function browserModule(): Record<string, unknown> {
  return {
    ensureChromeRunning: vi.fn(async (opts: { port?: number } = {}) => {
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
    killChrome: vi.fn(async (port = 9222) => {
      world.events.push(`kill:${port}`)
      if (world.failKill) throw new Error('kill EPERM')
      chromeGone()
    }),
    killProcessGroup: vi.fn(async (pid: number) => {
      world.events.push(`kill-group:${pid}`)
      chromeGone()
    }),
  }
}

/** `cdp/targets.js`: CDP probes and page operations against the simulated Chrome. */
export function targetsModule(): Record<string, unknown> {
  const list = async () => {
    if (!world.chromeUp || world.listFails) throw new Error('connect ECONNREFUSED')
    return world.pages.map((p) => ({ id: p.id, type: 'page', url: p.url, title: '', webSocketDebuggerUrl: `ws://fake/${p.id}` }))
  }
  return {
    isChromeReachable: vi.fn(async () => {
      world.probes++
      return world.chromeUp
    }),
    hideAllWindows: vi.fn(async () => {
      world.events.push('hide')
      if (world.failHide) throw new Error('Browser.setWindowBounds failed')
    }),
    closeAllPageTargets: vi.fn(async () => {
      world.events.push('close-pages')
      if (world.failClose) throw new Error('close failed')
      world.pages = []
    }),
    listPageTargetsOnly: vi.fn(list),
    listPageTargets: vi.fn(list),
  }
}

export interface SpDoubles {
  ensurePrivateSocketDir: ReturnType<typeof vi.fn>
  readProcessStartToken: ReturnType<typeof vi.fn>
  isSameProcess: ReturnType<typeof vi.fn>
  ensureBackend: ReturnType<typeof vi.fn>
  dialBackend: ReturnType<typeof vi.fn>
  serveBackend: ReturnType<typeof vi.fn>
}

/** The I/O entry points of `@adhd/sox-service-proxy`, as spies (shared by `spModule`). */
export const sp: SpDoubles = {
  ensurePrivateSocketDir: vi.fn(),
  readProcessStartToken: vi.fn(),
  isSameProcess: vi.fn(),
  ensureBackend: vi.fn(),
  dialBackend: vi.fn(),
  serveBackend: vi.fn(),
}

/** Default behaviour of the service-proxy doubles over the world. */
export function resetSp(): void {
  for (const f of Object.values(sp)) f.mockReset()
  sp.ensurePrivateSocketDir.mockImplementation((dir: string) => {
    if (world.dirUnsafe) throw unsafeDirError(dir)
    world.fs.mkdirSync(dir, { recursive: true })
  })
  sp.readProcessStartToken.mockImplementation((pid: number) => world.procs.get(pid) ?? null)
  sp.isSameProcess.mockImplementation((pid: number, token: string | null | undefined) => token != null && world.procs.get(pid) === token)
  sp.ensureBackend.mockImplementation(async () => ({ disposition: 'failed', detail: 'no backend in this spec' }))
  sp.dialBackend.mockImplementation(() => {
    throw new Error('dialBackend is not scripted in this spec')
  })
  sp.serveBackend.mockImplementation(async () => {
    throw new Error('serveBackend is not scripted in this spec')
  })
}

/** `@adhd/sox-service-proxy` with the pure parts real and the I/O replaced. */
export function spModule(orig: Record<string, unknown>): Record<string, unknown> {
  return {
    ...orig,
    ensurePrivateSocketDir: (...a: unknown[]) => sp.ensurePrivateSocketDir(...a),
    readProcessStartToken: (...a: unknown[]) => sp.readProcessStartToken(...a),
    isSameProcess: (...a: unknown[]) => sp.isSameProcess(...a),
    ensureBackend: (...a: unknown[]) => sp.ensureBackend(...a),
    dialBackend: (...a: unknown[]) => sp.dialBackend(...a),
    serveBackend: (...a: unknown[]) => sp.serveBackend(...a),
  }
}

/** Open an http(s) page (a captcha window, a kept result page). */
export function openPage(url: string): void {
  world.pages.push({ id: `T${world.pages.length + 1}`, url })
}
