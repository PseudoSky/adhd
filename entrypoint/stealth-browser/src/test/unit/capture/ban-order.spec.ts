/**
 * Ban evaluation.
 * Ticket 8468f7b1 AC capture-upgrade.21 · [capture-upgrade.21]
 * Real use: banRules turn a captcha page or a throttled answer into a typed
 * CAPTURE_BAN_DETECTED. They look at the answer the agent would get (the
 * selected one), in rule order, with the real status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import * as bans from '../../../lib/capture/bans.js'
import { fixtureWith, optionsFor, track, useFixture, WS_URL } from './capture-kit.js'

vi.mock('../../../lib/capture/bans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/capture/bans.js')>()
  return { ...actual, checkBans: vi.fn(actual.checkBans) }
})

beforeEach(() => {
  vi.mocked(bans.checkBans).mockClear()
})

describe('8468f7b1 [capture-upgrade.21] no ban evaluation without rules', () => {
  useFixture('doc-200')

  it('banRules unset and banRules [] never call checkBans', async () => {
    await captureNetworkResponse(WS_URL, optionsFor('doc-200'))
    await captureNetworkResponse(WS_URL, optionsFor('doc-200', { banRules: [] }))
    expect(bans.checkBans).not.toHaveBeenCalled()
  })

  it('a non-empty list is evaluated exactly once with the selected response url, real status and decoded body', async () => {
    await captureNetworkResponse(WS_URL, optionsFor('doc-200', { banRules: [{ name: 'never', signal: 'banned', checkBody: /zzz/ }] }))
    expect(bans.checkBans).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bans.checkBans).mock.calls[0]?.[1]).toEqual({ url: 'https://site.test/home', status: 200, body: '<html><body>hello</body></html>' })
  })
})

describe('8468f7b1 [capture-upgrade.21] rule order, then the selected response only', () => {
  useFixture(() =>
    fixtureWith('two-tabs-parallel', (f) => {
      const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
      f.steps.splice(
        generic,
        1,
        { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { result: { body: 'CAPTCHA page but small', base64Encoded: false } } },
        { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: 'a perfectly fine and much larger document body', base64Encoded: false } } },
      )
    }),
  )

  it('a banned body in a response that was NOT selected does not trigger the ban', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { banRules: [{ name: 'c', signal: 'captcha', checkBody: /CAPTCHA/ }] }))
    expect(out.requestId).toBe('B1')
  })

  it('rules are checked in list order: the first matching rule decides the signal', async () => {
    const both = [
      { name: 'body', signal: 'captcha' as const, checkBody: /fine/ },
      { name: 'url', signal: 'banned' as const, checkUrl: /\/b$/ },
    ]
    await expect(captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { banRules: both }))).rejects.toMatchObject({
      code: 'CAPTURE_BAN_DETECTED',
      detail: { signal: 'captcha' },
    })
    await expect(captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { banRules: [...both].reverse() }))).rejects.toMatchObject({
      code: 'CAPTURE_BAN_DETECTED',
      detail: { signal: 'banned' },
    })
  })
})

describe('8468f7b1 [capture-upgrade.21] a ban fires after a timeout-with-bodies success', () => {
  useFixture('doc-200')

  it('the timeout ends the capture with a body, and the body is then judged', async () => {
    vi.useFakeTimers()
    const t = track(
      captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 5_000, timeoutMs: 500, banRules: [{ name: 'hello', signal: 'login_required', checkBody: /hello/ }] })),
    )
    const assertion = expect(t.value()).rejects.toMatchObject({ code: 'CAPTURE_BAN_DETECTED', detail: { signal: 'login_required' } })
    await vi.advanceTimersByTimeAsync(500)
    await assertion
  })
})

describe('8468f7b1 [capture-upgrade.21] a status rule fires only on the real status', () => {
  const rig429 = useFixture('rate-limit-429')

  it('[429] fires on the 429 page; [200] does not (the old hard-coded status would have fired it)', async () => {
    await expect(captureNetworkResponse(WS_URL, optionsFor('rate-limit-429', { banRules: [{ name: 'r', signal: 'rate_limited', checkStatus: [429] }] }))).rejects.toMatchObject({
      code: 'CAPTURE_BAN_DETECTED',
    })
    const out = await captureNetworkResponse(WS_URL, optionsFor('rate-limit-429', { banRules: [{ name: 'ok', signal: 'banned', checkStatus: [200] }] }))
    expect(out.status).toBe(429)
    void rig429
  })
})
