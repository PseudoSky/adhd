/**
 * Header redaction at the persistence boundary.
 * Ticket 8468f7b1 AC capture-upgrade.16 · [capture-upgrade.16]
 * Real use: recordings persisted or streamed out of the process must not carry
 * credentials, while the in-memory exchanges stay raw for replay.
 */
import { describe, expect, it } from 'vitest'
import { MemoryRecordingSink } from '../../../lib/recording/memory-sink.js'
import { NetworkRecorder } from '../../../lib/recording/network-recorder.js'
import { REDACTED, redactHeaders } from '../../../lib/recording/redact.js'
import type { RecordedExchange } from '../../../lib/recording/types.js'
import { connectSession, fixtureWith, useFixture } from './capture-kit.js'

function exchangeWithSecrets(): RecordedExchange {
  const secrets = { Cookie: 'sid=1', AUTHORIZATION: 'Bearer t', 'proxy-authorization': 'Basic x', 'x-keep': 'visible' }
  return {
    requestId: 'R',
    url: 'https://site.test/',
    request: { method: 'GET', url: 'https://site.test/', headers: { ...secrets }, startedAt: 1 },
    response: { status: 200, headers: { 'Set-Cookie': 'a=1', 'set-cookie': 'b=2', 'content-type': 'text/html' } },
    redirects: [
      {
        request: { method: 'GET', url: 'https://site.test/old', headers: { cookie: 'hop=1', accept: '*/*' }, startedAt: 0 },
        response: { status: 302, headers: { 'SET-COOKIE': 'hop=2', location: '/' } },
      },
    ],
    wire: { requestExtraInfo: true, responseExtraInfo: true },
    state: 'finished',
  }
}

describe('8468f7b1 [capture-upgrade.16] redactHeaders()', () => {
  it('masks cookie, set-cookie, authorization and proxy-authorization case-insensitively in request, response and every redirect hop', () => {
    const before = exchangeWithSecrets()
    const out = redactHeaders()(before)
    expect(out.request.headers).toEqual({ Cookie: REDACTED, AUTHORIZATION: REDACTED, 'proxy-authorization': REDACTED, 'x-keep': 'visible' })
    expect(out.response?.headers).toEqual({ 'Set-Cookie': REDACTED, 'set-cookie': REDACTED, 'content-type': 'text/html' })
    expect(out.redirects[0]?.request.headers).toEqual({ cookie: REDACTED, accept: '*/*' })
    expect(out.redirects[0]?.response.headers).toEqual({ 'SET-COOKIE': REDACTED, location: '/' })
    // the input is never mutated
    expect(before.request.headers['Cookie']).toBe('sid=1')
    expect(before.redirects[0]?.response.headers['SET-COOKIE']).toBe('hop=2')
  })

  it('accepts a custom name list', () => {
    const out = redactHeaders(['x-keep'])(exchangeWithSecrets())
    expect(out.request.headers['x-keep']).toBe(REDACTED)
    expect(out.request.headers['Cookie']).toBe('sid=1')
  })

  it('an exchange without a response is redacted without inventing one', () => {
    const ex = exchangeWithSecrets()
    delete ex.response
    expect(redactHeaders()(ex).response).toBeUndefined()
  })
})

describe('8468f7b1 [capture-upgrade.16] sink and onExchange get redacted data; memory stays raw (extrainfo-before-main)', () => {
  const rig = useFixture('extrainfo-before-main')

  async function run(redact?: (e: RecordedExchange) => RecordedExchange): Promise<{ sink: MemoryRecordingSink; seen: RecordedExchange[]; recorder: NetworkRecorder }> {
    const session = await connectSession()
    const sink = new MemoryRecordingSink()
    const seen: RecordedExchange[] = []
    const recorder = new NetworkRecorder(session, { sink, redact, onExchange: (e) => seen.push(e), logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    rig.server.emitNow('Network.requestWillBeSentExtraInfo', { requestId: 'R1', headers: { Cookie: 'sid=abc' } })
    await recorder.settled()
    await recorder.flush()
    return { sink, seen, recorder }
  }

  it('the ExtraInfo-merged Cookie and Set-Cookie are masked for the sink and onExchange, raw in exchanges()', async () => {
    const { sink, seen, recorder } = await run(redactHeaders())
    const stored = sink.records()[0]?.exchange
    expect(stored?.request.headers['Cookie']).toBe(REDACTED)
    expect(stored?.response?.headers['set-cookie']).toBe(REDACTED)
    expect(seen[0]?.request.headers['Cookie']).toBe(REDACTED)
    expect(seen[0]?.response?.headers['set-cookie']).toBe(REDACTED)
    const raw = recorder.exchanges()[0]
    expect(raw?.request.headers['Cookie']).toBe('sid=abc')
    expect(raw?.response?.headers['set-cookie']).toBe('a=1')
  })

  it('without a redact option headers are intact (default identity)', async () => {
    const { sink, seen } = await run()
    expect(sink.records()[0]?.exchange.request.headers['Cookie']).toBe('sid=abc')
    expect(seen[0]?.response?.headers['set-cookie']).toBe('a=1')
  })
})

describe('8468f7b1 [capture-upgrade.16] redirect hop credentials are masked in the persisted record', () => {
  useFixture(() =>
    fixtureWith('redirect-301-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      const [first, second] = nav?.emit ?? []
      ;(first?.params['request'] as { headers: Record<string, string> }).headers['Cookie'] = 'hop=secret'
      ;(second?.params['redirectResponse'] as { headers: Record<string, string> }).headers['Set-Cookie'] = 'next=secret'
    }),
  )

  it('hop request Cookie and hop response Set-Cookie never reach the sink', async () => {
    const session = await connectSession()
    const sink = new MemoryRecordingSink()
    const recorder = new NetworkRecorder(session, { sink, redact: redactHeaders(), logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/old' })
    await recorder.settled()
    await recorder.close()
    const hop = sink.records()[0]?.exchange.redirects[0]
    expect(hop?.request.headers['Cookie']).toBe(REDACTED)
    expect(hop?.response.headers['Set-Cookie']).toBe(REDACTED)
    expect(hop?.response.headers['location']).toBe('https://site.test/new')
    expect(recorder.exchanges()[0]?.redirects[0]?.request.headers['Cookie']).toBe('hop=secret')
  })
})
