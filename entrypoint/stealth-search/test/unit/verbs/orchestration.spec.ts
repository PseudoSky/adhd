/**
 * guards: the verb runs Chrome before the unknown-provider, tripwire or cooldown gate, or leaks the page on a hitl outcome
 * tier: S
 * cites: ticket 8468f7b1 [search-verbs.4]
 * The search orchestration on a fake core (zero real Chrome): unknown provider before any gate, the
 * tripwire fail-fast, the cooldown, the concurrency queue, hostile outcomes and the cooldown, a HITL
 * outcome that fires the tripwire and keeps the page, and pageDisposal. The guard, the tripwire and the
 * orchestration are the real code over the tripwire package's in-memory fs.
 *
 * Inventory rows: I-02 (locked fail-fast), I-04 (unknown provider first), I-05 (gate before Chrome),
 * I-06 (cooldown gate), I-07 (bounded concurrency), I-13 (hostile outcomes, hitl keeps the context),
 * I-14 (finally dispose, outer catch).
 * Ticket 8468f7b1 · [search-verbs.4]
 */
import { describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import { StealthSearchError } from '../../../src/errors.js'
import { countingFs, hitlResponse, input, makeFakeCore, makeWorld, recordingInteraction, response, scriptedEngine } from '../../helpers/verbs/harness.js'

const fire = (world: ReturnType<typeof makeWorld>, reason: string) =>
  world.svc.tripwire.fire({ provider: 'github', query: 'vite', reason, pageUrl: 'https://github.com/sorry', strategy: 'network', browserSessionId: 'tab-0', lastOperation: 'x' })

describe('I-04 unknown provider is raised before any gate [search-verbs.4]', () => {
  it('UNKNOWN_PROVIDER: a provider that is not registered raises before the tripwire, the cooldown or Chrome', async () => {
    const io = { counter: undefined as undefined | (() => number) }
    const world = makeWorld({
      wrapFs: (fs) => {
        const c = countingFs(fs)
        io.counter = c.count
        return c.fs
      },
    })
    await expect(world.svc.search(input({ provider: 'altavista' as never }))).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
    await expect(world.svc.search(input({ provider: 'altavista' as never }))).rejects.toBeInstanceOf(StealthSearchError)
    expect(io.counter?.()).toBe(0)
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
  })

  it('an empty query is a usage error before any gate or page', async () => {
    const world = makeWorld()
    await expect(world.svc.search(input({ query: '   ' }))).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'query-required' } })
    expect(world.core.ensured).toBe(0)
  })

  it('a malformed option is a usage error before any gate or page', async () => {
    const world = makeWorld()
    await expect(world.svc.search(input({ timeoutMs: 0 }))).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'invalid-option', field: 'timeoutMs' } })
    await expect(world.svc.search(input({ offset: -1 }))).rejects.toMatchObject({ detail: { field: 'offset' } })
    await expect(world.svc.search(input({ port: 70000 }))).rejects.toBeInstanceOf(StealthCoreBrowserError)
    expect(world.core.opened).toHaveLength(0)
  })
})

describe('I-02 I-05 a tripwire-locked provider is a fail-fast hitl with attempts 0 [search-verbs.4]', () => {
  it.each(['captcha', 'banned', 'rate_limited'])('a provider tripped for %s answers outcome hitl, attempts 0, zero Chrome calls', async (reason) => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await fire(world, reason)
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ provider: 'github', outcome: 'hitl', attempts: 0, count: 0, results: [] })
    expect(out.hitl).toMatchObject({ reason, pageUrl: 'https://github.com/sorry', provider: 'github' })
    expect(out.error).toContain('clearTripwire("github")')
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
  })

  it('the block is counted by the gate and clearTripwire lets the next search proceed', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await fire(world, 'captcha')
    await world.svc.search(input())
    expect((await world.svc.tripwire.read('github'))?.blockedCount).toBe(1)
    expect(await world.svc.clearTripwire('github')).toEqual({ provider: 'github', cleared: true })
    expect((await world.svc.search(input())).outcome).toBe('success')
    expect(world.core.opened).toHaveLength(1)
  })
})

describe('I-06 the cooldown gate answers rate_limited with a retry hint and no window [search-verbs.4]', () => {
  it('an armed cooldown returns rate_limited, attempts 0, a retry-in hint and opens no window', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000, 'vite')
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome: 'rate_limited', attempts: 0, count: 0 })
    expect(out.error).toMatch(/cooling down after a previous rate_limited outcome — retry in ~20s/)
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
  })

  it('an expired cooldown is lifted and the search runs', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000)
    world.clock.now += 20_001
    expect((await world.svc.search(input())).outcome).toBe('success')
  })
})

describe('I-07 the concurrency cap queues the third call [search-verbs.4]', () => {
  it('with a cap of 2 the third concurrent search waits for a slot and runs after one finishes', async () => {
    const gates: Array<() => void> = []
    const world = makeWorld({
      strategies: () => new Promise((resolve) => gates.push(() => resolve(response()))),
    })
    const calls = [1, 2, 3].map((n) => world.svc.search(input({ query: `q${n}` })))
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    expect(world.svc.guard.searchConcurrencyInfo()).toEqual({ active: 2, queued: 1, max: 2 })
    expect(world.core.opened).toHaveLength(2)

    gates[0]?.()
    await vi.waitFor(() => expect(gates).toHaveLength(3))
    expect(world.core.opened).toHaveLength(3)
    gates[1]?.()
    gates[2]?.()
    const results = await Promise.all(calls)
    expect(results.map((r) => r.outcome)).toEqual(['success', 'success', 'success'])
    expect(world.svc.guard.searchConcurrencyInfo()).toEqual({ active: 0, queued: 0, max: 2 })
  })
})

describe('I-13 hostile outcomes arm the cooldown, hitl does not [search-verbs.4]', () => {
  it.each(['captcha', 'rate_limited', 'banned'] as const)('outcome %s arms the cooldown and ends the call with attempts 1', async (outcome) => {
    const engine = scriptedEngine(response({ outcome, error: outcome }))
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome, attempts: 1 })
    expect(engine.calls).toHaveLength(1)
    const cd = await world.svc.guard.readProviderCooldown('github')
    expect(cd).toMatchObject({ provider: 'github', reason: outcome })
    expect((cd?.until ?? 0) - world.clock.now).toBe(world.svc.guard.cooldownForOutcome(outcome))
    // The cooldown now gates the next call without a window.
    const again = await world.svc.search(input())
    expect(again).toMatchObject({ outcome: 'rate_limited', attempts: 0 })
    expect(world.core.opened).toHaveLength(1)
  })

  it('outcome hitl arms no cooldown (the tripwire is its gate)', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })
    const out = await world.svc.search(input())
    expect(out.outcome).toBe('hitl')
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
  })
})

describe('I-13 a HITL outcome fires the tripwire, reveals the page and keeps the context alive [search-verbs.4]', () => {
  it('captcha: the tripwire is fired with the page, the window is revealed and not disposed', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome: 'hitl', attempts: 1, hitl: { reason: 'captcha', pageUrl: 'https://github.com/sorry' } })
    expect(await world.svc.tripwire.read('github')).toMatchObject({ reason: 'captcha', pageUrl: 'https://github.com/sorry', browserSessionId: 'tab-1', query: 'vite' })
    const [page] = world.core.pages
    expect(page?.revealed).toBe(1)
    expect(page?.disposed).toBe(0)
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
  })

  it('the next search for the locked provider fails fast with attempts 0 and opens no second window', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })
    await world.svc.search(input())
    const second = await world.svc.search(input())
    expect(second).toMatchObject({ outcome: 'hitl', attempts: 0 })
    expect(world.core.opened).toHaveLength(1)
    expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])
  })

  it('an interaction port answering abort keeps the lock and returns the hitl response', async () => {
    const order: string[] = []
    const world = makeWorld({
      core: makeFakeCore(order),
      interaction: recordingInteraction(order, { solved: 'abort' }),
      strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies,
    })
    const out = await world.svc.search(input())
    expect(out.outcome).toBe('hitl')
    expect(await world.svc.tripwire.isTripped('github')).toBe(true)
    expect(world.core.pages[0]?.disposed).toBe(0)
  })

  it('an interaction port answering solved releases the lock and searches again on the same page', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'solved' }), strategies: engine.strategies })
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome: 'success', attempts: 2 })
    expect(await world.svc.tripwire.isTripped('github')).toBe(false)
    expect(world.core.opened).toHaveLength(1)
    expect(engine.calls.map((c) => c.pageWsUrl)).toEqual(['ws://fake/page/1', 'ws://fake/page/1'])
    expect(world.core.pages[0]?.disposed).toBe(1)
  })
})

describe('I-05 the interactive gate prompt [search-verbs.4]', () => {
  const seeded = async (answer: 'retry' | 'clear' | 'abort' | Error) => {
    const order: string[] = []
    const interaction = recordingInteraction(order, { gate: answer })
    const world = makeWorld({ core: makeFakeCore(order), interaction, strategies: scriptedEngine(response()).strategies })
    await fire(world, 'captcha')
    return { world, interaction }
  }

  it.each(['retry', 'clear'] as const)('answer %s clears the lock and the search runs', async (answer) => {
    const { world, interaction } = await seeded(answer)
    expect((await world.svc.search(input())).outcome).toBe('success')
    expect(interaction.gateCalls).toEqual([expect.objectContaining({ provider: 'github', reason: 'captcha', blockedCount: 1, pageUrl: 'https://github.com/sorry' })])
    expect(await world.svc.tripwire.isTripped('github')).toBe(false)
  })

  it('answer abort raises HITL_ABORTED and opens no window', async () => {
    const { world } = await seeded('abort')
    await expect(world.svc.search(input())).rejects.toMatchObject({ code: 'HITL_ABORTED' })
    expect(world.core.opened).toHaveLength(0)
    expect(await world.svc.tripwire.isTripped('github')).toBe(true)
  })

  it('a prompt that rejects with HITL_ABORTED (closed stdin) propagates to the host', async () => {
    const { searchError } = await import('../../../src/errors.js')
    const { world } = await seeded(searchError('HITL_ABORTED', 'stdin closed'))
    await expect(world.svc.search(input())).rejects.toMatchObject({ code: 'HITL_ABORTED' })
    expect(world.core.opened).toHaveLength(0)
  })
})

describe('I-14 pageDisposal and the outer catch [search-verbs.4]', () => {
  it('pageDisposal dispose (the default) closes the page in the finally path', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.search(input())
    expect(world.core.pages.map((p) => p.disposed)).toEqual([1])
  })

  it("pageDisposal keep leaves the page open for inspection", async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.search(input({ pageDisposal: 'keep' }))
    expect(world.core.pages.map((p) => p.disposed)).toEqual([0])
  })

  it('an engine that throws leaves no leaked page: the page is disposed, the slot released and the failure is typed', async () => {
    const world = makeWorld({
      strategies: async () => {
        throw new TypeError('boom')
      },
    })
    const err = await world.svc.search(input()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthSearchError)
    expect(err).toMatchObject({ code: 'SEARCH_FAILED', message: expect.stringContaining('boom') })
    expect(world.core.pages.map((p) => p.disposed)).toEqual([1])
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
  })

  it('a core failure keeps its own typed code', async () => {
    const core = makeFakeCore()
    core.failOpen = StealthCoreBrowserError.invalidEndpoint('no chrome')
    const world = makeWorld({ core, strategies: scriptedEngine(response()).strategies })
    await expect(world.svc.search(input())).rejects.toBe(core.failOpen)
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
  })
})

describe('the engine call [search-verbs.4]', () => {
  it('the qualifier is prepended, visibility maps to the window and github type:code searches in the shared profile', async () => {
    const engine = scriptedEngine(response())
    const world = makeWorld({ strategies: engine.strategies })
    await world.svc.search(input({ qualifier: 'type:code', visibility: 'foreground', host: '10.0.0.5', port: 9333 }))
    expect(engine.calls[0]).toMatchObject({ query: 'type:code vite', provider: 'github' })
    expect(world.core.opened).toEqual([{ cdpHost: '10.0.0.5:9333', foreground: true, sharedProfile: true }])
  })

  it('a plain query opens an off-screen isolated page and Chrome is asked to be ready and bumped', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.search(input())
    expect(world.core.opened).toEqual([{ cdpHost: '127.0.0.1:9222', foreground: false, sharedProfile: false }])
    expect(world.core.ensured).toBe(1)
    expect(world.core.noted).toBeGreaterThan(0)
  })

  it('a success leaves no tripwire status (resolved is a no-op when clear)', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    expect((await world.svc.search(input())).outcome).toBe('success')
    expect(await world.svc.tripwireStatus()).toEqual({})
  })
})
