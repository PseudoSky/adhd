/**
 * A forced strategy a provider cannot run is a usage error before any CDP work: SEARCH_FAILED with the
 * structured reason `strategy-unsupported`, raised before a page is opened, a gate is consulted or the
 * retry loop is entered. `network` and `auto` run on github; a provider with a `dom` config accepts `dom`.
 *
 * Ticket 8468f7b1 · commit 591e1a7 · [search-verbs.15]
 */
import { describe, expect, it } from 'vitest'
import { StealthSearchError } from '../../../errors.js'
import { countingFs, hitlResponse, input, makeFakeCore, makeWorld, recordingInteraction, response, scriptedEngine } from './harness.js'

describe('591e1a7: strategy-unsupported is raised before any page [search-verbs.15]', () => {
  it('github + dom rejects with a StealthSearchError SEARCH_FAILED whose reason is strategy-unsupported and whose message names github and dom', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    const err = await world.svc.search(input({ strategy: 'dom' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthSearchError)
    const e = err as StealthSearchError
    expect(e.code).toBe('SEARCH_FAILED')
    expect(e.detail).toMatchObject({ reason: 'strategy-unsupported', provider: 'github', strategy: 'dom' })
    expect(e.message).toContain('github')
    expect(e.message).toContain('dom')
  })

  it('before any page: zero page opens, zero Chrome calls, zero fs/gate reads, zero engine attempts and zero prompts for the rejected call', async () => {
    const order: string[] = []
    const fsProbe = { count: () => 0 }
    const engine = scriptedEngine(response())
    const interaction = recordingInteraction(order)
    const world = makeWorld({
      core: makeFakeCore(order),
      interaction,
      strategies: engine.strategies,
      wrapFs: (fs) => {
        const c = countingFs(fs)
        fsProbe.count = c.count
        return c.fs
      },
    })
    await expect(world.svc.search(input({ strategy: 'dom' }))).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(world.core.opened).toHaveLength(0)
    expect(world.core.ensured).toBe(0)
    expect(world.core.noted).toBe(0)
    expect(fsProbe.count()).toBe(0)
    expect(engine.calls).toHaveLength(0)
    expect(interaction.gateCalls).toHaveLength(0)
    expect(order).toEqual([])
    expect(world.logs).toEqual(['[search] github: strategy-unsupported (dom); nothing was opened'])
  })

  it('the usage error wins over a stored tripwire lock: no gate prompt, and the lock is untouched', async () => {
    const order: string[] = []
    const interaction = recordingInteraction(order)
    const world = makeWorld({ core: makeFakeCore(order), interaction, strategies: scriptedEngine(hitlResponse('captcha')).strategies })
    world.fs.writeText('/data/tripwire/github.lock', JSON.stringify({ reason: 'captcha', provider: 'github', query: 'q', pageUrl: 'https://github.com/sorry', strategy: 'network', trippedAt: new Date().toISOString(), blockedCount: 0 }))
    await expect(world.svc.search(input({ strategy: 'dom' }))).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(interaction.gateCalls).toHaveLength(0)
    expect(world.fs.exists('/data/tripwire/github.lock')).toBe(true)
  })

  it.each(['network', 'auto'] as const)('github accepts strategy %s and runs the engine on one page', async (strategy) => {
    const engine = scriptedEngine(response())
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input({ strategy }))
    expect(out).toMatchObject({ outcome: 'success', attempts: 1 })
    expect(engine.calls).toHaveLength(1)
    expect(world.core.opened).toHaveLength(1)
  })

  it.each(['duckduckgo', 'google', 'arxiv', 'npm', 'crates', 'pypi', 'mdn', 'stackoverflow'] as const)('%s has a dom config and accepts strategy dom', async (provider) => {
    const engine = scriptedEngine(response({ provider }))
    const world = makeWorld({ strategies: engine.strategies })
    const out = await world.svc.search(input({ provider, query: 'tree-sitter', strategy: 'dom' }))
    expect(out.outcome).toBe('success')
    expect(engine.calls[0]?.options).toMatchObject({ strategy: 'dom' })
  })

  it.each(['maven', 'wikipedia'] as const)('%s has no dom config and rejects strategy dom with strategy-unsupported before any page', async (provider) => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await expect(world.svc.search(input({ provider, strategy: 'dom' }))).rejects.toMatchObject({ code: 'SEARCH_FAILED', detail: { reason: 'strategy-unsupported', provider, strategy: 'dom' } })
    expect(world.core.opened).toHaveLength(0)
  })
})
