/**
 * A failing sink never hurts the capture.
 * Ticket 8468f7b1 AC capture-upgrade.17 · [capture-upgrade.17]
 * Real use: the disk fills up halfway through a recording. Capture keeps
 * going, every failure is logged once, and the loss is reported when the
 * recording is closed.
 * guards: capture continues (all exchanges recorded, later writes still attempted), logger is called once per failure, close() rejects SINK_FAILED with detail.failed === 1
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.17]
 */
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { CaptureError } from '../../../src/lib/recording/errors.js'
import { NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import { connectSession, fireRequest, makeSinkSpy, optionsFor, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.17] sink rejecting on its second write', () => {
  const rig = useFixture('doc-200')

  it('capture continues (all exchanges recorded, later writes still attempted), logger is called once per failure, close() rejects SINK_FAILED with detail.failed === 1', async () => {
    const session = await connectSession()
    const cause = new Error('disk full')
    const sink = makeSinkSpy((_env, i) => {
      if (i === 1) throw cause
    })
    const logger: string[] = []
    const recorder = new NetworkRecorder(session, { sink, logger: (m) => logger.push(m) })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' }) // settles R1
    fireRequest(rig.server, 'R2')
    fireRequest(rig.server, 'R3')
    await recorder.settled()
    expect(recorder.exchanges().map((e) => e.state)).toEqual(['finished', 'finished', 'finished'])

    const closed = recorder.close()
    await expect(closed).rejects.toBeInstanceOf(CaptureError)
    await expect(closed).rejects.toMatchObject({ code: 'CAPTURE_SINK_FAILED', detail: { failed: 1, dropped: 0, firstCause: cause }, cause })
    expect(sink.written.map((e) => e.exchange.requestId)).toEqual(['R1', 'R2', 'R3']) // the third write still happened
    expect(logger.filter((m) => m.includes('disk full'))).toHaveLength(1)
    expect(sink.log.filter((l) => l === 'close')).toHaveLength(1) // the sink is still closed
  })

  it('a sink whose close() throws is reported as a failure too', async () => {
    const session = await connectSession()
    const sink = makeSinkSpy()
    sink.close = () => Promise.reject(new Error('close failed'))
    const recorder = new NetworkRecorder(session, { sink, logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    await expect(recorder.close()).rejects.toMatchObject({ code: 'CAPTURE_SINK_FAILED', detail: { failed: 1 } })
  })

  it('flush() reports failures since the last flush only', async () => {
    const session = await connectSession()
    const sink = makeSinkSpy((_e, i) => {
      if (i === 0) throw new Error('first only')
    })
    const recorder = new NetworkRecorder(session, { sink, logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    await expect(recorder.flush()).rejects.toMatchObject({ code: 'CAPTURE_SINK_FAILED', detail: { failed: 1 } })
    fireRequest(rig.server, 'R2')
    await recorder.settled()
    await expect(recorder.flush()).resolves.toBeUndefined()
    await expect(recorder.close()).resolves.toBeUndefined()
  })
})

describe('8468f7b1 [capture-upgrade.17] captureNetworkResponse treats the sink as a pure observer', () => {
  useFixture('doc-200')

  it('still returns the captured page when every sink write and the sink close fail; the loss is logged', async () => {
    const sink = makeSinkSpy(() => {
      throw new Error('store offline')
    })
    sink.close = () => Promise.reject(new Error('close offline'))
    const opts = optionsFor('doc-200', { sink })
    const out = await captureNetworkResponse(WS_URL, opts)
    expect(out.body).toContain('hello')
    expect(opts.logs.some((l) => l.includes('recording sink'))).toBe(true)
  })
})
