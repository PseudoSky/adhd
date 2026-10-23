/**
 * guards: a hung provider outlives timeoutMs, leaks its concurrency slot or page, or arms the cooldown
 * tier: S
 * cites: ticket 8468f7b1 [search-verbs.11]
 * A hung provider cannot outlive the deadline: one overall `timeoutMs` (default 30000, shared across attempts,
 * never the 90 s of the old tool) ends a search whose engine never settles with outcome `timeout`, the
 * concurrency slot is released, the page is disposed and the cooldown is not armed.
 *
 * Inventory rows: I-04 (concurrency slot), I-05 (cooldown), I-14 (dispose in finally).
 * Ticket 8468f7b1 · backlog 861571da, 224e7a44 · [search-verbs.11]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../../../src/lib/search.js'
import { hitlResponse, input, makeFakeCore, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'

const hung = (): Promise<never> => new Promise<never>(() => undefined)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('861571da 224e7a44: a hung github engine resolves with outcome timeout at the 30000 deadline [search-verbs.11]', () => {
  it('useFakeTimers: a github search whose engine never settles resolves at 30000 ms with outcome timeout, not error after two attempts', async () => {
    expect(DEFAULT_SEARCH_TIMEOUT_MS).toBe(30000)
    const engine = scriptedEngine(hung)
    const world = makeWorld({ strategies: engine.strategies })
    let settled = false
    const pending = world.svc.search(input()).then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const out = await pending

    expect(out).toMatchObject({ provider: 'github', outcome: 'timeout', count: 0, results: [] })
    expect(out.outcome).not.toBe('error')
    expect(out.tookMs).toBe(30_000)
    expect(out.error).toContain('30000ms')
    // one attempt began and never came back: the deadline is shared, not restarted per attempt
    expect(engine.calls).toHaveLength(1)
  })

  it('dispose: the page of the hung attempt is disposed exactly once', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hung).strategies })
    const pending = world.svc.search(input())
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(world.core.pages).toHaveLength(1)
    expect(world.core.pages[0]?.disposed).toBe(1)
    expect(world.core.live).toBe(0)
  })

  it('release: the concurrency slot is released, so the next search runs under maxConcurrent 1', async () => {
    const engine = scriptedEngine(hung, response())
    const world = makeWorld({ strategies: engine.strategies, config: { maxConcurrent: 1 } })
    const first = world.svc.search(input())
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await first).outcome).toBe('timeout')

    const second = await world.svc.search(input({ query: 'react' }))
    expect(second).toMatchObject({ outcome: 'success', attempts: 1 })
    expect(engine.calls).toHaveLength(2)
  })

  it('no cooldown: a timeout does not arm the provider cooldown and writes no tripwire', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hung).strategies })
    const pending = world.svc.search(input())
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
    expect(await world.svc.guard.cooldownRemainingMs('github')).toBe(0)
    expect(world.fs.files()).toEqual([])
  })

  it('timeoutMs: an explicit 5000 deadline wins over the 30000 default', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hung).strategies })
    const pending = world.svc.search(input({ timeoutMs: 5000 }))
    await vi.advanceTimersByTimeAsync(5000)
    const out = await pending
    expect(out).toMatchObject({ outcome: 'timeout', tookMs: 5000 })
  })

  it('timeout: a Chrome that never becomes ready is also cut at 30000 with no page opened', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    world.core.core.ensureChrome = hung
    const pending = world.svc.search(input())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toMatchObject({ outcome: 'timeout', attempts: 0 })
    expect(world.core.pages).toHaveLength(0)
  })

  it('timeout: a hung fetch render is cut at 30000, its page disposed and the fetch strategy reported', async () => {
    const world = makeWorld({
      fetch: {
        newSession: () => ({ connect: async () => undefined, on: () => () => undefined, close: () => undefined, send: (async () => ({})) as never }),
        settle: hung,
      },
    })
    const pending = world.svc.search({ provider: 'fetch', query: 'https://example.com/slow' })
    await vi.advanceTimersByTimeAsync(30_000)
    const out = await pending
    expect(out).toMatchObject({ provider: 'fetch', outcome: 'timeout', strategy: 'fetch', url: 'https://example.com/slow' })
    expect(world.core.pages.every((p) => p.disposed === 1)).toBe(true)
  })

  it('a human prompt does not spend the deadline: the budget is paused while confirmSolved waits', async () => {
    // hitl then a slow human (45 s) then success: total wall time exceeds 30 s but the search still succeeds.
    const order: string[] = []
    const interaction = {
      confirmSolved: async () => {
        await new Promise((r) => setTimeout(r, 45_000))
        return 'solved' as const
      },
      promptTripwireGate: async () => 'clear' as const,
    }
    const world = makeWorld({ core: makeFakeCore(order), interaction, strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response()).strategies })
    const pending = world.svc.search(input())
    await vi.advanceTimersByTimeAsync(45_000)
    expect(await pending).toMatchObject({ outcome: 'success', attempts: 2 })
  })
})
