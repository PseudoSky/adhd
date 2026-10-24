/**
 * guards: UNKNOWN_PROVIDER is unreachable from the CLI or the MCP host (an enum rejects the provider first), or its span does not record the code
 * tier: S
 * cites: ticket 8468f7b1 [search-tracing-fixes.1] backlog 5152786d
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
import { BUILD_TIMEOUT_MS, FakeStdin, cliHarness, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

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

describe('UNKNOWN_PROVIDER reaches the verb and is recorded on the span [search-tracing-fixes.1]', () => {
  it(
    'UNKNOWN_PROVIDER cli span: an unknown provider passes the flag check, the verb throws UNKNOWN_PROVIDER, exit status follows it and the adhd span records the code',
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
      expect(recs.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      const err = recs[1] as Rec
      expect(err['error_code']).toBe('UNKNOWN_PROVIDER')
      expect(err['adhd.transport']).toBe('cli')
      expect(spawn.spawned).toEqual([])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'UNKNOWN_PROVIDER mcp span: the provider input has no enum, the tool call reaches the verb, rejects with UNKNOWN_PROVIDER and the adhd span records the code',
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
      const outcome = await client
        .callTool({ name: 'stealth_describeProvider', arguments: { data: { input: { provider: 'not-a-provider' } } } })
        .then(
          (res) => ({ res }),
          (err: unknown) => ({ err })
        )
      expect(outcome).toHaveProperty('err')
      expect(String((outcome as { err: Error }).err.message)).toMatch(/not-a-provider/)
      const recs = await records()
      expect(recs.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      const err = recs[1] as Rec
      expect(err['error_code']).toBe('UNKNOWN_PROVIDER')
      expect(err['adhd.transport']).toBe('mcp')
    },
    BUILD_TIMEOUT_MS
  )

  it('UNKNOWN_PROVIDER cli mcp span: the provider input of search, describeProvider and clearTripwire carries no enum', async () => {
    const built = await packageFor(fakeVerbs(vi.fn))
    for (const op of ['search', 'describeProvider', 'clearTripwire']) {
      const schema = built.pkg.schemas[op] as { input?: unknown } | undefined
      const provider = [schema?.input, 'properties', 'data', 'properties', 'input', 'properties', 'provider'].reduce(
        (node: unknown, key) => (key === schema?.input ? node : (node as Record<string, unknown> | undefined)?.[key as string]),
        schema?.input
      )
      expect(provider, op).toBeDefined()
      expect(JSON.stringify(provider), op).not.toMatch(/"enum"|"const"|anyOf|oneOf/)
    }
  }, BUILD_TIMEOUT_MS)
})
