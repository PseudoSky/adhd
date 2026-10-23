/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 * Exercises AC4 (graceful capture outcomes), PA4.2 (ban detection) and PA5.4 (typed capture codes).
 *
 * A monitoring job loads a page, wants the real status and body, and must tell a healthy page from a CAPTCHA
 * wall or a rate limit and decide whether to retry; when the page never answers it needs a typed outcome.
 * guards: [tests-use-cases.2] a healthy page is captured with its real status and needs no retry
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capture, cdp } from '../../../src/index.js'
import type { BanRule } from '../../../src/lib/types.js'
import { articleListHtml, articleListTrace, captchaWallTrace, pageTraceFor, rateLimitedTrace, SITE_URL } from '../../helpers/page-fixtures.js'
import { ChromeWorld, refuseWebSocketOpen } from '../../helpers/use-cases/scenario-kit.js'

const world = new ChromeWorld(9405)
const RULES: BanRule[] = [
  { name: 'captcha-wall', signal: 'captcha', checkBody: /unusual traffic|are you a robot/i },
  { name: 'rate-limit', signal: 'rate_limited', checkStatus: [429] },
]
const RETRY = { maxAttempts: 3, baseDelayMs: 1000, onCaptcha: 'retry', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' } as const

beforeEach(() => {
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'about:blank')]
})
afterEach(() => world.dispose())

async function wsUrl(): Promise<string> {
  const [tab] = await cdp.listPageTargetsOnly(`127.0.0.1:${world.port}`)
  return tab!.webSocketDebuggerUrl!
}

describe('Scenario: capture a page load and spot a block before trusting the content', () => {
  it('[tests-use-cases.2] a healthy page is captured with its real status and needs no retry', async () => {
    world.useCdp(articleListTrace())
    const res = await capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL, timeoutMs: 2_000 })
    expect(res).toMatchObject({ status: 200, url: SITE_URL, method: 'GET' })
    expect(res.body).toBe(articleListHtml)
    expect(capture.checkBans(RULES, { url: res.url, status: res.status, body: res.body })).toBeNull()
    expect(capture.decideRetry({ outcome: 'success' }, 1, RETRY).shouldRetry).toBe(false)
  })

  it('[tests-use-cases.2] a CAPTCHA wall is recognised and a backoff retry is advised', async () => {
    world.useCdp(captchaWallTrace())
    const res = await capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL })
    const ban = capture.checkBans(RULES, { url: res.url, status: res.status, body: res.body })
    expect(ban).toBe('captcha')
    const retry = capture.decideRetry({ outcome: ban! }, 1, RETRY)
    expect(retry.shouldRetry).toBe(true)
    expect(retry.delayMs).toBeGreaterThan(0)
    expect(capture.decideRetry({ outcome: ban! }, 3, RETRY).shouldRetry).toBe(false)
  })

  it('[tests-use-cases.2] a 429 is a rate limit', async () => {
    world.useCdp(rateLimitedTrace())
    const res = await capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL })
    expect(res.status).toBe(429)
    expect(capture.checkBans(RULES, { url: res.url, status: res.status, body: res.body })).toBe('rate_limited')
  })

  it('[tests-use-cases.4] with ban rules in the capture options a wall is a typed CAPTURE_BAN_DETECTED', async () => {
    world.useCdp(captchaWallTrace())
    await expect(capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL, banRules: RULES })).rejects.toMatchObject({
      code: 'CAPTURE_BAN_DETECTED',
      detail: { signal: 'captcha', status: 200 },
    })
  })

  it('[tests-use-cases.4] a page that never makes the awaited request is a typed CAPTURE_NO_MATCH, not a hang', async () => {
    world.useCdp(pageTraceFor('<html></html>'))
    const err = await capture.captureNetworkResponse(await wsUrl(), { urlPattern: /never-requested/, navigateUrl: SITE_URL, timeoutMs: 300 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CAPTURE_NO_MATCH' })
  })

  it('[tests-use-cases.4] a navigation Chrome refuses is CAPTURE_NAVIGATE_FAILED', async () => {
    world.useCdp({ meta: { name: 'nav-refused', origin: 'synthetic-protocol-conformant' }, steps: [{ when: { method: 'Page.navigate' }, reply: { result: { frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' } } }] })
    await expect(capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: 'https://nope.invalid/', timeoutMs: 500 })).rejects.toMatchObject({ code: 'CAPTURE_NAVIGATE_FAILED' })
  })

  it('[tests-use-cases.4] a tab whose socket cannot be opened is CAPTURE_CONNECT_FAILED', async () => {
    const server = world.useCdp(articleListTrace())
    refuseWebSocketOpen()
    await expect(capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL })).rejects.toMatchObject({ code: 'CAPTURE_CONNECT_FAILED' })
    expect(server.received).toEqual([])
  })
})
