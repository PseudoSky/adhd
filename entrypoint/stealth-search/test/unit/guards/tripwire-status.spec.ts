/**
 * guards: tripwireStatus omits a locked provider, or clearTripwire does not record the cleared audit event
 * tier: S
 * cites: ticket 8468f7b1 [search-port-guards.3] [search-port-guards.10]
 * tripwireStatus / clearTripwire (inventory row I-15) and the researcher flow that makes the clear
 * path discoverable to agents (backlog 93dee018): search returns hitl, tripwireStatus lists the
 * provider with clearWith and expiresAt, clearTripwire records a cleared audit event, the next
 * search succeeds.
 * Ticket 8468f7b1 · [search-port-guards.3] [search-port-guards.10]
 */
import { describe, expect, it } from 'vitest'
import { fireInput, makeEnv, auditLines, T0 } from '../../helpers/guards/guards-harness.js'
import type { Env } from '../../helpers/guards/guards-harness.js'

describe('tripwireStatus is a sparse string-keyed record [search-port-guards.3] I-15', () => {
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

/** A minimal search over the real guard and tripwire: gate, cooldown, work, outcome bookkeeping. */
async function search(env: Env, provider: string, work: () => string): Promise<{ outcome: string }> {
  const gate = await env.tripwire.gate(provider)
  if (gate.locked) return { outcome: 'hitl' }
  if ((await env.guard.cooldownRemainingMs(provider)) > 0) return { outcome: 'rate_limited' }
  const outcome = work()
  await env.guard.recordSearchOutcome(provider, outcome)
  if (outcome === 'success') await env.tripwire.resolved(provider)
  return { outcome }
}

describe('researcher flow: tripped, listed with clearWith, clearTripwire, next search proceeds [search-port-guards.10] 93dee018', () => {
  it('a tripped provider answers hitl, tripwireStatus lists clearWith clearTripwire with trippedAt and expiresAt, clearTripwire returns true and records a cleared audit event', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    expect(await search(env, 'github', () => 'success')).toEqual({ outcome: 'hitl' })

    const status = await env.tripwire.tripwireStatus()
    const entry = status['github']
    expect(entry).toMatchObject({ clearWith: 'clearTripwire', trippedAt: new Date(T0).toISOString() })
    expect(entry?.expiresAt).toBe(new Date(T0 + 7200000).toISOString())
    expect(entry?.recoveryHint).toContain('clearTripwire("github")')

    expect(await env.tripwire.clearTripwire('github')).toBe(true)
    expect(auditLines(env).slice(-1)[0]).toMatchObject({ event: 'tripwire-cleared', key: 'github', method: 'mcp-clear' })

    expect(await search(env, 'github', () => 'success')).toEqual({ outcome: 'success' })
    expect(await env.tripwire.tripwireStatus()).toEqual({})
  })

  it('expiresAt follows the configured TTL and an expired lock is not listed', async () => {
    const env = makeEnv({ tripwireTtlMs: 60000 })
    await env.tripwire.fire(fireInput('github', 'banned'))
    expect((await env.tripwire.tripwireStatus())['github']?.expiresAt).toBe(new Date(T0 + 60000).toISOString())
    env.clock.now += 60001
    expect(await env.tripwire.tripwireStatus()).toEqual({})
  })
})
