/**
 * guards: a chrome verb or a search call accepts a host that smuggles credentials, a path or a second port, addresses a non-loopback machine without the hosting process allowing it, or dials a debugger WebSocket on another host
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1]
 * Pre-review P9: the `host` input of every chrome verb is validated once (src/lib/endpoint.ts). Only loopback is
 * addressable by default; the hosting process opts other hosts in with `configureEndpointPolicy`, never a verb
 * input. A debugger WebSocket URL that points at another host is refused. fetch is stubbed to throw: no socket.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ fetch: vi.fn(() => Promise.reject(new Error('network is forbidden in the unit lane'))) }))
vi.stubGlobal('fetch', net.fetch)

import { chromeStatus, listPageTargets } from '../../../src/api.js'
import { StealthCoreBrowserError } from '../../../src/errors.js'
import { allowedHosts, assertSameEndpoint, configureEndpointPolicy, isLoopbackHost, portOf, resolveEndpoint } from '../../../src/lib/endpoint.js'

afterEach(() => {
  configureEndpointPolicy({})
  net.fetch.mockClear()
})

describe('the host input is validated once [audit-fixes.1]', () => {
  it.each(['127.0.0.1', 'localhost', 'LOCALHOST', '127.8.9.10', '::1', '[::1]'])('P9 loopback %s is addressable by default', (host) => {
    const r = resolveEndpoint({ host, port: 9333 })
    expect(r.port).toBe(9333)
    expect(r.cdpHost.endsWith(':9333')).toBe(true)
    expect(isLoopbackHost(host)).toBe(true)
  })

  it('P9 default endpoint: no input is 127.0.0.1:9222 and an IPv6 host is bracketed in cdpHost', () => {
    expect(resolveEndpoint()).toEqual({ host: '127.0.0.1', port: 9222, cdpHost: '127.0.0.1:9222' })
    expect(resolveEndpoint({ host: '::1' }).cdpHost).toBe('[::1]:9222')
    expect(resolveEndpoint({ host: '  ' }).host).toBe('127.0.0.1')
  })

  it.each(['evil@127.0.0.1', 'user:pw@localhost', 'localhost?x=1', 'localhost#frag', 'localhost:80', 'localhost/', 'a\\b', 'a b', 'localhost%2f', 'http://localhost', '', 'exa mple.com', '-bad.example', 'a..b', '[::1', '1.2.3.4.5.6'])('P9 malformed host %j is refused as an invalid endpoint', (host) => {
    if (host === '') return // blank means "use the default", asserted above
    const attempt = (): unknown => resolveEndpoint({ host })
    expect(attempt).toThrow(StealthCoreBrowserError)
    expect(attempt).toThrow(/host must be a bare host name|not a loopback/)
    try {
      attempt()
    } catch (e) {
      expect(e).toMatchObject({ code: 'CDP_UNREACHABLE', detail: { reason: 'invalid-endpoint' } })
    }
  })

  it.each(['chrome.example.net', '10.0.0.5', '169.254.169.254', '2001:db8::1', 'metadata.google.internal'])('P9 non-loopback %s is refused until the hosting process allows it', (host) => {
    expect(() => resolveEndpoint({ host })).toThrow(/not a loopback address/)
    configureEndpointPolicy({ allowHosts: [host] })
    expect(resolveEndpoint({ host }).host.replace(/^\[|\]$/g, '')).toBe(host)
    configureEndpointPolicy({})
    expect(() => resolveEndpoint({ host })).toThrow(/not a loopback address/)
  })

  it('P9 allow list: names compare case-insensitively, a malformed entry is refused, and the list is replaced by each configure call', () => {
    configureEndpointPolicy({ allowHosts: ['Chrome.Example.NET'] })
    expect(allowedHosts()).toEqual(['chrome.example.net'])
    expect(resolveEndpoint({ host: 'chrome.example.net' }).cdpHost).toBe('chrome.example.net:9222')
    expect(() => configureEndpointPolicy({ allowHosts: ['bad host'] })).toThrow(StealthCoreBrowserError)
    configureEndpointPolicy({ allowHosts: ['other.example.net'] })
    expect(() => resolveEndpoint({ host: 'chrome.example.net' })).toThrow(/not a loopback/)
  })

  it('P9 verbs: a verb with a refused host rejects before any request leaves', async () => {
    await expect(chromeStatus({ host: 'chrome.example.net' })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE', detail: { reason: 'invalid-endpoint' } })
    await expect(listPageTargets({ host: 'a@b' })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('P9 verbs: an allowed host is addressed (the request leaves for exactly that host)', async () => {
    configureEndpointPolicy({ allowHosts: ['chrome.example.net'] })
    await expect(chromeStatus({ host: 'chrome.example.net', port: 9555 })).resolves.toEqual({ running: false, managed: false })
    expect(net.fetch).toHaveBeenCalledWith('http://chrome.example.net:9555/json/version', expect.anything())
  })
})

describe('the debugger WebSocket must point back at the asked host [audit-fixes.1]', () => {
  it('P9 matching host passes, including bracketed IPv6 and any port', () => {
    expect(() => assertSameEndpoint('127.0.0.1:9222', 'ws://127.0.0.1:9222/devtools/browser/abc')).not.toThrow()
    expect(() => assertSameEndpoint('[::1]:9222', 'ws://[::1]:9222/devtools/browser/abc')).not.toThrow()
    expect(() => assertSameEndpoint('LOCALHOST:9222', 'ws://localhost:9333/devtools/page/1')).not.toThrow()
  })

  it('P9 another host is CDP_BAD_RESPONSE with reason ws-host-mismatch, and an unparseable URL is ws-url-invalid', () => {
    expect(() => assertSameEndpoint('127.0.0.1:9222', 'ws://evil.example.net:9222/devtools/browser/abc')).toThrow(expect.objectContaining({ code: 'CDP_BAD_RESPONSE', detail: expect.objectContaining({ reason: 'ws-host-mismatch' }) as unknown }))
    expect(() => assertSameEndpoint('127.0.0.1:9222', 'not a url')).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: 'ws-url-invalid' }) as unknown }))
  })
})

describe('portOf reads the port of host:port [audit-fixes.1]', () => {
  it('P34 port parse: IPv4, name and bracketed IPv6 hosts all yield their own port and anything else falls back', () => {
    expect(portOf('127.0.0.1:9333')).toBe(9333)
    expect(portOf('[::1]:9444')).toBe(9444)
    expect(portOf('localhost')).toBe(9222)
    expect(portOf('localhost:0')).toBe(9222)
    expect(portOf('localhost:99999', 1234)).toBe(1234)
  })
})
