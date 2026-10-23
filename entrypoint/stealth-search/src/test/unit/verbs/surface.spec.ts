/**
 * The eleven-verb surface: exactly the eleven function exports, every verb takes at most one JSON input
 * object, `SearchInput` carries the enums and no optional boolean, `launchChrome` has no `chromePath` or
 * `extraArgs`, and `getPageContext` returns cookie names and counts but never a value.
 *
 * Inventory rows: I-03 (listProviders), I-16 (chromeStatus managed), I-17 (shutdownChrome), I-18 (describeProvider).
 * Ticket 8468f7b1 · [search-verbs.1] [search-verbs.2] [search-verbs.3]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createMemoryFs } from '@adhd/resilience-core-tripwire'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  getPageContext: vi.fn(),
  chromeStatus: vi.fn(),
  shutdownChrome: vi.fn(),
}))

vi.mock('@adhd/stealth-core-browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/stealth-core-browser')>()
  return { ...actual, getPageContext: core.getPageContext, chromeStatus: core.chromeStatus, shutdownChrome: core.shutdownChrome }
})

import * as api from '../../../api.js'
import { configureSearch } from '../../../lib/search.js'
import { redactCookieValues } from '../../../host-projection.js'
import { hitlResponse, makeFakeCore, response, scriptedEngine } from './harness.js'

const srcDir = path.resolve(__dirname, '..', '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), 'utf8')

const ELEVEN = ['search', 'listProviders', 'describeProvider', 'tripwireStatus', 'clearTripwire', 'chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity', 'getPageContext']

beforeEach(() => {
  core.getPageContext.mockReset()
  core.chromeStatus.mockReset()
  core.shutdownChrome.mockReset()
})
afterEach(() => {
  configureSearch()
})

describe('api exports exactly the eleven tools, each taking at most one input object [search-verbs.2]', () => {
  it('the function exports are exactly the eleven tools: no shutdownSearchChrome, no providerUsage', () => {
    const fns = Object.entries(api)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort()
    expect(fns).toEqual([...ELEVEN].sort())
    expect(fns).not.toContain('shutdownSearchChrome')
    expect(fns).not.toContain('providerUsage')
  })

  it.each(ELEVEN)('%s takes at most one JSON input object (arity <= 1)', (name) => {
    const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
    expect(typeof fn).toBe('function')
    expect(fn?.length).toBeLessThanOrEqual(1)
  })

  it('SearchInput carries the strategy, content, visibility and pageDisposal enums and the offset / preview fields', () => {
    const text = read('api.ts')
    const searchInput = text.slice(text.indexOf('export interface SearchInput'), text.indexOf('export interface SearchHit'))
    expect(searchInput).toMatch(/strategy\?: SearchStrategyInput/)
    expect(text).toMatch(/type SearchStrategyInput = 'auto' \| 'network' \| 'dom' \| 'fetch'/)
    expect(searchInput).toMatch(/content\?: 'none' \| 'full'/)
    expect(searchInput).toMatch(/visibility\?: 'offscreen' \| 'foreground'/)
    expect(searchInput).toMatch(/pageDisposal\?: 'dispose' \| 'keep'/)
    expect(searchInput).toMatch(/preview\?: 'none' \| 'include'/)
    expect(searchInput).toMatch(/offset\?: number/)
  })

  it.each(['api.ts', 'lib/types.ts'])('%s declares no optional boolean property in any input or output type', (file) => {
    // an optional boolean extracts as a duplicated oneOf branch that the MCP client rejects
    expect(read(file)).not.toMatch(/\?\s*:\s*boolean/)
  })
})

describe('launchChrome keeps the core input {port, userDataDir} [search-verbs.3]', () => {
  it('api.ts names neither chromePath nor extraArgs anywhere', () => {
    expect(read('api.ts')).not.toMatch(/chromePath|extraArgs/)
  })

  it('a launchChrome call with chromePath or extraArgs does not type-check (ts-expect-error pins the type)', () => {
    // Never executed: the assertions are the two compiler directives below, checked by typecheck.
    const neverCalled = (): void => {
      // @ts-expect-error chromePath is not a property of LaunchChromeInput
      void api.launchChrome({ port: 9333, userDataDir: '/tmp/profile', chromePath: '/usr/bin/evil' })
      // @ts-expect-error extraArgs is not a property of LaunchChromeInput
      void api.launchChrome({ port: 9333, userDataDir: '/tmp/profile', extraArgs: ['--no-sandbox'] })
    }
    expect(typeof neverCalled).toBe('function')
  })
})

const cookieFixture = {
  found: true,
  context: {
    targetId: 'T1',
    url: 'https://example.com/account',
    title: 'Account',
    cookieCount: 2,
    cookies: [
      { name: 'session', value: 'SECRET123', domain: 'example.com', path: '/', secure: true },
      { name: 'csrf', value: 'SECRET123-too', domain: 'example.com', path: '/', secure: true },
    ],
  },
}

describe('getPageContext redacts cookie values at one site [search-verbs.3]', () => {
  it('redactCookieValues keeps the cookie names and counts and the output contains no SECRET123 string', async () => {
    core.getPageContext.mockResolvedValue(cookieFixture)
    const out = await api.getPageContext({ targetId: 'T1' })
    const json = JSON.stringify(out)
    expect(json).not.toContain('SECRET123')
    const ctx = out.context as unknown as { cookieCount: number; cookies: Array<Record<string, unknown>> }
    expect(ctx.cookies.map((c) => c['name'])).toEqual(['session', 'csrf'])
    expect(ctx.cookies).toHaveLength(2)
    expect(ctx.cookieCount).toBe(2)
    expect(ctx.cookies.every((c) => !('value' in c))).toBe(true)
    expect(core.getPageContext).toHaveBeenCalledWith({ targetId: 'T1' })
  })

  it('redactCookieValues never mutates its input and passes a null context through', async () => {
    const before = JSON.stringify(cookieFixture)
    expect(JSON.stringify(redactCookieValues(cookieFixture))).not.toContain('SECRET123')
    expect(JSON.stringify(cookieFixture)).toBe(before)
    core.getPageContext.mockResolvedValue({ found: false, context: null })
    await expect(api.getPageContext({ targetId: 'gone' })).resolves.toEqual({ found: false, context: null })
  })

  it('redactCookieValues strips a nested cookie object and leaves non-cookie values alone', () => {
    const out = redactCookieValues({ jar: { name: 'sid', value: 'SECRET123' }, meta: { name: 'title', note: 1 }, list: [1, 'a', { value: 'keep' }] })
    expect(out).toEqual({ jar: { name: 'sid' }, meta: { name: 'title', note: 1 }, list: [1, 'a', { value: 'keep' }] })
  })
})

describe('the chrome verbs are the core verbs [search-verbs.1] [search-verbs.2]', () => {
  it('chromeStatus keeps the managed flag (I-16): the re-exported verb is the core verb', async () => {
    core.chromeStatus.mockResolvedValue({ running: true, version: 'Chrome/130', protocol: '1.3', managed: true })
    await expect(api.chromeStatus({ port: 9333 })).resolves.toMatchObject({ running: true, managed: true })
    expect(core.chromeStatus).toHaveBeenCalledWith({ port: 9333 })
  })

  it('shutdownChrome (I-17) delegates to the core verb with the same input', async () => {
    core.shutdownChrome.mockResolvedValue({ ok: true, port: 9333 })
    await expect(api.shutdownChrome({ port: 9333 })).resolves.toEqual({ ok: true, port: 9333 })
    expect(core.shutdownChrome).toHaveBeenCalledWith({ port: 9333 })
  })
})

describe('the search-owned verbs [search-verbs.2]', () => {
  it('listProviders lists the twelve providers with strategies (I-03)', async () => {
    const out = await api.listProviders()
    expect(out.providers).toHaveLength(12)
    const github = out.providers.find((p) => p.id === 'github')
    expect(github).toMatchObject({ id: 'github', strategies: ['network', 'network'] })
    expect(out.providers.find((p) => p.id === 'fetch')?.strategies).toEqual(['fetch'])
  })

  it('describeProvider returns the qualifier examples and usage (I-18) and raises UNKNOWN_PROVIDER for an unknown id', async () => {
    const d = await api.describeProvider({ provider: 'github' })
    expect(d).toMatchObject({ id: 'github', name: 'GitHub' })
    expect(d.qualifierExamples.length).toBeGreaterThan(0)
    expect(d.usage).toContain('github')
    await expect(api.describeProvider({ provider: 'nope' as api.SearchProvider })).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
  })

  it('search, tripwireStatus and clearTripwire run through the configured service on a fake core', async () => {
    const order: string[] = []
    const engine = scriptedEngine(hitlResponse('captcha', 'https://github.com/sorry'), response())
    const mem = createMemoryFs()
    configureSearch({ config: { dataDir: '/data', sessionId: 's', fs: mem }, deps: { core: makeFakeCore(order).core, strategies: engine.strategies, sleep: async () => undefined } })

    const hit = await api.search({ provider: 'github', query: 'vite' })
    expect(hit).toMatchObject({ outcome: 'hitl', hitl: { reason: 'captcha' } })
    const status = await api.tripwireStatus()
    expect(Object.keys(status)).toEqual(['github'])
    expect(status['github']).toMatchObject({ provider: 'github', reason: 'captcha' })
    await expect(api.clearTripwire({ provider: 'github' })).resolves.toEqual({ provider: 'github', cleared: true })
    expect(await api.tripwireStatus()).toEqual({})
    await expect(api.search({ provider: 'github', query: 'vite' })).resolves.toMatchObject({ outcome: 'success', count: 1 })
  })
})
