/**
 * Request side of a recorded exchange.
 * Ticket 8468f7b1 AC capture-upgrade.3 · [capture-upgrade.3]
 * Real use: recording a JSON API call needs the request method, headers and
 * body, including bodies Chrome only announces with hasPostData.
 */
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '../../../lib/recording/network-recorder.js'
import { connectSession, fixtureWith, useFixture } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.3] request headers and postData (post-json-api)', () => {
  const rig = useFixture('post-json-api')

  it('records method, headers and the inline postData of the post-json-api exchange', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/api/search' })
    await recorder.settled()
    const ex = recorder.exchanges()[0]
    expect(ex?.request.method).toBe('POST')
    expect(ex?.request.headers).toEqual({ 'content-type': 'application/json' })
    expect(ex?.request.postData).toBe('{"q":"cats"}')
    expect(rig.server.received.map((r) => r.method)).not.toContain('Network.getRequestPostData')
  })
})

describe('8468f7b1 [capture-upgrade.3] hasPostData fetches the body with Network.getRequestPostData', () => {
  const announced = (): ReturnType<typeof fixtureWith> =>
    fixtureWith('post-json-api', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      const req = nav?.emit?.[0]?.params['request'] as Record<string, unknown>
      delete req['postData']
      f.steps.push({ when: { method: 'Network.getRequestPostData', params: { requestId: 'R1' } }, reply: { result: { postData: '{"q":"dogs"}' } } })
    })
  const rig = useFixture(announced)

  it('asks for the post data once and merges it before the exchange settles', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/api/search' })
    await recorder.settled()
    expect(recorder.exchanges()[0]?.request.postData).toBe('{"q":"dogs"}')
    expect(rig.server.received.filter((r) => r.method === 'Network.getRequestPostData')).toHaveLength(1)
  })

  it('a request that does not pass the filter never gets a post-data call', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined, filter: () => false })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/api/search' })
    await recorder.settled()
    expect(recorder.exchanges()).toHaveLength(0)
    expect(rig.server.received.map((r) => r.method)).not.toContain('Network.getRequestPostData')
    expect(rig.server.received.map((r) => r.method)).not.toContain('Network.getResponseBody')
  })
})

describe('8468f7b1 [capture-upgrade.3] a failing post-data fetch never throws', () => {
  const rig = useFixture(() =>
    fixtureWith('post-json-api', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      delete (nav?.emit?.[0]?.params['request'] as Record<string, unknown>)['postData']
      f.steps.push({ when: { method: 'Network.getRequestPostData' }, reply: { error: { code: -32000, message: 'No post data' } } })
    }),
  )

  it('leaves postData undefined and still finishes the exchange', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/api/search' })
    await recorder.settled()
    const ex = recorder.exchanges()[0]
    expect(ex?.request.postData).toBeUndefined()
    expect(ex?.request.hasPostData).toBe(true)
    expect(ex?.state).toBe('finished')
    expect(rig.server.unexpected).toEqual([])
  })
})
