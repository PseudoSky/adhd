/**
 * guards: a rejected flag leaves no span because telemetry starts after flag validation, or --help writes a span
 * tier: S
 * cites: ticket 8468f7b1 [search-tracing-fixes.2] backlog 5152786d
 * The REAL `runCli` over the real package, an injected telemetry initializer that starts a real sox-telemetry file
 * sink in a temp dir, and a process-spawn fake (no Chrome, no socket, no subprocess). Criteria: [search-tracing-fixes.2].
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetTelemetryForTest, initTelemetry } from '@adhd/sox-telemetry'
import type { TelemetryHandle } from '@adhd/sox-telemetry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../src/cli.js'
import { exitCodeFor } from '../../../src/errors.js'
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

function freshDir(): string {
  logDir = mkdtempSync(join(tmpdir(), 'stealth-search-trace-'))
  return logDir
}

/** The injected telemetry initializer: the real sox-telemetry file sink in the directory the host asks for. */
function realInit(calls: unknown[]): (o: { role: 'cli'; logDir?: string }) => void {
  return (o) => {
    calls.push(o)
    handle = initTelemetry({ service: 'stealth-search', role: o.role, logSink: 'file', logDir: o.logDir as string, otel: true })
  }
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

describe('telemetry starts before flag validation [search-tracing-fixes.2]', () => {
  it(
    'rejected flag span before flag validation: --cdp-port abc still writes the start and error span of the operation',
    async () => {
      const dir = freshDir()
      const verbs = fakeVerbs(vi.fn)
      const built = await packageFor(verbs)
      const id = built.surface.find((s) => s.operation === 'chromeStatus')?.id as string
      const calls: unknown[] = []
      const spawned: string[] = []
      const h = cliHarness(verbs, { build: async () => built, initTelemetry: realInit(calls), restartBrowser: async () => void spawned.push('restart') })
      const code = await runCli(['chromeStatus', '--cdp-port', 'abc', '--log-dir', dir], h.deps)
      expect(code).toBe(exitCodeFor('HOST_FLAG_INVALID'))
      expect(h.stderr.join('\n')).toContain('--cdp-port')
      expect(calls).toEqual([{ role: 'cli', logDir: dir }])
      const recs = await records()
      expect(recs.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
      expect(recs[1]?.['error_code']).toBe('HOST_FLAG_INVALID')
      expect(recs[1]?.['adhd.transport']).toBe('cli')
      expect(spawned).toEqual([])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'rejected flag span before flag validation: an unknown verb flag (after the host flags parsed) also writes the start and error span',
    async () => {
      const dir = freshDir()
      const verbs = fakeVerbs(vi.fn)
      const built = await packageFor(verbs)
      const id = built.surface.find((s) => s.operation === 'chromeStatus')?.id as string
      const calls: unknown[] = []
      const h = cliHarness(verbs, { build: async () => built, initTelemetry: realInit(calls) })
      const code = await runCli(['chromeStatus', '--no-such-flag', '1', '--log-dir', dir], h.deps)
      expect(code).toBe(exitCodeFor('HOST_FLAG_INVALID'))
      const recs = await records()
      expect(recs.map((r) => r.event)).toEqual([`adhd.${id}.start`, `adhd.${id}.error`])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'help is not a dispatch: --help, an operation --help and no arguments start no telemetry and write no span',
    async () => {
      const dir = freshDir()
      const verbs = fakeVerbs(vi.fn)
      const built = await packageFor(verbs)
      handle = initTelemetry({ service: 'stealth-search', role: 'cli', logSink: 'file', logDir: dir, otel: true })
      const calls: unknown[] = []
      for (const argv of [['--help'], ['chromeStatus', '--help'], [] as string[]]) {
        const h = cliHarness(verbs, { build: async () => built, initTelemetry: (o) => void calls.push(o) })
        const code = await runCli(argv, h.deps)
        expect(code, argv.join(' ')).toBe(0)
        expect(h.stdout.join('')).not.toBe('')
      }
      expect(calls).toEqual([])
      expect(await records()).toEqual([])
    },
    BUILD_TIMEOUT_MS
  )
})
