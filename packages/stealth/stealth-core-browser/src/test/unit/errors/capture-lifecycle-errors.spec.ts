/**
 * The capture and lifecycle codes: each of the 8 CaptureError and 6 LifecycleError codes is named literally,
 * carries its exit status, appears in docs/ERRORS.md in registry order, and the sink and reaper codes are
 * reached through the library (sinks, factories).
 * Ticket 8468f7b1 · [prod-errors.2] [prod-errors.6] [prod-errors.8] · PA5.1 / PA5.4.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, StealthCoreBrowserError, exitCodeFor } from '../../../errors.js'
import { CaptureError, captureError } from '../../../lib/recording/errors.js'
import { LifecycleError, lifecycleError, lifecycleErrors } from '../../../lib/lifecycle/errors.js'
import { MemoryRecordingSink } from '../../../lib/recording/memory-sink.js'
import { StoreRecordingSink } from '../../../lib/recording/store-sink.js'
import type { RecordingEnvelope } from '../../../lib/recording/types.js'

const CAPTURE = [
  ['CAPTURE_CONNECT_FAILED', 40],
  ['CAPTURE_NAVIGATE_FAILED', 41],
  ['CAPTURE_TIMEOUT', 42],
  ['CAPTURE_NO_MATCH', 43],
  ['CAPTURE_BAN_DETECTED', 44],
  ['CAPTURE_SESSION_CLOSED', 45],
  ['CAPTURE_SINK_FAILED', 46],
  ['CAPTURE_SINK_UNAVAILABLE', 47],
] as const

const LIFECYCLE = [
  ['LAUNCH_FAILED', 60],
  ['LAUNCH_LOCK_TIMEOUT', 61],
  ['CHROME_UNREACHABLE_AFTER_LAUNCH', 62],
  ['LAUNCH_CIRCUIT_OPEN', 63],
  ['REAPER_UNAVAILABLE', 64],
  ['ISOLATED_CONTEXT_FAILED', 65],
] as const

describe('8468f7b1 [prod-errors.8] every CaptureError code is a typed package error with a message and exit status', () => {
  it.each(CAPTURE)('%s is built by captureError, is a StealthCoreBrowserError and exits %i', (code, exit) => {
    const e = captureError(code, `${code} message`)
    expect(e).toBeInstanceOf(CaptureError)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.message).toBe(`${code} message`)
    expect(exitCodeFor(code)).toBe(exit)
  })
})

describe('8468f7b1 [prod-errors.8] every LifecycleError code is a typed package error with a message and exit status', () => {
  it.each(LIFECYCLE)('%s is built by lifecycleError, is a StealthCoreBrowserError and exits %i', (code, exit) => {
    const e = lifecycleError(code, `${code} message`)
    expect(e).toBeInstanceOf(LifecycleError)
    expect(e).toBeInstanceOf(StealthCoreBrowserError)
    expect(e.message).toBe(`${code} message`)
    expect(exitCodeFor(code)).toBe(exit)
  })

  it('REAPER_UNAVAILABLE and ISOLATED_CONTEXT_FAILED come out of the lifecycle factories with cause and detail', () => {
    const cause = new Error('root')
    expect(lifecycleErrors.reaperUnavailable(9333, cause, '/state')).toMatchObject({ code: 'REAPER_UNAVAILABLE', cause, detail: { port: 9333, path: '/state' } })
    expect(lifecycleErrors.isolatedContextFailed('createTarget', cause)).toMatchObject({ code: 'ISOLATED_CONTEXT_FAILED', cause, detail: { step: 'createTarget' } })
  })
})

describe('8468f7b1 [prod-errors.2] the recording sinks fail with typed capture codes', () => {
  const envelope = { key: 'k', seq: 1 } as unknown as RecordingEnvelope

  it('a MemoryRecordingSink written after close rejects with CAPTURE_SINK_FAILED', async () => {
    const sink = new MemoryRecordingSink()
    await sink.close()
    expect(() => sink.write(envelope)).toThrow(expect.objectContaining({ code: 'CAPTURE_SINK_FAILED', message: expect.stringContaining('closed') }))
  })

  it('a StoreRecordingSink with an unsafe table name fails with CAPTURE_SINK_UNAVAILABLE', () => {
    expect(() => new StoreRecordingSink({} as never, { table: 'x; DROP TABLE y' })).toThrow(expect.objectContaining({ code: 'CAPTURE_SINK_UNAVAILABLE', message: expect.stringContaining('invalid recording table name') }))
  })
})

describe('8468f7b1 [prod-errors.6] docs/ERRORS.md documents every code, its exit status and remediation, in registry order', () => {
  const doc = readFileSync(new URL('../../../../docs/ERRORS.md', import.meta.url), 'utf8')

  it('lists the 32 codes in the order of ERROR_CODES, each row carrying exitCodeFor(code)', () => {
    const rows = [...doc.matchAll(/^\| `([A-Z_]+)` \| (\d+) \|/gm)].map((m) => [m[1], Number(m[2])] as const)
    expect(rows.map((r) => r[0])).toEqual([...ERROR_CODES])
    for (const [code, exit] of rows) expect(exit).toBe(exitCodeFor(code))
  })

  it('states every remediation of the registry verbatim', () => {
    for (const code of ERROR_CODES) {
      const { remediation } = new StealthCoreBrowserError(code, 'm')
      expect(doc.includes(remediation)).toBe(true)
    }
  })
})
