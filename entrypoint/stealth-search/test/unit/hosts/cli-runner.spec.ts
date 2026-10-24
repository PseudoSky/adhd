/**
 * guards: runCli exits 0 with empty output, exits before the JSON is written, or mis-parses the one-shot and human flags
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [search-hosts.5] [search-hosts.10] [search-hosts.13] [search-hosts.16] [search-hosts.18] [search-hosts.21]
 * The CLI runner (`runCli`) over the real apigen package of the eleven verbs with fake verbs and
 * fake process edges. Ticket 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.5] [search-hosts.10] [search-hosts.13] [search-hosts.16] [search-hosts.18]
 * [search-hosts.21] · backlog abeedba8 (exit as soon as the JSON is written), 86ed154e (never exit 0
 * with empty output) · inventory rows I-36 (one-shot CLI), I-37 (human CLI flags), I-39
 * (--restart-browser, detached idle kill).
 * Fixtures are synthetic: no real Chrome, no socket, no spawned process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../src/cli.js'
import { exitCodeFor } from '../../../src/errors.js'
import { BUILD_TIMEOUT_MS, SAMPLES, cliHarness, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('CLI runner never rejects [audit-fixes.1] P31', () => {
  it(
    'a build failure whose stderr line cannot be written still resolves with the typed exit status and calls exit once',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn), {
        build: async () => {
          throw new Error('boom while building')
        },
        stderr: () => {
          throw new Error('stderr is closed')
        },
      })
      const code = await runCli(['chromeStatus'], h.deps)
      expect(code).toBe(exitCodeFor('HOST_BOOT_FAILED'))
      expect(h.exits).toEqual([code])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'an exit hook that throws does not turn into a rejection',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn), {
        build: async () => {
          throw new Error('boom while building')
        },
        stderr: () => {
          throw new Error('stderr is closed')
        },
        exit: () => {
          throw new Error('exit refused')
        },
      })
      await expect(runCli(['chromeStatus'], h.deps)).resolves.toBe(exitCodeFor('HOST_BOOT_FAILED'))
    },
    BUILD_TIMEOUT_MS
  )
})

describe('CLI runner: one JSON document, flushed, handles closed, then exit [search-hosts.18]', () => {
  it(
    'abeedba8 flush: I-36 stdout is written, flushed, the browser handles are closed, then exit(0), in that order',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      const code = await runCli(['chromeStatus', '--cdp-port', '19999'], h.deps)
      expect(code).toBe(0)
      expect(h.events).toEqual(['write', 'flush', 'close', 'exit(0)'])
      expect(h.stdout).toHaveLength(1)
      expect(JSON.parse(h.stdout[0] as string)).toEqual(SAMPLES.chromeStatus)
      expect(h.stdout[0]?.endsWith('\n')).toBe(true)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'abeedba8 exit: no timer or handle is left pending once the exit has been called (fake timers)',
    async () => {
      const pkg = await packageFor(fakeVerbs(vi.fn))
      vi.useFakeTimers()
      const h = cliHarness(fakeVerbs(vi.fn), {
        build: async () => pkg,
        stdout: { write: async () => undefined },
      })
      await runCli(['listProviders'], h.deps)
      expect(h.exits).toEqual([0])
      expect(vi.getTimerCount()).toBe(0)
      expect(h.uninstalled()).toBe(1)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'abeedba8 detached: the idleShutdown reaper is handed over by path and settings only, so the detached child never inherits stdout',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      await runCli(['chromeStatus', '--idle-shutdown', '45000', '--keep-alive'], h.deps)
      expect(h.managers).toHaveLength(1)
      const settings = h.managers[0] as Record<string, unknown>
      expect(Object.keys(settings).sort()).toEqual(['checkHistory', 'entryPath', 'idleTimeoutMs', 'keepAlive', 'logger'])
      expect(settings['idleTimeoutMs']).toBe(45000)
      expect(settings['keepAlive']).toBe(true)
      expect(settings['entryPath']).toBe('/fake/core/index.js')
      // The manager's diagnostics never go to stdout: with --verbose they go to stderr, otherwise nowhere.
      ;(settings['logger'] as (m: string) => void)('idle check')
      expect(h.stdout.join('')).not.toContain('idle check')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'abeedba8 stdout: a failing verb writes nothing to stdout and one typed line to stderr, then exits with its code',
    async () => {
      const { searchError } = await import('../../../src/errors.js')
      const h = cliHarness(
        fakeVerbs(vi.fn, {
          describeProvider: async () => {
            throw searchError('UNKNOWN_PROVIDER', 'no such provider "bogus"')
          },
        })
      )
      const code = await runCli(['describeProvider', '--provider', 'npm'], h.deps)
      expect(h.stdout).toEqual([])
      expect(h.stderr).toHaveLength(1)
      expect(h.stderr[0]).toMatch(/^UNKNOWN_PROVIDER: /)
      expect(code).toBe(exitCodeFor('UNKNOWN_PROVIDER'))
      expect(h.events).toEqual(['close', `exit(${code})`])
    },
    BUILD_TIMEOUT_MS
  )
})

describe('CLI runner never exits 0 with empty output [search-hosts.21]', () => {
  it(
    '86ed154e empty: an undefined verb result is a typed HOST_BOOT_FAILED on one stderr line, no stdout, non-zero exit',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn, { listProviders: async () => undefined as never }))
      const code = await runCli(['listProviders'], h.deps)
      expect(code).toBe(exitCodeFor('HOST_BOOT_FAILED'))
      expect(code).not.toBe(0)
      expect(h.stdout).toEqual([])
      expect(h.stderr).toHaveLength(1)
      expect(h.stderr[0]).toMatch(/^HOST_BOOT_FAILED: listProviders produced no output/)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '86ed154e empty: an empty string and a null result are HOST_BOOT_FAILED too',
    async () => {
      for (const value of ['', null]) {
        const h = cliHarness(fakeVerbs(vi.fn, { tripwireStatus: async () => value as never }))
        const code = await runCli(['tripwireStatus'], h.deps)
        expect(code).toBe(exitCodeFor('HOST_BOOT_FAILED'))
        expect(h.stdout).toEqual([])
        expect(h.stderr[0]).toMatch(/^HOST_BOOT_FAILED: /)
      }
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '86ed154e concurrent: three runner invocations at once, one returning undefined, give two stdout documents and one typed failure',
    async () => {
      const verbs = fakeVerbs(vi.fn, {
        chromeStatus: async () => ({ running: false, managed: false }),
        listProviders: async () => undefined as never,
        tripwireStatus: async () => ({}),
      })
      const runs = [['chromeStatus', '--cdp-port', '19999'], ['listProviders'], ['tripwireStatus']].map((argv) => {
        const h = cliHarness(verbs)
        return { h, done: runCli(argv, h.deps) }
      })
      const codes = await Promise.all(runs.map((r) => r.done))
      expect(codes).toEqual([0, exitCodeFor('HOST_BOOT_FAILED'), 0])
      expect(JSON.parse(runs[0]?.h.stdout[0] as string)).toEqual({ running: false, managed: false })
      expect(JSON.parse(runs[2]?.h.stdout[0] as string)).toEqual({})
      expect(runs[1]?.h.stdout).toEqual([])
      expect(runs[1]?.h.stderr[0]).toMatch(/^HOST_BOOT_FAILED: /)
      for (const r of runs) {
        expect(r.h.stdout.length + r.h.stderr.length).toBeGreaterThan(0)
        expect(r.h.exits).toHaveLength(1)
      }
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '86ed154e stdout: I-36 every operation writes one non-empty JSON document before exit 0',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const inputs: Record<string, string[]> = {
        search: ['duckduckgo', 'vite'],
        listProviders: [],
        describeProvider: ['npm'],
        tripwireStatus: [],
        clearTripwire: ['github'],
        getPageContext: ['tab-1'],
        chromeStatus: [],
        launchChrome: ['--port', '19990'],
        shutdownChrome: [],
        listPageTargets: [],
        checkChromeActivity: [],
      }
      for (const [op, args] of Object.entries(inputs)) {
        const h = cliHarness(verbs)
        const code = await runCli([op, ...args], h.deps)
        expect(code, `${op}: ${h.stderr.join('|')}`).toBe(0)
        expect(h.stdout, op).toHaveLength(1)
        expect(JSON.parse(h.stdout[0] as string), op).toEqual(SAMPLES[op as keyof typeof SAMPLES])
        expect(h.stderr, op).toEqual([])
      }
    },
    BUILD_TIMEOUT_MS
  )
})

describe('CLI runner: host flags, verb flags and typed failures [search-hosts.5] [search-hosts.10]', () => {
  it(
    '--cdp-port fills the port of the operation: the real core would be asked at that endpoint [search-hosts.5]',
    async () => {
      const verbs = fakeVerbs(vi.fn, { chromeStatus: async () => ({ running: false, managed: false }) })
      const h = cliHarness(verbs)
      await runCli(['chromeStatus', '--cdp-port', '19999', '--cdp-host', '10.0.0.7'], h.deps)
      expect(verbs.chromeStatus).toHaveBeenCalledTimes(1)
      expect(verbs.chromeStatus).toHaveBeenCalledWith({ host: '10.0.0.7', port: 19999 })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'HOST_FLAG_INVALID: a non-numeric --cdp-port is one stderr line starting HOST_FLAG_INVALID with no stack, exit 77 [search-hosts.10]',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const h = cliHarness(verbs)
      const code = await runCli(['--cdp-port', 'notanumber', 'chromeStatus'], h.deps)
      expect(code).toBe(77)
      expect(h.stderr).toHaveLength(1)
      expect(h.stderr[0]).toMatch(/^HOST_FLAG_INVALID: /)
      expect(h.stderr[0]).not.toContain('    at ')
      expect(h.stdout).toEqual([])
      expect(verbs.chromeStatus).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'HOST_FLAG_INVALID: an unknown operation and an unknown operation flag are rejected before any verb runs [search-hosts.10]',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const a = cliHarness(verbs)
      expect(await runCli(['bogusOperation'], a.deps)).toBe(77)
      expect(a.stderr[0]).toMatch(/^HOST_FLAG_INVALID: bogusOperation: unknown operation/)
      const b = cliHarness(verbs)
      expect(await runCli(['launchChrome', '--extra-args', '--evil'], b.deps)).toBe(77)
      expect(b.stderr[0]).toMatch(/^HOST_FLAG_INVALID: --extra-args: unknown flag/)
      for (const v of Object.values(verbs)) expect(v).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'verb flags: kebab-case flags, --input json, operands and --no-flag all build the input object (I-37: strategy, timeout, max-attempts, challenge-wait, qualifier, max-content-size)',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const h = cliHarness(verbs)
      await runCli(
        ['search', 'github', 'vite', '--qualifier', 'repo:vitejs/vite', '--strategy', 'network', '--timeout-ms', '9000', '--max-attempts', '2', '--challenge-wait-ms=0', '--content', 'full', '--max-content-size', '500', '--visibility', 'foreground', '--page-disposal', 'keep'],
        h.deps
      )
      expect(verbs.search).toHaveBeenCalledWith({
        provider: 'github',
        query: 'vite',
        qualifier: 'repo:vitejs/vite',
        strategy: 'network',
        timeoutMs: 9000,
        maxAttempts: 2,
        challengeWaitMs: 0,
        content: 'full',
        maxContentSize: 500,
        visibility: 'foreground',
        pageDisposal: 'keep',
      })
      const j = cliHarness(verbs)
      await runCli(['search', '--input', '{"provider":"npm","query":"zod","maxAttempts":1}', '--max-attempts', '3'], j.deps)
      expect(verbs.search).toHaveBeenLastCalledWith({ provider: 'npm', query: 'zod', maxAttempts: 3 })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'HOST_FLAG_INVALID: a missing required input, a bad number and a bad enum name the flag',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const cases: Array<[string[], RegExp]> = [
        [['search', '--provider', 'npm'], /^HOST_FLAG_INVALID: input: missing required flag\(s\): --query/],
        [['search', 'npm', 'zod', '--timeout-ms', 'soon'], /^HOST_FLAG_INVALID: --timeout-ms: "soon" is not a number/],
        [['search', 'npm', 'zod', '--strategy', 'telepathy'], /^HOST_FLAG_INVALID: --strategy: "telepathy" is not one of/],
        [['listProviders', 'extra'], /^HOST_FLAG_INVALID: extra: unexpected operand/],
      ]
      for (const [argv, rx] of cases) {
        const h = cliHarness(verbs)
        expect(await runCli(argv, h.deps), argv.join(' ')).toBe(77)
        expect(h.stderr[0]).toMatch(rx)
      }
      expect(verbs.search).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'launchChrome with extraArgs is rejected by the schema with nothing launched: the verb never runs [search-hosts.7] [search-hosts.16]',
    async () => {
      const verbs = fakeVerbs(vi.fn)
      const h = cliHarness(verbs)
      const code = await runCli(['launchChrome', '--input', '{"port":19997,"extraArgs":["--evil"],"chromePath":"/bin/sh"}'], h.deps)
      expect(code).toBe(77)
      expect(h.stderr[0]).toMatch(/^HOST_FLAG_INVALID: input: .*extraArgs/)
      expect(verbs.launchChrome).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '--pretty indents the document and --monitor adds one stderr line (I-37)',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      await runCli(['listProviders', '--pretty', '--monitor'], h.deps)
      expect(h.stdout[0]).toBe(`${JSON.stringify(SAMPLES.listProviders, null, 2)}\n`)
      expect(h.stderr).toHaveLength(1)
      expect(h.stderr[0]).toMatch(/^\[monitor\] elapsedMs=\d+ rssMb=[\d.]+ heapUsedMb=[\d.]+$/)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '--help lists the eleven operations and the whole host-flag table; <op> --help describes one operation [search-hosts.4] [search-hosts.6]',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      expect(await runCli(['--help'], h.deps)).toBe(0)
      const help = h.stdout[0] as string
      for (const op of ['search', 'listProviders', 'describeProvider', 'tripwireStatus', 'clearTripwire', 'getPageContext', 'chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity']) {
        expect(help).toContain(`  ${op}`)
      }
      expect(help).toMatch(/--cdp-port <n>\s+.*\(default 9222\)/)
      const o = cliHarness(fakeVerbs(vi.fn))
      expect(await runCli(['search', '--help'], o.deps)).toBe(0)
      expect(o.stdout[0]).toContain('--max-content-size <number>')
      expect(o.stdout[0]).toContain('(required)')
    },
    BUILD_TIMEOUT_MS
  )
})

describe('CLI runner: lifecycle wiring [search-hosts.13] [search-hosts.15]', () => {
  it(
    'I-39 --restart-browser runs shutdownChrome at the endpoint before the first operation; without the flag it never does',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      await runCli(['chromeStatus', '--restart-browser', '--cdp-port', '19999'], h.deps)
      expect(h.restarted).toEqual([{ host: '127.0.0.1', port: 19999 }])
      expect(h.events.indexOf('restart')).toBeLessThan(h.events.indexOf('write'))
      const n = cliHarness(fakeVerbs(vi.fn))
      await runCli(['chromeStatus'], n.deps)
      expect(n.restarted).toEqual([])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'the exit hooks are installed on chromeExitTarget without stdin watching, the managers get idleTimeoutMs/keepAlive/checkHistory false/entryPath, telemetry starts once as cli',
    async () => {
      const h = cliHarness(fakeVerbs(vi.fn))
      await runCli(['listProviders', '--data-dir', '/data/x', '--log-dir', '/logs'], h.deps)
      expect(h.hooks).toHaveLength(1)
      expect(h.hooks[0]?.options['stdinEof']).toBeUndefined()
      expect(h.hooks[0]?.options['forceExitMs']).toBe(5000)
      expect(h.hooks[0]?.target).toBeDefined()
      expect(h.managers).toEqual([expect.objectContaining({ idleTimeoutMs: 120000, keepAlive: false, checkHistory: false, entryPath: '/fake/core/index.js' })])
      expect(h.telemetry).toEqual([{ role: 'cli', logDir: '/logs' }])
      expect(h.configured).toHaveLength(1)
      const cfg = (h.configured[0] as { config: Record<string, unknown>; interaction: unknown }).config
      expect(cfg['dataDir']).toBe('/data/x')
      expect((h.configured[0] as { interaction: unknown }).interaction).toBeDefined()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'NODE_TOO_OLD: a runtime below 22.5 ends with one NODE_TOO_OLD line and exit 12 before anything is built [search-hosts.9]',
    async () => {
      const build = vi.fn()
      const h = cliHarness(fakeVerbs(vi.fn), { nodeVersion: '22.4.1', build })
      expect(await runCli(['listProviders'], h.deps)).toBe(12)
      expect(h.stderr[0]).toMatch(/^NODE_TOO_OLD: /)
      expect(build).not.toHaveBeenCalled()
    },
    BUILD_TIMEOUT_MS
  )
})
