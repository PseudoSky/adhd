/**
 * Flush, close and backpressure.
 * Ticket 8468f7b1 AC capture-upgrade.18 · [capture-upgrade.18]
 * Real use: a slow store must not be abandoned at the end of a capture; a stuck
 * one must not grow memory without bound; and a capture that times out still
 * closes the sink it was handed.
 * guards: resolves only after the slow sink.write finishes
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.18]
 */
import { describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import { connectSession, fireRequest, fixtureWith, makeSinkSpy, optionsFor, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.18] flush() awaits a slow write', () => {
  useFixture('doc-200')

  it('resolves only after the slow sink.write finishes', async () => {
    vi.useFakeTimers()
    const session = await connectSession()
    const sink = makeSinkSpy(() => new Promise<void>((r) => setTimeout(r, 1_000)))
    const recorder = new NetworkRecorder(session, { sink, logger: () => undefined })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    let flushed = false
    const f = recorder.flush().then(() => {
      flushed = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(flushed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await f
    expect(flushed).toBe(true)
    expect(sink.log).toEqual(['write', 'flush'])
  })
})

describe('8468f7b1 [capture-upgrade.18] close order', () => {
  useFixture('doc-200')

  it('is flush, then sink.close, then stop; and a second close() is a no-op', async () => {
    const session = await connectSession()
    const order: string[] = []
    const sink = makeSinkSpy()
    const write = sink.write.bind(sink)
    sink.write = async (e) => {
      order.push('sink.write')
      await write(e)
    }
    sink.flush = async () => {
      order.push('sink.flush')
    }
    sink.close = async () => {
      order.push('sink.close')
    }
    const recorder = new NetworkRecorder(session, { sink, logger: () => undefined })
    const stop = recorder.stop.bind(recorder)
    vi.spyOn(recorder, 'stop').mockImplementation(() => {
      order.push('stop')
      stop()
    })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    await recorder.settled()
    await recorder.close()
    await recorder.close()
    expect(order).toEqual(['sink.write', 'sink.flush', 'sink.close', 'stop'])
    expect(session.connected).toBe(true) // the session is never closed by the recorder
  })
})

describe('8468f7b1 [capture-upgrade.18] backpressure: maxQueue', () => {
  const rig = useFixture('doc-200')

  it('with maxQueue 2 and a blocked sink the third envelope is dropped, capture continues, close() reports detail.dropped === 1', async () => {
    const session = await connectSession()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const sink = makeSinkSpy(() => gate)
    const logs: string[] = []
    const recorder = new NetworkRecorder(session, { sink, maxQueue: 2, logger: (m) => logs.push(m) })
    await recorder.start()
    await session.send('Page.navigate', { url: 'https://site.test/home' })
    fireRequest(rig.server, 'R2')
    fireRequest(rig.server, 'R3')
    await recorder.settled()
    expect(recorder.exchanges()).toHaveLength(3) // capture itself never blocked
    release()
    await expect(recorder.close()).rejects.toMatchObject({ code: 'CAPTURE_SINK_FAILED', detail: { failed: 0, dropped: 1 } })
    expect(sink.written.map((e) => e.exchange.requestId)).toEqual(['R1', 'R2'])
    expect(sink.written.map((e) => e.seq)).toEqual([1, 2]) // the dropped one consumed seq 3
    expect(logs.filter((m) => m.includes('dropped'))).toHaveLength(1)
  })
})

describe('8468f7b1 [capture-upgrade.18] captureNetworkResponse({ sink }) closes the sink in finally', () => {
  useFixture('doc-200')

  it('closes it after a successful capture, after flushing', async () => {
    const sink = makeSinkSpy()
    await captureNetworkResponse(WS_URL, optionsFor('doc-200', { sink }))
    expect(sink.log).toEqual(['write', 'flush', 'close'])
  })
})

describe('8468f7b1 [capture-upgrade.18] ... even on CAPTURE_TIMEOUT', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) nav.emit = []
    }),
  )

  it('the timeout is the error the caller sees and the sink was still closed', async () => {
    vi.useFakeTimers()
    const sink = makeSinkSpy()
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { sink, timeoutMs: 400 }))
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(400)
    await assertion
    expect(sink.log).toContain('close')
    expect(vi.getTimerCount()).toBe(0)
  })
})
