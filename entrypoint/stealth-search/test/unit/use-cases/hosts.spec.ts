/**
 * guards: an agent driving the MCP host or the CLI gets a different surface, a spawned process, or an unredacted cookie value
 * tier: S
 * cites: ticket 8468f7b1 [search-usecases.1] [search-usecases.4] [search-usecases.5] [search-usecases.6] [search-mcp-iserror.1] [resolve-findings.4]
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/hosts/mcp-inprocess.spec.ts test/unit/use-cases/hosts.spec.ts -> exit 1; with the shared expectInvalidArgument checking another code both specs' schema-rejection tests fail
 * Use case: an agent drives stealth-search through the MCP host, a person through the CLI. The REAL
 * `startMcpHost` and `runCli` boot the REAL apigen package over an in-memory MCP transport pair and
 * fake process edges (stdout, exit, stdin, the exit-hook installer); the real search service runs over
 * the fake core. The only injected pieces are the Chrome/CDP edge, the stdio transport (replaced by
 * the server end of the in-memory pair) and the process. Nothing is spawned, no socket is opened.
 * Ported from the agent-search MCP session, P1 (launch hardening) and P2 (cookie redaction) scenarios.
 * Ticket 8468f7b1 · [search-usecases.1] [search-usecases.4] [search-usecases.5] [search-usecases.6]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { lifecycle } from '@adhd/stealth-core-browser'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ serverTransport: undefined as unknown, pageContext: vi.fn() }))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return hoisted.serverTransport as object
    }
  },
}))

// The Chrome/CDP edge: the core's page-context read (cookies come from the browser).
vi.mock('@adhd/stealth-core-browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/stealth-core-browser')>()
  return { ...actual, getPageContext: hoisted.pageContext }
})

import * as api from '../../../src/api.js'
import { runCli } from '../../../src/cli.js'
import { exitCodeFor } from '../../../src/errors.js'
import { getProvider } from '../../../src/lib/providers.js'
import { defaultHostSettings } from '../../../src/host-flags.js'
import { startMcpHost } from '../../../src/server.js'
import type { McpHostDeps, McpHostHandle, Verbs } from '../../../src/server.js'
import { input, makeFakeCore, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'
import { BUILD_TIMEOUT_MS, FakeStdin, cliHarness, expectInvalidArgument, expectMcpToolError, fakeVerbs, packageFor, trippedWorld, wire } from '../../helpers/hosts/host-harness.js'

const TOOLS = ['search', 'listProviders', 'describeProvider', 'tripwireStatus', 'clearTripwire', 'getPageContext', 'chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity'].map((n) => `stealth_${n}`)


const sessions: Array<{ handle: McpHostHandle; client: Client }> = []
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.client.close().catch(() => undefined)
    s.handle.uninstall()
  }
  hoisted.pageContext.mockReset()
})

async function session(verbs: Verbs, deps: McpHostDeps = {}) {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  hoisted.serverTransport = serverEnd
  const handle = await startMcpHost(
    { ...defaultHostSettings(), pidFile: undefined, traceFile: undefined, dataDir: '/data', logLevel: 'silent' },
    {
      build: () => packageFor(verbs),
      configureManagers: () => undefined,
      installHooks: () => () => undefined,
      configure: () => undefined,
      proc: { on: () => undefined, removeListener: () => undefined },
      stdin: new FakeStdin({ isTTY: true }),
      stderr: () => undefined,
      entryPath: '/fake/core/index.js',
      fs: { appendFile: () => undefined, readFile: () => '', writeFile: () => undefined, mkdirp: () => undefined },
      ...deps,
    }
  )
  const client = new Client({ name: 'use-cases', version: '0.0.0' })
  await client.connect(clientEnd)
  sessions.push({ handle, client })
  return { handle, client }
}

const realVerbs = api as unknown as Verbs

describe('an MCP-driven session', () => {
  it(
    'lists exactly the eleven stealth_* tools and runs a stealth_search call through the real search service',
    async () => {
      const world = makeWorld({ strategies: scriptedEngine(response()).strategies, core: makeFakeCore() })
      const { client } = await session(realVerbs, { build: () => packageFor(realVerbs), configure: wire(world, scriptedEngine(response()).strategies) })

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort())

      const res = await client.callTool({ name: 'stealth_search', arguments: { data: { input: { provider: 'github', query: 'vite' } } } })
      expect(res.isError).toBeUndefined()
      expect(res.structuredContent).toMatchObject({ provider: 'github', query: 'vite', outcome: 'success', attempts: 1 })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'a locked provider answers outcome hitl with attempts 0 as data, and the session survives it',
    async () => {
      const world = await trippedWorld()
      const { client } = await session(realVerbs, { build: () => packageFor(realVerbs), configure: wire(world, scriptedEngine(response()).strategies) })

      const res = await client.callTool({ name: 'stealth_search', arguments: { data: { input: { provider: 'github', query: 'vite' } } } })

      expect(res.structuredContent).toMatchObject({ outcome: 'hitl', attempts: 0, provider: 'github' })
      expect((await client.listTools()).tools).toHaveLength(11)
    },
    BUILD_TIMEOUT_MS
  )
})

describe('P1: launchChrome cannot be told what to run', () => {
  it(
    '[search-mcp-iserror.1] ADR-0018: a launchChrome call with extraArgs or chromePath returns isError true with invalid_argument text and the verb never runs',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const { client } = await session(verbs)

      const { tools } = await client.listTools()
      const schema = tools.find((t) => t.name === 'stealth_launchChrome')?.inputSchema as { properties: Record<string, { properties?: Record<string, { properties?: Record<string, unknown> }> }> }
      expect(Object.keys(schema.properties['data']?.properties?.['input']?.properties ?? {}).sort()).toEqual(['port', 'userDataDir'])

      await expectInvalidArgument(client.callTool({ name: 'stealth_launchChrome', arguments: { data: { input: { port: 19997, extraArgs: ['--evil'] } } } }), /extraArgs/)
      await expectInvalidArgument(client.callTool({ name: 'stealth_launchChrome', arguments: { data: { input: { port: 19997, chromePath: '/bin/sh' } } } }), /chromePath/)
      expect(verbs.launchChrome).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'the CLI rejects extraArgs in a JSON input the same way and exits non-zero without launching',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const h = cliHarness(verbs)
      const code = await runCli(['launchChrome', '--input', '{"port":19997,"extraArgs":["--evil"]}'], h.deps)
      expect(code).not.toBe(0)
      expect(h.stdout).toEqual([])
      expect(verbs.launchChrome).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )
})

describe('P2: getPageContext never leaks a cookie value', () => {
  it(
    'over MCP the output carries cookie names and counts but never the SECRET123 value',
    async () => {
      hoisted.pageContext.mockResolvedValue({
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
      })
      const { client } = await session(realVerbs, { build: () => packageFor(realVerbs) })

      const res = await client.callTool({ name: 'stealth_getPageContext', arguments: { data: { input: { targetId: 'T1' } } } })

      const text = JSON.stringify(res)
      expect(text).not.toContain('SECRET123')
      expect(text).toContain('session')
      expect(text).toContain('csrf')
      const ctx = (res.structuredContent as { context: { cookieCount: number; cookies: Array<Record<string, unknown>> } }).context
      expect(ctx.cookieCount).toBe(2)
      expect(ctx.cookies.map((c) => c['name'])).toEqual(['session', 'csrf'])
      expect(ctx.cookies.every((c) => !('value' in c))).toBe(true)
    },
    BUILD_TIMEOUT_MS
  )
})

describe('exit hooks soft-shut Chrome down', () => {
  it(
    'the host installs the core exit hooks on the managed Chrome target and uninstalls them on close',
    async () => {
      const installed: Array<{ target: unknown }> = []
      let uninstalled = 0
      const { handle } = await session(fakeVerbs(vi.fn), {
        installHooks: ((target: unknown) => {
          installed.push({ target })
          return () => void uninstalled++
        }) as McpHostDeps['installHooks'],
      })
      expect(installed).toHaveLength(1)
      expect(installed[0]?.target).toBe(lifecycle.chromeExitTarget)
      handle.uninstall()
      expect(uninstalled).toBe(1)
    },
    BUILD_TIMEOUT_MS
  )

  it('a crash runs the core hook: release, then shutdownIfIdle (soft shutdown), then exit 1', async () => {
    const calls: string[] = []
    const exits: number[] = []
    const listeners = new Map<string, (...a: unknown[]) => void>()
    const uninstall = lifecycle.installProcessExitHooks(
      { release: () => void calls.push('release'), shutdownIfIdle: async () => void calls.push('shutdownIfIdle') },
      { exit: (c) => void exits.push(c), proc: { on: (e, l) => void listeners.set(e, l), removeListener: () => undefined }, logger: () => undefined, forceExitMs: 5000 }
    )

    listeners.get('uncaughtException')?.(new Error('boom'))
    await vi.waitFor(() => expect(exits).toEqual([1]))

    expect(calls).toEqual(['release', 'shutdownIfIdle'])
    uninstall()
  })
})

describe('a wrong provider surfaces UNKNOWN_PROVIDER with its code and exit mapping', () => {
  it('the service raises a typed UNKNOWN_PROVIDER before any gate or Chrome call', async () => {
    const world = makeWorld({ strategies: scriptedEngine(response()).strategies })
    await expect(world.svc.search(input({ provider: 'altavista' as never }))).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
    expect(world.core.ensured).toBe(0)
    expect(world.core.opened).toHaveLength(0)
  })

  it('the exit code mapping for UNKNOWN_PROVIDER is stable and non-zero', () => {
    expect(exitCodeFor('UNKNOWN_PROVIDER')).toBe(70)
  })

  it(
    'the CLI prints one typed UNKNOWN_PROVIDER line on stderr, nothing on stdout, and exits with the mapped code',
    async () => {
      // the verb resolves the provider through the real registry, which raises the genuine typed error
      const h = cliHarness(fakeVerbs(vi.fn, { describeProvider: async () => getProvider('altavista') }))

      const code = await runCli(['describeProvider', '--provider', 'npm'], h.deps)

      expect(h.stdout).toEqual([])
      expect(h.stderr).toHaveLength(1)
      expect(h.stderr[0]).toMatch(/^UNKNOWN_PROVIDER: /)
      expect(code).toBe(exitCodeFor('UNKNOWN_PROVIDER'))
      expect(h.events[h.events.length - 1]).toBe(`exit(${code})`)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'the CLI passes an unregistered --provider value to the verb, which raises the typed UNKNOWN_PROVIDER (exit 70)',
    async () => {
      const verbs = fakeVerbs(vi.fn, { describeProvider: async () => getProvider('altavista') })
      const h = cliHarness(verbs)
      const code = await runCli(['describeProvider', '--provider', 'altavista'], h.deps)
      expect(code).toBe(exitCodeFor('UNKNOWN_PROVIDER'))
      expect(h.stdout).toEqual([])
      expect(h.stderr[0]).toMatch(/^UNKNOWN_PROVIDER: /)
      expect(verbs.describeProvider).toHaveBeenCalledTimes(1)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '[search-mcp-iserror.1] ADR-0018: over MCP an unknown provider reaches the verb, which raises the typed UNKNOWN_PROVIDER as an isError tool result carrying the code, and the session keeps serving',
    async () => {
      const { client } = await session(realVerbs, { build: () => packageFor(realVerbs) })
      await expectMcpToolError(client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'altavista' } } } }), /altavista/, 'UNKNOWN_PROVIDER')
      expect((await client.listTools()).tools).toHaveLength(11)
    },
    BUILD_TIMEOUT_MS
  )
})
