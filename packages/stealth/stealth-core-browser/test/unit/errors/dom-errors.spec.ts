/**
 * The DOM walk reaches SELECTOR_TIMEOUT as a typed code when the result selector never appears.
 * Ticket 8468f7b1 · [prod-errors.2] · PA5.1 / PA5.4 · SELECTOR_TIMEOUT.
 * The session is an in-memory fake under fake timers.
 * guards: rejects with SELECTOR_TIMEOUT naming the selector and the last error when the selector never appears
 * tier: S
 * cites: 8468f7b1 [prod-errors.2]
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { walkDomTree } from '../../../src/lib/capture/dom.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('8468f7b1 [prod-errors.2] walkDomTree rejects with a typed code (PA5.4)', () => {
  it('rejects with SELECTOR_TIMEOUT naming the selector and the last error when the selector never appears', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, nodeType: 9, nodeName: '#document' } }
      if (method === 'DOM.querySelector') throw new Error('selector failed')
      return {}
    })
    const p = walkDomTree({ send } as never, { navigateUrl: 'https://search.test/?q=a', waitFor: '#res', timeoutMs: 2_000 }, {})
    const assertion = expect(p).rejects.toMatchObject({
      code: 'SELECTOR_TIMEOUT',
      message: expect.stringContaining('Timed out waiting for "#res" (2000ms). Last error: selector failed'),
      detail: { selector: '#res', timeoutMs: 2_000 },
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })
})
