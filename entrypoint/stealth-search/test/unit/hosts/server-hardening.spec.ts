/**
 * guards: a failed build leaves hooks, trace listeners or the pid registered; the trace listeners go on before the exit hooks; a 0 or negative pid reaches process.kill; an unreadable dependency version silently blinds the cache key
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.16] [resolve-findings.4] (F49 F50 F83 F84 F85)
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/hosts/server-hardening.spec.ts -> exit 1 (4 failed | 3 passed) with no unwind around build() or installHooks, the pid filter back to !Number.isNaN and packageVersionOf returning ''.
 * Real use: an in-process host retries a boot whose package build threw; a stale pid file holds a 0 or a negative number.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostBootFailedError } from '../../../src/host-errors.js'
import { parseHostFlags } from '../../../src/host-flags.js'
import { packageVersionOf, registerPid, startMcpHost } from '../../../src/server.js'
import type { HostFs, McpHostDeps } from '../../../src/server.js'
import { FakeStdin, fakeVerbs, packageFor } from '../../helpers/hosts/host-harness.js'

afterEach(() => vi.restoreAllMocks())

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

const settings = parseHostFlags(['--pid-file', '/p/mcp.pids'], 'mcp').settings

/** A process surface that records which listeners are attached right now, in attach order. */
function liveProc(): { on(e: string, l: (...a: unknown[]) => void): unknown; removeListener(e: string, l: (...a: unknown[]) => void): unknown; attached: string[]; log: string[] } {
  const attached: string[] = []
  const log: string[] = []
  const store: Array<[string, (...a: unknown[]) => void]> = []
  return {
    attached,
    log,
    on: (e, l) => {
      store.push([e, l])
      attached.push(e)
      log.push(`on:${e}`)
    },
    removeListener: (e, l) => {
      const i = store.findIndex(([ev, fn]) => ev === e && fn === l)
      if (i >= 0) {
        store.splice(i, 1)
        attached.splice(attached.indexOf(e), 1)
      }
      log.push(`off:${e}`)
    },
  }
}

function deps(proc: ReturnType<typeof liveProc>, fs: ReturnType<typeof memoryFs>, over: McpHostDeps = {}): McpHostDeps & { uninstalls: number } {
  const d = {
    uninstalls: 0,
    build: () => packageFor(fakeVerbs(vi.fn)),
    runMcp: async () => undefined,
    configure: () => undefined,
    configureManagers: (() => undefined) as McpHostDeps['configureManagers'],
    installHooks: (() => {
      proc.log.push('hooks')
      return () => void d.uninstalls++
    }) as McpHostDeps['installHooks'],
    proc,
    stdin: new FakeStdin({ isTTY: false }),
    stderr: () => undefined,
    fs,
    pid: 4242,
    isAlive: () => false,
    entryPath: '/fake/core/index.js',
    ...over,
  }
  return d
}

describe('8468f7b1 [resolve-findings.4] startMcpHost unwinds what it installed', () => {
  it('a build() that throws removes the exit hooks, the trace listeners and the pid, so a retry starts clean', async () => {
    const proc = liveProc()
    const fs = memoryFs()
    const d = deps(proc, fs, { build: async () => { throw new Error('extraction failed') } })
    await expect(startMcpHost(settings, d)).rejects.toThrow('extraction failed')
    expect(d.uninstalls).toBe(1)
    expect(proc.attached.filter((e) => e === 'uncaughtException' || e === 'unhandledRejection')).toEqual([])
    expect(fs.files.get('/p/mcp.pids')?.trim() ?? '').not.toContain('4242')
  })

  it('the trace listeners are attached only after the exit hooks, and a failing hook installer leaves none behind', async () => {
    const proc = liveProc()
    const fs = memoryFs()
    await startMcpHost(settings, deps(proc, fs))
    expect(proc.log.indexOf('hooks')).toBeGreaterThanOrEqual(0)
    expect(proc.log.indexOf('on:uncaughtException')).toBeGreaterThan(proc.log.indexOf('hooks'))
    expect(proc.log.indexOf('on:unhandledRejection')).toBeGreaterThan(proc.log.indexOf('hooks'))

    const proc2 = liveProc()
    const fs2 = memoryFs()
    const failing2 = deps(proc2, fs2, { installHooks: (() => { throw new Error('hooks refused') }) as McpHostDeps['installHooks'] })
    await expect(startMcpHost(settings, failing2)).rejects.toThrow('hooks refused')
    expect(proc2.attached.filter((e) => e === 'uncaughtException' || e === 'unhandledRejection')).toEqual([])
    expect(fs2.files.get('/p/mcp.pids')?.trim() ?? '').not.toContain('4242')
  })

  it('the handle uninstall() removes the hooks, the trace listeners and the pid', async () => {
    const proc = liveProc()
    const fs = memoryFs()
    const d = deps(proc, fs)
    const handle = await startMcpHost(settings, d)
    expect(proc.attached).toEqual(expect.arrayContaining(['uncaughtException', 'unhandledRejection']))
    handle.uninstall()
    expect(d.uninstalls).toBe(1)
    expect(proc.attached.filter((e) => e === 'uncaughtException' || e === 'unhandledRejection')).toEqual([])
    expect(fs.files.get('/p/mcp.pids')?.trim() ?? '').not.toContain('4242')
  })
})

describe('8468f7b1 [resolve-findings.4] pid registry', () => {
  it('never probes a 0 or negative pid (process.kill would address a process group)', () => {
    const probed: number[] = []
    const reg = registerPid({
      pidFile: '/p/mcp.pids',
      maxSiblings: 10,
      fs: memoryFs({ '/p/mcp.pids': '0\n-1\n-4242\n77\nnot-a-pid\n' }),
      pid: 4242,
      isAlive: (p) => { probed.push(p); return true },
      warn: () => undefined,
      proc: { on: () => undefined },
    })
    expect(probed).toEqual([77])
    expect(reg.siblings).toEqual([77])
  })
})

describe('8468f7b1 [resolve-findings.4] package version in the cache key', () => {
  it('an unresolvable package yields a marker, never an empty string', () => {
    expect(packageVersionOf('@adhd/does-not-exist-anywhere')).toBe('unresolved:@adhd/does-not-exist-anywhere')
  })

  it('the baker refuses an unresolvable package with a typed HOST_BOOT_FAILED', () => {
    try {
      packageVersionOf('@adhd/does-not-exist-anywhere', true)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(HostBootFailedError)
      expect((e as HostBootFailedError).detail).toMatchObject({ reason: 'package-version-unresolved', package: '@adhd/does-not-exist-anywhere' })
    }
  })

  it('a resolvable workspace package yields its version', () => {
    expect(packageVersionOf('@adhd/stealth-core-browser')).toMatch(/^\d+\.\d+\.\d+/)
  })
})
