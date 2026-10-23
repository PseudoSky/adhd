/**
 * A zero-result page is one attempt: the verb's attempt loop uses the core `decideRetry`; a github zero-match
 * response (outcome `empty`) returns `empty` with attempts 1, a transport failure (`error` or `timeout` from
 * `noCaptureOutcome`) retries up to maxAttempts, and `onTimeout: 'abort'` stops.
 *
 * Inventory rows: I-06 (retry with backoff), I-07 (hostile outcomes end the call).
 * Ticket 8468f7b1 · commit c00edea · [search-verbs.16]
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDERS } from '../../../lib/providers.js'
import { noCaptureOutcome } from '../../../lib/network.js'
import { body, makeDeps, recordingCapture } from '../engine/harness.js'
import { input, makeWorld, response, scriptedEngine } from './harness.js'

const original = { ...PROVIDERS.github.retry }
afterEach(() => {
  Object.assign(PROVIDERS.github.retry, original)
})

const failure = (socketError: string | null) => {
  const outcome = noCaptureOutcome(socketError)
  return response({ outcome, error: outcome === 'timeout' ? 'nothing captured within 30000ms' : `socket: ${socketError ?? ''}` })
}

describe('c00edea: legitimate zero results are one attempt [search-verbs.16]', () => {
  it('empty: a github zero-match response returns outcome empty with attempts 1 (it was 3) and one engine pass', async () => {
    const engine = scriptedEngine(response({ outcome: 'empty', results: [], count: 0 }))
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input({ query: 'zzzz-no-such-repo-0000' }))
    expect(out).toMatchObject({ outcome: 'empty', count: 0, attempts: 1 })
    expect(engine.calls).toHaveLength(1)
    expect(world.sleeps).toEqual([])
    expect(world.core.pages).toHaveLength(1)
    expect(world.core.pages[0]?.disposed).toBe(1)
  })

  it('empty: through the real engine a github API answer of zero items is outcome empty with attempts 1 and no backoff', async () => {
    const rec = recordingCapture(async () => body('<html></html>'))
    const world = makeWorld({
      engine: makeDeps({ capture: rec.capture, fetchImpl: async () => new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) }),
    })
    const out = await world.svc.search(input({ query: 'zzzz-no-such-repo-0000' }))
    expect(out.outcome).toBe('empty')
    expect(out.attempts).toBe(1)
    expect(world.sleeps).toEqual([])
  })

  it('decideRetry: an empty answer is never retried, so the cooldown is disarmed rather than armed', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response({ outcome: 'empty', results: [], count: 0 })).strategies })
    await world.svc.search(input())
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
  })
})

describe('c00edea: noCaptureOutcome transport failures still retry up to maxAttempts [search-verbs.16]', () => {
  it.each([
    ['timeout', null],
    ['error', 'socket closed'],
  ] as const)('noCaptureOutcome %s: the attempts count reaches maxAttempts 3 with a recorded backoff sleep between attempts', async (expected, socketError) => {
    expect(noCaptureOutcome(socketError)).toBe(expected)
    const engine = scriptedEngine(failure(socketError))
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input({ maxAttempts: 3 }))
    expect(out).toMatchObject({ outcome: expected, attempts: 3 })
    expect(engine.calls).toHaveLength(3)
    expect(world.sleeps).toHaveLength(2)
    expect(world.sleeps.every((ms) => ms > 0)).toBe(true)
    // every attempt got its own page and each was disposed
    expect(world.core.pages).toHaveLength(3)
    expect(world.core.pages.every((p) => p.disposed === 1)).toBe(true)
  })

  it('attempts: a transport failure followed by a success returns success with attempts 2', async () => {
    const engine = scriptedEngine(failure(null), response())
    const world = makeWorld({ strategies: engine.strategies })
    expect(await world.svc.search(input())).toMatchObject({ outcome: 'success', attempts: 2 })
    expect(world.sleeps).toHaveLength(1)
  })

  it('attempts: without maxAttempts the github provider retry config bounds the loop at 2', async () => {
    const engine = scriptedEngine(failure(null))
    const world = makeWorld({ strategies: engine.strategies })
    expect(await world.svc.search(input())).toMatchObject({ outcome: 'timeout', attempts: 2 })
  })

  it("decideRetry onTimeout 'abort' stops after the first timeout: attempts 1, no sleep", async () => {
    ;(PROVIDERS.github.retry as { onTimeout: string }).onTimeout = 'abort'
    const engine = scriptedEngine(failure(null))
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input({ maxAttempts: 3 }))
    expect(out).toMatchObject({ outcome: 'timeout', attempts: 1 })
    expect(engine.calls).toHaveLength(1)
    expect(world.sleeps).toEqual([])
  })

  it('attempts: a transport failure arms no cooldown (only hostile outcomes do)', async () => {
    const world = makeWorld({ strategies: scriptedEngine(failure('socket closed')).strategies })
    await world.svc.search(input({ maxAttempts: 2 }))
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
  })
})
