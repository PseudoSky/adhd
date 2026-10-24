/**
 * Builders for the ChromeManager-level specs over `manager-world.ts`: the
 * reaper host process of the port (a real pure `createReaperHost` whose effects
 * act on the world, served by `FakeReaperHub`) and client processes (a
 * `ChromeManager` holding a `FakeReaperLink`). Import it AFTER the spec's
 * `vi.mock` calls (it imports the mocked modules).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.22]).
 */
import { ChromeManager, type ChromeManagerOptions } from '../../../src/lib/chrome-manager.js'
import { createOwnershipStore, type OwnershipFs } from '../../../src/lib/lifecycle/ownership.js'
import { countActiveWebPages } from '../../../src/lib/lifecycle/page-tier.js'
import { createReaperHost, type ReaperHost, type ReaperHostDeps } from '../../../src/lib/lifecycle/reaper-host.js'
import { FakeReaperHub, FakeReaperLink } from './fake-reaper-link.js'
import { chromeGone, GRACE, HOST, IDLE, PORT, STATE_DIR, world } from './manager-world.js'

export interface WorldHostOptions {
  idleTimeoutMs?: number
  shutdownGraceMs?: number
  scope?: ReaperHostDeps['scope']
  checkHistoryDefault?: boolean
  logs?: string[]
}

/** A real `createReaperHost` whose effects act on the world (host clock = the faked `Date.now`). */
export function worldHost(o: WorldHostOptions = {}): ReaperHost {
  const owner = createOwnershipStore({
    stateDir: STATE_DIR,
    port: PORT,
    fs: world.fs as unknown as OwnershipFs,
    isSameProcess: (pid, start) => start !== null && world.procs.get(pid) === start,
    readProcessStartToken: (pid) => world.procs.get(pid) ?? null,
  })
  return createReaperHost({
    port: PORT,
    idleTimeoutMs: o.idleTimeoutMs ?? IDLE,
    shutdownGraceMs: o.shutdownGraceMs ?? GRACE,
    ...(o.scope ? { scope: o.scope } : {}),
    ...(o.checkHistoryDefault === undefined ? {} : { checkHistoryDefault: o.checkHistoryDefault }),
    now: () => Date.now(),
    probeChrome: async () => world.chromeUp,
    countHttpPages: () =>
      countActiveWebPages(async () => {
        if (!world.chromeUp || world.listFails) throw new Error('connect ECONNREFUSED')
        return world.pages
      }),
    historyRecent: () => {
      if (world.history instanceof Error) throw world.history
      return world.history
    },
    owner: {
      read: () => owner.read(),
      isValid: (r) => owner.isValid(r),
      remove: () => {
        world.events.push('host:remove-record')
        owner.remove()
      },
    },
    closeAllPageTargets: async () => {
      world.events.push('host:close-pages')
      if (world.failClose) throw new Error('close failed')
      world.pages = []
    },
    killProcessGroup: async (pid) => {
      world.events.push(`host:kill-group:${pid}`)
      if (world.failKill) throw new Error('kill EPERM')
      world.procs.delete(pid)
      chromeGone()
    },
    killChrome: async (port) => {
      world.events.push(`host:kill:${port}`)
      if (world.failKill) throw new Error('kill EPERM')
      chromeGone()
    },
    logger: (m) => o.logs?.push(m),
  })
}

/** One reaper host process for the port, started on the first ensure. */
export function makeHub(o: WorldHostOptions = {}): FakeReaperHub {
  return new FakeReaperHub({ makeHost: () => worldHost(o) })
}

export interface Client {
  manager: ChromeManager
  link: FakeReaperLink
  logs: string[]
  /** Only the degraded-mode warnings (`warning:` lines). */
  warnings(): string[]
}

/** One client process: a ChromeManager holding a FakeReaperLink to `hub`. */
export function client(hub: FakeReaperHub, pid: number, opts: ChromeManagerOptions = {}): Client {
  const logs: string[] = []
  const link = new FakeReaperLink(hub, { pid, checkHistory: opts.checkHistory ?? true })
  const manager = new ChromeManager({
    cdpHost: HOST,
    idleTimeoutMs: IDLE,
    shutdownGraceMs: GRACE,
    stateDir: STATE_DIR,
    logger: (m) => logs.push(m),
    link,
    ...opts,
  })
  return { manager, link, logs, warnings: () => logs.filter((l) => l.startsWith('warning:')) }
}
