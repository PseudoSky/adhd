/**
 * guards: a login_required hitl writes a tripwire, arms a cooldown, or skips navigating to the sign-in URL before asking
 * tier: S
 * cites: ticket 8468f7b1 [search-verbs.13]
 * The login interrupt flows through the verb without a lock (commit 591e1a7, delta report row 4):
 * a `login_required` hitl writes no tripwire and arms no cooldown, the revealed page is navigated to
 * the sign-in URL before the human is asked, a stored `login_required` lock never gates (and a success
 * clears it), while a lock of any other reason still fails fast with attempts 0 and zero Chrome calls.
 *
 * Inventory rows: I-13 (hitl keeps the context), I-13.b (login_required exemption).
 * Ticket 8468f7b1 · [search-verbs.13]
 */
import { describe, expect, it } from 'vitest'
import { searchError } from '../../../src/errors.js'
import { hitlResponse, input, makeFakeCore, makeWorld, recordingInteraction, response, scriptedEngine, T0 } from '../../helpers/verbs/harness.js'

const SIGN_IN = 'https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fsearch%3Fq%3Dvite%26type%3Dcode'
const storedLock = (world: ReturnType<typeof makeWorld>, reason: string) =>
  world.fs.writeText('/data/tripwire/github.lock', JSON.stringify({ reason, provider: 'github', query: 'vite', pageUrl: 'https://github.com/sorry', strategy: 'network', trippedAt: new Date(T0).toISOString(), blockedCount: 0 }))

describe('591e1a7: a login_required hitl writes no tripwire and arms no cooldown [search-verbs.13]', () => {
  it('login_required with an interaction port: reveal, then navigate to pageUrl, then confirmSolved; no tripwire, no cooldown, and a solved answer searches again', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('login_required', SIGN_IN), response())
    const world = makeWorld({ core: makeFakeCore(order), interaction: recordingInteraction(order, { solved: 'solved' }), strategies: engine.strategies })
    const out = await world.svc.search(input({ qualifier: 'type:code' }))

    expect(order).toEqual(['reveal', `navigate:${SIGN_IN}`, 'confirmSolved', 'dispose'])
    expect(world.core.navigations).toEqual([{ pageWsUrl: 'ws://fake/page/1', url: SIGN_IN }])
    // no tripwire: no lock file, no audit line, nothing listed
    expect(world.fs.files()).toEqual([])
    expect(await world.svc.tripwire.isTripped('github')).toBe(false)
    expect(await world.svc.tripwireStatus()).toEqual({})
    // no cooldown
    expect(await world.svc.guard.readProviderCooldown('github')).toBeNull()
    // the signed-in retry runs on the same page and succeeds: attempts counts both
    expect(out).toMatchObject({ outcome: 'success', attempts: 2 })
    expect(world.core.opened).toEqual([{ cdpHost: '127.0.0.1:9222', foreground: false, sharedProfile: true }])
  })

  it('the confirmSolved prompt is told the sign-in pageUrl and the reason', async () => {
    const order: string[] = []
    const interaction = recordingInteraction(order, { solved: 'abort' })
    const world = makeWorld({ core: makeFakeCore(order), interaction, strategies: scriptedEngine(hitlResponse('login_required', SIGN_IN)).strategies })
    await world.svc.search(input({ qualifier: 'type:code' }))
    expect(interaction.solvedCalls).toEqual([expect.objectContaining({ provider: 'github', reason: 'login_required', pageUrl: SIGN_IN, strategy: 'network' })])
  })

  it('login_required without an interaction port (MCP): the sign-in page is shown, the window stays open, hitl is returned with no tripwire', async () => {
    const order: string[] = []
    const world = makeWorld({ core: makeFakeCore(order), strategies: scriptedEngine(hitlResponse('login_required', SIGN_IN)).strategies })
    const out = await world.svc.search(input({ qualifier: 'type:code' }))
    expect(out).toMatchObject({ outcome: 'hitl', attempts: 1, hitl: { reason: 'login_required', pageUrl: SIGN_IN } })
    expect(order).toEqual(['reveal', `navigate:${SIGN_IN}`])
    expect(world.core.pages[0]?.disposed).toBe(0)
    expect(world.fs.files()).toEqual([])
    // the next search is not gated: login_required left no lock to fail fast on
    expect((await world.svc.search(input({ qualifier: 'type:code' }))).attempts).toBe(1)
    expect(world.core.opened).toHaveLength(2)
  })

  it('confirmSolved that rejects on a closed stdin takes the abort path: the hitl response is returned, not thrown, and the window stays open', async () => {
    const order: string[] = []
    const world = makeWorld({
      core: makeFakeCore(order),
      interaction: recordingInteraction(order, { solved: searchError('HITL_ABORTED', 'stdin closed') }),
      strategies: scriptedEngine(hitlResponse('login_required', SIGN_IN)).strategies,
    })
    const out = await world.svc.search(input({ qualifier: 'type:code' }))
    expect(out).toMatchObject({ outcome: 'hitl', attempts: 1 })
    expect(world.core.pages[0]?.disposed).toBe(0)
  })
})

describe('591e1a7: a stored lock and the gate [search-verbs.13]', () => {
  it('a stored login_required lock does not fail-fast: the search runs, and a success clears the lock', async () => {
    const engine = scriptedEngine(response())
    const world = makeWorld({ strategies: engine.strategies })
    storedLock(world, 'login_required')
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome: 'success', attempts: 1 })
    expect(engine.calls).toHaveLength(1)
    expect(world.core.opened).toHaveLength(1)
    expect(world.fs.exists('/data/tripwire/github.lock')).toBe(false)
  })

  it.each(['captcha', 'banned', 'rate_limited'])('a stored %s lock still fails fast: hitl, attempts 0, zero Chrome calls, the lock stays', async (reason) => {
    const engine = scriptedEngine(response())
    const world = makeWorld({ strategies: engine.strategies })
    storedLock(world, reason)
    const out = await world.svc.search(input())
    expect(out).toMatchObject({ outcome: 'hitl', attempts: 0 })
    expect(out.hitl?.reason).toBe(reason)
    expect(engine.calls).toHaveLength(0)
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
    expect(world.fs.exists('/data/tripwire/github.lock')).toBe(true)
  })
})
