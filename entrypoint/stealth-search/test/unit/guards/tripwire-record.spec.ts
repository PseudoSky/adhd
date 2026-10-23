/**
 * guards: a tripwire fire, gate, clear, resolve or read misreports state, or a legacy agent-search lock is not honoured
 * tier: S
 * cites: ticket 8468f7b1 [search-port-guards.3]
 * Tripwire over the tripwire package (inventory row I-21): fire, gate with blocked-count, cleared,
 * resolved, read, isTripped, an expired lock, a corrupt lock and the typed errors.
 * Decision O8: the namespace is `stealth-search`; a legacy `agent-search` flat lock under the same
 * root is still read and lapses with the 2 h TTL.
 * Ticket 8468f7b1 · [search-port-guards.3]
 */
import { describe, expect, it } from 'vitest'
import { TRIPWIRE_NAMESPACE } from '../../../src/lib/tripwire.js'
import { isSearchError } from '../../../src/errors.js'
import { auditLines, fireInput, makeEnv, T0 } from '../../helpers/guards/guards-harness.js'

describe('tripwire wiring [search-port-guards.3] I-21', () => {
  it('uses the stealth-search namespace of decision O8 (existing agent-search locks expire in 2 h)', async () => {
    expect(TRIPWIRE_NAMESPACE).toBe('stealth-search')
    const env = makeEnv()
    const rec = await env.tripwire.fire(fireInput('github', 'captcha'))
    expect(rec?.namespace).toBe('stealth-search')
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(true)
    expect(auditLines(env)[0]).toMatchObject({ namespace: 'stealth-search', event: 'tripwire-fired', key: 'github' })
  })

  it('tripwire lock lifecycle: fire, blocked gate, cleared, then open again', async () => {
    const env = makeEnv()
    expect(await env.tripwire.gate('github')).toEqual({ locked: false, record: null })
    const fired = await env.tripwire.fire(fireInput('github', 'captcha', { query: 'rust async' }))
    expect(fired).toMatchObject({ provider: 'github', reason: 'captcha', query: 'rust async', searchSessionId: 'sess-1', browserSessionId: 'tab-1', strategy: 'dom', blockedCount: 0 })
    expect(await env.tripwire.isTripped('github')).toBe(true)

    const g1 = await env.tripwire.gate('github')
    const g2 = await env.tripwire.gate('github')
    expect(g1.locked).toBe(true)
    expect(g1.record?.reason).toBe('captcha')
    expect(g2.record?.blockedCount).toBe(2)
    expect((await env.tripwire.read('github'))?.blockedCount).toBe(2)
    expect(auditLines(env).map((l) => l['event'])).toEqual(['tripwire-fired', 'tripwire-gate-blocked', 'tripwire-gate-blocked'])
    expect(auditLines(env)[2]).toMatchObject({ blockedCount: 2, reason: 'captcha' })

    expect(await env.tripwire.cleared('github')).toBe(true)
    expect(await env.tripwire.isTripped('github')).toBe(false)
    expect(await env.tripwire.gate('github')).toEqual({ locked: false, record: null })
    expect(auditLines(env).slice(-1)[0]).toMatchObject({ event: 'tripwire-cleared', method: 'mcp-clear', blockedCount: 2 })
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(false)
  })

  it('clear of a tripped provider is true and clear of an untripped one is false', async () => {
    const env = makeEnv()
    expect(await env.tripwire.cleared('github')).toBe(false)
    expect(auditLines(env)).toEqual([])
    await env.tripwire.fire(fireInput('github', 'banned'))
    expect(await env.tripwire.clearTripwire('github')).toBe(true)
    expect(await env.tripwire.clearTripwire('github')).toBe(false)
  })

  it('resolved audits tripwire-resolved and clears the lock (the success path)', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'rate_limited'))
    env.clock.now += 5000
    await env.tripwire.resolved('github')
    expect(await env.tripwire.isTripped('github')).toBe(false)
    const events = auditLines(env)
    expect(events.find((l) => l['event'] === 'tripwire-resolved')).toMatchObject({ reason: 'rate_limited', durationMs: 5000 })
    await expect(env.tripwire.resolved('github')).resolves.toBeUndefined()
  })

  it('an expired lock no longer blocks, is removed on the gate and is read as clear', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.clock.now = T0 + 7200000
    expect(await env.tripwire.isTripped('github')).toBe(true)
    env.clock.now = T0 + 7200001
    expect(await env.tripwire.read('github')).toBeNull()
    expect(await env.tripwire.isTripped('github')).toBe(false)
    expect(await env.tripwire.gate('github')).toEqual({ locked: false, record: null })
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(false)
  })

  it('honours the TTL from the config', async () => {
    const env = makeEnv({ tripwireTtlMs: 1000 })
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.clock.now += 1001
    expect(await env.tripwire.isTripped('github')).toBe(false)
  })

  it('a legacy agent-search flat lock is still honoured and lapses after the TTL (O8)', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/duckduckgo.lock', JSON.stringify({
      reason: 'captcha', provider: 'duckduckgo', query: 'old', searchSessionId: 'old-sess', browserSessionId: 'b', pageUrl: 'https://x/', strategy: 'dom',
      trippedAt: new Date(T0).toISOString(), reverifiedAt: null, resolvedAt: null, blockedCount: 0, lastOperation: 'x',
    }))
    const g = await env.tripwire.gate('duckduckgo')
    expect(g.locked).toBe(true)
    expect(g.record).toMatchObject({ reason: 'captcha', query: 'old', searchSessionId: 'old-sess', provider: 'duckduckgo' })
    env.clock.now += 7200001
    expect(await env.tripwire.isTripped('duckduckgo')).toBe(false)
  })

  it('a corrupt lock raises TRIPWIRE_STATE_UNREADABLE from gate, read and isTripped (never clear)', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/github.lock', '{garbage')
    for (const call of [() => env.tripwire.gate('github'), () => env.tripwire.read('github'), () => env.tripwire.isTripped('github')]) {
      await expect(call()).rejects.toSatisfy((e) => isSearchError(e, 'TRIPWIRE_STATE_UNREADABLE'))
    }
    // an agent can still clear it
    expect(await env.tripwire.clearTripwire('github')).toBe(true)
    expect(await env.tripwire.isTripped('github')).toBe(false)
  })

  it('an empty lock file is corrupt too', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/tripwire/github.lock', '')
    await expect(env.tripwire.gate('github')).rejects.toSatisfy((e) => isSearchError(e, 'TRIPWIRE_STATE_UNREADABLE'))
  })

  it('a failed clear raises TRIPWIRE_CLEAR_FAILED', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.fs.failOn({ op: ['unlink', 'rename'], path: /github\.lock/, code: 'EACCES' })
    await expect(env.tripwire.cleared('github')).rejects.toSatisfy((e) => isSearchError(e, 'TRIPWIRE_CLEAR_FAILED'))
  })

  it('refuses an invalid provider id with UNKNOWN_PROVIDER', async () => {
    const env = makeEnv()
    await expect(env.tripwire.gate('../x')).rejects.toSatisfy((e) => isSearchError(e, 'UNKNOWN_PROVIDER'))
  })
})
