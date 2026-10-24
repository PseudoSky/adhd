/**
 * guards: the MCP host boots with the wrong transport, skips exit-hook or pid-registry wiring, or the stdin-EOF grace is wrong
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.12] [search-hosts.13] [search-hosts.14] [search-hosts.15] [search-hosts.16]
 * The MCP host's boot: transport selection, exit-hook and manager wiring, the boot trace, the pid
 * registry, the stdin-EOF grace and the bin body (`mcpMain`), all through the exported host
 * factories with fakes at every process edge. Ticket 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.12] [search-hosts.13] [search-hosts.14] [search-hosts.15] [search-hosts.16]
 * · inventory rows I-33 (boot trace, pid registry, crash handlers, 5 s forced exit, stdin-EOF
 * orphan), I-34 (stdio, sse, streaming-http, host and port, logger level, format and file), I-39
 * (--restart-browser).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lifecycle } from '@adhd/stealth-core-browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostBootFailedError, HostTransportUnsupportedError } from '../../../src/host-errors.js'
import { defaultHostSettings, parseHostFlags } from '../../../src/host-flags.js'
import type { HostSettings } from '../../../src/host-flags.js'
import {
  FORCE_EXIT_MS,
  STDIN_GRACE_MS,
  createBootTrace,
  graceStdin,
  mcpMain,
  registerPid,
  selectTransport,
  startMcpHost,
} from '../../../src/server.js'
import type { HostFs, McpHostDeps } from '../../../src/server.js'
import { tracingPlugin } from '../../../src/tracing.js'
import { BUILD_TIMEOUT_MS, FakeStdin, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'
import type { RunInput } from '@adhd/apigen-core-client'

afterEach(() => {
  vi.useRealTimers()
})

/** An in-memory HostFs. */
function memoryFs(initial: Record<string, string> = {}): HostFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    appendFile: (p, d) => void files.set(p, (files.get(p) ?? '') + d),
    readFile: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    writeFile: (p, d) => void files.set(p, d),
    mkdirp: () => undefined,
  }
}

function settingsFrom(...argv: string[]): HostSettings {
  return parseHostFlags(argv, 'mcp').settings
}

interface Recorder {
  deps: McpHostDeps
  runs: RunInput[]
  hooks: Array<{ target: unknown; options: Record<string, unknown> }>
  managers: Array<Record<string, unknown>>
  configured: unknown[]
  restarts: unknown[]
  stderr: string[]
  procOn: Array<[string, (...a: unknown[]) => void]>
  fs: ReturnType<typeof memoryFs>
  uninstalled: number
}

function recorder(over: McpHostDeps = {}): Recorder {
  const rec: Recorder = { deps: {}, runs: [], hooks: [], managers: [], configured: [], restarts: [], stderr: [], procOn: [], fs: memoryFs(), uninstalled: 0 }
  rec.deps = {
    build: () => packageFor(fakeVerbs(vi.fn)),
    runMcp: async (input) => void rec.runs.push(input),
    configure: (o) => void rec.configured.push(o),
    configureManagers: ((s: Record<string, unknown>) => void rec.managers.push(s)) as McpHostDeps['configureManagers'],
    installHooks: ((target: unknown, options: Record<string, unknown>) => {
      rec.hooks.push({ target, options })
      return () => void rec.uninstalled++
    }) as McpHostDeps['installHooks'],
    restartBrowser: async (i) => void rec.restarts.push(i),
    proc: { on: (e, l) => void rec.procOn.push([e, l]), removeListener: () => undefined },
    stdin: new FakeStdin({ isTTY: false }),
    stderr: (l) => void rec.stderr.push(l),
    fs: rec.fs,
    pid: 4242,
    isAlive: () => false,
    entryPath: '/fake/core/index.js',
    ...over,
  }
  return rec
}

describe('transport selection [search-hosts.12] [search-hosts.16]', () => {
  it('I-34 stdio, sse and streaming-http are accepted; anything else is HOST_TRANSPORT_UNSUPPORTED naming the supported ones', () => {
    for (const t of ['stdio', 'sse', 'streaming-http']) expect(selectTransport(t)).toBe(t)
    expect(() => selectTransport('carrier-pigeon')).toThrow(HostTransportUnsupportedError)
    try {
      selectTransport('carrier-pigeon')
    } catch (e) {
      expect((e as HostTransportUnsupportedError).code).toBe('HOST_TRANSPORT_UNSUPPORTED')
      expect((e as Error).message).toContain('carrier-pigeon')
      expect((e as Error).message).toContain('stdio, sse, streaming-http')
    }
  })

  it(
    'an unknown transport fails before anything is started: no manager, no hook, no pid registration, nothing run',
    async () => {
      const rec = recorder()
      await expect(startMcpHost(settingsFrom('--transport', 'carrier-pigeon'), rec.deps)).rejects.toBeInstanceOf(HostTransportUnsupportedError)
      expect(rec.managers).toEqual([])
      expect(rec.hooks).toEqual([])
      expect(rec.runs).toEqual([])
      expect(rec.fs.files.size).toBe(0)
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'I-34 stdio is the default and sse / streaming-http carry --listen-port and --listen-host to the plugin with an abort signal',
    async () => {
      const stdio = recorder()
      const a = await startMcpHost(settingsFrom(), stdio.deps)
      await a.done
      expect(stdio.runs[0]?.options['transport']).toBe('stdio')
      for (const t of ['sse', 'streaming-http'] as const) {
        const rec = recorder()
        const h = await startMcpHost(settingsFrom('--transport', t, '--listen-port', '4100', '--listen-host', '0.0.0.0', '--allow-remote-listen'), rec.deps)
        await h.done
        expect(rec.runs[0]?.options).toMatchObject({ transport: t, port: 4100, host: '0.0.0.0' })
        expect(rec.runs[0]?.signal).toBeInstanceOf(AbortSignal)
        expect(rec.runs[0]?.signal?.aborted).toBe(false)
        h.abort()
        expect(rec.runs[0]?.signal?.aborted).toBe(true)
      }
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'a transport that fails to start is a typed HOST_BOOT_FAILED on done, with the cause',
    async () => {
      const rec = recorder({ runMcp: async () => Promise.reject(Object.assign(new Error('EADDRINUSE 3100'), { code: 'EADDRINUSE' })) })
      const h = await startMcpHost(settingsFrom('--transport', 'sse'), rec.deps)
      await expect(h.done).rejects.toBeInstanceOf(HostBootFailedError)
      await h.done.catch((e: HostBootFailedError) => {
        expect(e.message).toContain('EADDRINUSE 3100')
        expect(e.cause).toBeInstanceOf(Error)
      })
    },
    BUILD_TIMEOUT_MS
  )
})

describe('logger settings reach the plugin [search-hosts.12]', () => {
  it(
    'I-34 logger: --log-level, --log-format and --log-file configure the logger handed to the plugin: a line lands in the file at that level and nothing is written to stdout',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'stealth-search-logger-spec-'))
      const file = join(dir, 'host.log')
      const stdout = vi.spyOn(process.stdout, 'write')
      try {
        const rec = recorder()
        await (await startMcpHost(settingsFrom('--log-level', 'warn', '--log-format', 'json', '--log-file', file), rec.deps)).done
        const logger = rec.runs[0]?.logger as { info(m: string): void; warn(m: string): void } | undefined
        logger?.info('below the level')
        logger?.warn('at the level')
        const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { msg: string; level: number })
        expect(lines.map((l) => l.msg)).toEqual(['at the level'])
        expect(lines[0]?.level).toBe(40)
        expect(stdout).not.toHaveBeenCalled()
      } finally {
        stdout.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    BUILD_TIMEOUT_MS
  )
})

describe('tracing is mounted, not configured [search-hosts.15]', () => {
  it(
    'the plugin is run with the tracingPlugin of src/tracing.ts in usePlugins and the eleven tool descriptions',
    async () => {
      const rec = recorder()
      await (await startMcpHost(settingsFrom(), rec.deps)).done
      const plugins = rec.runs[0]?.options['usePlugins'] as unknown[]
      expect(plugins).toEqual([tracingPlugin])
      expect(plugins[0]).toBe(tracingPlugin)
      const descriptions = rec.runs[0]?.options['toolDescriptions'] as Record<string, string>
      expect(Object.keys(descriptions)).toHaveLength(11)
      for (const [name, d] of Object.entries(descriptions)) expect(d.length, name).toBeGreaterThanOrEqual(40)
    },
    BUILD_TIMEOUT_MS
  )
})

describe('lifecycle wiring [search-hosts.13]', () => {
  it(
    'stdio installs the exit hooks on chromeExitTarget with stdinEof true and a 5000 ms bound; sse and streaming-http do not watch stdin',
    async () => {
      const stdio = recorder()
      await (await startMcpHost(settingsFrom(), stdio.deps)).done
      expect(stdio.hooks).toHaveLength(1)
      expect(stdio.hooks[0]?.target).toBe(lifecycle.chromeExitTarget)
      expect(stdio.hooks[0]?.options['stdinEof']).toBe(true)
      expect(stdio.hooks[0]?.options['forceExitMs']).toBe(FORCE_EXIT_MS)
      expect(FORCE_EXIT_MS).toBe(5000)
      for (const t of ['sse', 'streaming-http']) {
        const rec = recorder()
        await (await startMcpHost(settingsFrom('--transport', t), rec.deps)).done
        expect(rec.hooks[0]?.options['stdinEof'], t).toBeUndefined()
      }
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'an interactive stdin (a person at a terminal) is not an orphan: no stdin watching even for stdio',
    async () => {
      const rec = recorder({ stdin: new FakeStdin({ isTTY: true }) })
      await (await startMcpHost(settingsFrom(), rec.deps)).done
      expect(rec.hooks[0]?.options['stdinEof']).toBeUndefined()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'configureManagers gets idleTimeoutMs, keepAlive, checkHistory false, entryPath and a logger that writes to stderr only',
    async () => {
      const rec = recorder()
      await (await startMcpHost(settingsFrom('--idle-shutdown', '30000', '--keep-alive'), rec.deps)).done
      expect(rec.managers).toHaveLength(1)
      expect(rec.managers[0]).toMatchObject({ idleTimeoutMs: 30000, keepAlive: true, checkHistory: false, entryPath: '/fake/core/index.js' })
      ;(rec.managers[0]?.['logger'] as (m: string) => void)('reaper armed')
      expect(rec.stderr[rec.stderr.length - 1]).toContain('reaper armed')
      const check = recorder()
      await (await startMcpHost(settingsFrom('--check-history'), check.deps)).done
      expect(check.managers[0]).toMatchObject({ checkHistory: true })
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'the search config is wired from the flags and the MCP host provides no interactive port',
    async () => {
      const rec = recorder()
      await (await startMcpHost(settingsFrom('--tripwire-ttl-ms', '5000', '--max-concurrent', '3'), rec.deps)).done
      const cfg = rec.configured[0] as { config: Record<string, unknown>; interaction?: unknown }
      expect(cfg.config).toMatchObject({ tripwireTtlMs: 5000, maxConcurrent: 3 })
      expect(cfg.interaction).toBeUndefined()
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'I-39 --restart-browser runs shutdownChrome at the CDP endpoint before the transport starts',
    async () => {
      const order: string[] = []
      const rec = recorder({
        restartBrowser: async (i) => {
          order.push(`restart:${i.host}:${i.port}`)
        },
        runMcp: async () => void order.push('run'),
      })
      await (await startMcpHost(settingsFrom('--restart-browser', '--cdp-port', '19999'), rec.deps)).done
      expect(order).toEqual(['restart:127.0.0.1:19999', 'run'])
    },
    BUILD_TIMEOUT_MS
  )
})

describe('boot behaviours of server.mjs as flag-driven code [search-hosts.14]', () => {
  it('I-33 --trace-file: one JSON line per boot stage with time and pid; no file, no trace; a failing write never fails the boot', () => {
    const fs = memoryFs()
    const trace = createBootTrace('/t/boot.trace', { fs, pid: 7, now: () => new Date('2026-10-21T10:00:00.000Z') })
    trace('boot', { transport: 'stdio' })
    trace('configured')
    const lines = (fs.files.get('/t/boot.trace') ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([
      { t: '2026-10-21T10:00:00.000Z', pid: 7, stage: 'boot', transport: 'stdio' },
      { t: '2026-10-21T10:00:00.000Z', pid: 7, stage: 'configured' },
    ])
    expect(() => createBootTrace(undefined)('boot')).not.toThrow()
    const broken: HostFs = { ...fs, appendFile: () => { throw new Error('disk full') } }
    expect(() => createBootTrace('/t/x', { fs: broken })('boot')).not.toThrow()
  })

  it(
    'I-33 a started host writes its boot stages to the trace file in order',
    async () => {
      const rec = recorder()
      await (await startMcpHost(settingsFrom('--trace-file', '/t/boot.trace'), rec.deps)).done
      const stages = (rec.fs.files.get('/t/boot.trace') ?? '').trim().split('\n').map((l) => (JSON.parse(l) as { stage: string }).stage)
      expect(stages).toEqual(['boot', 'pid-registered', 'configured', 'hooks-installed', 'package-built', 'run-invoked'])
    },
    BUILD_TIMEOUT_MS
  )

  it('I-33 --pid-file: live siblings at or above --max-siblings warn on stderr and never get killed; the pid is registered and leaves the registry on exit', () => {
    const fs = memoryFs({ '/p/mcp.pids': '101\n102\n103\n104\n999\n' })
    const warnings: string[] = []
    const exitListeners: Array<() => void> = []
    const reg = registerPid({
      pidFile: '/p/mcp.pids',
      maxSiblings: 4,
      fs,
      pid: 500,
      isAlive: (p) => p !== 999,
      warn: (m) => void warnings.push(m),
      proc: { on: (_e, l) => void exitListeners.push(l) },
    })
    expect(reg.siblings).toEqual([101, 102, 103, 104])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('4 sibling instances')
    expect(warnings[0]).toContain('kill 101 102 103 104')
    expect((fs.files.get('/p/mcp.pids') ?? '').trim().split('\n').map(Number).sort()).toEqual([101, 102, 103, 104, 500])
    exitListeners[0]?.()
    expect((fs.files.get('/p/mcp.pids') ?? '').trim().split('\n').map(Number).sort()).toEqual([101, 102, 103, 104])
    reg.unregister()
  })

  it('I-33 fewer siblings than --max-siblings do not warn; no --pid-file means no registry', () => {
    const fs = memoryFs({ '/p/mcp.pids': '101\n' })
    const warnings: string[] = []
    registerPid({ pidFile: '/p/mcp.pids', maxSiblings: 4, fs, pid: 500, isAlive: () => true, warn: (m) => void warnings.push(m), proc: { on: () => undefined } })
    expect(warnings).toEqual([])
    const none = registerPid({ pidFile: undefined, maxSiblings: 4, fs })
    expect(none.siblings).toEqual([])
    expect(() => none.unregister()).not.toThrow()
  })

  it('I-33 [I-17] uncaughtException and unhandledRejection handlers are registered next to the core exit hooks, and the hooks do the soft Chrome shutdown then exit 1', async () => {
    const rec = recorder({ proc: undefined })
    const registered: string[] = []
    rec.deps.proc = { on: (e) => void registered.push(e), removeListener: () => undefined }
    await (await startMcpHost(settingsFrom('--trace-file', '/t/x'), rec.deps)).done
    expect(registered).toEqual(expect.arrayContaining(['uncaughtException', 'unhandledRejection']))
    // The core hook itself (not faked): crash -> release + soft shutdown -> exit(1).
    const exits: number[] = []
    const calls: string[] = []
    const listeners = new Map<string, (...a: unknown[]) => void>()
    const uninstall = lifecycle.installProcessExitHooks(
      { release: () => void calls.push('release'), shutdownIfIdle: async () => void calls.push('shutdownIfIdle') },
      { exit: (c) => void exits.push(c), proc: { on: (e, l) => void listeners.set(e, l), removeListener: () => undefined }, logger: () => undefined, forceExitMs: FORCE_EXIT_MS }
    )
    listeners.get('uncaughtException')?.(new Error('boom'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['release', 'shutdownIfIdle'])
    expect(exits).toEqual([1])
    uninstall()
  })

  it('I-33 a teardown that never finishes is cut off by the 5000 ms forced exit (fake timers)', () => {
    vi.useFakeTimers()
    const exits: number[] = []
    const listeners = new Map<string, (...a: unknown[]) => void>()
    lifecycle.installProcessExitHooks(
      { release: () => undefined, shutdownIfIdle: () => new Promise<void>(() => undefined) },
      {
        exit: (c) => void exits.push(c),
        proc: { on: (e, l) => void listeners.set(e, l), removeListener: () => undefined },
        logger: () => undefined,
        forceExitMs: FORCE_EXIT_MS,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }
    )
    listeners.get('SIGTERM')?.()
    vi.advanceTimersByTime(FORCE_EXIT_MS - 1)
    expect(exits).toEqual([])
    vi.advanceTimersByTime(1)
    expect(exits).toEqual([143])
  })

  it('I-33 stdin EOF orphan detection waits a 1000 ms grace: the hook sees `end` only once stdin stayed closed that long, and a removed listener never fires', () => {
    vi.useFakeTimers()
    const stdin = new FakeStdin({ isTTY: false })
    const wrapped = graceStdin(stdin)
    let ended = 0
    const onEnd = (): void => void ended++
    wrapped.on('end', onEnd)
    expect(STDIN_GRACE_MS).toBe(1000)
    stdin.close()
    vi.advanceTimersByTime(999)
    expect(ended).toBe(0)
    vi.advanceTimersByTime(1)
    expect(ended).toBe(1)
    // end then close are one EOF: still one call.
    vi.advanceTimersByTime(5000)
    expect(ended).toBe(1)

    const s2 = new FakeStdin({ isTTY: false })
    const w2 = graceStdin(s2)
    let fired = 0
    const l2 = (): void => void fired++
    w2.on('end', l2)
    s2.close()
    w2.removeListener('end', l2)
    vi.advanceTimersByTime(2000)
    expect(fired).toBe(0)
    expect(s2.count('end')).toBe(0)
    expect(s2.count('close')).toBe(0)
  })

  it(
    'I-33 on stdio the exit hook is handed the grace-wrapped stdin: closing stdin triggers the hook listener after 1000 ms, not before',
    async () => {
      const stdin = new FakeStdin({ isTTY: false })
      let hookEnd: (() => void) | undefined
      const rec = recorder({ stdin })
      rec.deps.installHooks = ((_t: unknown, options: { stdin?: { on(e: 'end', l: () => void): unknown } }) => {
        options.stdin?.on('end', () => void (hookEnd = () => undefined))
        return () => undefined
      }) as McpHostDeps['installHooks']
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await (await startMcpHost(settingsFrom(), rec.deps)).done
      stdin.close()
      vi.advanceTimersByTime(999)
      expect(hookEnd).toBeUndefined()
      vi.advanceTimersByTime(1)
      expect(hookEnd).toBeDefined()
    },
    BUILD_TIMEOUT_MS
  )
})

describe('the bin body (mcpMain) [search-hosts.9] [search-hosts.10] [search-hosts.12]', () => {
  it('--help prints the whole host-flag table and exits 0 without booting anything', async () => {
    const out: string[] = []
    const rec = recorder()
    const code = await mcpMain(['--help'], { ...rec.deps, stdout: (t) => void out.push(t) })
    expect(code).toBe(0)
    expect(out[0]).toContain('Usage: stealth-search-mcp [host flags]')
    expect(out[0]).toContain('--listen-port <n>')
    expect(rec.managers).toEqual([])
  })

  it(
    'telemetry starts once as live-service before the host starts; a clean end exits 0',
    async () => {
      const order: string[] = []
      const rec = recorder({ runMcp: async () => void order.push('run') })
      const code = await mcpMain(['--log-dir', '/logs'], { ...rec.deps, initTelemetry: (o) => void order.push(`telemetry:${JSON.stringify(o)}`) })
      expect(code).toBe(0)
      expect(order).toEqual(['telemetry:{"role":"live-service","logDir":"/logs"}', 'run'])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'HOST_TRANSPORT_UNSUPPORTED, HOST_FLAG_INVALID and HOST_BOOT_FAILED are one stderr line each and the exit status of the code (78, 77, 79)',
    async () => {
      const a = recorder()
      expect(await mcpMain(['--transport', 'carrier-pigeon'], a.deps)).toBe(78)
      expect(a.stderr).toHaveLength(1)
      expect(a.stderr[0]).toMatch(/^HOST_TRANSPORT_UNSUPPORTED: /)
      const b = recorder()
      expect(await mcpMain(['--listen-port', 'abc'], b.deps)).toBe(77)
      expect(b.stderr[0]).toMatch(/^HOST_FLAG_INVALID: --listen-port/)
      const c = recorder()
      expect(await mcpMain(['stray'], c.deps)).toBe(77)
      expect(c.stderr[0]).toMatch(/^HOST_FLAG_INVALID: stray: unknown argument/)
      const d = recorder({ build: async () => Promise.reject(new Error('extract exploded')) })
      expect(await mcpMain([], d.deps)).toBe(79)
      expect(d.stderr[0]).toMatch(/^HOST_BOOT_FAILED: /)
      for (const r of [a, b, c, d]) expect(r.stderr[0]).not.toContain('    at ')
    },
    BUILD_TIMEOUT_MS
  )
})

describe('defaults the MCP host boots with [search-hosts.6]', () => {
  it('stdio, 3100 on 127.0.0.1, idle shutdown 120000 ms and the MCP logger level info when no flag is passed', () => {
    const s = defaultHostSettings()
    expect([s.transport, s.listenPort, s.listenHost, s.idleShutdownMs, s.logLevel]).toEqual(['stdio', 3100, '127.0.0.1', 120000, undefined])
  })
})
