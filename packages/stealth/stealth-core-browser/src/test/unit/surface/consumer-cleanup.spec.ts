/**
 * Consumer cleanup of isolated pages: the context is disposed in a finally
 * unless the caller keeps the page (keepPage or a human-in-the-loop window),
 * and a context whose page session never connected does not leak.
 * Ticket 8468f7b1 · [tests-unit-surface.6] · [fs-195] [fs-196] [fs-197]
 *
 * The CDP target factory and the page session are mocked: no socket, no Chrome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  disposeContext: vi.fn(),
  closePage: vi.fn(),
  connectFails: false,
}))

vi.mock('../../../lib/cdp/targets.js', () => ({
  createIsolatedPageTarget: vi.fn(async () => ({
    targetId: 'T1',
    browserContextId: 'ctx-1',
    pageWsUrl: 'ws://fake/devtools/page/T1',
    reveal: vi.fn(async () => undefined),
    dispose: world.disposeContext,
  })),
}))
vi.mock('../../../lib/cdp/session.js', () => ({
  CdpSession: class {
    async connect(): Promise<void> {
      if (world.connectFails) throw new Error('socket closed before open')
    }
    close(): void {
      world.closePage()
    }
  },
}))

import { lifecycle } from '../../../index.js'

const HOST = '127.0.0.1:9333'

beforeEach(() => {
  vi.clearAllMocks()
  world.connectFails = false
  world.disposeContext.mockResolvedValue(undefined)
})

describe('isolated page cleanup', () => {
  it('[fs-195] disposes the isolated context in a finally', async () => {
    await expect(lifecycle.withIsolatedPage(HOST, undefined, async () => 'done')).resolves.toBe('done')
    expect(world.disposeContext).toHaveBeenCalledOnce()
    expect(world.closePage).toHaveBeenCalledOnce()
    await expect(
      lifecycle.withIsolatedPage(HOST, undefined, async () => {
        throw new Error('capture blew up')
      }),
    ).rejects.toThrow('capture blew up')
    expect(world.disposeContext).toHaveBeenCalledTimes(2)
  })

  it('[fs-196] keepPage and hitl leave the context open', async () => {
    // a caller that keeps the page (keepPage, or a human solving a captcha) uses openIsolatedPage
    // and disposes later itself: opening never disposes
    const page = await lifecycle.openIsolatedPage(HOST)
    expect(world.disposeContext).not.toHaveBeenCalled()
    expect(world.closePage).not.toHaveBeenCalled()
    await page.dispose()
    await page.dispose() // idempotent
    expect(world.disposeContext).toHaveBeenCalledOnce()
  })

  it('[fs-197] the outer catch disposes a leaked context', async () => {
    world.connectFails = true
    await expect(lifecycle.openIsolatedPage(HOST)).rejects.toThrow()
    expect(world.closePage).toHaveBeenCalledOnce()
    expect(world.disposeContext).toHaveBeenCalledOnce()
  })
})
