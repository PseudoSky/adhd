/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.2] [tests-use-cases.4]
 * Exercises the endpoint namespace (audit-fixes P9, pre-review) and PA7.4 (explicit non-9222 port).
 *
 * A host process takes a Chrome address from a caller it does not trust. Before any connection it checks that
 * the address is a bare loopback host, that another host is refused until the process allows it, and that a
 * debugger WebSocket URL pointing at a third host is rejected. No socket is opened at any point.
 * guards: [tests-use-cases.2] an address is vetted: loopback accepted, a smuggled or foreign host refused until allowed
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.2] [tests-use-cases.4]
 */
import { afterEach, describe, expect, it } from 'vitest'
import { endpoint, StealthCoreBrowserError } from '../../../src/index.js'
import { run as runEndpoint } from '../../../examples/namespaces/endpoint.js'

afterEach(() => endpoint.configureEndpointPolicy())

describe('Scenario: vet a Chrome endpoint before connecting to it', () => {
  it('[tests-use-cases.2] accepts loopback hosts and builds the host:port string for IPv4, names and IPv6', () => {
    expect(endpoint.resolveEndpoint({ port: 9434 })).toEqual({ host: '127.0.0.1', port: 9434, cdpHost: '127.0.0.1:9434' })
    expect(endpoint.resolveEndpoint({ host: 'localhost', port: 9434 }).cdpHost).toBe('localhost:9434')
    expect(endpoint.resolveEndpoint({ host: '::1', port: 9434 }).cdpHost).toBe('[::1]:9434')
    expect(endpoint.portOf('[::1]:9434')).toBe(9434)
  })

  it('[tests-use-cases.2] refuses a host that smuggles credentials, a path or a second port, and a bad port', () => {
    for (const host of ['user@evil.test', '127.0.0.1:80', 'a/b', 'a b', '%31']) {
      expect(() => endpoint.resolveEndpoint({ host, port: 9434 })).toThrowError(expect.objectContaining({ code: 'CDP_UNREACHABLE' }))
    }
    expect(() => endpoint.resolveEndpoint({ port: 70000 })).toThrowError(StealthCoreBrowserError)
  })

  it('[tests-use-cases.2] a foreign host is refused until the hosting process allows it', () => {
    expect(endpoint.isLoopbackHost('chrome.example.test')).toBe(false)
    expect(() => endpoint.resolveEndpoint({ host: 'chrome.example.test', port: 9434 })).toThrowError(expect.objectContaining({ code: 'CDP_UNREACHABLE' }))
    endpoint.configureEndpointPolicy({ allowHosts: ['Chrome.Example.Test'] })
    expect(endpoint.allowedHosts()).toEqual(['chrome.example.test'])
    expect(endpoint.resolveEndpoint({ host: 'chrome.example.test', port: 9434 }).cdpHost).toBe('chrome.example.test:9434')
  })

  it('[tests-use-cases.2] a debugger WebSocket URL on another host is refused with CDP_BAD_RESPONSE', () => {
    endpoint.assertSameEndpoint('127.0.0.1:9434', 'ws://127.0.0.1:9434/devtools/browser/B1')
    expect(() => endpoint.assertSameEndpoint('127.0.0.1:9434', 'ws://evil.test:9434/devtools/browser/B1')).toThrowError(expect.objectContaining({ code: 'CDP_BAD_RESPONSE' }))
    expect(() => endpoint.assertSameEndpoint('127.0.0.1:9434', 'not a url')).toThrowError(expect.objectContaining({ code: 'CDP_BAD_RESPONSE' }))
  })

  it('[tests-use-cases.4] namespaces/endpoint walks the same vetting end to end', () => {
    expect(runEndpoint({ port: 9434 })).toEqual({
      loopback: { host: '127.0.0.1', port: 9434, cdpHost: '127.0.0.1:9434' },
      remoteIsLoopback: false,
      remoteRefusedBefore: 'CDP_UNREACHABLE',
      remoteAllowedAfter: true,
      redirectRefused: true,
      parsedPort: 9434,
    })
    expect(endpoint.allowedHosts()).toEqual([])
  })
})
