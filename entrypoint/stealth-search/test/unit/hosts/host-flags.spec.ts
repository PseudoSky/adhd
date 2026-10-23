/**
 * guards: a host flag default, value or rendering is wrong, or a bad value is accepted
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.6] [search-hosts.10] [search-hosts.16]
 * The host-flag parser (`parseHostFlags`) driven with every flag of the table, its defaults, its
 * `--help` rendering and the bad values it rejects. Ticket 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.6] [search-hosts.10] [search-hosts.16] · inventory rows I-34 (host, port,
 * logger level/format/file), I-37 (human CLI flags: keep-alive, idle-shutdown, restart-browser,
 * monitor, pretty, verbose), I-33 (--trace-file, --pid-file, --max-siblings).
 */
import { describe, expect, it } from 'vitest'
import { HostFlagInvalidError } from '../../../src/host-errors.js'
import {
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  HOST_FLAGS,
  defaultHostSettings,
  parseHostFlags,
  renderCliHelpFlags,
  renderHostFlagRows,
  renderMcpHelp,
  toSearchHostConfig,
} from '../../../src/host-flags.js'
import type { HostSettings } from '../../../src/host-flags.js'

/** A valid argument and the setting it must produce, per flag. */
const VALID: Record<string, { raw?: string; value: unknown }> = {
  'cdp-host': { raw: '10.1.2.3', value: '10.1.2.3' },
  'cdp-port': { raw: '19999', value: 19999 },
  'user-data-dir': { raw: '/tmp/profile', value: '/tmp/profile' },
  transport: { raw: 'sse', value: 'sse' },
  'listen-port': { raw: '4100', value: 4100 },
  'listen-host': { raw: '0.0.0.0', value: '0.0.0.0' },
  'idle-shutdown': { raw: '45000', value: 45000 },
  'keep-alive': { value: true },
  'restart-browser': { value: true },
  'check-history': { value: true },
  monitor: { value: true },
  pretty: { value: true },
  verbose: { value: true },
  'log-level': { raw: 'debug', value: 'debug' },
  'log-format': { raw: 'json', value: 'json' },
  'log-file': { raw: '/tmp/s.log', value: '/tmp/s.log' },
  'log-dir': { raw: '/tmp/logs', value: '/tmp/logs' },
  'data-dir': { raw: '/tmp/data', value: '/tmp/data' },
  'audit-path': { raw: '/tmp/audit.log', value: '/tmp/audit.log' },
  'audit-max-bytes': { raw: '1048576', value: 1048576 },
  'tripwire-ttl-ms': { raw: '60000', value: 60000 },
  'cooldown-captcha-ms': { raw: '1', value: 1 },
  'cooldown-rate-ms': { raw: '2', value: 2 },
  'cooldown-banned-ms': { raw: '3', value: 3 },
  'max-concurrent': { raw: '0', value: 0 },
  'max-siblings': { raw: '9', value: 9 },
  'pid-file': { raw: '/tmp/s.pids', value: '/tmp/s.pids' },
  'trace-file': { raw: '/tmp/s.trace', value: '/tmp/s.trace' },
}

/** An argument each value-taking flag must refuse. */
const INVALID: Record<string, string> = {
  'cdp-host': '  ',
  'cdp-port': 'notanumber',
  'listen-port': '70000',
  'idle-shutdown': '-5',
  'log-level': 'loud',
  'log-format': 'xml',
  'audit-max-bytes': '0',
  'tripwire-ttl-ms': '1.5',
  'cooldown-captcha-ms': 'soon',
  'cooldown-rate-ms': '-1',
  'cooldown-banned-ms': '',
  'max-concurrent': 'two',
  'max-siblings': '-1',
  'user-data-dir': ' ',
  transport: '',
  'listen-host': ' ',
  'log-file': ' ',
  'log-dir': ' ',
  'data-dir': ' ',
  'audit-path': ' ',
  'pid-file': ' ',
  'trace-file': ' ',
}

function parse(...argv: string[]) {
  return parseHostFlags(argv, 'cli')
}

describe('host flags: every flag of the table [search-hosts.16]', () => {
  it('the table lists the flags of SPEC 2.3 and a spec case exists for every one of them', () => {
    expect(HOST_FLAGS.map((f) => f.name).sort()).toEqual(Object.keys(VALID).sort())
  })

  for (const flag of HOST_FLAGS) {
    const sample = VALID[flag.name]
    it(`--${flag.name} sets ${flag.key} and nothing else`, () => {
      expect(sample).toBeDefined()
      const argv = sample?.raw === undefined ? [`--${flag.name}`] : [`--${flag.name}`, sample.raw]
      const out = parse(...argv)
      const expected: HostSettings = { ...defaultHostSettings(), [flag.key]: sample?.value }
      expect(out.settings).toEqual(expected)
      expect([...out.given]).toEqual([flag.key])
      expect(out.operation).toBeUndefined()
      expect(out.rest).toEqual([])
      expect(parse(`--${flag.name}=${sample?.raw ?? ''}`.replace(/=$/, '')).settings[flag.key]).toBe(sample?.value)
    })
  }

  it('flags can follow or precede the operation and its own flags are returned untouched, in order', () => {
    const out = parse('--cdp-port', '19999', 'search', 'duckduckgo', 'vite', '--max-attempts', '2', '--pretty')
    expect(out.operation).toBe('search')
    expect(out.rest).toEqual(['duckduckgo', 'vite', '--max-attempts', '2'])
    expect(out.settings.cdpPort).toBe(19999)
    expect(out.settings.pretty).toBe(true)
  })

  it('--help and -h are recognised anywhere and removed from the operation tokens', () => {
    expect(parse('--help').help).toBe(true)
    const op = parse('search', '-h')
    expect(op.help).toBe(true)
    expect(op.operation).toBe('search')
    expect(op.rest).toEqual([])
    expect(parse('listProviders').help).toBe(false)
  })
})

describe('host flags: defaults [search-hosts.6]', () => {
  it('no flag leaves every default of the table', () => {
    const s = parse().settings
    expect(s.cdpHost).toBe(DEFAULT_CDP_HOST)
    expect(s.cdpPort).toBe(9222)
    expect(DEFAULT_CDP_PORT).toBe(9222)
    expect(s.listenPort).toBe(3100)
    expect(DEFAULT_LISTEN_PORT).toBe(3100)
    expect(s.listenHost).toBe('127.0.0.1')
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1')
    expect(s.transport).toBe('stdio')
    expect(s.idleShutdownMs).toBe(120000)
    expect(DEFAULT_IDLE_SHUTDOWN_MS).toBe(120000)
    expect(s.tripwireTtlMs).toBe(7200000)
    expect([s.cooldownCaptchaMs, s.cooldownRateMs, s.cooldownBannedMs]).toEqual([30000, 20000, 60000])
    expect(s.maxConcurrent).toBe(2)
    expect(s.maxSiblings).toBe(4)
    expect([s.keepAlive, s.restartBrowser, s.checkHistory, s.monitor, s.pretty, s.verbose]).toEqual([false, false, false, false, false, false])
    expect(parse().given.size).toBe(0)
  })

  it('checkHistory is off for the search host unless --check-history is passed (a recent history visit must not keep a search Chrome alive)', () => {
    expect(parse().settings.checkHistory).toBe(false)
    expect(parse('--check-history').settings.checkHistory).toBe(true)
  })

  it('--help prints every flag of the table once, each default on its own line', () => {
    const rows = renderHostFlagRows()
    expect(rows).toHaveLength(HOST_FLAGS.length)
    const line = (flag: string) => rows.find((r) => r.trimStart().startsWith(`--${flag} `) || r.trimStart().startsWith(`--${flag}  `)) ?? ''
    expect(line('cdp-port')).toContain('(default 9222)')
    expect(line('listen-port')).toContain('(default 3100)')
    expect(line('listen-host')).toContain('(default 127.0.0.1)')
    expect(line('transport')).toContain('(default stdio)')
    expect(line('idle-shutdown')).toContain('(default 120000)')
    expect(line('tripwire-ttl-ms')).toContain('(default 7200000)')
    expect(line('cooldown-captcha-ms')).toContain('(default 30000)')
    expect(line('cooldown-rate-ms')).toContain('(default 20000)')
    expect(line('cooldown-banned-ms')).toContain('(default 60000)')
    expect(line('max-concurrent')).toContain('(default 2)')
    expect(line('max-siblings')).toContain('(default 4)')
    expect(line('pid-file')).not.toContain('(default')
    expect(renderCliHelpFlags()[0]).toBe('Host flags:')
    expect(renderMcpHelp()).toContain('Usage: stealth-search-mcp [host flags]')
    for (const f of HOST_FLAGS) expect(renderMcpHelp()).toContain(`--${f.name}`)
  })
})

describe('host flags: HOST_FLAG_INVALID for a bad value [search-hosts.10]', () => {
  for (const [flag, raw] of Object.entries(INVALID)) {
    it(`--${flag} ${JSON.stringify(raw)} is refused with HOST_FLAG_INVALID naming the flag`, () => {
      let caught: unknown
      try {
        parse(`--${flag}`, raw)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(HostFlagInvalidError)
      const err = caught as HostFlagInvalidError
      expect(err.code).toBe('HOST_FLAG_INVALID')
      expect(err.message).toContain(`--${flag}`)
    })
  }

  it('a value-taking flag without its value is refused', () => {
    expect(() => parse('--cdp-port')).toThrow(HostFlagInvalidError)
  })
})

describe('host flags become the typed guard config [search-hosts.16]', () => {
  it('toSearchHostConfig carries dataDir, audit, ttl, cooldowns, concurrency and siblings from the flags', () => {
    const s = parse('--data-dir', '/d', '--audit-path', '/d/a.log', '--audit-max-bytes', '99', '--tripwire-ttl-ms', '1000', '--cooldown-captcha-ms', '1', '--cooldown-rate-ms', '2', '--cooldown-banned-ms', '3', '--max-concurrent', '5', '--max-siblings', '6').settings
    expect(toSearchHostConfig(s)).toEqual({
      dataDir: '/d',
      auditPath: '/d/a.log',
      auditMaxBytes: 99,
      tripwireTtlMs: 1000,
      cooldownCaptchaMs: 1,
      cooldownRateMs: 2,
      cooldownBannedMs: 3,
      maxConcurrent: 5,
      maxSiblings: 6,
    })
  })

  it('an unset --audit-path is not passed, so the config derives it from the data directory', () => {
    expect('auditPath' in toSearchHostConfig(parse().settings)).toBe(false)
  })
})
