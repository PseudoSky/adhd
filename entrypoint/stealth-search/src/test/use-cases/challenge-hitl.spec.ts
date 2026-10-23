/**
 * Use case: a search hits a Cloudflare managed challenge, then a human gate. The real engine
 * (`runStrategies`, `recoverFromChallenge`) runs over a fake CDP page (HTML fixtures labelled
 * synthetic-protocol-conformant) and the real search service runs over the fake core; only the
 * Chrome/CDP edge and the clock are injected. No process, no socket, no Chrome.
 * Ported from the agent-search end-to-end challenge and HITL scenarios (I-12, I-13, I-14).
 * Ticket 8468f7b1 · [search-usecases.1] [search-usecases.2] [search-usecases.5] [search-usecases.6]
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../lib/providers.js'
import { runStrategies } from '../../lib/network.js'
import { body, FakePage, fixture, makeClock, makeDeps, recordingCapture } from '../unit/engine/harness.js'
import { hitlResponse, input, makeFakeCore, makeWorld, recordingInteraction, response, scriptedEngine } from '../unit/verbs/harness.js'

const pypi = getProvider('pypi')
const challengeHtml = fixture('cf-challenge.html')
const clearHtml = fixture('pypi-results.html')
const pageRef = (revealed: string[]) => ({ pageWsUrl: 'ws://page', reveal: async () => void revealed.push('reveal') })

describe('managed-challenge recovery: reveal, poll, retry once', () => {
  it('a Cloudflare challenge clears once the window is revealed, and the search is retried exactly once', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async (_c, n) => (n === 0 ? body(challengeHtml) : body(clearHtml)))
    const clean = new FakePage({ html: clearHtml })

    const r = await runStrategies(pageRef(revealed), pypi, 'requests', {}, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => clean }))

    expect(revealed).toEqual(['reveal'])
    expect(rec.calls).toHaveLength(2)
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(2)
    expect(clean.closed).toBe(1)
  })

  it('a challenge that never clears ends as hitl captcha for the human gate, with one capture and no retry', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))
    const stuck = new FakePage({ html: challengeHtml })

    const r = await runStrategies(pageRef(revealed), pypi, 'requests', { challengeWaitMs: 6000 }, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => stuck }))

    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('captcha')
    expect(rec.calls).toHaveLength(1)
    expect(revealed).toEqual(['reveal'])
  })

  it('there is no second retry: a challenge that survives the retry is hitl captcha after exactly two captures', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))
    const clean = new FakePage({ html: clearHtml })

    const r = await runStrategies(pageRef(revealed), pypi, 'requests', {}, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => clean }))

    expect(r.outcome).toBe('hitl')
    expect(rec.calls).toHaveLength(2)
    expect(revealed).toEqual(['reveal'])
  })

  it('challengeWaitMs 0 disables the recovery: no reveal, no retry, the captcha goes to the caller', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))

    const r = await runStrategies(pageRef(revealed), pypi, 'requests', { challengeWaitMs: 0 }, makeDeps({ capture: rec.capture, clock: makeClock() }))

    expect(r.outcome).toBe('hitl')
    expect(rec.calls).toHaveLength(1)
    expect(revealed).toEqual([])
  })
})

describe('a HITL outcome fires the tripwire, reveals the page and keeps the context alive', () => {
  it('the tripwire records the page, the window is revealed and the page is not disposed', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })

    const out = await world.svc.search(input())

    expect(out).toMatchObject({ outcome: 'hitl', attempts: 1, hitl: { reason: 'captcha', pageUrl: 'https://github.com/sorry' } })
    expect(await world.svc.tripwire.read('github')).toMatchObject({ reason: 'captcha', pageUrl: 'https://github.com/sorry', browserSessionId: 'tab-1' })
    const [page] = world.core.pages
    expect(page?.revealed).toBe(1)
    expect(page?.disposed).toBe(0)
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
  })

  it('hitl does not arm the cooldown; the next search fails fast on the tripwire with attempts 0 and no second window', async () => {
    const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies })
    await world.svc.search(input())
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()

    const second = await world.svc.search(input())

    expect(second).toMatchObject({ outcome: 'hitl', attempts: 0 })
    expect(world.core.opened).toHaveLength(1)
  })

  it('a human who solves the challenge releases the lock and the search continues on the same kept page', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'solved' }), strategies: engine.strategies })

    const out = await world.svc.search(input())

    expect(out).toMatchObject({ outcome: 'success', attempts: 2 })
    expect(await world.svc.tripwire.isTripped('github')).toBe(false)
    expect(engine.calls.map((c) => c.pageWsUrl)).toEqual(['ws://fake/page/1', 'ws://fake/page/1'])
    expect(world.core.opened).toHaveLength(1)
    expect(order.indexOf('reveal')).toBeLessThan(order.indexOf('confirmSolved'))
  })

  it('a human who aborts keeps the lock and the page stays open', async () => {
    const order: string[] = []
    const world = makeWorld({
      core: makeFakeCore(order),
      interaction: recordingInteraction(order, { solved: 'abort' }),
      strategies: scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry')).strategies,
    })

    expect((await world.svc.search(input())).outcome).toBe('hitl')

    expect(await world.svc.tripwire.isTripped('github')).toBe(true)
    expect(world.core.pages[0]?.disposed).toBe(0)
  })
})

describe('page disposal rules', () => {
  it('the default disposes the page once the search is done', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.search(input())
    expect(world.core.pages.map((p) => p.disposed)).toEqual([1])
    expect(world.core.live).toBe(0)
  })

  it('pageDisposal keep leaves the page open for the agent to inspect', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await world.svc.search(input({ pageDisposal: 'keep' }))
    expect(world.core.pages.map((p) => p.disposed)).toEqual([0])
  })

  it('an engine failure leaks no page: it is disposed and the slot released', async () => {
    const world = makeWorld({
      strategies: async () => {
        throw new TypeError('socket closed mid-search')
      },
    })
    await expect(world.svc.search(input())).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(world.core.pages.map((p) => p.disposed)).toEqual([1])
    expect(world.svc.guard.searchConcurrencyInfo().active).toBe(0)
  })
})
