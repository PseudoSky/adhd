/**
 * Use case: an agent hammers a provider that starts rate limiting, and several agents search at once.
 * Real search service, guard and cooldown file over the in-memory fs and a controllable clock; only
 * the Chrome edge is injected. No process, no socket, no Chrome.
 * Ported from the agent-search end-to-end cooldown and concurrency scenarios (I-06, I-07, I-13, I-19, I-20).
 * Ticket 8468f7b1 · [search-usecases.1] [search-usecases.2] [search-usecases.5] [search-usecases.6]
 */
import { describe, expect, it, vi } from 'vitest'
import { hitlResponse, input, makeWorld, response, scriptedEngine } from '../unit/verbs/harness.js'

describe('a hostile outcome arms the cooldown', () => {
  it.each(['captcha', 'rate_limited', 'banned'] as const)('outcome %s arms the cooldown, and the next call fails fast with rate_limited and no window', async (outcome) => {
    const engine = scriptedEngine(response({ outcome, error: outcome }))
    const world = makeWorld({ strategies: engine.strategies })

    const first = await world.svc.search(input())
    expect(first).toMatchObject({ outcome, attempts: 1 })
    const cooldown = await world.svc.guard.readProviderCooldown('github')
    expect(cooldown).toMatchObject({ provider: 'github', reason: outcome })
    expect((cooldown?.until ?? 0) - world.clock.now).toBe(world.svc.guard.cooldownForOutcome(outcome))

    const second = await world.svc.search(input())
    expect(second).toMatchObject({ outcome: 'rate_limited', attempts: 0, count: 0 })
    expect(second.error).toMatch(/cooling down after a previous .* outcome — retry in ~\d+s/)
    // fail-fast: no second window, no second engine run
    expect(world.core.opened).toHaveLength(1)
    expect(engine.calls).toHaveLength(1)
  })

  it('outcome hitl does not arm the cooldown (the tripwire is its gate, never the cooldown)', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })
    expect((await world.svc.search(input())).outcome).toBe('hitl')
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
    expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])
  })

  it('a success arms nothing', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    expect((await world.svc.search(input())).outcome).toBe('success')
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
  })
})

describe('cooldown fail-fast without a window', () => {
  it('an armed cooldown answers rate_limited with a retry-in hint and Chrome is never asked to be ready', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000, 'vite')

    const out = await world.svc.search(input())

    expect(out).toMatchObject({ outcome: 'rate_limited', attempts: 0 })
    expect(out.error).toMatch(/retry in ~20s/)
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
  })

  it('the cooldown lifts when its time passes and the search runs', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000)
    expect((await world.svc.search(input())).outcome).toBe('rate_limited')
    world.clock.now += 20_001
    expect((await world.svc.search(input())).outcome).toBe('success')
  })

  it('a cooldown on one provider does not gate another', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response({ provider: 'npm', query: 'zod' })).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000)
    expect((await world.svc.search(input({ provider: 'npm', query: 'zod' }))).outcome).toBe('success')
  })
})

describe('the cooldown file is written atomically', () => {
  it('arming writes a temp file and renames it over the cooldown file, leaving no temp file behind', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.guard.setProviderCooldown('github', 'rate_limited', 20_000)

    const renames = world.fs.ops.filter((o) => o.op === 'rename')
    expect(renames).toHaveLength(1)
    expect(renames[0]?.path).toMatch(/\.tmp$/)
    expect(renames[0]?.path2).toMatch(/github\.json$/)
    expect(world.fs.files().filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(await world.svc.guard.readProviderCooldown('github')).toMatchObject({ reason: 'rate_limited' })
  })
})

describe('the concurrency cap of 2 queues the third call FIFO', () => {
  it('two searches run, the third and fourth wait and are admitted in arrival order', async () => {
    const gates: Array<() => void> = []
    const started: string[] = []
    const world = makeWorld({
      strategies: (_page, _provider, query) =>
        new Promise((resolve) => {
          started.push(query)
          gates.push(() => resolve(response({ query })))
        }),
    })

    const calls = ['a', 'b', 'c', 'd'].map((q) => world.svc.search(input({ query: q })))
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']))
    expect(world.svc.guard.searchConcurrencyInfo()).toEqual({ active: 2, queued: 2, max: 2 })
    expect(world.core.opened).toHaveLength(2)

    gates[1]?.()
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']))
    gates[0]?.()
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']))
    gates[2]?.()
    gates[3]?.()

    const results = await Promise.all(calls)
    expect(results.map((r) => r.query)).toEqual(['a', 'b', 'c', 'd'])
    expect(world.core.maxLive).toBe(2)
    expect(world.svc.guard.searchConcurrencyInfo()).toEqual({ active: 0, queued: 0, max: 2 })
  })

  it('a failing search releases its slot so the queue keeps moving', async () => {
    let n = 0
    const world = makeWorld({
      strategies: async () => {
        if (n++ === 0) throw new TypeError('engine exploded')
        return response()
      },
      config: { maxConcurrent: 1 },
    })
    await expect(world.svc.search(input())).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
    expect((await world.svc.search(input())).outcome).toBe('success')
  })
})
