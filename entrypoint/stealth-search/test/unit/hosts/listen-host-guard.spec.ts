/**
 * guards: the unauthenticated sse or streaming-http transport binds a non-loopback address without an explicit opt-in or a warning
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [search-hosts.12]
 * Pre-review P30: `--listen-host` outside loopback exposes launchChrome, shutdownChrome and URL fetching to the
 * network with no authentication, so the host refuses it (HOST_FLAG_INVALID) unless `--allow-remote-listen` is
 * passed, and warns when it is. stdio and loopback binds are untouched. Nothing is bound: the guard runs first.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { describe, expect, it } from 'vitest'
import { defaultHostSettings } from '../../../src/host-flags.js'
import { refuseUnauthenticatedRemoteListen, startMcpHost } from '../../../src/server.js'

const base = defaultHostSettings()

describe('an unauthenticated transport does not bind the network by accident [audit-fixes.1]', () => {
  it.each(['0.0.0.0', '::', '192.168.1.20', 'host.example.net'])('P30 %s is refused on sse and streaming-http with HOST_FLAG_INVALID naming the flag and the opt-in', (listenHost) => {
    for (const transport of ['sse', 'streaming-http'] as const) {
      expect(() => refuseUnauthenticatedRemoteListen({ ...base, listenHost, allowRemoteListen: false }, transport, () => undefined)).toThrow(
        expect.objectContaining({ code: 'HOST_FLAG_INVALID', message: expect.stringContaining('--allow-remote-listen') as unknown }),
      )
    }
  })

  it.each(['127.0.0.1', 'localhost', '::1', '127.5.5.5'])('P30 loopback %s binds without a warning', (listenHost) => {
    const warnings: string[] = []
    refuseUnauthenticatedRemoteListen({ ...base, listenHost, allowRemoteListen: false }, 'sse', (m) => void warnings.push(m))
    expect(warnings).toEqual([])
  })

  it('P30 stdio never binds, so any listen host is ignored', () => {
    expect(() => refuseUnauthenticatedRemoteListen({ ...base, listenHost: '0.0.0.0', allowRemoteListen: false }, 'stdio', () => undefined)).not.toThrow()
  })

  it('P30 the explicit opt-in binds and logs one warning naming the address and port', () => {
    const warnings: string[] = []
    refuseUnauthenticatedRemoteListen({ ...base, listenHost: '0.0.0.0', listenPort: 4100, allowRemoteListen: true }, 'sse', (m) => void warnings.push(m))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/WARNING: listening on 0\.0\.0\.0 with no authentication/)
    expect(warnings[0]).toContain('0.0.0.0:4100')
  })

  it('P30 startMcpHost refuses before anything is wired: no pid file, no hooks, no run', async () => {
    const touched: string[] = []
    await expect(
      startMcpHost(
        { ...base, transport: 'sse', listenHost: '0.0.0.0', pidFile: '/x/pids', traceFile: '/x/trace' },
        {
          installHooks: () => {
            touched.push('hooks')
            return () => undefined
          },
          runMcp: async () => void touched.push('run'),
          fs: { appendFile: () => void touched.push('trace'), readFile: () => '', writeFile: () => void touched.push('pid'), mkdirp: () => undefined },
        },
      ),
    ).rejects.toMatchObject({ code: 'HOST_FLAG_INVALID' })
    expect(touched).toEqual([])
  })
})
