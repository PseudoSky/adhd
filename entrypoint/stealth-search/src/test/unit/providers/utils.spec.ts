/**
 * Qualifier prepend and the GitHub type:code resolution on real provider ids, plus fallbackView.
 * Inventory rows I-10, I-10.a. Ticket 8468f7b1 · [search-port-providers.3] [search-port-providers.10] · commit 591e1a7.
 */
import { describe, expect, it } from 'vitest'
import { PROVIDERS, PROVIDER_NAMES, getProvider } from '../../../lib/providers.js'
import { applyQualifier, fallbackView, resolveProvider, stripTypeCode } from '../../../lib/utils.js'

const github = getProvider('github')

describe('qualifier prepend [search-port-providers.3]', () => {
  it('qualifier prepend: repo:owner/name is put in front of the github query', () => {
    expect(applyQualifier(github, 'repo:vitejs/vite', 'plugin api')).toBe('repo:vitejs/vite plugin api')
  })
  it('qualifier prepend: site:example.com is put in front of a google query', () => {
    expect(applyQualifier(getProvider('google'), 'site:example.com', 'pricing')).toBe('site:example.com pricing')
  })
  it('no-qualifier case: an empty or blank qualifier returns the query unchanged', () => {
    expect(applyQualifier(github, '', 'vite')).toBe('vite')
    expect(applyQualifier(github, '   ', 'vite')).toBe('vite')
  })
  it('fetch-provider no-prepend case: the query is a URL and is never corrupted by a qualifier', () => {
    expect(applyQualifier(getProvider('fetch'), 'site:example.com', 'https://react.dev/learn')).toBe('https://react.dev/learn')
  })
})

describe('type:code resolves to code search [search-port-providers.3]', () => {
  it('stripTypeCode removes the qualifier and collapses whitespace', () => {
    expect(stripTypeCode('useState type:code language:ts')).toBe('useState language:ts')
    expect(stripTypeCode('type:code useState')).toBe('useState')
    expect(stripTypeCode('no qualifier here')).toBe('no qualifier here')
  })

  it('type:code resolves to code search: a github query with the qualifier gets the override, an object that is not a registered provider', () => {
    const resolved = resolveProvider(github, applyQualifier(github, 'type:code', 'useState'))
    expect(resolved).not.toBe(github)
    expect(resolved.id).toBe('github')
    expect(resolved.url('type:code useState')).toBe('https://github.com/search?q=useState&type=code')
    expect(resolved.strategies).toEqual({ primary: 'network' })
    expect(PROVIDER_NAMES).toHaveLength(12)
    expect(Object.values(PROVIDERS)).not.toContain(resolved)
  })

  it('identity: no qualifier, a non-github provider with type:code, and a non-code github query all return the provider itself', () => {
    expect(resolveProvider(github, 'vite')).toBe(github)
    expect(resolveProvider(github, 'type:repositories vite')).toBe(github)
    for (const id of PROVIDER_NAMES.filter((n) => n !== 'github')) {
      const p = getProvider(id)
      expect(resolveProvider(p, 'x type:code')).toBe(p)
    }
  })
})

describe('fallbackView swaps the capture and resolveProvider overrides github code [search-port-providers.10]', () => {
  it('fallbackView of github is the page capture (github.com/search) while github.network still targets api.github.com (fallbackNetwork, 591e1a7)', () => {
    expect(fallbackView(github).network).toBe(github.fallbackNetwork)
    expect(fallbackView(github).network?.urlPattern).toContain('github.com/search')
    expect(github.network?.urlPattern).toContain('api.github.com')
    expect(fallbackView(github).id).toBe('github')
    expect(github.network?.urlPattern.startsWith('api.')).toBe(true)
    expect(fallbackView(github).network?.urlPattern.startsWith('api.')).toBe(false)
  })
  it('fallbackView of a provider without fallbackNetwork is that provider unchanged', () => {
    for (const id of PROVIDER_NAMES.filter((n) => n !== 'github')) {
      const p = getProvider(id)
      expect(fallbackView(p), id).toBe(p)
    }
  })
  it('the type:code override leaves fallbackNetwork undefined, carries sharedProfile true and emptyRequiresLogin (591e1a7)', () => {
    const code = resolveProvider(github, 'x type:code')
    expect(code.fallbackNetwork).toBeUndefined()
    expect(code.dom).toBeUndefined()
    expect(code.sharedProfile).toBe(true)
    expect(code.network?.emptyRequiresLogin).toBeDefined()
    expect(fallbackView(code)).toBe(code)
  })
  it('resolveProvider does not mutate the registered github provider', () => {
    resolveProvider(github, 'x type:code')
    expect(github.fallbackNetwork).toBeDefined()
    expect(github.strategies.fallback).toBe('network')
    expect(github.sharedProfile).toBeUndefined()
  })
})
