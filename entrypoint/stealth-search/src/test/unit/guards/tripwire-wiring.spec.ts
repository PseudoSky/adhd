/**
 * The search wiring of the tripwire package (tripwire.ts over createTripwire), one case per
 * backlog item that the old hand-rolled search-tripwire.ts got wrong. Each title carries its uid.
 * Where the package itself does not deliver the behavior the spec states it with `it.fails`
 * (see the findings in the state report).
 * Ticket 8468f7b1 · [search-port-guards.9]
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DATA_DIR } from '../../../lib/config.js'
import { isSearchError } from '../../../errors.js'
import { auditLines, fireInput, makeEnv, T0 } from './guards-harness.js'

describe('tripwire wiring [search-port-guards.9]', () => {
  it('c6d7fbcf: a corrupt lock file fails closed (raises TRIPWIRE_STATE_UNREADABLE, never reads as clear)', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.fs.writeText('/data/tripwire/github.lock', '{"reason": "capt')
    await expect(env.tripwire.gate('github')).rejects.toSatisfy((e) => isSearchError(e, 'TRIPWIRE_STATE_UNREADABLE'))
    await expect(env.tripwire.isTripped('github')).rejects.toSatisfy((e) => isSearchError(e, 'TRIPWIRE_STATE_UNREADABLE'))
    expect((await env.tripwire.tripwireStatus())['github']).toMatchObject({ reason: 'unreadable-lock' })
  })

  it('982ea870: a SearchHostConfig dataDir override moves the lock and the audit file; nothing is written under the default root', async () => {
    const env = makeEnv({ dataDir: '/custom/root' })
    await env.tripwire.fire(fireInput('github', 'captcha'))
    await env.tripwire.gate('github')
    await env.tripwire.cleared('github')
    expect(env.config.auditPath).toBe('/custom/root/audit.log')
    expect(env.fs.exists('/custom/root/audit.log')).toBe(true)
    expect(env.fs.files().length).toBeGreaterThan(0)
    expect(env.fs.files().every((f) => f.startsWith('/custom/root/'))).toBe(true)
    expect(env.fs.ops.filter((o) => o.path.startsWith(DEFAULT_DATA_DIR) || (o.path2 ?? '').startsWith(DEFAULT_DATA_DIR))).toEqual([])
  })

  it('9487dcd0: created lock and audit files are 0600 in 0700 directories', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    await env.tripwire.gate('github')
    await env.guard.recordSearchOutcome('github', 'captcha')
    const files = env.fs.files()
    expect(files).toContain('/data/tripwire/github.lock')
    expect(files).toContain('/data/audit.log')
    for (const f of files) expect(env.fs.modeOf(f), f).toBe(0o600)
    for (const d of ['/data', '/data/tripwire', '/data/guard']) expect(env.fs.modeOf(d), d).toBe(0o700)
  })

  it('d201694e: re-tripping a tripped provider keeps the first cause and counts the re-trip', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha', { query: 'first' }))
    env.clock.now += 1000
    const second = await env.tripwire.fire(fireInput('github', 'banned', { query: 'second' }))
    expect(second).toMatchObject({ reason: 'captcha', query: 'first' })
    expect(await env.tripwire.read('github')).toMatchObject({ reason: 'captcha', query: 'first', trippedAt: new Date(T0).toISOString() })
    const events = auditLines(env).map((l) => l['event'])
    expect(events).toEqual(['tripwire-fired', 'tripwire-retripped'])
    expect(auditLines(env)[1]).toMatchObject({ reason: 'banned', trippedAt: new Date(T0).toISOString() })
  })

  it('a3266358: concurrent writes use distinct temp file names', async () => {
    const env = makeEnv()
    await Promise.all([
      ...Array.from({ length: 6 }, () => env.guard.setProviderCooldown('github', 'captcha', 1000)),
      ...Array.from({ length: 6 }, (_, i) => env.tripwire.fire(fireInput(i % 2 === 0 ? 'github' : 'brave', 'captcha'))),
    ])
    const tmps = env.fs.ops.filter((o) => o.op === 'openExclusive' && o.path.endsWith('.tmp')).map((o) => o.path)
    expect(tmps.length).toBeGreaterThanOrEqual(6)
    expect(new Set(tmps).size).toBe(tmps.length)
    expect(env.fs.files().filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(env.fs.readText('/data/guard/github.json') ?? '')).toMatchObject({ provider: 'github' })
  })

  it('6ae134b9: N concurrent blocked-count increments yield N', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    const N = 12
    await Promise.all(Array.from({ length: N }, () => env.tripwire.gate('github')))
    expect((await env.tripwire.read('github'))?.blockedCount).toBe(N)
    const blocked = auditLines(env).filter((l) => l['event'] === 'tripwire-gate-blocked')
    expect(blocked).toHaveLength(N)
    // a block counted after the clear must not resurrect the lock
    await env.tripwire.cleared('github')
    expect(await env.tripwire.read('github')).toBeNull()
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(false)
  })

  it('08801f2a: the audit cap rewrite is atomic and counts lines, with a multibyte case', async () => {
    const cap = 100000
    const env = makeEnv({ auditMaxBytes: cap })
    const path = '/' + '日本語'.repeat(40)
    await env.tripwire.fire(fireInput('github', 'captcha', { pageUrl: `https://ünï.example${path}?q=1` }))
    const total = 400
    for (let i = 0; i < total; i++) await env.tripwire.gate('github')
    const raw = env.fs.readBytes(env.config.auditPath)
    expect(raw).toBeDefined()
    expect(raw?.length ?? Infinity).toBeLessThanOrEqual(cap)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    const lines = text.split('\n')
    expect(lines.slice(-1)[0]).toBe('')
    const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as { event: string; blockedCount?: number; pageUrl?: string })
    // the oldest lines were dropped whole, the newest survive, and the sequence is contiguous
    expect(parsed.length).toBeLessThan(total)
    const counts = parsed.filter((p) => p.event === 'tripwire-gate-blocked').map((p) => p.blockedCount ?? -1)
    expect(counts.slice(-1)[0]).toBe(total)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBe((counts[i - 1] ?? 0) + 1)
    expect(decodeURIComponent(parsed.slice(-1)[0]?.pageUrl ?? '')).toContain('日本語')
    // the rewrite never writes into the live audit file in place
    expect(env.fs.ops.filter((o) => (o.op === 'openExclusive' || o.op === 'write') && o.path === env.config.auditPath)).toEqual([])
  })

  it('84e1f7a2: TTL expiry removal is audited (tripwire-expired, method expired, original reason kept)', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.clock.now += 7200001
    expect(await env.tripwire.gate('github')).toEqual({ locked: false, record: null })
    expect(env.fs.exists('/data/tripwire/github.lock')).toBe(false)
    const expired = auditLines(env).filter((l) => l['event'] === 'tripwire-expired')
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ key: 'github', method: 'expired', reason: 'captcha' })
  })

  // FINDING (tripwire package): the expiry audit line carries the original trip reason and
  // method 'expired', never the literal reason `ttl-expired` that backlog 84e1f7a2 names.
  it.fails('84e1f7a2: TTL expiry removal writes an audit line with reason ttl-expired', async () => {
    const env = makeEnv()
    await env.tripwire.fire(fireInput('github', 'captcha'))
    env.clock.now += 7200001
    await env.tripwire.gate('github')
    const expired = auditLines(env).filter((l) => l['event'] === 'tripwire-expired')
    expect(expired[0]?.['reason']).toBe('ttl-expired')
  })

  it('3aaa855f: the clear path leaves a final record identical to a plain delete, with no dead resolved or reverified write', async () => {
    const viaClear = makeEnv()
    await viaClear.tripwire.fire(fireInput('github', 'captcha'))
    await viaClear.tripwire.gate('github')
    const opsBefore = viaClear.fs.ops.length
    await viaClear.tripwire.cleared('github')

    const lock = '/data/tripwire/github.lock'
    expect(viaClear.fs.exists(lock)).toBe(false)
    // after the clear started, the lock file is only removed, never rewritten
    const clearOps = viaClear.fs.ops.slice(opsBefore).filter((o) => o.path === lock || o.path2 === lock)
    expect(clearOps.every((o) => o.op === 'unlink' || o.op === 'rename' || o.op === 'readFile' || o.op === 'stat')).toBe(true)
    expect(clearOps.some((o) => o.op === 'openExclusive' || o.op === 'write' || o.op === 'link')).toBe(false)
    // no resolved / reverified field is written anywhere
    for (const f of viaClear.fs.files()) {
      const t = viaClear.fs.readText(f) ?? ''
      expect(t, f).not.toMatch(/resolvedAt|reverifiedAt/)
    }
    // the same lock removed by hand leaves the same lock state
    const byHand = makeEnv()
    await byHand.tripwire.fire(fireInput('github', 'captcha'))
    await byHand.tripwire.gate('github')
    await byHand.fs.unlink(lock)
    expect(await byHand.tripwire.read('github')).toEqual(await viaClear.tripwire.read('github'))
    expect(byHand.fs.files().filter((f) => f.startsWith('/data/tripwire/') && f.endsWith('.lock'))).toEqual(
      viaClear.fs.files().filter((f) => f.startsWith('/data/tripwire/') && f.endsWith('.lock')),
    )
  })
})
