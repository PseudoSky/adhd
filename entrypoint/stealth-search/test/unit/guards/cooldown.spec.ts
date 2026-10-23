/**
 * guards: a provider cooldown is written non-atomically, expires late, survives expiry, or arms for a hitl outcome
 * tier: S
 * cites: ticket 8468f7b1 [search-port-guards.2]
 * Provider cooldown (inventory row I-19): atomic temp-file-then-rename writes to
 * `<data>/guard/<provider>.json`, the three durations, lazy removal of an expired cooldown,
 * the hitl exclusion and PROVIDER_STATE_IO for unreadable state.
 * Ticket 8468f7b1 · [search-port-guards.2]
 */
import { describe, expect, it } from 'vitest'
import { isSearchError } from '../../../src/errors.js'
import { makeEnv } from '../../helpers/guards/guards-harness.js'

describe('provider cooldown [search-port-guards.2] I-19', () => {
  it('cooldown arms and disarms atomically', async () => {
    const env = makeEnv()
    await env.guard.recordSearchOutcome('github', 'captcha', 'repo:x')
    const path = '/data/guard/github.json'
    expect(env.fs.exists(path)).toBe(true)
    // atomic: a unique temp file was created, then renamed over the final name, and none is left
    const rename = env.fs.ops.find((o) => o.op === 'rename')
    expect(rename?.path2).toBe(path)
    expect(rename?.path).toMatch(/\/data\/guard\/github\.json\.\d+\.[0-9a-f]+\.tmp$/)
    expect(env.fs.files().filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(await env.guard.cooldownRemainingMs('github')).toBe(30000)
    // success disarms
    await env.guard.recordSearchOutcome('github', 'success')
    expect(env.fs.exists(path)).toBe(false)
    expect(await env.guard.cooldownRemainingMs('github')).toBe(0)
    // empty disarms too
    await env.guard.recordSearchOutcome('github', 'banned')
    expect(env.fs.exists(path)).toBe(true)
    await env.guard.recordSearchOutcome('github', 'empty')
    expect(env.fs.exists(path)).toBe(false)
  })

  it('arms the three cooldown durations 30000, 20000 and 60000 from the config', async () => {
    const env = makeEnv()
    for (const [outcome, ms] of [['captcha', 30000], ['rate_limited', 20000], ['banned', 60000]] as const) {
      expect(env.guard.cooldownForOutcome(outcome)).toBe(ms)
      await env.guard.recordSearchOutcome(outcome, outcome)
      const cd = await env.guard.readProviderCooldown(outcome)
      expect(cd).toMatchObject({ provider: outcome, reason: outcome, until: env.clock.now + ms })
    }
    const custom = makeEnv({ cooldownCaptchaMs: 5, cooldownRateMs: 6, cooldownBannedMs: 7 })
    expect([custom.guard.cooldownForOutcome('captcha'), custom.guard.cooldownForOutcome('rate_limited'), custom.guard.cooldownForOutcome('banned')]).toEqual([5, 6, 7])
  })

  it('removes an expired cooldown lazily on read and only then', async () => {
    const env = makeEnv()
    await env.guard.recordSearchOutcome('github', 'rate_limited')
    env.clock.now += 19999
    expect(await env.guard.cooldownRemainingMs('github')).toBe(1)
    expect(env.fs.exists('/data/guard/github.json')).toBe(true)
    env.clock.now += 1
    // nothing removed until a read happens (lazy)
    expect(env.fs.exists('/data/guard/github.json')).toBe(true)
    expect(await env.guard.cooldownRemainingMs('github')).toBe(0)
    expect(env.fs.exists('/data/guard/github.json')).toBe(false)
  })

  it('never arms a cooldown for a hitl outcome and leaves an armed one alone', async () => {
    const env = makeEnv()
    await env.guard.recordSearchOutcome('github', 'hitl')
    expect(env.fs.files()).toEqual([])
    await env.guard.recordSearchOutcome('github', 'captcha')
    await env.guard.recordSearchOutcome('github', 'hitl')
    expect(env.fs.exists('/data/guard/github.json')).toBe(true)
    for (const other of ['error', 'timeout', 'weird']) {
      await env.guard.recordSearchOutcome('github', other)
      expect(env.fs.exists('/data/guard/github.json')).toBe(true)
    }
  })

  it('creates the cooldown file 0600 in a 0700 directory and records the query', async () => {
    const env = makeEnv()
    await env.guard.setProviderCooldown('github', 'captcha', 100, 'q1')
    expect(env.fs.modeOf('/data/guard/github.json')).toBe(0o600)
    expect(env.fs.modeOf('/data/guard')).toBe(0o700)
    expect((await env.guard.readProviderCooldown('github'))?.query).toBe('q1')
  })

  it('shares one cooldown between two guards over the same data dir (cross-process)', async () => {
    const env = makeEnv()
    const other = (await import('../../../src/lib/guard.js')).createSearchGuard(env.config)
    await env.guard.recordSearchOutcome('github', 'captcha')
    expect(await other.cooldownRemainingMs('github')).toBe(30000)
  })

  it('raises PROVIDER_STATE_IO for a corrupt, mis-shaped or unreadable state file', async () => {
    const env = makeEnv()
    env.fs.writeText('/data/guard/github.json', '{not json')
    await expect(env.guard.readProviderCooldown('github')).rejects.toSatisfy((e) => isSearchError(e, 'PROVIDER_STATE_IO'))
    env.fs.writeText('/data/guard/github.json', '{"until":"soon"}')
    await expect(env.guard.cooldownRemainingMs('github')).rejects.toSatisfy((e) => isSearchError(e, 'PROVIDER_STATE_IO'))
    env.fs.failOn({ op: 'readFile', path: '/data/guard/github.json', code: 'EACCES' })
    await expect(env.guard.readProviderCooldown('github')).rejects.toSatisfy((e) => isSearchError(e, 'PROVIDER_STATE_IO'))
  })

  it('raises PROVIDER_STATE_IO when the rename fails and removes the temp file', async () => {
    const env = makeEnv()
    env.fs.failOn({ op: 'rename', code: 'ENOSPC' })
    await expect(env.guard.setProviderCooldown('github', 'captcha', 10)).rejects.toSatisfy((e) => isSearchError(e, 'PROVIDER_STATE_IO'))
    expect(env.fs.files()).toEqual([])
  })

  it('raises PROVIDER_STATE_IO when a cooldown cannot be removed, but not when it is already gone', async () => {
    const env = makeEnv()
    await expect(env.guard.clearProviderCooldown('github')).resolves.toBeUndefined()
    await env.guard.recordSearchOutcome('github', 'captcha')
    env.fs.failOn({ op: 'unlink', path: '/data/guard/github.json', code: 'EACCES' })
    await expect(env.guard.clearProviderCooldown('github')).rejects.toSatisfy((e) => isSearchError(e, 'PROVIDER_STATE_IO'))
  })

  it('refuses a provider id that would escape the guard directory', async () => {
    const env = makeEnv()
    await expect(env.guard.readProviderCooldown('../tripwire/x')).rejects.toSatisfy((e) => isSearchError(e, 'UNKNOWN_PROVIDER'))
  })
})
