/**
 * guards: a failing call writes more than one adhd.<op>.error for its real op id, or more than the single documented upstream twin adhd.op.error (op id `op`)
 * tier: S
 * cites: ticket 8468f7b1 [search-tracing-fixes.3] [search-hosts.16] backlog 5152786d
 * The REAL `runCli` over the real package with a failing verb, and the MCP-side layer driven in process, each over
 * a real sox-telemetry file sink in a temp dir and a process-spawn fake (no Chrome, no socket, no subprocess).
 * The shared apigen tracing plugin writes a documented upstream twin `adhd.op.error` (op id `op`) next to every
 * `adhd.<op>.error`; it is kept as is. Criteria: [search-tracing-fixes.3].
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Call, Result } from '@adhd/apigen-core-client'
import { _resetTelemetryForTest, initTelemetry } from '@adhd/sox-telemetry'
import type { TelemetryHandle } from '@adhd/sox-telemetry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../src/cli.js'
import { searchError } from '../../../src/errors.js'
import { tracingPlugin } from '../../../src/tracing.js'
import { BUILD_TIMEOUT_MS, cliHarness, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

interface Rec {
  event: string
  [key: string]: unknown
}

let logDir: string | undefined
let handle: TelemetryHandle | undefined

afterEach(() => {
  handle?.close()
  handle = undefined
  _resetTelemetryForTest()
  if (logDir) rmSync(logDir, { recursive: true, force: true })
  logDir = undefined
})

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

/** The one tolerated record carrying the literal op id `op`: the plugin's documented upstream twin. */
const TWIN = 'adhd.op.error'

describe('one error event per failing call [search-tracing-fixes.3]', () => {
  it(
    'duplicate adhd.op.error: a failing CLI verb writes exactly one adhd.<op>.error and the only op id op record is the single adhd.op.error twin',
    async () => {
      startSink('cli')
      const verbs = fakeVerbs(vi.fn, {
        chromeStatus: async () => {
          throw searchError('SEARCH_FAILED', 'forced failure')
        },
      })
      const built = await packageFor(verbs)
      const id = built.surface.find((s) => s.operation === 'chromeStatus')?.id as string
      const h = cliHarness(verbs, { build: async () => built })
      await runCli(['chromeStatus'], h.deps)
      const recs = await records()
      const own = recs.filter((r) => r.event.startsWith(`adhd.${id}.`))
      expect(own.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      expect(String(own[1]?.['error'])).toContain('forced failure')
      expect(recs.filter((r) => r.event === TWIN)).toHaveLength(1)
      expect(recs.filter((r) => r.event.endsWith('.error'))).toHaveLength(2)
      expect(recs.every((r) => r['adhd.op'] === id)).toBe(true)
    },
    BUILD_TIMEOUT_MS
  )

  it('duplicate adhd.op.error op id: the layer both hosts mount writes one error record for a failing call and a single adhd.op.error twin, no other record has the op id op', async () => {
    startSink('live-service')
    await handle?.otelReady()
    const layer = tracingPlugin.capabilities.layer?.layer as unknown as (call: Call, next: () => Promise<Result>) => Promise<Result>
    const call = {
      operation: { id: 'stealth/probe' },
      data: {},
      envelope: {},
      ctx: new Map(),
      transport: 'mcp',
      signal: new AbortController().signal,
    } as unknown as Call
    await expect(layer(call, async () => Promise.reject(searchError('UNKNOWN_PROVIDER', 'nope')))).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
    const recs = await records()
    expect(recs.filter((r) => r.event === 'adhd.stealth/probe.error')).toHaveLength(1)
    expect(recs.filter((r) => r.event === TWIN)).toHaveLength(1)
    expect(recs.map((r) => r.event).sort()).toEqual(['adhd.op.error', 'adhd.stealth/probe.error', 'adhd.stealth/probe.start'])
    for (const r of recs) expect(r['adhd.op']).toBe('stealth/probe')
  })
})
