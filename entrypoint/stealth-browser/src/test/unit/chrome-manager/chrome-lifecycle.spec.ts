/**
 * The five idle-shutdown deferral scenarios of the scratch chrome-lifecycle
 * test (port-fixes), re-proven on the connection-based mechanism: every
 * ChromeManager holds one connection to the reaper host of its port; the host
 * keeps the registry of connected clients and their last `activity`. No shared
 * activity file exists anywhere.
 * Ticket 8468f7b1 · [port-fixes.5] [port-fixes.8] [chrome-lifecycle.5] [chrome-lifecycle.6]
 *
 * The invariant under test (regression guard for the mutual-deferral livelock):
 * a process that REFUSES to close Chrome because a sibling is active re-arms its
 * own idle timer WITHOUT advertising activity; only genuine use (`bump()`)
 * stamps it. Otherwise every idle process keeps every other one alive forever.
 *
 *   1. deferral to an active sibling does not stamp the deferrer (livelock guard)
 *   2. genuine activity (bump) still stamps, alongside the sibling
 *   3. a STALE sibling does not hold Chrome alive, and only the configured CDP port is probed
 *   4. no sibling at all: shutdown proceeds
 *   5. a DEAD sibling (killed, its connection closed) is ignored
 *
 * Simulated machine (../lifecycle/manager-world): fake clock, scripted Chrome on
 * port 9333, the real reaper host behind a FakeReaperLink, MemFs for every
 * file. No socket, no process, and port 9222 is never contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../lifecycle/manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('../lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('../lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { ensureChromeRunning } from '../../../lib/cdp/browser.js'
import { isChromeReachable } from '../../../lib/cdp/targets.js'
import { client, makeHub } from '../lifecycle/manager-clients.js'
import { HOST, IDLE, PORT, resetSp, resetWorld, STATE_DIR, world } from '../lifecycle/manager-world.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  vi.mocked(isChromeReachable).mockClear()
  vi.mocked(ensureChromeRunning).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function pair() {
  const hub = makeHub()
  const me = client(hub, 11)
  const sibling = client(hub, 22)
  await me.manager.ready()
  await sibling.manager.ready()
  const stampOf = (pid: number) => hub.host!.clients().find((c) => c.pid === pid)?.lastActivityAt ?? null
  return { hub, me, sibling, stampOf }
}

describe('8468f7b1 [port-fixes.5] [chrome-lifecycle.6] ChromeManager idle-shutdown deferral (livelock guard)', () => {
  it('1. deferral to an active sibling does not stamp the deferrer (livelock guard)', async () => {
    const { me, sibling, stampOf } = await pair()
    await vi.advanceTimersByTimeAsync(IDLE / 2)
    sibling.manager.bump()
    const mine = stampOf(11)
    const sent = me.link.activityCalls
    await me.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(true)
    expect(stampOf(11)).toBe(mine)
    expect(me.link.activityCalls).toBe(sent)
  })

  it('2. genuine activity (bump) still stamps, alongside the sibling', async () => {
    const { me, sibling, stampOf } = await pair()
    await vi.advanceTimersByTimeAsync(100)
    sibling.manager.bump()
    await vi.advanceTimersByTimeAsync(100)
    me.manager.bump()
    expect(stampOf(11)).toBe(Date.now())
    expect(stampOf(22)).toBe(Date.now() - 100)
  })

  it('3. a STALE sibling does not hold Chrome alive: shutdown proceeds and only the configured CDP port is probed', async () => {
    const { me, sibling } = await pair()
    await sibling.manager.shutdownIfIdle() // the sibling defers to me once, then goes quiet (its timer is cancelled)
    expect(world.chromeUp).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE + 1) // ...past the window
    await me.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
    // Every CDP touch was the configured (simulated) port, never the shared 9222.
    expect(vi.mocked(ensureChromeRunning).mock.calls.map((c) => c[0])).toEqual([{ port: PORT }, { port: PORT }])
    for (const [host] of vi.mocked(isChromeReachable).mock.calls) expect(host).toBe(HOST)
  })

  it('4. no sibling at all: shutdown proceeds', async () => {
    const me = client(makeHub(), 11)
    await me.manager.ready()
    await me.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
    expect(me.manager.isReady).toBe(false)
  })

  it('5. a DEAD sibling is ignored: a crashed sibling cannot block shutdown forever', async () => {
    const { hub, me, sibling } = await pair()
    sibling.manager.bump() // fresh activity...
    sibling.link.kill9() // ...then the sibling process is killed: its connection closes, no release
    expect(hub.host!.clients().map((c) => c.pid)).toEqual([11])
    await me.manager.shutdownIfIdle()
    expect(world.chromeUp).toBe(false)
  })

  it('never writes an activity file: the private state dir holds only the owner record and the breaker', async () => {
    const { me, sibling } = await pair()
    me.manager.bump()
    sibling.manager.bump()
    await me.manager.shutdownIfIdle()
    expect(world.fs.readdirSync('/tmp')).toEqual([])
    expect(world.fs.readdirSync(STATE_DIR).filter((f) => !/^chrome-\d+\.json$|^breaker-\d+\.json$/.test(f))).toEqual([])
  })
})
