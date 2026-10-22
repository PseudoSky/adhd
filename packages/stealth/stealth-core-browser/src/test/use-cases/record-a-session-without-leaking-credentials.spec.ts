/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 * Exercises AC4 (recording sinks), PA4.3 (credential redaction) and PA5.4 (CAPTURE_SINK_FAILED).
 *
 * A developer keeps a replayable record of a logged-in page load for later debugging. Cookies and
 * authorization headers must be masked before anything reaches storage, and a sink that fails is a typed error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capture, cdp, recording } from '../../index.js'
import { articleListHtml, pageTraceFor, SITE_URL } from '../support/page-fixtures.js'
import { ChromeWorld } from './scenario-kit.js'

const world = new ChromeWorld(9406)
const SECRETS = { Cookie: 'sid=opaque-session-token', Authorization: 'Bearer opaque-bearer' }

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

describe('Scenario: record a logged-in page load for debugging without leaking credentials', () => {
  it('[tests-use-cases.2] the stored exchange masks credential headers and keeps the body', async () => {
    world.useCdp(pageTraceFor(articleListHtml, { requestHeaders: SECRETS, mimeType: 'text/html' }))
    const sink = new recording.MemoryRecordingSink()
    await capture.captureNetworkResponse(await wsUrl(), { urlPattern: /./, navigateUrl: SITE_URL, sink, redact: recording.redactHeaders() })
    const [record] = sink.records()
    expect(sink.isClosed).toBe(true)
    expect(record!.exchange.request.headers['Cookie']).toBe(recording.REDACTED)
    expect(record!.exchange.request.headers['Authorization']).toBe(recording.REDACTED)
    expect(record!.exchange.request.headers['Accept']).toBe('*/*')
    const stored = JSON.stringify(sink.records())
    for (const secret of ['opaque-session-token', 'opaque-bearer']) expect(stored).not.toContain(secret)
    expect(stored).toContain('Release notes')
  })

  it('[tests-use-cases.2] the default redaction list covers cookies, set-cookie and authorization, and custom lists are honoured', () => {
    expect(recording.DEFAULT_REDACTED_HEADERS).toEqual(expect.arrayContaining(['cookie', 'set-cookie', 'authorization']))
    const exchange = {
      request: { url: SITE_URL, method: 'GET', headers: { 'X-Api-Key': 'k', Cookie: 'c' } },
      redirects: [],
    } as unknown as Parameters<ReturnType<typeof recording.redactHeaders>>[0]
    const masked = recording.redactHeaders(['x-api-key'])(exchange)
    expect(masked.request.headers).toEqual({ 'X-Api-Key': recording.REDACTED, Cookie: 'c' })
  })

  it('[tests-use-cases.4] writing to a closed sink is a typed CAPTURE_SINK_FAILED', () => {
    const sink = new recording.MemoryRecordingSink()
    sink.close()
    const envelope = { seq: 1 } as unknown as Parameters<typeof sink.write>[0]
    expect(() => sink.write(envelope)).toThrowError(expect.objectContaining({ code: 'CAPTURE_SINK_FAILED' }) as Error)
  })
})
