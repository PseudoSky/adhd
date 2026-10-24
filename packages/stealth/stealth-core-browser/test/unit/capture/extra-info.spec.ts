/**
 * ExtraInfo merge.
 * Ticket 8468f7b1 AC capture-upgrade.5 · [capture-upgrade.5]
 * Real use: Chrome reports the cookies it really sent/received in separate
 * ExtraInfo events that can land before or after the main event. The record
 * must be identical either way, with the ExtraInfo values winning.
 * guards: extrainfo-before-main and extrainfo-after-main give the same exchange (extra wins, set-cookie merged)
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.5]
 */
import { describe, expect, it } from 'vitest'
import { EXTRA_INFO_BUFFER_MAX, EXTRA_INFO_BUFFER_TTL_MS, NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import type { RecordedExchange } from '../../../src/lib/recording/types.js'
import { connectSession, flushMicrotasks, useFixture } from '../../helpers/capture/capture-kit.js'
import { FakeCdpServer, loadFixture } from '../../helpers/fake-cdp.js'
import { afterEach, beforeEach, vi } from 'vitest'

async function record(fixture: string): Promise<RecordedExchange> {
  const session = await connectSession()
  const recorder = new NetworkRecorder(session, { logger: () => undefined })
  await recorder.start()
  await session.send('Page.navigate', { url: 'https://site.test/home' })
  await recorder.settled()
  const ex = recorder.exchanges()[0]
  if (!ex) throw new Error(`no exchange recorded for ${fixture}`)
  return ex
}

describe('8468f7b1 [capture-upgrade.5] both orders merge identically', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('extrainfo-before-main and extrainfo-after-main give the same exchange (extra wins, set-cookie merged)', async () => {
    const results: RecordedExchange[] = []
    for (const name of ['extrainfo-before-main', 'extrainfo-after-main']) {
      restore = new FakeCdpServer(loadFixture(name)).install()
      results.push(await record(name))
      restore()
    }
    const [before, after] = results
    expect(before?.response?.headers).toEqual({ 'content-type': 'text/html', 'set-cookie': 'a=1' })
    expect(after?.response?.headers).toEqual(before?.response?.headers)
    expect(after?.response).toEqual(before?.response)
    expect(after?.wire).toEqual({ requestExtraInfo: false, responseExtraInfo: true })
    expect(before?.wire).toEqual(after?.wire)
  })
})

describe('8468f7b1 [capture-upgrade.5] request ExtraInfo: extra wins, wire.requestExtraInfo is set', () => {
  const rig = useFixture('extrainfo-before-main')

  it('merges Cookie and sec-ch-ua over the main request headers case-insensitively', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    rig.server.emitNow('Network.requestWillBeSentExtraInfo', {
      requestId: 'R1',
      headers: { cookie: 'sid=abc', 'sec-ch-ua': '"Chrome";v="126"', accept: 'text/html' },
    })
    await recorder.settled()
    const ex = recorder.exchanges()[0]
    expect(ex?.wire.requestExtraInfo).toBe(true)
    expect(ex?.request.headers).toEqual({ cookie: 'sid=abc', 'sec-ch-ua': '"Chrome";v="126"', accept: 'text/html' }) // "Accept" replaced, not duplicated
  })

  it('request ExtraInfo that arrives BEFORE the main event is buffered and applied identically', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    rig.server.emitNow('Network.requestWillBeSentExtraInfo', { requestId: 'EARLY', headers: { cookie: 'k=v' } })
    rig.server.emitNow('Network.requestWillBeSent', {
      requestId: 'EARLY',
      request: { url: 'https://site.test/early', method: 'GET', headers: { Accept: '*/*' } },
      timestamp: 1,
    })
    const ex = recorder.exchanges()[0]
    expect(ex?.request.headers).toEqual({ Accept: '*/*', cookie: 'k=v' })
    expect(ex?.wire.requestExtraInfo).toBe(true)
  })
})

describe('8468f7b1 [capture-upgrade.5] the orphan buffer is bounded (1000 entries, 30 s TTL)', () => {
  const rig = useFixture('extrainfo-before-main')
  beforeEach(() => vi.useFakeTimers())

  async function orphanRig(): Promise<NetworkRecorder> {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    return recorder
  }
  const requestFor = (id: string): Record<string, unknown> => ({
    requestId: id,
    request: { url: `https://site.test/${id}`, method: 'GET', headers: {} },
    timestamp: 1,
  })

  it('the 1001st orphan evicts the oldest: id 0 loses its cookie, id 1 keeps it', async () => {
    expect(EXTRA_INFO_BUFFER_MAX).toBe(1000)
    const recorder = await orphanRig()
    for (let i = 0; i <= 1000; i += 1) {
      rig.server.emitNow('Network.requestWillBeSentExtraInfo', { requestId: `o${i}`, headers: { cookie: `c${i}` } })
    }
    rig.server.emitNow('Network.requestWillBeSent', requestFor('o0'))
    rig.server.emitNow('Network.requestWillBeSent', requestFor('o1'))
    rig.server.emitNow('Network.requestWillBeSent', requestFor('o1000'))
    const byId = new Map(recorder.exchanges().map((e) => [e.requestId, e]))
    expect(byId.get('o0')?.request.headers).toEqual({}) // evicted
    expect(byId.get('o1')?.request.headers).toEqual({ cookie: 'c1' })
    expect(byId.get('o1000')?.request.headers).toEqual({ cookie: 'c1000' })
  })

  it('an orphan older than 30 s is dropped; one inside the TTL is applied', async () => {
    expect(EXTRA_INFO_BUFFER_TTL_MS).toBe(30_000)
    const recorder = await orphanRig()
    rig.server.emitNow('Network.requestWillBeSentExtraInfo', { requestId: 'old', headers: { cookie: 'stale' } })
    await vi.advanceTimersByTimeAsync(15_000)
    rig.server.emitNow('Network.requestWillBeSentExtraInfo', { requestId: 'fresh', headers: { cookie: 'ok' } })
    await vi.advanceTimersByTimeAsync(15_001) // old is 30_001 ms old, fresh is 15_001
    rig.server.emitNow('Network.requestWillBeSent', requestFor('old'))
    rig.server.emitNow('Network.requestWillBeSent', requestFor('fresh'))
    const byId = new Map(recorder.exchanges().map((e) => [e.requestId, e]))
    expect(byId.get('old')?.request.headers).toEqual({})
    expect(byId.get('fresh')?.request.headers).toEqual({ cookie: 'ok' })
    await flushMicrotasks()
  })
})
