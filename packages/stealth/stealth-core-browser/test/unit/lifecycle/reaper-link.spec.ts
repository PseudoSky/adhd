/**
 * CL15 (F24 N1 N5) the real ReaperLink adapter over the service proxy.
 * Ticket 8468f7b1 · [chrome-lifecycle.15]
 *
 * `createProxyReaperLink` ensures the reaper host with `ensureBackend`, holds
 * ONE `dialBackend` connection that sends `hello{pid, checkHistory}` as its
 * first frame on connect, then `activity` (fire-and-forget), `release`,
 * `reapIfIdle`, `status`. The dispositions spawned, already-live and
 * adopted-after-wait map to ok; `failed` (including E_UDS_DIR_UNSAFE) and a
 * throwing ensure map to REAPER_UNAVAILABLE (degraded mode). The package is
 * mocked with vi.mock('@adhd/sox-service-proxy'): its pure parts stay real,
 * ensure/dial are doubles, and the frames are answered by a real
 * `createReaperHost`. No socket, no process.
 * guards: ${d} maps to ok: one dialBackend connection that sent hello first
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.15]
 */
import { isAbsolute } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { createProxyReaperLink, LINK_GIVE_UP_MS, REAPER_ENTRY_SCRIPT, reaperSingletonKey, type ProxyReaperLinkConfig } from '../../../src/lib/lifecycle/reaper-link.js'
import { FakeBackend } from '../../helpers/lifecycle/fake-backend.js'
import { worldHost } from '../../helpers/lifecycle/manager-clients.js'
import { PORT, resetSp, resetWorld, sp, STATE_DIR, world } from '../../helpers/lifecycle/manager-world.js'
import { must } from '../../helpers/must.js'

let backend: FakeBackend
let logs: string[]

const CFG: ProxyReaperLinkConfig = {
  port: PORT,
  stateDir: STATE_DIR,
  pid: 4321,
  checkHistory: false,
  idleTimeoutMs: 120_000,
  shutdownGraceMs: 30_000,
  orphanWindowMs: 30_000,
  scope: 'port-occupant',
  entryPath: '/pkg/dist/index.js',
  nodePath: '/usr/local/bin/node',
}

function link(over: Partial<ProxyReaperLinkConfig> = {}) {
  return createProxyReaperLink({ ...CFG, logger: (m) => logs.push(m), ...over })
}

function disposition(d: string, extra: Record<string, unknown> = {}) {
  sp.ensureBackend = vi.fn(async () => ({ disposition: d, detail: `${d} detail`, ...extra }))
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  world.chromeUp = true
  logs = []
  backend = new FakeBackend()
  backend.host = worldHost()
  sp.dialBackend = vi.fn(backend.dial)
  disposition('spawned', { pid: 999 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.15] ensure dispositions', () => {
  for (const d of ['spawned', 'already-live', 'adopted-after-wait']) {
    it(`${d} maps to ok: one dialBackend connection that sent hello first`, async () => {
      disposition(d)
      const l = link()
      await expect(l.ensureAndHello()).resolves.toBe(true)
      expect(l.isUp()).toBe(true)
      expect(l.lastError()).toBeNull()
      expect(sp.dialBackend).toHaveBeenCalledTimes(1)
      const conn = must(backend.dials[0])
      expect(conn.opts.socketPath).toMatch(new RegExp(`^${STATE_DIR}/`))
      expect(conn.opts.backoff).toEqual({ giveUpAfterMs: LINK_GIVE_UP_MS })
      expect(conn.sent[0]).toMatchObject({ method: 'hello', params: { pid: 4321, checkHistory: false } })
      // The host registered this client under its connection, history flag included; hello is not activity.
      expect(must(backend.host).clients()).toEqual([{ id: conn.connectionId, pid: 4321, checkHistory: false, lastActivityAt: null }])
    })
  }

  it('failed maps to REAPER_UNAVAILABLE (degraded mode) and never dials', async () => {
    disposition('failed')
    const l = link()
    await expect(l.ensureAndHello()).resolves.toBe(false)
    expect(l.isUp()).toBe(false)
    expect(l.lastError()?.code).toBe('REAPER_UNAVAILABLE')
    expect(sp.dialBackend).not.toHaveBeenCalled()
  })

  it('failed with E_UDS_DIR_UNSAFE maps to REAPER_UNAVAILABLE carrying the code and the state dir', async () => {
    disposition('failed', { errorCode: 'E_UDS_DIR_UNSAFE', detail: 'socket dir is group-writable' })
    const l = link()
    expect(await l.ensureAndHello()).toBe(false)
    const err = must(l.lastError())
    expect(err.code).toBe('REAPER_UNAVAILABLE')
    expect((err.cause as { code?: string }).code).toBe('E_UDS_DIR_UNSAFE')
    expect(err.detail).toMatchObject({ port: PORT, path: STATE_DIR })
    expect(err.message).toMatch(/0700/)
  })

  it('an ensureBackend that throws maps to REAPER_UNAVAILABLE, never a rejection', async () => {
    sp.ensureBackend = vi.fn(async () => {
      throw new Error('EACCES: lock file')
    })
    const l = link()
    await expect(l.ensureAndHello()).resolves.toBe(false)
    expect(l.lastError()?.code).toBe('REAPER_UNAVAILABLE')
  })

  it('a hello that resolves -32001 (never connected within 2 s) closes the dial at once', async () => {
    backend.accepting = false
    const l = link()
    expect(await l.ensureAndHello()).toBe(false)
    expect(backend.dials).toHaveLength(1)
    expect(must(backend.dials[0]).closed).toBe(true)
    expect(l.isUp()).toBe(false)
    expect(l.lastError()?.message).toMatch(/did not accept a connection within 2000 ms/)
  })

  it('the spawn form is the one pinned by sp-reaper-load-proof', async () => {
    const l = link()
    await l.ensureAndHello()
    const opts = must(vi.mocked(sp.ensureBackend).mock.calls[0])[0] as Record<string, unknown>
    expect(opts['singletonKey']).toBe(reaperSingletonKey(PORT))
    expect(opts['command']).toBe('/usr/local/bin/node')
    const args = opts['args'] as string[]
    expect(args.slice(0, 3)).toEqual(['-e', REAPER_ENTRY_SCRIPT, '/pkg/dist/index.js'])
    expect(REAPER_ENTRY_SCRIPT).toBe('require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))')
    expect(JSON.parse(must(args[3]))).toMatchObject({ port: PORT, stateDir: STATE_DIR, idleTimeoutMs: 120_000, shutdownGraceMs: 30_000, orphanWindowMs: 30_000, scope: 'port-occupant' })
  })

  it('with no entryPath the link resolves the entry itself: an absolute path, or a typed REAPER_UNAVAILABLE (never a null entry)', async () => {
    const l = link({ entryPath: undefined })
    const up = await l.ensureAndHello()
    if (up) {
      const args = (must(vi.mocked(sp.ensureBackend).mock.calls[0])[0] as { args: string[] }).args
      expect(isAbsolute(must(args[2]))).toBe(true)
    } else {
      expect(sp.ensureBackend).not.toHaveBeenCalled()
      expect(l.lastError()?.code).toBe('REAPER_UNAVAILABLE')
    }
  })
})

describe('8468f7b1 [chrome-lifecycle.15] the held connection', () => {
  it('at most one live dial: concurrent and repeated ensures share one connection', async () => {
    const l = link()
    await Promise.all([l.ensureAndHello(), l.ensureAndHello(), l.ensureAndHello()])
    await l.ensureAndHello()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(1)
    expect(sp.dialBackend).toHaveBeenCalledTimes(1)
  })

  it('activity is fire-and-forget: a notification (no id) that never throws', async () => {
    const l = link()
    await l.ensureAndHello()
    expect(l.activity()).toBeUndefined()
    expect(must(backend.dials[0]).notified).toEqual([{ jsonrpc: '2.0', method: 'activity' }])
    backend.notifyThrows = true
    expect(() => l.activity()).not.toThrow()
    expect(logs.some((m) => m.startsWith('activity not sent'))).toBe(true)
  })

  it('activity on a down link is a silent no-op', () => {
    const l = link()
    expect(() => l.activity()).not.toThrow()
    expect(sp.dialBackend).not.toHaveBeenCalled()
  })

  it('reapIfIdle and status answer through the host; null while the link is down', async () => {
    const l = link()
    expect(await l.reapIfIdle()).toBeNull()
    expect(await l.status()).toBeNull()
    await l.ensureAndHello()
    world.pages = [{ id: 'P', url: 'https://example.com/' }]
    expect(await l.reapIfIdle()).toEqual({ action: 'keep', pinnedBy: 'page', reaped: false })
    expect(await l.status()).toMatchObject({ clients: 1, chromeUp: true, httpPages: 1 })
  })

  it('[resolve-findings.2] F129 a connection whose send rejects answers null instead of rejecting', async () => {
    const l = link()
    await l.ensureAndHello()
    must(backend.dials[0]).send = vi.fn(async () => { throw new Error('socket reset') })
    await expect(l.reapIfIdle()).resolves.toBeNull()
    await expect(l.status()).resolves.toBeNull()
    expect(logs.join('\n')).toMatch(/reapIfIdle not answered: socket reset/)
    expect(logs.join('\n')).toMatch(/status not answered: socket reset/)
  })

  it('release unregisters and closes the connection; the host registry is empty', async () => {
    const l = link()
    await l.ensureAndHello()
    await l.release()
    expect(must(backend.dials[0]).sent.map((r) => r.method)).toEqual(['hello', 'release'])
    expect(must(backend.dials[0]).closed).toBe(true)
    expect(must(backend.host).clients()).toEqual([])
    expect(l.isUp()).toBe(false)
    await expect(l.release()).resolves.toBeUndefined() // idempotent
  })

  it('a killed client (kill -9) is dropped by the host at once: its connection closes, no release is sent', async () => {
    const l = link()
    await l.ensureAndHello()
    const conn = must(backend.dials[0])
    conn.close() // the kernel closed the dead process's socket
    expect(conn.sent.map((r) => r.method)).toEqual(['hello'])
    expect(must(backend.host).clients()).toEqual([])
  })

  it('a backend that drops the connection is never re-dialed or re-ensured on disconnect', async () => {
    const l = link()
    await l.ensureAndHello()
    backend.retire()
    expect(l.isUp()).toBe(false)
    expect(must(backend.dials[0]).closed).toBe(true) // the link closed the dropped dial itself
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sp.ensureBackend).toHaveBeenCalledTimes(1)
    expect(sp.dialBackend).toHaveBeenCalledTimes(1)
    // A reconnect is a NEW dial after a fresh ensure, only when the manager asks.
    backend.host = worldHost()
    await l.ensureAndHello()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(2)
    expect(backend.live()).toHaveLength(1)
  })
})
