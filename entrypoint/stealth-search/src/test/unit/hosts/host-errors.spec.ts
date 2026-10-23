/**
 * The typed host errors and their one rendering. Ticket 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.9] [search-hosts.10] [search-hosts.16] · inventory row I-36 (one-shot CLI
 * failure shape: one stderr line, a stable exit status, no stack).
 */
import { describe, expect, it } from 'vitest'
import { StealthSearchError, exitCodeFor, searchError } from '../../../errors.js'
import {
  HostBootFailedError,
  HostFlagInvalidError,
  HostTransportUnsupportedError,
  asHostError,
  bootFailed,
  flagInvalid,
  hostExitCode,
  nodeTooOldError,
  renderHostError,
  transportUnsupported,
} from '../../../host-errors.js'
import { assertSupportedNode, nodeVersionSupported } from '../../../cli.js'

describe('host errors are StealthSearchError subclasses with stable codes [search-hosts.10]', () => {
  it('HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED and HOST_BOOT_FAILED carry their code, class and a stable exit status', () => {
    const cases: Array<[StealthSearchError, string, number]> = [
      [flagInvalid('--cdp-port', 'expected an integer'), 'HOST_FLAG_INVALID', 77],
      [transportUnsupported('carrier-pigeon', ['stdio', 'sse']), 'HOST_TRANSPORT_UNSUPPORTED', 78],
      [bootFailed('could not start'), 'HOST_BOOT_FAILED', 79],
    ]
    for (const [err, code, status] of cases) {
      expect(err).toBeInstanceOf(StealthSearchError)
      expect(err.code).toBe(code)
      expect(hostExitCode(err)).toBe(status)
      expect(exitCodeFor(code)).toBe(status)
    }
    expect(flagInvalid('--x', 'bad')).toBeInstanceOf(HostFlagInvalidError)
    expect(transportUnsupported('x', ['stdio'])).toBeInstanceOf(HostTransportUnsupportedError)
    expect(bootFailed('x')).toBeInstanceOf(HostBootFailedError)
  })

  it('details and the cause travel with the error', () => {
    const cause = new Error('EADDRINUSE')
    const e = bootFailed('listen failed', cause, { transport: 'sse' })
    expect(e.cause).toBe(cause)
    expect(e.detail).toMatchObject({ transport: 'sse' })
    expect(flagInvalid('--cdp-port', 'bad', { value: 'x' }).detail).toMatchObject({ flag: '--cdp-port', value: 'x' })
    expect(transportUnsupported('x', ['stdio', 'sse']).detail).toMatchObject({ transport: 'x', supported: ['stdio', 'sse'] })
  })

  it('renderHostError is ONE line `<CODE>: <message>` with no stack, newlines folded', () => {
    const line = renderHostError(bootFailed('first line\n  second line'))
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toMatch(/^HOST_BOOT_FAILED: first line second line/)
    expect(line).not.toContain('    at ')
  })

  it('asHostError keeps a typed error, lifts a coded object and turns anything else into HOST_BOOT_FAILED with the cause', () => {
    const typed = flagInvalid('--x', 'bad')
    expect(asHostError(typed)).toBe(typed)
    const coded = asHostError({ code: 'UNKNOWN_PROVIDER', message: 'no such provider', detail: { id: 'x' } })
    expect(coded.code).toBe('UNKNOWN_PROVIDER')
    expect(coded.detail).toMatchObject({ id: 'x' })
    const plain = new Error('boom')
    const wrapped = asHostError(plain)
    expect(wrapped.code).toBe('HOST_BOOT_FAILED')
    expect(wrapped.cause).toBe(plain)
    expect(asHostError('a string').code).toBe('HOST_BOOT_FAILED')
    expect(hostExitCode(searchError('HITL_ABORTED', 'x'))).toBe(2)
  })
})

describe('the NODE_TOO_OLD preflight function [search-hosts.9] [search-hosts.16]', () => {
  it('22.5 and newer pass; older and unparsable versions do not', () => {
    for (const v of ['22.5.0', '22.5.1', '22.12.0', '23.0.0', '24.11.1', '100.0.0']) expect(nodeVersionSupported(v), v).toBe(true)
    for (const v of ['22.4.9', '22.0.0', '20.19.0', '18.0.0', '21.99.0', '', 'v22', 'abc']) expect(nodeVersionSupported(v), v).toBe(false)
  })

  it('assertSupportedNode throws the core-owned NODE_TOO_OLD with the version, exit status 12, and returns for a supported runtime', () => {
    expect(() => assertSupportedNode('22.12.0')).not.toThrow()
    let caught: unknown
    try {
      assertSupportedNode('20.1.0')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StealthSearchError)
    expect((caught as StealthSearchError).code).toBe('NODE_TOO_OLD')
    expect(renderHostError(caught)).toMatch(/^NODE_TOO_OLD: Node\.js 20\.1\.0 is too old/)
    expect(hostExitCode(caught)).toBe(12)
    expect(nodeTooOldError('18.0.0').code).toBe('NODE_TOO_OLD')
  })
})
