/**
 * MemoryRecordingSink.
 * Ticket 8468f7b1 AC capture-upgrade.15 · [capture-upgrade.15]
 * Real use: the in-memory sink of quick scripts and tests: it keeps what it is
 * given, once per key, in seq order, and can be closed any number of times.
 * guards: stores envelopes and returns them in seq order whatever the arrival order
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.15]
 */
import { describe, expect, it } from 'vitest'
import { MemoryRecordingSink } from '../../../src/lib/recording/memory-sink.js'
import type { RecordingEnvelope } from '../../../src/lib/recording/types.js'

function envelope(seq: number, requestId: string, status = 200): RecordingEnvelope {
  return {
    recordingId: 'r',
    key: `r:${requestId}`,
    seq,
    ts: new Date(seq * 1000).toISOString(),
    exchange: {
      requestId,
      url: `https://site.test/${requestId}`,
      request: { method: 'GET', url: `https://site.test/${requestId}`, headers: {}, startedAt: seq },
      response: { status, headers: {} },
      redirects: [],
      wire: { requestExtraInfo: false, responseExtraInfo: false },
      state: 'finished',
    },
  }
}

describe('8468f7b1 [capture-upgrade.15] MemoryRecordingSink', () => {
  it('stores envelopes and returns them in seq order whatever the arrival order', () => {
    const sink = new MemoryRecordingSink()
    sink.write(envelope(3, 'c'))
    sink.write(envelope(1, 'a'))
    sink.write(envelope(2, 'b'))
    expect(sink.records().map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('is idempotent by key: a replay replaces, it never duplicates', () => {
    const sink = new MemoryRecordingSink()
    sink.write(envelope(1, 'a', 200))
    sink.write(envelope(1, 'a', 500))
    expect(sink.records()).toHaveLength(1)
    expect(sink.records()[0]?.exchange.response?.status).toBe(500)
  })

  it('double close() is safe, and a write after close is rejected', () => {
    const sink = new MemoryRecordingSink()
    sink.write(envelope(1, 'a'))
    sink.close()
    sink.close()
    expect(sink.isClosed).toBe(true)
    expect(sink.records()).toHaveLength(1)
    expect(() => sink.write(envelope(2, 'b'))).toThrow('closed')
  })
})
