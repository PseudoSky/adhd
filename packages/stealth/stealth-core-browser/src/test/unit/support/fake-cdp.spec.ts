/**
 * Harness spec for src/test/support/fake-cdp.ts.
 * Ticket 8468f7b1 AC cdp-test-harness.3 · [cdp-test-harness.1] [cdp-test-harness.3]
 * Real use: a CDP client opens a socket, enables domains, navigates and
 * correlates replies by id while Network events stream in; Chrome may die.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpSession } from '../../../lib/cdp/session.js'
import { FakeCdpServer, loadFixture, type CdpFixture } from '../../support/fake-cdp.js'

const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'cdp')
const URL_ = 'ws://127.0.0.1:1/devtools/page/X'

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  vi.useRealTimers()
})

function boot(fixture: CdpFixture | string, strict = true): FakeCdpServer {
  const server = new FakeCdpServer(typeof fixture === 'string' ? loadFixture(fixture) : fixture, { strict })
  restore = server.install()
  return server
}

async function connect(): Promise<CdpSession> {
  const s = new CdpSession()
  await s.connect(URL_)
  return s
}

describe('8468f7b1 [cdp-test-harness.3] HC1 id correlation', () => {
  it('HC1 answers each command by its own id, in any completion order, and records it', async () => {
    const server = boot('doc-200')
    const s = await connect()
    const [a, b, nav] = await Promise.all([
      s.send('Page.enable'),
      s.send('Network.enable'),
      s.send('Page.navigate', { url: 'https://site.test/home' }),
    ])
    expect(a).toEqual({})
    expect(b).toEqual({})
    expect(nav).toEqual({ frameId: 'F1', loaderId: 'L1' })
    expect(server.received.map((r) => [r.id, r.method])).toEqual([
      [1, 'Page.enable'],
      [2, 'Network.enable'],
      [3, 'Page.navigate'],
    ])
    expect(server.unexpected).toEqual([])
  })

  it('HC1 streams the fixture events after the reply and serves the response body', async () => {
    boot('doc-200')
    const s = await connect()
    const seen: string[] = []
    s.on('Network.responseReceived', (p) => seen.push(String((p['response'] as { status: number }).status)))
    const loaded = new Promise<void>((r) => s.on('Network.loadingFinished', () => r()))
    await s.send('Network.enable')
    await s.send('Page.navigate', { url: 'https://site.test/home' })
    await loaded
    expect(seen).toEqual(['200'])
    expect(await s.send('Network.getResponseBody', { requestId: 'R1' })).toEqual({
      body: '<html><body>hello</body></html>',
      base64Encoded: false,
    })
  })

  it('HC1 returns a CDP error reply as a rejected command (no-body-204)', async () => {
    boot('no-body-204')
    const s = await connect()
    await expect(s.send('Network.getResponseBody', { requestId: 'R1' })).rejects.toThrow(/No resource with given identifier/)
  })

  it('HC1 reuses the last matching step for a repeated command and counts every socket', async () => {
    const server = boot('two-tabs-parallel')
    const a = await connect()
    const b = await connect()
    await a.send('Network.enable')
    await b.send('Network.enable')
    expect(server.openCount()).toBe(2)
    expect(server.unexpected).toEqual([])
  })

  it('HC1 subset-matches params so the right step answers (isolated-context-ok)', async () => {
    boot('isolated-context-ok')
    const s = await connect()
    const { browserContextId } = await s.send<{ browserContextId: string }>('Target.createBrowserContext')
    const { targetId } = await s.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId })
    expect(targetId).toBe('T1')
    expect(await s.send('Target.closeTarget', { targetId })).toEqual({ success: true })
  })

  it('HC1 surfaces the target-missing failure on close (isolated-context-target-missing)', async () => {
    boot('isolated-context-target-missing')
    const s = await connect()
    await expect(s.send('Target.closeTarget', { targetId: 'gone' })).rejects.toThrow(/No target with given id/)
  })
})

describe('8468f7b1 [cdp-test-harness.3] HC2 strict unknown command', () => {
  it('HC2 answers an unknown command with CDP error -32601 and lists it in .unexpected', async () => {
    const server = boot('doc-200')
    const raw = new WebSocket(URL_)
    const frames: Array<{ id: number; error?: { code: number } }> = []
    raw.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))))
    await new Promise((r) => raw.addEventListener('open', r, { once: true }))
    raw.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '1' } }))
    await Promise.resolve()
    await Promise.resolve()
    expect(frames).toEqual([{ id: 7, error: { code: -32601, message: "'Runtime.evaluate' wasn't found" } }])
    expect(server.unexpected).toEqual(['Runtime.evaluate'])
  })

  it('HC2 non-strict mode still records the unknown command but answers with an empty result', async () => {
    const server = boot('doc-200', false)
    const s = await connect()
    expect(await s.send('Emulation.setFoo')).toEqual({})
    expect(server.unexpected).toEqual(['Emulation.setFoo'])
  })
})

describe('8468f7b1 [cdp-test-harness.3] HC3 fake-timer ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('HC3 delivers delayMs events in time order and ordered ties in fixture order', async () => {
    boot({
      meta: { name: 'timed', origin: 'synthetic-protocol-conformant' },
      steps: [
        {
          when: { method: 'Page.navigate' },
          emit: [
            { method: 'Network.loadingFinished', params: { requestId: 'late' }, delayMs: 300 },
            { method: 'Network.loadingFinished', params: { requestId: 'now' } },
            { method: 'Network.loadingFinished', params: { requestId: 'tieA' }, delayMs: 100 },
            { method: 'Network.loadingFinished', params: { requestId: 'tieB' }, delayMs: 100 },
          ],
        },
      ],
    })
    const s = await connect()
    const order: string[] = []
    s.on('Network.loadingFinished', (p) => order.push(String(p['requestId'])))
    await s.send('Page.navigate', { url: 'https://x.test' })
    expect(order).toEqual(['now'])
    await vi.advanceTimersByTimeAsync(99)
    expect(order).toEqual(['now'])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['now', 'tieA', 'tieB'])
    await vi.advanceTimersByTimeAsync(200)
    expect(order).toEqual(['now', 'tieA', 'tieB', 'late'])
  })

  it('HC3 emitNow pushes an event to every open socket immediately', async () => {
    const server = boot('doc-200')
    const a = await connect()
    const b = await connect()
    const got: string[] = []
    a.on('Page.frameNavigated', () => got.push('a'))
    b.on('Page.frameNavigated', () => got.push('b'))
    server.emitNow('Page.frameNavigated', { frame: { id: 'F1' } })
    expect(got).toEqual(['a', 'b'])
  })
})

/**
 * Network-domain field names copied from Chrome's browser_protocol.json
 * (no network fetch). Event param names; Request / Response object names.
 */
const NETWORK_EVENT_FIELDS: Record<string, string[]> = {
  'Network.requestWillBeSent': ['requestId', 'loaderId', 'documentURL', 'request', 'timestamp', 'wallTime', 'initiator', 'redirectHasExtraInfo', 'redirectResponse', 'type', 'frameId', 'hasUserGesture'],
  'Network.responseReceived': ['requestId', 'loaderId', 'timestamp', 'type', 'response', 'hasExtraInfo', 'frameId'],
  'Network.responseReceivedExtraInfo': ['requestId', 'blockedCookies', 'headers', 'resourceIPAddressSpace', 'statusCode', 'headersText', 'cookiePartitionKey', 'cookiePartitionKeyOpaque'],
  'Network.requestWillBeSentExtraInfo': ['requestId', 'associatedCookies', 'headers', 'connectTiming', 'clientSecurityState', 'siteHasCookieInOtherPartition'],
  'Network.loadingFinished': ['requestId', 'timestamp', 'encodedDataLength'],
  'Network.loadingFailed': ['requestId', 'timestamp', 'type', 'errorText', 'canceled', 'blockedReason', 'corsErrorStatus'],
}
const REQUEST_FIELDS = ['url', 'urlFragment', 'method', 'headers', 'postData', 'hasPostData', 'postDataEntries', 'mixedContentType', 'initialPriority', 'referrerPolicy', 'isLinkPreload', 'trustTokenParams', 'isSameSite']
const RESPONSE_FIELDS = ['url', 'status', 'statusText', 'headers', 'headersText', 'mimeType', 'charset', 'requestHeaders', 'requestHeadersText', 'connectionReused', 'connectionId', 'remoteIPAddress', 'remotePort', 'fromDiskCache', 'fromServiceWorker', 'fromPrefetchCache', 'encodedDataLength', 'timing', 'protocol', 'securityState']
const BODY_RESULT_FIELDS = ['body', 'base64Encoded']
const NAVIGATE_RESULT_FIELDS = ['frameId', 'loaderId', 'errorText']

describe('8468f7b1 [cdp-test-harness.1] HC4 Network-domain field-name allow-list', () => {
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.cdp.json')).map((f) => f.replace('.cdp.json', ''))

  it('HC4 covers exactly the fourteen required fixtures', () => {
    expect(names.sort()).toEqual(
      ['binary-base64', 'cached-304', 'cors-failure', 'doc-200', 'extrainfo-after-main', 'extrainfo-before-main', 'isolated-context-ok', 'isolated-context-target-missing', 'no-body-204', 'post-json-api', 'rate-limit-429', 'redirect-301-200', 'search-404', 'two-tabs-parallel'].sort(),
    )
  })

  it.each(names)('HC4 %s uses only protocol field names and an honest origin label', (name) => {
    const fx = loadFixture(name)
    expect(fx.meta.name).toBe(name)
    expect(['recorded', 'synthetic-protocol-conformant']).toContain(fx.meta.origin)
    for (const step of fx.steps) {
      for (const key of Object.keys(step.reply?.result ?? {})) {
        const resultFields: Record<string, string[]> = { 'Network.getResponseBody': BODY_RESULT_FIELDS, 'Page.navigate': NAVIGATE_RESULT_FIELDS }
        const allowed = resultFields[step.when.method]
        if (allowed) expect(allowed, `${name} ${step.when.method} result.${key}`).toContain(key)
      }
      for (const ev of step.emit ?? []) {
        if (!ev.method.startsWith('Network.')) continue
        const allowed = NETWORK_EVENT_FIELDS[ev.method]
        expect(allowed, `${name}: unknown Network event ${ev.method}`).toBeDefined()
        for (const key of Object.keys(ev.params)) expect(allowed, `${name} ${ev.method}.${key}`).toContain(key)
        const p = ev.params as Record<string, Record<string, unknown> | undefined>
        for (const key of Object.keys(p['request'] ?? {})) expect(REQUEST_FIELDS, `${name} request.${key}`).toContain(key)
        for (const o of [p['response'], p['redirectResponse']]) {
          for (const key of Object.keys(o ?? {})) expect(RESPONSE_FIELDS, `${name} response.${key}`).toContain(key)
        }
      }
    }
  })

  it('HC4 the scenario shapes the use-case suites rely on are present', () => {
    const events = (n: string) => loadFixture(n).steps.flatMap((s) => s.emit ?? [])
    expect(events('redirect-301-200').filter((e) => e.method === 'Network.requestWillBeSent').map((e) => 'redirectResponse' in e.params)).toEqual([false, true])
    expect(events('cached-304').map((e) => e.method)).toContain('Network.responseReceivedExtraInfo')
    expect(events('cors-failure').map((e) => e.method)).not.toContain('Network.responseReceived')
    expect(events('rate-limit-429').find((e) => e.method === 'Network.responseReceived')?.params).toMatchObject({ response: { status: 429, headers: { 'retry-after': '30' } } })
    const order = (n: string) => events(n).map((e) => e.method)
    expect(order('extrainfo-before-main').indexOf('Network.responseReceivedExtraInfo')).toBeLessThan(order('extrainfo-before-main').indexOf('Network.responseReceived'))
    expect(order('extrainfo-after-main').indexOf('Network.responseReceivedExtraInfo')).toBeGreaterThan(order('extrainfo-after-main').indexOf('Network.responseReceived'))
    expect(new Set(events('two-tabs-parallel').map((e) => e.params['requestId']))).toEqual(new Set(['A1', 'B1']))
  })
})

describe('8468f7b1 [cdp-test-harness.3] HC5 closeFromServer', () => {
  it('HC5 fires close on every open socket, rejects pending commands and disconnects the session', async () => {
    const server = boot({ meta: { name: 'silent', origin: 'synthetic-protocol-conformant' }, steps: [] }, false)
    const s = await connect()
    let closeCode: number | undefined
    // a second observer on the same wire proves the event reaches every listener
    const raw = new WebSocket(URL_)
    raw.addEventListener('close', (ev) => (closeCode = (ev as { code?: number }).code))
    await new Promise((r) => raw.addEventListener('open', r, { once: true }))
    expect(s.connected).toBe(true)
    server.closeFromServer(1006)
    expect(closeCode).toBe(1006)
    expect(s.connected).toBe(false)
    await expect(s.send('Page.enable')).rejects.toThrow(/not connected/)
  })

  it('HC5 a client-initiated close also fires close and later server pushes are dropped', async () => {
    const server = boot('doc-200')
    const raw = new WebSocket(URL_)
    await new Promise((r) => raw.addEventListener('open', r, { once: true }))
    const events: string[] = []
    raw.addEventListener('message', () => events.push('message'))
    const closed = new Promise<void>((r) => raw.addEventListener('close', () => r()))
    raw.close()
    await closed
    server.emitNow('Page.frameNavigated', {})
    expect(events).toEqual([])
  })
})
