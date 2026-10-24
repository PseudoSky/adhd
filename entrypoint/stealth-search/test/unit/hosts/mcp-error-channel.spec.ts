/**
 * guards: a typed StealthSearchError or an ApiError raised by a verb reaches an MCP client in a form other than the one apigen ADR-0018 defines, or src/errors.ts claims a form that does not exist
 * tier: S
 * cites: ticket 8468f7b1 [search-mcp-iserror.2] [search-hosts.16] backlog 4909102e
 * The MCP host driven in-process (REAL `startMcpHost`, REAL `mcpPlugin.run`, a real MCP client over the SDK's
 * in-memory transport pair; nothing is spawned). A verb that throws is the real use case: an agent calls a tool and
 * the verb fails. Criteria: [search-mcp-iserror.2] · backlog 4909102e (missing isError channel).
 *
 * Decision recorded by 4909102e: `StealthSearchError` extends the core's `StealthCoreBrowserError` (an `Error` with a
 * string `code`), and `ApiError` is a separate `Error` class with a canonical `code`; one class cannot extend both,
 * so a StealthSearchError is NOT an ApiError and the apigen plugin re-throws it. The client sees a JSON-RPC
 * rejection (isError is not set), and an ApiError from the same verb surface IS an isError tool result.
 */
import { ApiError } from '@adhd/apigen-base-errors'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StealthSearchError, searchError } from '../../../src/errors.js'
import { defaultHostSettings } from '../../../src/host-flags.js'
import { startMcpHost } from '../../../src/server.js'
import type { McpHostHandle, Verbs } from '../../../src/server.js'
import { BUILD_TIMEOUT_MS, FakeStdin, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

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

describe('how a verb failure reaches an MCP client [search-mcp-iserror.2]', () => {
  it(
    '4909102e isError: a StealthSearchError is not an ApiError, so the typed error rejects the client call with its code in the message and never sets isError',
    async () => {
      const thrown = searchError('UNKNOWN_PROVIDER', 'provider "nope" is not registered')
      expect(thrown).toBeInstanceOf(StealthSearchError)
      expect(thrown).not.toBeInstanceOf(ApiError)
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw thrown } }))
      const outcome = await client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } }).then(
        (res) => ({ res }),
        (err: unknown) => ({ err })
      )
      expect(outcome).toHaveProperty('err')
      expect((outcome as { err: Error }).err.message).toMatch(/provider "nope" is not registered/)
      expect(outcome).not.toHaveProperty('res')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '4909102e isError: an ApiError raised by the same verb is an isError tool result whose text starts with its code and whose _meta carries the code (ADR-0018)',
    async () => {
      const client = await session(fakeVerbs(vi.fn, { describeProvider: async () => { throw new ApiError('not_found', 'no such provider') } }))
      const res = (await client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'duckduckgo' } } } })) as {
        isError?: boolean
        content?: Array<{ text?: string }>
        _meta?: Record<string, unknown>
      }
      expect(res.isError).toBe(true)
      expect(res.content?.[0]?.text).toBe('not_found: no such provider')
      expect(res._meta?.['adhd/error']).toMatchObject({ code: 'not_found' })
    },
    BUILD_TIMEOUT_MS
  )

  it('4909102e isError: src/errors.ts names the rejection form of a typed error and no longer claims an isError code form', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(new URL('../../../src/errors.ts', import.meta.url), 'utf8')
    expect(text).not.toContain('isError: true')
    expect(text).toMatch(/JSON-RPC/)
  })
})
