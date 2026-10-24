/**
 * The sink is a pure observer.
 * Ticket 8468f7b1 AC capture-upgrade.24 · [capture-upgrade.24]
 * Real use: switching persistence on or off, or changing the backend, must not
 * change what captureNetworkResponse returns, and with no sink the recorder
 * must not pay for one.
 * guards: 8468f7b1 [capture-upgrade.24] identical CapturedResponse with and without a sink
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.24]
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import type { RecordingSink } from '../../../src/lib/recording/types.js'
import { MemoryRecordingSink } from '../../../src/lib/recording/memory-sink.js'
import { StoreRecordingSink } from '../../../src/lib/recording/store-sink.js'
import { FakeCdpServer, loadFixture } from '../../helpers/fake-cdp.js'
import { makeStoreFake, optionsFor, plain, WS_URL } from '../../helpers/capture/capture-kit.js'

const FIXTURES = ['doc-200', 'no-body-204', 'search-404', 'redirect-301-200', 'two-tabs-parallel'] as const

let restore: (() => void) | undefined
afterEach(() => restore?.())

async function run(name: string, sink?: RecordingSink): Promise<{ out: unknown; server: FakeCdpServer }> {
  const server = new FakeCdpServer(loadFixture(name))
  restore = server.install()
  const out = await captureNetworkResponse(WS_URL, optionsFor(name, { sink }))
  restore()
  restore = undefined
  return { out: plain(out), server }
}

describe('8468f7b1 [capture-upgrade.24] identical CapturedResponse with and without a sink', () => {
  it.each(FIXTURES)('%s: sink unset, MemoryRecordingSink and StoreRecordingSink over the fake all return the same response', async (name) => {
    const bare = await run(name)
    const mem = new MemoryRecordingSink()
    const memRun = await run(name, mem)
    const fake = makeStoreFake()
    const storeRun = await run(name, new StoreRecordingSink(fake.store))
    expect(memRun.out).toEqual(bare.out)
    expect(storeRun.out).toEqual(bare.out)
    // and the sinks really did persist
    expect(mem.records().length).toBeGreaterThan(0)
    expect([...fake.rows.keys()].filter((k) => !k.startsWith('schema:')).length).toBe(mem.records().length)
  })
})

describe('8468f7b1 [capture-upgrade.24] with sink unset nothing is allocated or sent for it', () => {
  it.each(FIXTURES)('%s: no envelope is built and no CDP command beyond the urlPattern body fetches is sent', async (name) => {
    const redact = vi.fn((e: unknown) => e)
    const server = new FakeCdpServer(loadFixture(name))
    restore = server.install()
    await captureNetworkResponse(WS_URL, optionsFor(name, { redact: redact as never }))
    const methods = server.received.map((r) => r.method)
    expect(redact).not.toHaveBeenCalled() // redaction (the first step of building an envelope) never ran
    expect(methods.slice(0, 3)).toEqual(['Page.enable', 'Network.enable', 'Page.navigate'])
    expect(methods.slice(3).every((m) => m === 'Network.getResponseBody')).toBe(true)
    expect(methods.slice(3).length).toBeGreaterThan(0)
    expect(methods).not.toContain('Network.getRequestPostData')
  })
})
