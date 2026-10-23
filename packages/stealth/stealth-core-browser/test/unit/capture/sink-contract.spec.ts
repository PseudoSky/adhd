/**
 * The RecordingSink contract.
 * Ticket 8468f7b1 AC capture-upgrade.14 · [capture-upgrade.14]
 * Real use: whatever sink a caller plugs in gets exactly one envelope per
 * settled exchange, an idempotency key and a strictly increasing seq, and a
 * redirect chain is one record (never one per hop).
 * guards: delivers two envelopes with key recordingId:requestId and a strictly increasing seq
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.14]
 */
import { describe, expect, it } from 'vitest'
import { MemoryRecordingSink } from '../../../src/lib/recording/memory-sink.js'
import { NetworkRecorder } from '../../../src/lib/recording/network-recorder.js'
import { connectSession, useFixture } from '../../helpers/capture/capture-kit.js'

async function record(url: string, recordingId?: string): Promise<MemoryRecordingSink> {
  const session = await connectSession()
  const sink = new MemoryRecordingSink()
  const recorder = new NetworkRecorder(session, { sink, recordingId, logger: () => undefined })
  await recorder.start()
  await session.send('Page.navigate', { url })
  await recorder.settled()
  await recorder.close()
  return sink
}

describe('8468f7b1 [capture-upgrade.14] one envelope per settled exchange (two-tabs-parallel)', () => {
  useFixture('two-tabs-parallel')

  it('delivers two envelopes with key recordingId:requestId and a strictly increasing seq', async () => {
    const sink = await record('https://site.test/a', 'rec-42')
    const envs = sink.records()
    expect(envs.map((e) => e.exchange.requestId)).toEqual(['A1', 'B1'])
    expect(envs.map((e) => e.key)).toEqual(['rec-42:A1', 'rec-42:B1'])
    expect(envs.every((e) => e.recordingId === 'rec-42')).toBe(true)
    expect(envs.map((e) => e.seq)).toEqual([1, 2])
    expect(envs.every((e) => !Number.isNaN(Date.parse(e.ts)))).toBe(true)
  })

  it('a recorder without an explicit recordingId generates a distinct one per recorder', async () => {
    const a = (await record('https://site.test/a')).records()[0]?.recordingId
    const b = (await record('https://site.test/a')).records()[0]?.recordingId
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

describe('8468f7b1 [capture-upgrade.14] redirect-301-200 is ONE envelope', () => {
  useFixture('redirect-301-200')
  it('carries the whole chain', async () => {
    const envs = (await record('https://site.test/old')).records()
    expect(envs).toHaveLength(1)
    expect(envs[0]?.exchange.redirects).toHaveLength(1)
    expect(envs[0]?.exchange.url).toBe('https://site.test/new')
  })
})

describe('8468f7b1 [capture-upgrade.14] cors-failure is delivered as failed', () => {
  useFixture('cors-failure')
  it('a failed exchange is an envelope with state failed', async () => {
    const envs = (await record('https://site.test/api/x')).records()
    expect(envs).toHaveLength(1)
    expect(envs[0]?.exchange.state).toBe('failed')
    expect(envs[0]?.exchange.failure?.errorText).toBe('net::ERR_FAILED')
  })
})
