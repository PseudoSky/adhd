/**
 * ExtraInfo status override and failed exchanges.
 * Ticket 8468f7b1 AC capture-upgrade.6 · [capture-upgrade.6]
 * Real use: a revalidated asset reports 200 in responseReceived but 304 on the
 * wire; a CORS-blocked call has no response event at all. Both must be
 * recorded truthfully, and a failure must be KEPT, not discarded.
 */
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import { NetworkRecorder } from '../../../lib/recording/network-recorder.js'
import { connectSession, optionsFor, useFixture, WS_URL } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.6] cached-304: ExtraInfo statusCode overrides status', () => {
  useFixture('cached-304')
  it('captureNetworkResponse reports 304 although responseReceived said 200', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('cached-304'))
    expect(out.status).toBe(304)
    expect(out.body).toBe('console.log(1)')
    expect(out.exchange.wire.responseExtraInfo).toBe(true)
  })
})

describe('8468f7b1 [capture-upgrade.6] cors-failure: status from ExtraInfo, exchange kept as failed', () => {
  useFixture('cors-failure')
  it('yields state failed, the ExtraInfo status and failure.errorText', async () => {
    const session = await connectSession()
    const recorder = new NetworkRecorder(session, { logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/api/x' })
    await recorder.settled()
    const ex = recorder.exchanges()[0]
    expect(ex).toBeDefined()
    expect(ex?.state).toBe('failed')
    expect(ex?.response?.status).toBe(403)
    expect(ex?.failure?.errorText).toBe('net::ERR_FAILED')
    expect(ex?.failure?.corsErrorStatus).toEqual({ corsError: 'PreflightMissingAllowOriginHeader', failedParameter: '' })
    expect(ex?.failure?.canceled).toBeUndefined()
    expect(ex?.response?.body).toBeUndefined()
  })
})
