/**
 * guards: a typed StealthSearchError (or a core StealthCoreBrowserError) raised by a verb reaches an MCP client as a JSON-RPC rejection without its machine-readable code, or src/errors.ts and docs/ERRORS.md claim a form that does not exist
 * tier: S
 * cites: ticket 8468f7b1 [search-mcp-iserror.2] [search-hosts.16] [audit-fixes.1] backlog 4909102e
 * The MCP host driven in-process (REAL `startMcpHost`, REAL `mcpPlugin.run`, a real MCP client over the SDK's
 * in-memory transport pair; nothing is spawned). A verb that throws is the real use case: an agent calls a tool and
 * the verb fails. Criteria: [search-mcp-iserror.2] · [audit-fixes.1] (P3 of the pre-review: the typed error must reach
 * the client as an isError tool result carrying its code, as apigen ADR-0018 defines for an ApiError).
 *
 * A StealthSearchError extends the core's `StealthCoreBrowserError`, so it cannot be an ApiError; the MCP host maps
 * every typed failure to an ApiError-shaped carrier (`withMcpErrorChannel`) before the plugin sees it. The text is
 * `<canonical>: <CODE>: <message>`; a thrown non-typed value stays a protocol error.
 */
import { ApiError } from '@adhd/apigen-base-errors'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import { StealthSearchError, searchError } from '../../../src/errors.js'
import { McpToolError, toMcpToolError } from '../../../src/host-errors.js'
import { defaultHostSettings } from '../../../src/host-flags.js'
import { startMcpHost } from '../../../src/server.js'
import type { McpHostHandle, Verbs } from '../../../src/server.js'
import { BUILD_TIMEOUT_MS, FakeStdin, expectMcpToolError, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

const hoisted = vi.hoisted(() => ({ serverTransport: undefined as unknown }))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return hoisted.serverTransport as object
    }
  },
}))

const sessions: Array<{ handle: McpHostHandle; client: Client }> = []

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.client.close().catch(() => undefined)
    s.handle.uninstall()
  }
})

async function session(verbs: Verbs): Promise<Client> {
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
    }
  )
  const client = new Client({ name: 'error-channel-spec', version: '0.0.0' })
  await client.connect(clientEnd)
  sessions.push({ handle, client })
  return client
}

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }>; _meta?: Record<string, unknown> }

describe('how a verb failure reaches an MCP client [search-mcp-iserror.2] [audit-fixes.1]', () => {
  it(
    'P3 typed code: a StealthSearchError is an isError tool result whose text names its stable code and whose _meta carries the canonical code',
    async () => {
      const thrown = searchError('UNKNOWN_PROVIDER', 'provider "nope" is not registered')
      expect(thrown).toBeInstanceOf(StealthSearchError)
      expect(thrown).not.toBeInstanceOf(ApiError)
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw thrown } }))
      const call = client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } })
      await expectMcpToolError(call, /provider "nope" is not registered/, 'UNKNOWN_PROVIDER')
      const res = (await call) as ToolResult
      expect(res.content?.[0]?.text).toMatch(/^invalid_argument: UNKNOWN_PROVIDER: /)
      expect(res._meta?.['adhd/error']).toMatchObject({ code: 'invalid_argument' })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'P3 internal code: a failure that blames the environment (HITL_ABORTED) is `internal` and still names its own code first',
    async () => {
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw searchError('HITL_ABORTED', 'the human did not confirm') } }))
      const call = client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } })
      await expectMcpToolError(call, /the human did not confirm/, 'HITL_ABORTED')
      expect(((await call) as ToolResult).content?.[0]?.text).toMatch(/^internal: HITL_ABORTED: /)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'P3 core error: a core StealthCoreBrowserError reaching the search host is the same isError result with its own code',
    async () => {
      const client = await session(fakeVerbs(vi.fn, { chromeStatus: async () => { throw new StealthCoreBrowserError('CDP_UNREACHABLE', 'no Chrome answers on 127.0.0.1:19999') } }))
      const call = client.callTool({ name: 'stealth_chromeStatus', arguments: { data: { input: {} } } })
      await expectMcpToolError(call, /no Chrome answers/, 'CDP_UNREACHABLE')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'P3 rejection kept: a thrown value that is not typed stays a JSON-RPC rejection (ADR-0018: protocol errors are for non-ApiError throws)',
    async () => {
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw new TypeError('boom') } }))
      const outcome = await client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } }).then(
        (res) => ({ res }),
        (err: unknown) => ({ err })
      )
      expect(outcome).toHaveProperty('err')
      expect(outcome).not.toHaveProperty('res')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '4909102e isError: an ApiError raised by the same verb is an isError tool result whose text starts with its code and whose _meta carries the code (ADR-0018)',
    async () => {
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw new ApiError('not_found', 'no such provider') } }))
      const res = (await client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } })) as ToolResult
      expect(res.isError).toBe(true)
      expect(res.content?.[0]?.text).toBe('not_found: no such provider')
      expect(res._meta?.['adhd/error']).toMatchObject({ code: 'not_found' })
    },
    BUILD_TIMEOUT_MS
  )

  it('P3 map: toMcpToolError wraps typed errors only and keeps the original as cause and details', () => {
    const typed = searchError('FETCH_URL_REFUSED', 'private address')
    const mapped = toMcpToolError(typed) as McpToolError
    expect(mapped).toBeInstanceOf(McpToolError)
    expect(mapped.code).toBe('invalid_argument')
    expect(mapped.details.code).toBe('FETCH_URL_REFUSED')
    expect(mapped.cause).toBe(typed)
    const plain = new RangeError('x')
    expect(toMcpToolError(plain)).toBe(plain)
  })

  it('P3 docs: src/errors.ts and docs/ERRORS.md describe the isError form of a typed error and no longer claim a JSON-RPC rejection', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../../src/errors.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/isError/)
    expect(src).not.toMatch(/client sees a\s+JSON-RPC error response/)
    const doc = readFileSync(new URL('../../../docs/ERRORS.md', import.meta.url), 'utf8')
    expect(doc).not.toMatch(/the code is not a separate field/)
    expect(doc).toMatch(/<canonical>: <CODE>: <message>/)
  })
})
