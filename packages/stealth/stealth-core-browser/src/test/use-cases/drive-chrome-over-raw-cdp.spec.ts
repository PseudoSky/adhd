/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 * Exercises AC1 (typed CDP session), PA5.4 (stable error codes) and PA8.2 (no Runtime.evaluate anywhere).
 *
 * A developer drives the controlled Chrome with raw protocol commands and needs every way the conversation
 * can go wrong (a hung Chrome, a Chrome that dies mid-command, a refused command, a dead endpoint) to arrive
 * as a typed error with a stable code instead of a hang.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError, cdp } from '../../index.js'
import type { FakeCdpServer } from '../support/fake-cdp.js'
import { ChromeWorld, refuseWebSocketOpen, installSilentWebSocket } from './scenario-kit.js'

const world = new ChromeWorld(9404)

beforeEach(() => {
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'https://docs.test/a')]
})
afterEach(() => {
  world.dispose()
  vi.useRealTimers()
})

describe('Scenario: drive a Chrome over raw CDP and survive every failure of the conversation', () => {
  it('[tests-use-cases.2] lists the tabs and exchanges commands with the page without ever evaluating script', async () => {
    const server: FakeCdpServer = world.useCdp({
      meta: { name: 'raw-conversation', origin: 'synthetic-protocol-conformant' },
      steps: [
        { when: { method: 'Page.enable' } },
        { when: { method: 'Page.getNavigationHistory' }, reply: { result: { currentIndex: 0, entries: [{ id: 1, url: 'https://docs.test/a' }] } } },
      ],
    })
    expect(await cdp.isChromeReachable(`127.0.0.1:${world.port}`)).toBe(true)
    expect((await cdp.getChromeInfo(`127.0.0.1:${world.port}`)).browserVersion).toBe('Chrome/150.0.1')
    const [tab] = await cdp.listPageTargetsOnly(`127.0.0.1:${world.port}`)
    const session = new cdp.CdpSession()
    await session.connect(tab!.webSocketDebuggerUrl!)
    expect(session.connected).toBe(true)
    const events: string[] = []
    session.on('Page.loadEventFired', (p) => events.push(String(p['timestamp'])))
    await session.send('Page.enable')
    const history = await session.send<{ currentIndex: number }>('Page.getNavigationHistory')
    server.emitNow('Page.loadEventFired', { timestamp: 7 })
    session.close()
    expect(history.currentIndex).toBe(0)
    expect(events).toEqual(['7'])
    expect(server.received.map((r) => r.method)).toEqual(['Page.enable', 'Page.getNavigationHistory'])
    expect(server.received.map((r) => r.method)).not.toContain('Runtime.evaluate')
  })

  it('[tests-use-cases.4] a refused command is CDP_REMOTE_ERROR carrying the protocol code', async () => {
    world.useCdp({
      meta: { name: 'refused', origin: 'synthetic-protocol-conformant' },
      steps: [{ when: { method: 'Page.navigate' }, reply: { error: { code: -32602, message: 'Invalid parameters' } } }],
    })
    const session = new cdp.CdpSession()
    await session.connect('ws://127.0.0.1:9404/devtools/page/T1')
    const err = await session.send('Page.navigate', { url: 'nonsense' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthCoreBrowserError)
    expect(err).toMatchObject({ code: 'CDP_REMOTE_ERROR', detail: { remoteCode: -32602 } })
    session.close()
  })

  it('[tests-use-cases.4] a command before connect is CDP_NOT_CONNECTED', async () => {
    await expect(new cdp.CdpSession().send('Page.enable')).rejects.toMatchObject({ code: 'CDP_NOT_CONNECTED' })
  })

  it('[tests-use-cases.4] a hung Chrome is CDP_TIMEOUT, not a hang', async () => {
    vi.useFakeTimers()
    const restore = installSilentWebSocket()
    try {
      const session = new cdp.CdpSession()
      await session.connect('ws://127.0.0.1:9404/devtools/page/T1')
      const pending = session.send('Page.enable', {}, 500).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(600)
      expect(await pending).toMatchObject({ code: 'CDP_TIMEOUT', detail: { method: 'Page.enable', timeoutMs: 500 } })
    } finally {
      restore()
    }
  })

  it('[tests-use-cases.4] a Chrome that dies mid-command is CDP_SESSION_CLOSED', async () => {
    const server = world.useCdp({ meta: { name: 'dies', origin: 'synthetic-protocol-conformant' }, steps: [{ when: { method: 'Page.enable' } }] })
    const session = new cdp.CdpSession()
    await session.connect('ws://127.0.0.1:9404/devtools/page/T1')
    const pending = session.send('Page.enable').catch((e: unknown) => e)
    server.closeFromServer()
    expect(await pending).toMatchObject({ code: 'CDP_SESSION_CLOSED' })
    expect(session.connected).toBe(false)
  })

  it('[tests-use-cases.4] a page socket that refuses to open is CDP_CONNECT_FAILED', async () => {
    const server = world.useCdp({ meta: { name: 'refuses', origin: 'synthetic-protocol-conformant' }, steps: [] })
    refuseWebSocketOpen()
    await expect(new cdp.CdpSession().connect('ws://127.0.0.1:9404/devtools/page/T1')).rejects.toMatchObject({ code: 'CDP_CONNECT_FAILED' })
    expect(server.openCount()).toBe(1)
  })

  it('[tests-use-cases.4] a dead endpoint is unreachable and its page listing is a typed CDP error', async () => {
    world.up = false
    expect(await cdp.isChromeReachable(`127.0.0.1:${world.port}`)).toBe(false)
    await expect(cdp.getChromeInfo(`127.0.0.1:${world.port}`)).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(world.requested.every((u) => new URL(u).port === '9404')).toBe(true)
  })
})
