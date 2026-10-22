/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 * Exercises AC5 (isolated-page cleanup) and PA5.4 (ISOLATED_CONTEXT_FAILED).
 *
 * A job needs a page that shares no cookies with the person's own tabs. It opens a page in a brand new
 * browser context, uses it, and whatever happens (success, a failing step, Chrome refusing the context) the
 * context is disposed and no socket is left open.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lifecycle } from '../../index.js'
import { loadFixture, type CdpFixture } from '../support/fake-cdp.js'
import { ChromeWorld } from './scenario-kit.js'

const world = new ChromeWorld(9411)

beforeEach(() => {
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'about:blank')]
})
afterEach(() => world.dispose())

function isolatedFixture(replace: Record<string, { error: { code: number; message: string } }> = {}): CdpFixture {
  const f = loadFixture('isolated-context-ok')
  f.steps = [
    { when: { method: 'Browser.getWindowForTarget' }, reply: { result: { windowId: 7 } } },
    { when: { method: 'Browser.setWindowBounds' } },
    ...f.steps.map((s) => (s.when.method in replace ? { ...s, reply: replace[s.when.method] } : s)),
  ]
  return f
}

const host = (): string => `127.0.0.1:${world.port}`

describe('Scenario: open an isolated page, use it and leave nothing behind', () => {
  it('[tests-use-cases.2] the page lives in its own new context and the context is disposed afterwards', async () => {
    const server = world.useCdp(isolatedFixture())
    const seen = await lifecycle.withIsolatedPage(host(), undefined, async (page) => {
      expect(page.page.connected).toBe(true)
      return { context: page.browserContextId, target: page.targetId }
    })
    expect(seen).toEqual({ context: 'CTX1', target: 'T1' })
    const methods = server.received.map((r) => r.method)
    expect(methods).toContain('Target.createBrowserContext')
    expect(server.received.find((r) => r.method === 'Target.disposeBrowserContext')?.params).toEqual({ browserContextId: 'CTX1' })
    expect(methods).not.toContain('Runtime.evaluate')
  })

  it('[tests-use-cases.2] the context is still disposed when the work inside the page throws', async () => {
    const server = world.useCdp(isolatedFixture())
    await expect(lifecycle.withIsolatedPage(host(), undefined, async () => { throw new Error('work failed') })).rejects.toThrow('work failed')
    expect(server.received.filter((r) => r.method === 'Target.disposeBrowserContext')).toHaveLength(1)
  })

  it('[tests-use-cases.2] dispose is idempotent and never throws', async () => {
    const server = world.useCdp(isolatedFixture())
    const page = await lifecycle.openIsolatedPage(host())
    await page.dispose()
    await page.dispose()
    expect(page.page.connected).toBe(false)
    expect(server.received.filter((r) => r.method === 'Target.disposeBrowserContext')).toHaveLength(1)
  })

  it('[tests-use-cases.4] Chrome refusing to create the context is ISOLATED_CONTEXT_FAILED and no page is attempted', async () => {
    const server = world.useCdp(isolatedFixture({ 'Target.createBrowserContext': { error: { code: -32000, message: 'Failed to create context' } } }))
    const err = await lifecycle.openIsolatedPage(host()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'ISOLATED_CONTEXT_FAILED', detail: { step: 'createIsolatedPageTarget' } })
    expect(err).toBeInstanceOf(lifecycle.LifecycleError)
    expect(server.received.map((r) => r.method)).not.toContain('Target.createTarget')
  })

  it('[tests-use-cases.4] a failure after the context exists still disposes it before the error surfaces', async () => {
    const server = world.useCdp(isolatedFixture({ 'Target.createTarget': { error: { code: -32000, message: 'Failed to create target' } } }))
    await expect(lifecycle.openIsolatedPage(host())).rejects.toMatchObject({ code: 'ISOLATED_CONTEXT_FAILED' })
    expect(server.received.filter((r) => r.method === 'Target.disposeBrowserContext').map((r) => r.params)).toEqual([{ browserContextId: 'CTX1' }])
  })
})
