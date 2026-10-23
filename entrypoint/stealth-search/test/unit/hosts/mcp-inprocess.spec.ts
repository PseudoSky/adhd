/**
 * guards: the MCP host does not serve the eleven verbs over the SDK transport, or the in-process path spawns a process
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.7] [search-hosts.12] [search-hosts.16] [search-hosts.20] [search-hosts.22]
 * The MCP host driven in-process: the REAL `startMcpHost`, the REAL `mcpPlugin.run` and a real MCP
 * client over the SDK's in-memory transport pair (the stdio transport is replaced by the server end
 * of that pair, so no process is spawned and no pipe or socket is opened). Ticket 8468f7b1 · plan
 * state search-hosts.
 *
 * Criteria: [search-hosts.7] [search-hosts.12] [search-hosts.16] [search-hosts.20] [search-hosts.22]
 * · backlog 9d05e8b2 (CLI and MCP report the same tripwire status), 591e1a7 (a hitl outcome) ·
 * inventory rows I-34 (stdio transport), I-35 (package build, $ref inlining).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../src/api.js'
import { runCli } from '../../../src/cli.js'
import { defaultHostSettings } from '../../../src/host-flags.js'
import type { HostSettings } from '../../../src/host-flags.js'
import { hitlResponse, input, makeFakeCore, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'
import { startMcpHost } from '../../../src/server.js'
import type { McpHostDeps, McpHostHandle, Verbs } from '../../../src/server.js'
import { BUILD_TIMEOUT_MS, FakeStdin, cliHarness, fakeVerbs, packageFor, trippedWorld, wire, expectMcpToolError } from '../../helpers/hosts/host-harness.js'

const hoisted = vi.hoisted(() => ({ serverTransport: undefined as unknown }))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return hoisted.serverTransport as object
    }
  },
}))

const MCP_NAMES = ['search', 'listProviders', 'describeProvider', 'tripwireStatus', 'clearTripwire', 'getPageContext', 'chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity'].map((n) => `stealth_${n}`)

const sessions: Array<{ handle: McpHostHandle; client: Client }> = []

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.client.close().catch(() => undefined)
    s.handle.uninstall()
  }
})

/** Start the host on the stdio transport (the in-memory server end) and connect a client to it. */
async function session(verbs: Verbs, deps: McpHostDeps = {}, settings: HostSettings = defaultHostSettings()): Promise<{ handle: McpHostHandle; client: Client }> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  hoisted.serverTransport = serverEnd
  const proc = { on: () => undefined, removeListener: () => undefined }
  const handle = await startMcpHost(
    { ...settings, pidFile: undefined, traceFile: undefined, dataDir: '/data', logLevel: 'silent' },
    {
      build: () => packageFor(verbs),
      configureManagers: () => undefined,
      installHooks: () => () => undefined,
      configure: () => undefined,
      proc,
      stdin: new FakeStdin({ isTTY: true }),
      stderr: () => undefined,
      entryPath: '/fake/core/index.js',
      fs: { appendFile: () => undefined, readFile: () => '', writeFile: () => undefined, mkdirp: () => undefined },
      ...deps,
    }
  )
  const client = new Client({ name: 'hosts-spec', version: '0.0.0' })
  await client.connect(clientEnd)
  const s = { handle, client }
  sessions.push(s)
  return s
}

describe('MCP host: tools/list over the real mcp plugin [search-hosts.7]', () => {
  it(
    'tools/list names are exactly the eleven stealth_* names, every description is at least 40 characters, launchChrome has no chromePath or extraArgs property',
    async () => {
      const { client } = await session(fakeVerbs(vi.fn))
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([...MCP_NAMES].sort())
      for (const t of tools) expect((t.description ?? '').length, t.name).toBeGreaterThanOrEqual(40)
      const launch = tools.find((t) => t.name === 'stealth_launchChrome')
      const data = (launch?.inputSchema.properties as Record<string, { properties?: Record<string, { properties?: Record<string, unknown> }> }>)['data']
      const props = Object.keys(data?.properties?.['input']?.properties ?? {})
      expect(props.sort()).toEqual(['port', 'userDataDir'])
      expect(props).not.toContain('chromePath')
      expect(props).not.toContain('extraArgs')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'a launchChrome call carrying extraArgs or chromePath is rejected by the schema and the verb is never called (nothing is spawned)',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const { client } = await session(verbs)
      await expectMcpToolError(client.callTool({ name: 'stealth_launchChrome', arguments: { data: { input: { port: 19997, extraArgs: ['--evil'] } } } }), /extraArgs/)
      await expectMcpToolError(client.callTool({ name: 'stealth_launchChrome', arguments: { data: { input: { port: 19997, chromePath: '/bin/sh' } } } }), /chromePath/)
      expect(verbs.launchChrome).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'a launchChrome call with no input at all is rejected too (the host schema requires data.input), so an empty call can never start a Chrome with defaults',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const { client } = await session(verbs)
      await expectMcpToolError(client.callTool({ name: 'stealth_launchChrome', arguments: {} }), /required key 'input'/)
      await expectMcpToolError(client.callTool({ name: 'stealth_launchChrome', arguments: { data: {} } }), /required key 'input'/)
      expect(verbs.launchChrome).not.toHaveBeenCalled()
      const ok = await client.callTool({ name: 'stealth_launchChrome', arguments: { data: { input: { port: 19990 } } } })
      expect(ok.isError).toBeFalsy()
      expect(verbs.launchChrome).toHaveBeenCalledWith({ port: 19990 })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'stdio answers a tool call with the verb result as text and structuredContent [search-hosts.12]',
    async () => {
      const verbs = fakeVerbs(vi.fn, { chromeStatus: async () => ({ running: false, managed: false }) })
      const { client } = await session(verbs)
      const res = await client.callTool({ name: 'stealth_chromeStatus', arguments: { data: { input: { port: 19999 } } } })
      expect(verbs.chromeStatus).toHaveBeenCalledWith({ port: 19999 })
      expect(res.structuredContent).toEqual({ running: false, managed: false })
      expect((res.content as Array<{ text: string }>)[0]?.text).toBe('{"running":false,"managed":false}')
    },
    BUILD_TIMEOUT_MS
  )
})

describe('CLI and MCP report the same tripwire status [search-hosts.20]', () => {
  it(
    '9d05e8b2 tripwireStatus: with one live and one expired lock the CLI projection and the MCP tool result list the same tripped set, the expired lock in neither',
    async () => {
      // Seed: duckduckgo tripped three hours ago (past the 2 h TTL = expired), github tripped now (live).
      const world = makeWorld({ strategies: scriptedEngine((call) => hitlResponse('captcha', 'https://example.test/challenge', { provider: call.provider, query: call.query })).strategies, core: makeFakeCore() })
      const T0 = world.clock.now
      world.clock.now = T0 - 3 * 3600 * 1000
      expect((await world.svc.search(input({ provider: 'duckduckgo', query: 'vite' }))).outcome).toBe('hitl')
      world.clock.now = T0
      expect((await world.svc.search(input({ provider: 'github', query: 'vite' }))).outcome).toBe('hitl')
      expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])

      const wiring = wire(world, scriptedEngine(response()).strategies)
      const cli = cliHarness(api as unknown as Verbs, { build: () => packageFor(api as unknown as Verbs), configure: wiring })
      expect(await runCli(['tripwireStatus'], cli.deps)).toBe(0)
      const fromCli = JSON.parse(cli.stdout[0] as string) as Record<string, unknown>

      const { client } = await session(api as unknown as Verbs, { build: () => packageFor(api as unknown as Verbs), configure: wiring })
      const res = await client.callTool({ name: 'stealth_tripwireStatus', arguments: { data: {} } })
      const fromMcp = res.structuredContent as Record<string, unknown>

      expect(Object.keys(fromCli).sort()).toEqual(['github'])
      expect(Object.keys(fromMcp).sort()).toEqual(Object.keys(fromCli).sort())
      expect(fromMcp).toEqual(fromCli)
      expect(fromCli).not.toHaveProperty('duckduckgo')
      expect(fromMcp).not.toHaveProperty('duckduckgo')
      expect((fromCli['github'] as Record<string, unknown>)['clearWith']).toBe('clearTripwire')
    },
    BUILD_TIMEOUT_MS
  )
})

describe('a hitl outcome on the MCP host [search-hosts.22]', () => {
  it(
    '591e1a7 isError: the apigen mcp plugin has no isError channel, so a tripped provider answers outcome hitl with attempts 0 as data, and a rejected call is an error response',
    async () => {
      const world = await trippedWorld()
      const { client } = await session(api as unknown as Verbs, { build: () => packageFor(api as unknown as Verbs), configure: wire(world, scriptedEngine(response()).strategies) })
      const res = await client.callTool({ name: 'stealth_search', arguments: { data: { input: { provider: 'github', query: 'vite' } } } })
      expect(res.isError).toBeUndefined()
      const out = res.structuredContent as Record<string, unknown>
      expect(out).toMatchObject({ outcome: 'hitl', attempts: 0, provider: 'github' })
      expect(out['hitl']).toMatchObject({ reason: 'captcha' })
      await expectMcpToolError(client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'not-a-provider' } } } }), /not one of/)
    },
    BUILD_TIMEOUT_MS
  )
})
