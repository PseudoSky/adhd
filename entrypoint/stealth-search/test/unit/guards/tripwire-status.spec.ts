/**
 * guards: tripwireStatus omits a locked provider, or clearTripwire does not record the cleared audit event
 * tier: S
 * cites: ticket 8468f7b1 [search-port-guards.3] [search-port-guards.10] [resolve-findings.4]
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/guards/tripwire-status.spec.ts -> exit 1; with the search service's tripwire gate disabled the researcher flow's second search reaches the engine and fails 'the gate answered the second search'
 * tripwireStatus / clearTripwire (inventory row [I-15]) and the researcher flow that makes the clear
 * path discoverable to agents (backlog 93dee018): search returns hitl, tripwireStatus lists the
 * provider with clearWith and expiresAt, clearTripwire records a cleared audit event, the next
 * search succeeds.
 * Ticket 8468f7b1 · [search-port-guards.3] [search-port-guards.10]
 */
import { describe, expect, it } from 'vitest'
import { fireInput, makeEnv, T0 } from '../../helpers/guards/guards-harness.js'
import { hitlResponse, input, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'

describe('tripwireStatus is a sparse string-keyed record [search-port-guards.3] [I-15]', () => {
  it('clear returns false when not tripped', async () => {
    const env = makeEnv()
    expect(await env.tripwire.clearTripwire('github')).toBe(false)
  })

  it('lists only tripped providers (sparse), never the whole provider union', async () => {
    const env = makeEnv()
    expect(await env.tripwire.tripwireStatus()).toEqual({})
    await env.tripwire.fire(fireInput('github', 'captcha'))
    await env.tripwire.fire(fireInput('duckduckgo', 'banned'))
    const status = await env.tripwire.tripwireStatus()
    expect(Object.keys(status).sort()).toEqual(['duckduckgo', 'github'])
    expect(status['github']).toMatchObject({ provider: 'github', reason: 'captcha' })
    expect(status['brave']).toBeUndefined()
  })

  it('lists a corrupt lock so an agent can clear it', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/github.lock', '{garbage')
    const status = await env.tripwire.tripwireStatus()
    expect(status['github']).toMatchObject({ reason: 'unreadable-lock', clearWith: 'clearTripwire' })
  })
})

describe('researcher flow: tripped, listed with clearWith, clearTripwire, next search proceeds [search-port-guards.10] 93dee018', () => {
  it('a captcha hitl trips the provider through the product search service, the next search answers hitl, tripwireStatus lists clearWith clearTripwire, clearTripwire records a cleared audit event and the following search succeeds', async () => {
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const world = makeWorld({ strategies: engine.strategies })

    const first = await world.svc.search(input())
    expect(first.outcome).toBe('hitl')
    const second = await world.svc.search(input())
    expect(second.outcome).toBe('hitl')
    expect(engine.calls).toHaveLength(1) // the gate answered the second search; no page work

    const entry = (await world.svc.tripwireStatus())['github']
    expect(entry).toMatchObject({ clearWith: 'clearTripwire', reason: 'captcha', trippedAt: new Date(T0).toISOString() })
    expect(entry?.expiresAt).toBe(new Date(T0 + 7200000).toISOString())
    expect(entry?.recoveryHint).toContain('clearTripwire("github")')

    expect((await world.svc.clearTripwire('github')).cleared).toBe(true)
    const audit = world.fs.readText(world.svc.config.auditPath) ?? ''
    const last = JSON.parse(audit.trim().split('\n').slice(-1)[0] as string) as Record<string, unknown>
    expect(last).toMatchObject({ event: 'tripwire-cleared', key: 'github', method: 'mcp-clear' })

    expect((await world.svc.search(input())).outcome).toBe('success')
    expect(await world.svc.tripwireStatus()).toEqual({})
  })

  it('expiresAt follows the configured TTL and an expired lock is not listed', async () => {
    const env = makeEnv({ tripwireTtlMs: 60000 })
    await env.tripwire.fire(fireInput('github', 'banned'))
    expect((await env.tripwire.tripwireStatus())['github']?.expiresAt).toBe(new Date(T0 + 60000).toISOString())
    env.clock.now += 60001
    expect(await env.tripwire.tripwireStatus()).toEqual({})
  })
})
