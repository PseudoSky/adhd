/**
 * guards: UNKNOWN_PROVIDER is unreachable from the CLI or the MCP host (an enum rejects the provider first), or its span does not record the failure of the verb
 * tier: S
 * cites: ticket 8468f7b1 [search-tracing-fixes.1] [search-hosts.16] [audit-fixes.1] backlog 5152786d [resolve-findings.4]
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/hosts/search-tracing-unknown-provider.spec.ts -> exit 1; with providerSchemaOf walking to a missing property the no-enum test fails its toBeDefined assertion
 * The REAL `runCli` and the REAL `startMcpHost` (in-memory MCP client) over the real package, with the REAL
 * `describeProvider` verb bound to it, an unknown provider id, a real sox-telemetry file sink in a temp dir and a
 * process-spawn fake (no Chrome, no socket, no subprocess). Criteria: [search-tracing-fixes.1].
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { _resetTelemetryForTest, initTelemetry } from '@adhd/sox-telemetry'
import type { TelemetryHandle } from '@adhd/sox-telemetry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeProvider } from '../../../src/api.js'
import { runCli } from '../../../src/cli.js'
import { exitCodeFor } from '../../../src/errors.js'
import { defaultHostSettings } from '../../../src/host-flags.js'
import { startMcpHost } from '../../../src/server.js'
import type { McpHostHandle } from '../../../src/server.js'
import { BUILD_TIMEOUT_MS, FakeStdin, cliHarness, expectMcpToolError, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

const hoisted = vi.hoisted(() => ({ serverTransport: undefined as unknown }))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return hoisted.serverTransport as object
    }
  },
}))

interface Rec {
  event: string
  [key: string]: unknown
}

let logDir: string | undefined
let handle: TelemetryHandle | undefined
const sessions: Array<{ host: McpHostHandle; client: Client }> = []

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.client.close().catch(() => undefined)
    s.host.uninstall()
  }
  handle?.close()
  handle = undefined
  _resetTelemetryForTest()
  if (logDir) rmSync(logDir, { recursive: true, force: true })
  logDir = undefined
})

/** The injected telemetry sink: the real sox-telemetry JSONL file sink in a temp directory. */
function startSink(role: 'cli' | 'live-service'): void {
  _resetTelemetryForTest()
  logDir = mkdtempSync(join(tmpdir(), 'stealth-search-trace-'))
  handle = initTelemetry({ service: 'stealth-search', role, logSink: 'file', logDir, otel: true })
}

async function records(): Promise<Rec[]> {
  await handle?.otelReady()
  const path = handle?.currentLogFilePath() ?? null
  if (path === null || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Rec)
}

/** The process-spawn fake: anything that would start a process lands here and the spec asserts it stayed empty. */
function spawnFake(): { spawned: string[]; restartBrowser: () => Promise<void> } {
  const spawned: string[] = []
  return { spawned, restartBrowser: async () => void spawned.push('restartBrowser') }
}

/** The span records of one operation (the shared plugin also writes its documented `adhd.op.error` twin, asserted in search-tracing-single-error.spec.ts). */
function ofOp(recs: Rec[], id: string): Rec[] {
  return recs.filter((r) => r.event.startsWith(`adhd.${id}.`))
}

/** The `provider` property schema of an operation input: input.properties.data.properties.input.properties.provider. */
function providerSchemaOf(input: unknown): unknown {
  const child = (node: unknown, key: string): unknown => (node as Record<string, unknown> | undefined)?.[key]
  let node = input
  for (const key of ['properties', 'data', 'properties', 'input', 'properties', 'provider']) node = child(node, key)
  return node
}

describe('UNKNOWN_PROVIDER reaches the verb and is recorded on the span [search-tracing-fixes.1]', () => {
  it(
    'UNKNOWN_PROVIDER cli span: an unknown provider passes the flag check, the verb throws UNKNOWN_PROVIDER, exit status follows it and the adhd span records the message of the verb',
    async () => {
      startSink('cli')
      const verbs = fakeVerbs(vi.fn, { describeProvider: describeProvider as never })
      const built = await packageFor(verbs)
      const id = built.surface.find((s) => s.operation === 'describeProvider')?.id as string
      const spawn = spawnFake()
      const h = cliHarness(verbs, { build: async () => built, restartBrowser: spawn.restartBrowser })
      const code = await runCli(['describeProvider', '--provider', 'not-a-provider'], h.deps)
      expect(h.stderr.join('\n')).toContain('UNKNOWN_PROVIDER')
      expect(h.stderr.join('\n')).not.toContain('is not one of')
      expect(code).toBe(exitCodeFor('UNKNOWN_PROVIDER'))
      expect(h.stdout).toHaveLength(0)
      const recs = await records()
      const span = ofOp(recs, id)
      expect(span.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      const err = span[1] as Rec
      // The shared plugin records the message of the failure, not its typed code (the code is the exit status).
      expect(String(err['error'])).toContain('Unknown provider "not-a-provider"')
      expect(err['adhd.transport']).toBe('cli')
      expect(spawn.spawned).toEqual([])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'UNKNOWN_PROVIDER mcp span: the provider input has no enum, the tool call reaches the verb, answers an isError result naming UNKNOWN_PROVIDER and the adhd span records the message of the verb',
    async () => {
      startSink('live-service')
      const verbs = fakeVerbs(vi.fn, { describeProvider: describeProvider as never })
      const built = await packageFor(verbs)
      const id = built.surface.find((s) => s.operation === 'describeProvider')?.id as string
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
      hoisted.serverTransport = serverEnd
      const host = await startMcpHost(
        { ...defaultHostSettings(), pidFile: undefined, traceFile: undefined, dataDir: '/data', logLevel: 'silent' },
        {
          build: async () => built,
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
      const client = new Client({ name: 'unknown-provider-spec', version: '0.0.0' })
      await client.connect(clientEnd)
      sessions.push({ host, client })
      await expectMcpToolError(client.callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'not-a-provider' } } } }), /not-a-provider/, 'UNKNOWN_PROVIDER')
      const recs = await records()
      const span = ofOp(recs, id)
      expect(span.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      const err = span[1] as Rec
      expect(String(err['error'])).toContain('Unknown provider "not-a-provider"')
      expect(err['adhd.transport']).toBe('mcp')
    },
    BUILD_TIMEOUT_MS
  )

  it('UNKNOWN_PROVIDER cli mcp span: the provider input of search, describeProvider and clearTripwire carries no enum', async () => {
    const built = await packageFor(fakeVerbs(vi.fn))
    for (const op of ['search', 'describeProvider', 'clearTripwire']) {
      const schema = built.pkg.schemas[op] as { input?: unknown } | undefined
      const provider = providerSchemaOf(schema?.input)
      expect(provider, op).toBeDefined()
      expect(JSON.stringify(provider), op).not.toMatch(/"enum"|"const"|anyOf|oneOf/)
    }
  }, BUILD_TIMEOUT_MS)
})
