/**
 * A forced strategy a provider cannot run is a SEARCH_FAILED StealthSearchError (no new code) whose
 * structured detail carries reason 'strategy-unsupported'; HITL_ABORTED exits 2 like a hitl response.
 * Ticket 8468f7b1 · [search-errors.7] · delta commit 591e1a7.
 */
import { describe, expect, it } from 'vitest'
import { StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import { SEARCH_ERROR_CODES, StealthSearchError, exitCodeFor, strategyUnsupported } from '../../../errors.js'

describe('591e1a7 strategy-unsupported is a SEARCH_FAILED error', () => {
  const err = strategyUnsupported('arxiv', 'dom')

  it('strategy-unsupported builds a SEARCH_FAILED StealthSearchError with exitCodeFor 71', () => {
    expect(err).toBeInstanceOf(StealthSearchError)
    expect(err).toBeInstanceOf(StealthCoreBrowserError)
    expect(err.code).toBe('SEARCH_FAILED')
    expect(exitCodeFor(err.code)).toBe(71)
  })

  it('strategy-unsupported detail reason names provider and strategy in the message', () => {
    expect(err.detail).toEqual({ reason: 'strategy-unsupported', provider: 'arxiv', strategy: 'dom' })
    expect(err.message).toContain('arxiv')
    expect(err.message).toContain('dom')
  })

  it('strategy-unsupported adds no code to the registry of 13', () => {
    expect(SEARCH_ERROR_CODES).toHaveLength(13)
    expect(SEARCH_ERROR_CODES).not.toContain('STRATEGY_UNSUPPORTED')
  })

  it('591e1a7 strategy-unsupported keeps caller detail alongside the reason', () => {
    expect(strategyUnsupported('npm', 'api', { detail: { query: 'x' } }).detail).toMatchObject({ reason: 'strategy-unsupported', query: 'x' })
  })
})

describe('591e1a7 HITL_ABORTED exitCodeFor is 2', () => {
  it('HITL_ABORTED exitCodeFor equals 2, the exit code of a hitl response', () => {
    expect(exitCodeFor('HITL_ABORTED')).toBe(2)
  })
})
