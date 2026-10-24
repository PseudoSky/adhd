/**
 * guards: the README omits a safety opt-in flag, the result-size contract, or the thrown-versus-returned error contract
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [audit-fixes.4]
 * Audit findings P9, P19, P30 and P41: the documented behaviour must name every opt-in the host flags define for a
 * safety default, and the fields that bound a result. Reads package files only: no process, no network.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_FLAGS } from '../../../src/host-flags.js'

const root = join(__dirname, '..', '..', '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const errors = readFileSync(join(root, 'docs', 'ERRORS.md'), 'utf8')

describe('[audit-fixes.1] README documents the safety opt-ins', () => {
  const optIns = HOST_FLAGS.filter((f) => f.name.startsWith('allow-')).map((f) => f.name)

  it('finds the opt-in flags it checks (the test is not vacuous)', () => {
    expect(optIns).toEqual(expect.arrayContaining(['allow-cdp-hosts', 'allow-remote-listen']))
  })

  it.each(optIns)('--%s is named in the README', (name) => {
    expect(readme).toContain(`--${name}`)
  })
})

describe('[audit-fixes.4] README documents the result-size and fetch-outcome contract', () => {
  it('P41: maxResultBytes and omitted are documented, with the fetch provider named as the exception', () => {
    expect(readme).toMatch(/maxResultBytes/)
    expect(readme).toMatch(/`omitted`/)
    expect(readme).toMatch(/`fetch` provider does not use `maxResultBytes`/)
  })

  it('P19: ERRORS.md states one rule for a refused URL and it matches the code (returned, not thrown)', () => {
    expect(errors).toMatch(/A refused fetch URL is never thrown/)
    expect(errors).not.toMatch(/\(an unknown provider, a refused URL, a bad flag\)/)
  })
})
