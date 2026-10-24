/**
 * guards: a README example, command line or sample output drifts from the example files or the operation surface
 * tier: S
 * cites: ticket 8468f7b1 [search-examples.1] [search-examples.2] [search-examples.3] [search-examples.4]
 * The README examples are real. Every example in `examples/` is imported and its `run` executed
 * against an injected fake of the eleven operations (no Chrome, no socket, no process); every fenced
 * block of README.md is looked up in `examples/manifest.json` and verified by its kind: TypeScript
 * lines must be lines of the example file, `stealth-search` command lines must name a real operation
 * and only host flags or properties of that operation's input, the MCP config must name the bin and
 * parse as host flags, and the sample output must be what the example printed.
 *
 * Ticket 8468f7b1 · plan state search-examples · [search-examples.1] [search-examples.2]
 * [search-examples.3] [search-examples.4]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type {
  CheckChromeActivityInput,
  ChromeEndpointInput,
  ClearTripwireInput,
  DescribeProviderInput,
  GetPageContextInput,
  LaunchChromeInput,
  SearchInput,
  SearchOutput,
} from '../../../src/api.js'
import { HOST_FLAGS, parseHostFlags } from '../../../src/host-flags.js'
import * as chromeLifecycle from '../../../examples/chrome-lifecycle.js'
import * as fetchPage from '../../../examples/fetch-page.js'
import * as pageTargets from '../../../examples/page-targets.js'
import * as providers from '../../../examples/providers.js'
import * as searchWeb from '../../../examples/search-web.js'
import * as tripwire from '../../../examples/tripwire.js'
import type { ExampleDeps, StealthSearchApi } from '../../../examples/types.js'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string): string => readFileSync(join(PKG_DIR, rel), 'utf8')

const OPERATIONS = [
  'search',
  'listProviders',
  'describeProvider',
  'tripwireStatus',
  'clearTripwire',
  'chromeStatus',
  'launchChrome',
  'shutdownChrome',
  'listPageTargets',
  'checkChromeActivity',
  'getPageContext',
] as const satisfies readonly (keyof StealthSearchApi)[]

/** The input properties of every operation, tied to the input types at compile time. */
const INPUT_PROPERTIES: Record<(typeof OPERATIONS)[number], readonly string[]> = {
  search: [
    'provider', 'query', 'qualifier', 'strategy', 'content', 'preview', 'offset', 'maxContentSize',
    'timeoutMs', 'maxAttempts', 'challengeWaitMs', 'visibility', 'pageDisposal', 'host', 'port',
  ] satisfies (keyof SearchInput)[],
  listProviders: [],
  describeProvider: ['provider'] satisfies (keyof DescribeProviderInput)[],
  tripwireStatus: [],
  clearTripwire: ['provider'] satisfies (keyof ClearTripwireInput)[],
  chromeStatus: ['host', 'port'] satisfies (keyof ChromeEndpointInput)[],
  launchChrome: ['port', 'userDataDir'] satisfies (keyof LaunchChromeInput)[],
  shutdownChrome: ['host', 'port'] satisfies (keyof ChromeEndpointInput)[],
  listPageTargets: ['host', 'port'] satisfies (keyof ChromeEndpointInput)[],
  checkChromeActivity: ['host', 'port', 'withinMinutes'] satisfies (keyof CheckChromeActivityInput)[],
  getPageContext: ['host', 'port', 'targetId'] satisfies (keyof GetPageContextInput)[],
}

const camel = (flag: string): string => flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
const hostFlagNames = new Set(HOST_FLAGS.map((f) => `--${f.name}`))

function searchOutput(over: Partial<SearchOutput>): SearchOutput {
  return {
    provider: 'duckduckgo',
    query: 'q',
    count: 0,
    results: [],
    outcome: 'success',
    tookMs: 12,
    attempts: 1,
    strategy: 'dom',
    ...over,
  }
}

/** The eleven operations, faked: the injected edge below the examples. */
function fakeApi() {
  const search = vi.fn(async (input: SearchInput): Promise<SearchOutput> => {
    if (input.provider === 'fetch') {
      const offset = input.offset ?? 0
      const pages = ['# Getting started\n', 'Install the package.\n']
      const next = offset + 1
      return searchOutput({
        provider: 'fetch',
        strategy: 'fetch',
        content: pages[offset] ?? '',
        ...(next < pages.length ? { nextOffset: next } : {}),
      })
    }
    return searchOutput({
      count: 2,
      results: [
        { title: 'Detecting headless Chrome', url: 'https://developer.chrome.com/docs/detect', snippet: 's1' },
        { title: 'Chrome for Testing', url: 'https://developer.chrome.com/docs/chrome-for-testing', snippet: 's2' },
      ],
    })
  })
  const api = {
    search,
    listProviders: vi.fn(async () => ({
      providers: [
        { id: 'duckduckgo', name: 'DuckDuckGo', help: 'web', strategies: ['dom'] },
        { id: 'github', name: 'GitHub', help: 'code', strategies: ['network', 'dom'] },
      ],
    })),
    describeProvider: vi.fn(async (input: DescribeProviderInput) => ({
      id: input.provider,
      name: 'GitHub',
      help: 'code',
      url: 'https://github.com',
      strategies: ['network'],
      qualifierExamples: ['repo:vitejs/vite'],
      bans: ['rate_limited'],
      usage: 'u',
    })),
    tripwireStatus: vi.fn(async (): ReturnType<StealthSearchApi['tripwireStatus']> => ({
      google: {
        provider: 'google',
        namespace: 'search',
        reason: 'captcha',
        trippedAt: '2026-01-01T00:00:00.000Z',
        blockedCount: 3,
        query: 'q',
        pageUrl: 'https://www.google.com/sorry',
        strategy: 'dom',
        clearWith: 'clearTripwire' as const,
        expiresAt: '2026-01-01T01:00:00.000Z',
      },
    })),
    clearTripwire: vi.fn(async (input: ClearTripwireInput) => ({ provider: input.provider, cleared: true })),
    chromeStatus: vi.fn(async (): ReturnType<StealthSearchApi['chromeStatus']> => ({ running: false, managed: false })),
    launchChrome: vi.fn(async (input?: LaunchChromeInput) => ({ ok: true, port: input?.port ?? 9222 })),
    shutdownChrome: vi.fn(async () => ({ ok: true, running: false })),
    listPageTargets: vi.fn(async (): ReturnType<StealthSearchApi['listPageTargets']> => ({
      targets: [
        { id: 'T1', type: 'service_worker', url: 'https://example.com/sw.js' },
        { id: 'T2', type: 'page', url: 'https://example.com/' },
      ],
    })),
    checkChromeActivity: vi.fn(async (): ReturnType<StealthSearchApi['checkChromeActivity']> => ({
      activePages: 0,
      pageTargets: [],
      lastVisit: null,
      recentlyUsed: false,
      meta: { checkedAt: '2026-01-01T00:00:00.000Z', cdpHost: '127.0.0.1', profileDir: '/profile' },
    })),
    getPageContext: vi.fn(async (input: GetPageContextInput): ReturnType<StealthSearchApi['getPageContext']> => ({
      found: true,
      context: {
        targetId: input.targetId,
        url: 'https://example.com/',
        title: 'Example',
        cookieCount: 2,
        hasHistory: true,
        historyVisits: 5,
      },
    })),
  } satisfies StealthSearchApi
  return api
}

const EXAMPLES = {
  'chrome-lifecycle': chromeLifecycle,
  'fetch-page': fetchPage,
  'page-targets': pageTargets,
  providers,
  'search-web': searchWeb,
  tripwire,
} as const

interface ManifestEntry {
  id: string
  block: number
  kind: 'ts' | 'sh' | 'text' | 'json'
  source: string
}

const readme = read('README.md')
const manifest = JSON.parse(read('examples/manifest.json')) as ManifestEntry[]
const blocks = [...readme.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)].map((m) => ({ lang: m[1]?.trim() ?? '', body: m[2] ?? '' }))

/** Split a command line into tokens, honouring double and single quotes. */
function tokens(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

describe('examples: every example runs against injected fakes [search-examples.4]', () => {
  it('exports run() from every example file and calls only injected operations', async () => {
    const api = fakeApi()
    const deps: ExampleDeps = { api }
    const printed: Record<string, string> = {}
    for (const [name, mod] of Object.entries(EXAMPLES)) {
      expect(typeof mod.run, name).toBe('function')
      printed[name] = await mod.run(deps)
      expect(printed[name], name).not.toBe('')
    }
    // all eleven operations are exercised by the examples [search-examples.1]
    for (const op of OPERATIONS) expect(api[op].mock.calls.length, op).toBeGreaterThan(0)
  })

  it('search-web prints one numbered hit per result and reports a non-success outcome', async () => {
    const api = fakeApi()
    expect(await searchWeb.run({ api })).toContain('1. Detecting headless Chrome\n   https://developer.chrome.com/docs/detect')
    api.search.mockResolvedValueOnce(searchOutput({ outcome: 'captcha', error: 'wall' }))
    expect(await searchWeb.run({ api })).toBe('duckduckgo: captcha (wall)')
  })

  it('fetch-page follows nextOffset until the document ends and stops on a failed outcome', async () => {
    const api = fakeApi()
    expect(await fetchPage.run({ api })).toBe('# Getting started\nInstall the package.\n')
    expect(api.search.mock.calls.map(([i]) => i.offset)).toEqual([0, 1])
    api.search.mockResolvedValueOnce(searchOutput({ provider: 'fetch', outcome: 'timeout' }))
    expect(await fetchPage.run({ api })).toBe('fetch: timeout')
  })

  it('tripwire clears what it lists, and reports an empty table', async () => {
    const api = fakeApi()
    expect(await tripwire.run({ api })).toContain('cleared google')
    expect(api.clearTripwire).toHaveBeenCalledWith({ provider: 'google' })
    api.tripwireStatus.mockResolvedValueOnce({})
    expect(await tripwire.run({ api })).toBe('no provider is blocked')
  })

  it('chrome-lifecycle launches only when nothing answers and shuts down only when idle', async () => {
    const api = fakeApi()
    await chromeLifecycle.run({ api })
    expect(api.launchChrome).toHaveBeenCalledWith({ port: 9333 })
    expect(api.shutdownChrome).toHaveBeenCalledTimes(1)
    const busy = fakeApi()
    busy.chromeStatus.mockResolvedValue({ running: true, managed: true, version: 'Chrome/1' })
    busy.checkChromeActivity.mockResolvedValue({
      activePages: 2, pageTargets: ['a'], lastVisit: null, recentlyUsed: true,
      meta: { checkedAt: 'x', cdpHost: '127.0.0.1', profileDir: '/p' },
    })
    await chromeLifecycle.run({ api: busy })
    expect(busy.launchChrome).not.toHaveBeenCalled()
    expect(busy.shutdownChrome).not.toHaveBeenCalled()
  })

  it('page-targets reads the first page target and handles none and a vanished page', async () => {
    const api = fakeApi()
    expect(await pageTargets.run({ api })).toBe('Example <https://example.com/> cookies=2 visits=5')
    expect(api.getPageContext).toHaveBeenCalledWith({ port: 9333, targetId: 'T2' })
    api.listPageTargets.mockResolvedValueOnce({ targets: [] })
    expect(await pageTargets.run({ api })).toBe('no open page')
    api.getPageContext.mockResolvedValueOnce({ found: false, context: null })
    expect(await pageTargets.run({ api })).toBe('T2 closed meanwhile')
  })

  it('providers lists every provider and the qualifier examples of github', async () => {
    const out = await providers.run({ api: fakeApi() })
    expect(out).toContain('github: network, dom')
    expect(out).toContain('  repo:vitejs/vite')
  })
})

describe('examples: manifest covers every README block [search-examples.2]', () => {
  it('has one entry per fenced block, indexed 0..n-1, with unique ids and a known kind', () => {
    expect(blocks.length).toBeGreaterThan(0)
    expect(manifest.length).toBe(blocks.length)
    expect(manifest.map((e) => e.block).sort((a, b) => a - b)).toEqual(blocks.map((_b, i) => i))
    expect(new Set(manifest.map((e) => e.id)).size).toBe(manifest.length)
    for (const e of manifest) {
      expect(Object.keys(e).sort(), e.id).toEqual(['block', 'id', 'kind', 'source'])
      expect(['ts', 'sh', 'text', 'json'], e.id).toContain(e.kind)
    }
  })

  it('the fence language of each block is its manifest kind', () => {
    for (const e of manifest) expect(blocks[e.block]?.lang, e.id).toBe(e.kind)
  })

  it('every imported example is a file of examples/ and the README points at that directory', () => {
    for (const name of Object.keys(EXAMPLES)) expect(() => read(`examples/${name}.ts`), name).not.toThrow()
    expect(readme).toContain('examples/')
  })
})

describe('examples: README blocks are verified by kind [search-examples.3]', () => {
  const entry = (kind: ManifestEntry['kind']) => manifest.filter((e) => e.kind === kind)

  it('ts blocks are lines of the example file they cite', () => {
    const ts = entry('ts')
    expect(ts.length).toBeGreaterThan(0)
    for (const e of ts) {
      const lines = new Set(read(e.source).split('\n').map((l) => l.trim()))
      const body = (blocks[e.block]?.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      expect(body.length, e.id).toBeGreaterThan(0)
      for (const line of body) expect(lines.has(line), `${e.id}: ${line}`).toBe(true)
    }
  })

  it('sh blocks: every command line names a real operation and only real flags', () => {
    const sh = entry('sh')
    expect(sh.length).toBeGreaterThan(0)
    for (const e of sh) {
      const lines = (blocks[e.block]?.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      expect(lines.length, e.id).toBeGreaterThan(0)
      for (const line of lines) {
        const [bin, op, ...args] = tokens(line)
        expect(bin, line).toBe('stealth-search')
        expect(OPERATIONS as readonly string[], line).toContain(op)
        const known = INPUT_PROPERTIES[op as (typeof OPERATIONS)[number]]
        for (const arg of args.filter((a) => a.startsWith('--'))) {
          const ok = hostFlagNames.has(arg) || arg === '--input' || known.includes(camel(arg.slice(2)))
          expect(ok, `${line}: ${arg}`).toBe(true)
        }
      }
      // the entry's source is one of the operations the block runs
      expect(lines.map((l) => tokens(l)[1]), e.id).toContain(e.source)
    }
  })

  it('json blocks: the MCP config names a package bin and its args parse as host flags', () => {
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> }
    const json = entry('json')
    expect(json.length).toBeGreaterThan(0)
    for (const e of json) {
      const doc = JSON.parse(blocks[e.block]?.body ?? '') as { mcpServers: Record<string, { command: string; args: string[] }> }
      for (const server of Object.values(doc.mcpServers)) {
        expect(Object.keys(pkg.bin), e.id).toContain(server.command)
        expect(server.command, e.id).toBe(e.source)
        const parsed = parseHostFlags(server.args, 'mcp')
        expect(parsed.rest, e.id).toEqual([])
        expect(parsed.operation, e.id).toBeUndefined()
      }
    }
  })

  it('text blocks equal what the cited example printed', async () => {
    const text = entry('text')
    expect(text.length).toBeGreaterThan(0)
    for (const e of text) {
      const name = e.source.replace(/^examples\//, '').replace(/\.ts$/, '') as keyof typeof EXAMPLES
      const printed = await EXAMPLES[name].run({ api: fakeApi() })
      expect(`${printed}\n`, e.id).toBe(blocks[e.block]?.body)
    }
  })

  it('the README states the operation-first command style for all eleven operations', () => {
    for (const op of OPERATIONS) expect(readme, op).toContain(op)
  })
})
