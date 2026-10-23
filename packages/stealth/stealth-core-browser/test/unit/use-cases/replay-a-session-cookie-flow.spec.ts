/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 * Exercises AC2 (read-only profile access), PA2.1 and the TARGET/CDP typed errors of the page-context verb.
 *
 * A developer replaying a logged-in flow needs to know which cookies the profile holds for the site of an
 * open tab: which are session cookies that die with Chrome and which persist, without the verb ever
 * handing the secret values to the caller.
 * guards: [tests-use-cases.3] separates session cookies from persistent ones
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3] [tests-use-cases.4]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPageContext, storage } from '../../../src/index.js'
import { ProfileBuilder, SESSION_COOKIES, type BuiltProfile } from '../../helpers/profile-fixtures.js'
import { ChromeWorld, useProfileHome } from '../../helpers/use-cases/scenario-kit.js'

const NOW = Date.now() / 1000
const world = new ChromeWorld(9402)
let profile: BuiltProfile
let home: ReturnType<typeof useProfileHome>

beforeEach(() => {
  profile = ProfileBuilder.realistic(NOW).history([{ url: 'https://app.test/dashboard', title: 'Dashboard', secondsAgo: 30, visits: 7 }]).build()
  home = useProfileHome(profile)
  world.up = true
  world.installFetch()
  world.tabs = [world.tab('T1', 'https://app.test/dashboard', 'Dashboard')]
})
afterEach(() => {
  world.dispose()
  home.restore()
})

describe('Scenario: replay a logged-in session by understanding which cookies survive', () => {
  it('[tests-use-cases.3] separates session cookies from persistent ones', () => {
    const jar = new storage.CookieClient(home.profileDir)
    const app = jar.getCookiesByDomain('app.test')
    expect(app.map((c) => c.name).sort()).toEqual(['csrf', 'remember', 'sid', 'theme'])
    const session = app.filter((c) => !c.hasExpires)
    const persistent = app.filter((c) => c.hasExpires)
    expect(session.map((c) => c.name).sort()).toEqual(['csrf', 'sid'])
    expect(session.every((c) => c.expiresUtc === null)).toBe(true)
    expect(persistent.every((c) => c.expiresUtc !== null && c.expiresUtc.getTime() > NOW * 1000)).toBe(true)
    expect(app.find((c) => c.name === 'sid')).toMatchObject({ isSecure: true, isHttpOnly: true, path: '/' })
    expect(jar.getCookies().length).toBe(SESSION_COOKIES.length)
    expect(jar.getCookiesByDomain('nobody.test')).toEqual([])
  })

  it('[tests-use-cases.2] getPageContext counts the cookies and visits of an open tab and never returns their values', async () => {
    world.useCdp({
      meta: { name: 'page-context', origin: 'synthetic-protocol-conformant' },
      steps: [{ when: { method: 'Target.getTargetInfo', params: { targetId: 'T1' } }, reply: { result: { targetInfo: { targetId: 'T1', type: 'page', title: 'Dashboard', url: 'https://app.test/dashboard' } } } }],
    })
    const result = await getPageContext({ targetId: 'T1', port: world.port })
    expect(result.found).toBe(true)
    expect(result.context).toMatchObject({ targetId: 'T1', url: 'https://app.test/dashboard', cookieCount: 4, hasHistory: true, historyVisits: 7 })
    const wire = JSON.stringify(result)
    for (const secret of ['opaque-session-token', 'opaque-csrf', 'opaque-remember']) expect(wire).not.toContain(secret)
    expect(world.requested.every((u) => new URL(u).port === String(world.port))).toBe(true)
  })

  it('[tests-use-cases.4] a tab that was closed is reported as not found, and an invalid port is a typed error', async () => {
    world.useCdp({ meta: { name: 'no-target', origin: 'synthetic-protocol-conformant' }, steps: [] })
    expect(await getPageContext({ targetId: 'GONE', port: world.port })).toEqual({ found: false, context: null })
    await expect(getPageContext({ targetId: 'T1', port: 70000 })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
  })
})
