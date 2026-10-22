/**
 * The 13 codes of the search entrypoint: each code is built through the real StealthSearchError class
 * (no mocking of the error class) and proven to be an instance of StealthSearchError AND
 * StealthCoreBrowserError, to carry its `code`, its remediation, its `exitCodeFor` status and the
 * `<CODE>: <message>` message format. Codes whose raising module belongs to a later state get their
 * real-path specs under that state's directory.
 * Ticket 8468f7b1 · [search-errors.1] [search-errors.2] [search-errors.3].
 */
import { describe, expect, it } from 'vitest'
import { StealthCoreBrowserError, exitCodeFor as coreExitCodeFor } from '@adhd/stealth-core-browser'
import { SEARCH_ERROR_CODES, SEARCH_REMEDIATION, StealthSearchError, exitCodeFor, isSearchError, isSearchErrorCode, searchError } from '../../../errors.js'
import type { SearchErrorCode } from '../../../errors.js'

const EXPECTED: ReadonlyArray<readonly [SearchErrorCode, number]> = [
  ['UNKNOWN_PROVIDER', 70],
  ['SEARCH_FAILED', 71],
  ['SELECTOR_TIMEOUT', 33],
  ['HITL_ABORTED', 2],
  ['TRIPWIRE_STATE_UNREADABLE', 72],
  ['TRIPWIRE_CLEAR_FAILED', 73],
  ['PROVIDER_STATE_IO', 74],
  ['FETCH_URL_REFUSED', 75],
  ['PDF_EXTRACT_FAILED', 76],
  ['HOST_FLAG_INVALID', 77],
  ['HOST_TRANSPORT_UNSUPPORTED', 78],
  ['HOST_BOOT_FAILED', 79],
  ['NODE_TOO_OLD', 12],
]

describe('SEARCH_ERROR_CODES registry [search-errors.1]', () => {
  it('lists exactly the 13 codes in documentation order', () => {
    expect([...SEARCH_ERROR_CODES]).toEqual(EXPECTED.map(([c]) => c))
  })

  it('has a remediation and a distinct exit status for every code', () => {
    for (const [code] of EXPECTED) expect(SEARCH_REMEDIATION[code].length).toBeGreaterThan(10)
    expect(new Set(EXPECTED.map(([c]) => exitCodeFor(c))).size).toBe(13)
  })

  it('exitCodeFor falls back to the core table and then to 1', () => {
    expect(exitCodeFor('CDP_TIMEOUT')).toBe(coreExitCodeFor('CDP_TIMEOUT'))
    expect(exitCodeFor('NOT_A_CODE')).toBe(1)
    expect(isSearchErrorCode('SEARCH_FAILED')).toBe(true)
    expect(isSearchErrorCode('CDP_TIMEOUT')).toBe(false)
  })
})

describe.each(EXPECTED)('%s [search-errors.2]', (code, exit) => {
  const cause = new StealthCoreBrowserError('CDP_TIMEOUT', 'underlying')
  const err = searchError(code, `the ${code} failure`, { cause, detail: { probe: code } })

  it('is a StealthSearchError and a StealthCoreBrowserError', () => {
    expect(err).toBeInstanceOf(StealthSearchError)
    expect(err).toBeInstanceOf(StealthCoreBrowserError)
    expect(err).toBeInstanceOf(Error)
    expect(isSearchError(err, code)).toBe(true)
    expect(err.name).toBe('StealthSearchError')
  })

  it('carries code, exitCodeFor status, cause and detail', () => {
    expect(err.code).toBe(code)
    expect(exitCodeFor(code)).toBe(exit)
    expect(err.cause).toBe(cause)
    expect(err.detail).toEqual({ probe: code })
  })

  it('formats the message as summary then remediation and exposes the remediation', () => {
    expect(err.message).toBe(`the ${code} failure — ${SEARCH_REMEDIATION[code]}`)
    expect(err.remediation).toBe(SEARCH_REMEDIATION[code])
  })

  it('is distinguishable from a plain core error', () => {
    expect(new StealthCoreBrowserError('CDP_TIMEOUT', 'x') instanceof StealthSearchError).toBe(false)
  })
})
