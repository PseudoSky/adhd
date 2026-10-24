/**
 * guards: one banned or rate-limited site arms a fetch cooldown that blocks every other site
 * guards: a human who solves the captcha on the last allowed attempt is wasted
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.4]
 * Audit findings P22 and P23. The CDP core, the engine and the resolver are fakes: no Chrome, no socket, no DNS.
 */
import { describe, expect, it } from 'vitest'
import { cooldownKeyFor } from '../../../src/lib/search.js'
import { hitlResponse, input, makeFakeCore, makeWorld, recordingInteraction, response, scriptedEngine } from '../../helpers/verbs/harness.js'

const noNetwork = {
  resolveHost: async (): Promise<string[]> => {
    throw new Error('unit lane: no DNS')
  },
  openPage: async (): Promise<never> => {
    throw new Error('unit lane: no page')
  },
}

describe('[audit-fixes.4] P22: a fetch cooldown is scoped to the site', () => {
  it('cooldownKeyFor: a search keys on the provider, a fetch on provider and host', () => {
    expect(cooldownKeyFor('github', false, 'vite')).toBe('github')
    expect(cooldownKeyFor('fetch', true, 'https://A.Example.com/x?y=1')).toBe('fetch.a.example.com')
    expect(cooldownKeyFor('fetch', true, 'not a url')).toBe('fetch')
  })

  it('cooldownKeyFor: keys stay inside the provider-id alphabet and 64 characters, and distinct long hosts stay distinct', () => {
    const a = cooldownKeyFor('fetch', true, `https://${'a'.repeat(70)}.example.com/`)
    const b = cooldownKeyFor('fetch', true, `https://${'a'.repeat(70)}.example.org/`)
    for (const k of [a, b, cooldownKeyFor('fetch', true, 'http://[2001:4860::1]/')]) expect(k).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    expect(a).not.toBe(b)
  })

  it('a cooldown armed for one host answers rate_limited for that host only', async () => {
    const world = makeWorld({ fetch: noNetwork })
    await world.svc.guard.setProviderCooldown(cooldownKeyFor('fetch', true, 'https://banned.example.com/a'), 'banned', 60_000)

    const same = await world.svc.search(input({ provider: 'fetch', query: 'https://banned.example.com/other-page' }))
    expect(same).toMatchObject({ outcome: 'rate_limited', attempts: 0 })
    expect(same.error).toMatch(/cooling down after a previous banned outcome/)

    const other = await world.svc.search(input({ provider: 'fetch', query: 'https://fine.example.org/page' }))
    expect(other.error ?? '').not.toMatch(/cooling down/)
    expect(other.outcome).not.toBe('rate_limited')
  })

  it('a search provider still cools down under its own id', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response({ outcome: 'rate_limited', error: 'slow' })).strategies })
    await world.svc.search(input())
    expect(await world.svc.guard.readProviderCooldown('github')).not.toBeNull()
  })
})

describe('[audit-fixes.4] P23: a solved captcha is not lost to maxAttempts', () => {
  it('maxAttempts 1: the human solves, the search runs once more on the same page and succeeds', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'solved' }), strategies: engine.strategies })
    const out = await world.svc.search(input({ maxAttempts: 1 }))
    expect(out).toMatchObject({ outcome: 'success', attempts: 2 })
    expect(engine.calls.map((c) => c.pageWsUrl)).toEqual(['ws://fake/page/1', 'ws://fake/page/1'])
    expect(await world.svc.tripwire.isTripped('github')).toBe(false)
  })

  it('the bonus is bounded: a page that keeps returning a captcha ends after at most three solved passes beyond maxAttempts', async () => {
    const order: string[] = []
    const engine = scriptedEngine((): ReturnType<typeof hitlResponse> => hitlResponse('captcha', 'https://github.com/sorry'))
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'solved' }), strategies: engine.strategies })
    const out = await world.svc.search(input({ maxAttempts: 1 }))
    expect(out.outcome).toBe('hitl')
    expect(engine.calls).toHaveLength(4)
  })

  it('an abort answer still ends the call without an extra pass', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'abort' }), strategies: engine.strategies })
    const out = await world.svc.search(input({ maxAttempts: 1 }))
    expect(out.outcome).toBe('hitl')
    expect(engine.calls).toHaveLength(1)
  })
})
