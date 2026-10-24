/**
 * guards: the outcome set, the HitlInfo login_required reason or the provider shape drifts from the contract
 * tier: S
 * cites: ticket 8468f7b1 [search-port-providers.2] [search-port-providers.10]
 * Shared types: the eight outcomes, HitlInfo including the login_required reason, the core PageSource
 * on a result, and the two-config provider shape. Inventory row [I-23].
 * Ticket 8468f7b1 · [search-port-providers.2] [search-port-providers.10] · commit 591e1a7.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PageSource } from '@adhd/stealth-core-browser'
import type { HitlInfo, ProviderConfig, SearchOutcome, SearchResponse, SearchResult } from '../../../src/lib/types.js'
import { getProvider } from '../../../src/lib/providers.js'
import { resolveProvider } from '../../../src/lib/utils.js'

const here = dirname(fileURLToPath(import.meta.url))
const typesSource = readFileSync(join(here, '../../../src/lib/types.ts'), 'utf8')

describe('outcome and HitlInfo shapes [search-port-providers.2]', () => {
  it('outcome and HitlInfo shapes: all eight outcomes are assignable and a login_required hitl response typechecks', () => {
    const all: SearchOutcome[] = ['success', 'empty', 'error', 'timeout', 'hitl', 'captcha', 'rate_limited', 'banned']
    expect(new Set(all).size).toBe(8)
    const hitl: HitlInfo = {
      pageUrl: 'https://github.com/search?q=useState&type=code',
      reason: 'login_required',
      provider: 'github',
      query: 'useState type:code',
      trippedAt: '2026-10-21T00:00:00.000Z',
      strategy: 'network',
    }
    const response: SearchResponse = { provider: 'github', query: 'useState type:code', count: 0, results: [], outcome: 'hitl', hitl, tookMs: 5, attempts: 1, strategy: 'network' }
    expect(response.hitl?.reason).toBe('login_required')
  })

  it('a SearchResult carries the core PageSource as its source', () => {
    const source: PageSource = { provider: 'github', strategy: 'network', capturedUrl: 'https://api.github.com/search/repositories?q=vite', position: 0, capturedAt: '2026-10-21T00:00:00.000Z' }
    const r: SearchResult = { title: 'vitejs/vite', url: 'https://github.com/vitejs/vite', snippet: '', source }
    expect(r.source?.provider).toBe('github')
  })

  it('types.ts imports PageSource from the core, never defines it, and has no optional boolean', () => {
    expect(typesSource).toMatch(/import type \{[^}]*PageSource[^}]*\} from '@adhd\/stealth-core-browser'/)
    expect(typesSource).not.toMatch(/(interface|type)\s+(PageSource|SearchResultSource)\b/)
    expect(typesSource).not.toMatch(/\?\s*:\s*boolean/)
  })
})

describe('two-config provider shape [search-port-providers.10]', () => {
  it('sharedProfile is the literal true on the type:code override and absent on the repository provider; emptyRequiresLogin and fallbackNetwork live on the network configs (591e1a7)', () => {
    const code: ProviderConfig = resolveProvider(getProvider('github'), 'x type:code')
    const sharedProfile: true | undefined = code.sharedProfile
    expect(sharedProfile).toBe(true)
    expect(getProvider('github').sharedProfile).toBeUndefined()
    expect(code.network?.emptyRequiresLogin?.pattern).toBeInstanceOf(RegExp)
    expect(getProvider('github').fallbackNetwork).toBeDefined()
    expect(typesSource).toMatch(/sharedProfile\?\s*:\s*true/)
    expect(typesSource).toContain('login_required')
  })
})
