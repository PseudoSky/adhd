/**
 * guards: an address in a reserved, multicast, benchmarking, documentation, NAT64, 6to4, Teredo or IPv4-mapped range passes the SSRF policy, or a public address is refused
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [fix-search-fetch.1]
 * The complete forbidden-address table (pre-review P28) through the real policy functions: every special-purpose
 * IPv4 range, every IPv6 form that can embed or alias a private IPv4 address, the literal-host check and the
 * resolver check. Pure functions, no network.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { describe, expect, it } from 'vitest'
import { forbiddenTargetReason, isForbiddenAddress, resolveAndCheck, validateFetchUrl } from '../../../src/lib/fetch/policy.js'

const FORBIDDEN_V4 = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']
const PUBLIC_V4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.167.255.255', '198.17.255.255', '198.20.0.1', '223.255.255.255']
const FORBIDDEN_V6 = [
  '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::10.0.0.1', '::a00:1',
  '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1',
  '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::5',
  '2001::1', '2001:db8::1', '100::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff0e::1',
  'fe80::1%eth0',
]
const PUBLIC_V6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', 'fc::1']

describe('the forbidden-address table is complete (P28) [audit-fixes.1]', () => {
  it.each(FORBIDDEN_V4)('P28 forbidden IPv4 %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
    expect(forbiddenTargetReason(new URL(`https://${ip}/`))).toMatch(/blocked IP literal/)
  })

  it.each(PUBLIC_V4)('P28 public IPv4 %s is allowed', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false)
    expect(forbiddenTargetReason(new URL(`https://${ip}/`))).toBeNull()
  })

  it.each(FORBIDDEN_V6)('P28 forbidden IPv6 %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  it.each(PUBLIC_V6)('P28 public IPv6 %s is allowed', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false)
  })

  it('P28 bracketed and unparseable input: brackets are stripped, anything that is not an IP literal is refused', () => {
    expect(isForbiddenAddress('[::1]')).toBe(true)
    expect(isForbiddenAddress('[2606:4700:4700::1111]')).toBe(false)
    expect(isForbiddenAddress('not-an-ip')).toBe(true)
    expect(isForbiddenAddress('')).toBe(true)
  })

  it('P28 URL forms: the hex, decimal and octal spellings URL normalises are judged on the normalised address', () => {
    for (const host of ['0x7f.1', '2130706433', '0177.0.0.1', '[::ffff:7f00:1]', '[2002:7f00:1::]', '[64:ff9b::7f00:1]']) {
      expect(validateFetchUrl(`https://${host}/`).ok, host).toBe(false)
    }
  })

  it('P28 resolver answers: a name that resolves to any newly covered range is refused with the offending address', async () => {
    for (const address of ['198.18.0.5', '224.0.0.9', '240.1.1.1', '255.255.255.255', '64:ff9b::7f00:1', '2002:a00:1::1']) {
      await expect(resolveAndCheck('docs.example.test', async () => ['93.184.216.34', address])).rejects.toMatchObject({ code: 'FETCH_URL_REFUSED', detail: { address } })
    }
  })
})
