/**
 * A login interrupt is not a ban (inventory row I-13.b, commit 591e1a7): login_required writes no
 * lock and no audit line, a stored login_required lock never blocks the gate and a later
 * successful search clears it, while captcha, banned and rate_limited still block and count.
 * The cooldown stays unarmed for a hitl outcome. Real tripwire wiring over a temp data dir.
 * Ticket 8468f7b1 · [search-port-guards.11]
 */
import { describe, expect, it } from 'vitest'
import { auditLines, fireInput, makeEnv, T0 } from './guards-harness.js'

describe('login_required is not a ban [search-port-guards.11] 591e1a7', () => {
  it('login_required writes no tripwire: fire leaves no lock and no audit record', async () => {
    const env = makeEnv()
    expect(await env.tripwire.fire(fireInput('github', 'login_required'))).toBeNull()
    expect(env.fs.files()).toEqual([])
    expect(auditLines(env)).toEqual([])
    expect(await env.tripwire.tripwireStatus()).toEqual({})
  })

  it('a stored login_required lock never blocks the gate: open, no block counted, no audit line', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/github.lock', JSON.stringify({
      reason: 'login_required', provider: 'github', query: 'q', trippedAt: new Date(T0).toISOString(), blockedCount: 0,
    }))
    for (let i = 0; i < 3; i++) expect(await env.tripwire.gate('github')).toEqual({ locked: false, record: null })
    expect(auditLines(env)).toEqual([])
    expect(await env.tripwire.isTripped('github')).toBe(false)
    expect(env.fs.files().filter((f) => f.includes('.blocked'))).toEqual([])
    expect(await env.tripwire.tripwireStatus()).toEqual({})
  })

  it('a later successful search clears the stale login_required lock', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/github.lock', JSON.stringify({
      reason: 'login_required', provider: 'github', trippedAt: new Date(T0).toISOString(), blockedCount: 0,
    }))
    expect((await env.tripwire.gate('github')).locked).toBe(false)
    await env.tripwire.resolved('github')
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(false)
    expect(auditLines(env).map((l) => l['event'])).toContain('tripwire-resolved')
  })

  it.each(['captcha', 'banned', 'rate_limited'])('%s still locks, blocks the gate and counts the blocked call', async (reason) => {
    const env = makeEnv()
    expect(await env.tripwire.fire(fireInput('github', reason))).toMatchObject({ reason })
    const g = await env.tripwire.gate('github')
    expect(g.locked).toBe(true)
    expect(g.record).toMatchObject({ reason, blockedCount: 1 })
    expect(auditLines(env).map((l) => l['event'])).toEqual(['tripwire-fired', 'tripwire-gate-blocked'])
  })

  it('the guard cooldown stays unarmed for a hitl outcome that fired a login_required interrupt', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'login_required'))
    await env.guard.recordSearchOutcome('github', 'hitl')
    expect(await env.guard.cooldownRemainingMs('github')).toBe(0)
    expect(env.fs.files()).toEqual([])
  })
})
