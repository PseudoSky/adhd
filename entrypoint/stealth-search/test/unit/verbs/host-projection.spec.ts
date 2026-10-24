/**
 * guards: a cookie-shaped object loses its value wherever the core puts it: as the root, as an array element under any key, in a nested object, inside another cookie-shaped record
 * tier: S
 * cites: ticket 8468f7b1 [resolve-findings.4] (F115 F116)
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/verbs/host-projection.spec.ts -> exit 1 with walk() restored to strip only under a `cookies` key and as a direct property (2 failed | 3 passed): the array-element and root cases fail.
 * Real use: getPageContext returns whatever the core returns today; a future core field (`sessions: [{name, value}]`) must not leak.
 */
import { describe, expect, it } from 'vitest'
import { redactCookieValues } from '../../../src/host-projection.js'

describe('8468f7b1 [resolve-findings.4] redactCookieValues strips a cookie value at any position', () => {
  it('a cookie-shaped array element under a key other than `cookies`', () => {
    const out = redactCookieValues({ sessions: [{ name: 'sid', value: 'SECRET123', host: 'a.test' }] })
    expect(out).toEqual({ sessions: [{ name: 'sid', host: 'a.test' }] })
  })

  it('a cookie-shaped root value and a root array of cookies', () => {
    expect(redactCookieValues({ name: 'sid', value: 'SECRET123' })).toEqual({ name: 'sid' })
    expect(redactCookieValues([{ name: 'a', value: 'SECRET123' }, { name: 'b', value: 'SECRET456' }])).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('a cookie deep inside nested arrays and objects', () => {
    const out = redactCookieValues({ a: { b: [[{ c: { name: 'deep', value: 'SECRET123' } }]] } })
    expect(JSON.stringify(out)).not.toContain('SECRET123')
    expect(out).toEqual({ a: { b: [[{ c: { name: 'deep' } }]] } })
  })

  it('keeps non-cookie shapes: a `value` without a string name, and a name without a value', () => {
    const input = { setting: { value: 'keep' }, label: { name: 'x' }, n: 1, s: 'v', nil: null }
    expect(redactCookieValues(input)).toEqual(input)
  })

  it('never mutates its input', () => {
    const input = { sessions: [{ name: 'sid', value: 'SECRET123' }] }
    const before = JSON.stringify(input)
    redactCookieValues(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
