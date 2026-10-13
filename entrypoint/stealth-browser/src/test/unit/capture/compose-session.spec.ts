/**
 * The recorder shares a session with other subscribers.
 * Ticket 8468f7b1 AC capture-upgrade.2 · [capture-upgrade.2]
 * Real use: an agent already listens to Network.loadingFinished on its session
 * (page settling); attaching a recorder must not displace that listener, and
 * detaching the recorder must leave the session and the other listener alone.
 */
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '../../../lib/recording/network-recorder.js'
import { connectSession, useFixture } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.2] recorder composes with other subscribers', () => {
  const rig = useFixture('doc-200')

  it('a pre-existing Network.loadingFinished subscriber still fires; stop() removes only the recorder handlers and never closes the session', async () => {
    const session = await connectSession()
    let other = 0
    session.on('Network.loadingFinished', () => {
      other += 1
    })
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()

    expect(other).toBe(1)
    expect(recorder.exchanges()).toHaveLength(1)
    expect(recorder.exchanges()[0]?.state).toBe('finished')

    recorder.stop()
    rig.server.emitNow('Network.requestWillBeSent', {
      requestId: 'LATE',
      request: { url: 'https://site.test/late', method: 'GET', headers: {} },
      timestamp: 101,
    })
    rig.server.emitNow('Network.loadingFinished', { requestId: 'LATE', timestamp: 101.1 })

    expect(other).toBe(2) // the other subscriber is untouched
    expect(recorder.exchanges()).toHaveLength(1) // the recorder no longer folds events
    expect(session.connected).toBe(true) // stop() never closes the session
    expect(rig.server.openCount()).toBe(1)
  })

  it('start() is idempotent: a second start does not double-subscribe', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    expect(recorder.exchanges()).toHaveLength(1)
    expect(rig.server.received.filter((r) => r.method === 'Network.getResponseBody')).toHaveLength(1)
  })
})
