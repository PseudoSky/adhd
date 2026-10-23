/**
 * Use case: a researcher's provider got locked behind a captcha and the agent keeps calling it.
 * The real search service, guard and tripwire run over the tripwire package's in-memory fs and a
 * controllable clock; only the Chrome edge (the fake core and the scripted engine) is injected.
 * Nothing is spawned, no socket is opened and no Chrome is touched.
 * Ported from the agent-search end-to-end tripwire scenarios (I-02, I-05, I-15).
 * Ticket 8468f7b1 · [search-usecases.1] [search-usecases.2] [search-usecases.5] [search-usecases.6]
 */
import { describe, expect, it } from 'vitest'
import { input, makeWorld, response, scriptedEngine } from '../unit/verbs/harness.js'
import type { World } from '../unit/verbs/harness.js'
import { createSearchHostConfig } from '../../lib/config.js'

const fire = (world: World, reason: string) =>
  world.svc.tripwire.fire({ provider: 'github', query: 'vite', reason, pageUrl: 'https://github.com/sorry', strategy: 'network', browserSessionId: 'tab-0', lastOperation: 'x' })

describe('a locked provider fails fast without touching Chrome', () => {
  it.each(['captcha', 'banned', 'rate_limited'])('a provider tripped for %s answers outcome hitl, attempts 0, with zero Chrome calls', async (reason) => {
    const engine = scriptedEngine(response())
    const world = makeWorld({ strategies: engine.strategies })
    await fire(world, reason)

    const out = await world.svc.search(input())

    expect(out).toMatchObject({ provider: 'github', outcome: 'hitl', attempts: 0, count: 0, results: [] })
    expect(out.hitl).toMatchObject({ reason, pageUrl: 'https://github.com/sorry' })
    expect(out.error).toContain('clearTripwire("github")')
    // zero Chrome calls: no readiness check, no page, no engine run
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
    expect(engine.calls).toHaveLength(0)
  })

  it('the lock is per provider: another provider still searches while github is locked', async () => {
    const engine = scriptedEngine(response({ provider: 'npm', query: 'zod' }))
    const world = makeWorld({ strategies: engine.strategies })
    await fire(world, 'captcha')

    const other = await world.svc.search(input({ provider: 'npm', query: 'zod' }))

    expect(other.outcome).toBe('success')
    expect(world.core.opened).toHaveLength(1)
  })
})

describe('tripwire status and clear', () => {
  it('status lists the locked provider with clearWith, trippedAt and expiresAt; clearTripwire reopens it', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await fire(world, 'captcha')

    const status = await world.svc.tripwireStatus()
    expect(Object.keys(status)).toEqual(['github'])
    expect(status['github']).toMatchObject({ clearWith: 'clearTripwire', trippedAt: new Date(world.clock.now).toISOString() })
    expect(status['github']?.recoveryHint).toContain('clearTripwire("github")')

    expect(await world.svc.clearTripwire('github')).toEqual({ provider: 'github', cleared: true })
    expect(await world.svc.tripwireStatus()).toEqual({})
    expect((await world.svc.search(input())).outcome).toBe('success')
  })

  it('clearing a provider that is not locked reports cleared false and changes nothing', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    expect(await world.svc.clearTripwire('github')).toEqual({ provider: 'github', cleared: false })
    expect(await world.svc.tripwireStatus()).toEqual({})
  })

  it('every blocked call is counted on the lock', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await fire(world, 'captcha')
    await world.svc.search(input())
    await world.svc.search(input())
    expect((await world.svc.tripwire.read('github'))?.blockedCount).toBe(2)
  })
})

describe('a lock expires on its own', () => {
  it('after the TTL the lock is no longer listed and the search runs', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await fire(world, 'banned')
    const ttl = createSearchHostConfig({ dataDir: '/data', sessionId: 's' }).tripwireTtlMs

    world.clock.now += ttl - 1
    expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])
    expect((await world.svc.search(input())).outcome).toBe('hitl')

    world.clock.now += 2
    expect(await world.svc.tripwireStatus()).toEqual({})
    expect((await world.svc.search(input())).outcome).toBe('success')
  })

  it('a configured short TTL expires the lock at expiresAt', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies, config: { tripwireTtlMs: 60_000 } })
    await fire(world, 'captcha')
    expect((await world.svc.tripwireStatus())['github']?.expiresAt).toBe(new Date(world.clock.now + 60_000).toISOString())
    world.clock.now += 60_001
    expect(await world.svc.tripwireStatus()).toEqual({})
    expect((await world.svc.search(input())).outcome).toBe('success')
  })
})
