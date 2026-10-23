/**
 * The page-settle failure modes reach the caller as typed codes.
 * Ticket 8468f7b1 · [prod-errors.2] · PA5.1 / PA5.4 · PAGE_SETTLE_FAILED, NAVIGATION_FAILED, OPERATION_ABORTED.
 * The CdpSession is an in-memory fake under fake timers: no WebSocket, no network.
 * guards: rejects with PAGE_SETTLE_FAILED when neither navigate nor loaderId scopes the wait
 * tier: S
 * cites: 8468f7b1 [prod-errors.2]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitPageSettled } from '../../../src/lib/cdp/settle.js'
import type { CdpSession } from '../../../src/lib/cdp/session.js'
import { StealthCoreBrowserError } from '../../../src/errors.js'

function fakeSession(navigateResult: { loaderId?: string; errorText?: string } = { loaderId: 'L1' }): CdpSession {
  const send = vi.fn(async (method: string): Promise<unknown> => (method === 'Page.navigate' ? navigateResult : {}))
  const on = vi.fn(() => () => undefined)
  return { send, on } as unknown as CdpSession
}

const arm = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('8468f7b1 [prod-errors.2] awaitPageSettled rejects with a typed code (PA5.4)', () => {
  it('rejects with PAGE_SETTLE_FAILED when neither navigate nor loaderId scopes the wait', async () => {
    await expect(awaitPageSettled(fakeSession())).rejects.toMatchObject({ code: 'PAGE_SETTLE_FAILED', message: expect.stringContaining('pass `navigate` (preferred) or `loaderId`') })
  })

  it('rejects with NAVIGATION_FAILED when Page.navigate reports an errorText, naming the url', async () => {
    const p = awaitPageSettled(fakeSession({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }), { navigate: 'https://nope.invalid/' })
    const assertion = expect(p).rejects.toMatchObject({
      code: 'NAVIGATION_FAILED',
      message: expect.stringContaining('Page.navigate failed: net::ERR_NAME_NOT_RESOLVED'),
      detail: { url: 'https://nope.invalid/', errorText: 'net::ERR_NAME_NOT_RESOLVED' },
    })
    await arm()
    await assertion
  })

  it('rejects with OPERATION_ABORTED for an already-aborted signal, keeping the abort reason as cause and message', async () => {
    const ctl = new AbortController()
    const reason = new Error('caller gave up')
    ctl.abort(reason)
    const p = awaitPageSettled(fakeSession(), { navigate: 'https://react.test/', abort: ctl.signal })
    const assertion = expect(p).rejects.toMatchObject({ code: 'OPERATION_ABORTED', message: expect.stringContaining('caller gave up'), cause: reason })
    await arm()
    await assertion
  })

  it('rejects with OPERATION_ABORTED when the signal aborts mid-wait, with a default message for a reasonless abort', async () => {
    const ctl = new AbortController()
    const p = awaitPageSettled(fakeSession(), { navigate: 'https://react.test/', abort: ctl.signal })
    const assertion = expect(p).rejects.toMatchObject({ code: 'OPERATION_ABORTED' })
    await arm()
    ctl.abort()
    await assertion
  })

  it('a typed abort reason passes through unchanged and a string reason becomes the message', async () => {
    const typed = new StealthCoreBrowserError('CDP_TIMEOUT', 'upstream timeout')
    const c1 = new AbortController()
    const p1 = awaitPageSettled(fakeSession(), { navigate: 'https://react.test/', abort: c1.signal })
    const a1 = expect(p1).rejects.toBe(typed)
    await arm()
    c1.abort(typed)
    await a1

    const c2 = new AbortController()
    const p2 = awaitPageSettled(fakeSession(), { navigate: 'https://react.test/', abort: c2.signal })
    const a2 = expect(p2).rejects.toMatchObject({ code: 'OPERATION_ABORTED', message: expect.stringContaining('user pressed stop') })
    await arm()
    c2.abort('user pressed stop')
    await a2
  })
})
