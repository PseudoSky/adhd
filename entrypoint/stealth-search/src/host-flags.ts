/**
 * @adhd/stealth-search: src/host-flags.ts
 *
 * The host-flag table (SPEC 2.3) and its parser. Both bins accept the same flags, take every
 * setting from them (ADR-0001: no environment variable is read anywhere) and print the whole table
 * with its defaults in `--help`. `parseHostFlags` turns argv into a typed `HostSettings`, the
 * operands (the operation token) and the tokens it does not own (the operation's own flags, which
 * the CLI host passes on to the apigen invoker).
 *
 * Parsing is `commander` (decision O12 in evidence/naming-decision.md: the apigen cliPlugin parses
 * only the flags of the operation it dispatches and rejects any other `--flag`, so the host-level
 * flags need a parser of their own). Help is rendered from the typed table, one row per flag, so a
 * row never wraps and a default is never lost.
 *
 * Inventory rows: I-33 (trace file, pid file, siblings), I-34 (transport, listen host and port,
 * logger level, format and file), I-37 (idle-shutdown, keep-alive, restart-browser, monitor,
 * pretty, verbose).
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.6] [search-hosts.10] [search-hosts.14]
 */
import { Command, CommanderError } from 'commander'
import { flagInvalid } from './host-errors.js'
import { DEFAULT_SEARCH_HOST_CONFIG } from './lib/config.js'
import type { SearchHostConfig } from './lib/config.js'

/** Which host reads the flags. */
export type HostKind = 'cli' | 'mcp'

/** The log levels of the host logger. */
export const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type HostLogLevel = (typeof LOG_LEVELS)[number]

/** The log formats of the host logger. */
export const LOG_FORMATS = ['pretty', 'json'] as const
export type HostLogFormat = (typeof LOG_FORMATS)[number]

/** The MCP transports the MCP host serves. */
export const MCP_TRANSPORTS = ['stdio', 'sse', 'streaming-http'] as const
export type McpTransport = (typeof MCP_TRANSPORTS)[number]

/** Default CDP endpoint, listen address and idle shutdown. */
export const DEFAULT_CDP_HOST = '127.0.0.1'
export const DEFAULT_CDP_PORT = 9222
export const DEFAULT_LISTEN_PORT = 3100
export const DEFAULT_LISTEN_HOST = '127.0.0.1'
export const DEFAULT_TRANSPORT: McpTransport = 'stdio'
export const DEFAULT_IDLE_SHUTDOWN_MS = 120_000

/** Every setting the host flags control, typed. */
export interface HostSettings {
  cdpHost: string
  cdpPort: number
  userDataDir: string | undefined
  listenPort: number
  listenHost: string
  /** Raw transport name; the MCP host validates it (HOST_TRANSPORT_UNSUPPORTED). */
  transport: string
  idleShutdownMs: number
  keepAlive: boolean
  restartBrowser: boolean
  monitor: boolean
  pretty: boolean
  verbose: boolean
  /** Let a recent Chrome history visit keep Chrome alive. The search host leaves it off. */
  checkHistory: boolean
  logLevel: HostLogLevel | undefined
  logFormat: HostLogFormat | undefined
  logFile: string | undefined
  logDir: string | undefined
  dataDir: string
  auditPath: string | undefined
  auditMaxBytes: number
  tripwireTtlMs: number
  cooldownCaptchaMs: number
  cooldownRateMs: number
  cooldownBannedMs: number
  maxConcurrent: number
  maxSiblings: number
  pidFile: string | undefined
  traceFile: string | undefined
}

type SettingKey = keyof HostSettings

interface FlagSpec {
  /** Long flag name without the dashes. */
  name: string
  /** `<n>`, `<path>` and so on; absent for a boolean flag. */
  arg?: string
  key: SettingKey
  help: string
  /** The default shown in `--help` (absent when the flag has none). */
  shown?: string
  parse?: (flag: string, raw: string) => unknown
}

function integer(flag: string, raw: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(raw.trim())) throw flagInvalid(flag, `expected an integer, got "${raw}"`, { value: raw })
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw flagInvalid(flag, `expected an integer from ${min} to ${max === Number.MAX_SAFE_INTEGER ? 'any size' : max}, got "${raw}"`, { value: raw })
  }
  return n
}

const port = (flag: string, raw: string): number => integer(flag, raw, 1, 65535)
const milliseconds = (flag: string, raw: string): number => integer(flag, raw, 0, Number.MAX_SAFE_INTEGER)
const positive = (flag: string, raw: string): number => integer(flag, raw, 1, Number.MAX_SAFE_INTEGER)
const count = (flag: string, raw: string): number => integer(flag, raw, 0, Number.MAX_SAFE_INTEGER)
const anyInteger = (flag: string, raw: string): number => integer(flag, raw, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)

function oneOf<T extends string>(values: readonly T[]): (flag: string, raw: string) => T {
  return (flag, raw) => {
    const hit = values.find((v) => v === raw)
    if (hit === undefined) throw flagInvalid(flag, `expected one of ${values.join(', ')}, got "${raw}"`, { value: raw })
    return hit
  }
}

function nonEmpty(flag: string, raw: string): string {
  if (raw.trim() === '') throw flagInvalid(flag, 'expected a non-empty value', { value: raw })
  return raw
}

const D = DEFAULT_SEARCH_HOST_CONFIG

/** The host-flag table. Order is the order of `--help`. */
export const HOST_FLAGS: readonly FlagSpec[] = [
  { name: 'cdp-host', arg: '<host>', key: 'cdpHost', help: 'Chrome remote-debugging host', shown: DEFAULT_CDP_HOST, parse: nonEmpty },
  { name: 'cdp-port', arg: '<n>', key: 'cdpPort', help: 'Chrome remote-debugging port', shown: String(DEFAULT_CDP_PORT), parse: port },
  { name: 'user-data-dir', arg: '<path>', key: 'userDataDir', help: 'Chrome profile directory launchChrome uses when none is given', parse: nonEmpty },
  { name: 'transport', arg: '<name>', key: 'transport', help: 'MCP transport: stdio, sse or streaming-http (MCP host)', shown: DEFAULT_TRANSPORT, parse: nonEmpty },
  { name: 'listen-port', arg: '<n>', key: 'listenPort', help: 'Port the sse and streaming-http transports bind (MCP host)', shown: String(DEFAULT_LISTEN_PORT), parse: port },
  { name: 'listen-host', arg: '<addr>', key: 'listenHost', help: 'Address the sse and streaming-http transports bind (MCP host)', shown: DEFAULT_LISTEN_HOST, parse: nonEmpty },
  { name: 'idle-shutdown', arg: '<ms>', key: 'idleShutdownMs', help: 'Close the Chrome this host launched after this many idle milliseconds', shown: String(DEFAULT_IDLE_SHUTDOWN_MS), parse: milliseconds },
  { name: 'keep-alive', key: 'keepAlive', help: 'Never close Chrome on idle' },
  { name: 'restart-browser', key: 'restartBrowser', help: 'Soft-shut Chrome down before the first operation (shutdownChrome)' },
  { name: 'check-history', key: 'checkHistory', help: 'Let a recent Chrome history visit keep Chrome alive' },
  { name: 'monitor', key: 'monitor', help: 'Print the resource usage of the operation on stderr (CLI)' },
  { name: 'pretty', key: 'pretty', help: 'Pretty-print the JSON result (CLI)' },
  { name: 'verbose', key: 'verbose', help: 'Write internal logs to stderr (never stdout)' },
  { name: 'log-level', arg: '<level>', key: 'logLevel', help: `Log level: ${LOG_LEVELS.join(', ')} (default silent for the CLI, info for the MCP host)`, parse: oneOf(LOG_LEVELS) },
  { name: 'log-format', arg: '<format>', key: 'logFormat', help: `Log format: ${LOG_FORMATS.join(' or ')} (default pretty on a terminal, json otherwise)`, parse: oneOf(LOG_FORMATS) },
  { name: 'log-file', arg: '<path>', key: 'logFile', help: 'Write logs to this file instead of stderr', parse: nonEmpty },
  { name: 'log-dir', arg: '<path>', key: 'logDir', help: 'Directory of the telemetry record files', parse: nonEmpty },
  { name: 'data-dir', arg: '<path>', key: 'dataDir', help: 'Root of the tripwire, cooldown and audit state', shown: D.dataDir, parse: nonEmpty },
  { name: 'audit-path', arg: '<path>', key: 'auditPath', help: 'NDJSON audit log (default: audit.log under the data directory)', parse: nonEmpty },
  { name: 'audit-max-bytes', arg: '<bytes>', key: 'auditMaxBytes', help: 'Audit log size cap in bytes', shown: String(D.auditMaxBytes), parse: positive },
  { name: 'tripwire-ttl-ms', arg: '<ms>', key: 'tripwireTtlMs', help: 'A tripwire older than this no longer blocks', shown: String(D.tripwireTtlMs), parse: positive },
  { name: 'cooldown-captcha-ms', arg: '<ms>', key: 'cooldownCaptchaMs', help: 'Cooldown after a captcha outcome', shown: String(D.cooldownCaptchaMs), parse: milliseconds },
  { name: 'cooldown-rate-ms', arg: '<ms>', key: 'cooldownRateMs', help: 'Cooldown after a rate-limited outcome', shown: String(D.cooldownRateMs), parse: milliseconds },
  { name: 'cooldown-banned-ms', arg: '<ms>', key: 'cooldownBannedMs', help: 'Cooldown after a banned outcome', shown: String(D.cooldownBannedMs), parse: milliseconds },
  { name: 'max-concurrent', arg: '<n>', key: 'maxConcurrent', help: 'Searches in flight per process; 0 or less disables the cap', shown: String(D.maxConcurrent), parse: anyInteger },
  { name: 'max-siblings', arg: '<n>', key: 'maxSiblings', help: 'Sibling processes tolerated before a warning (and before launching is refused)', shown: String(D.maxSiblings), parse: count },
  { name: 'pid-file', arg: '<path>', key: 'pidFile', help: 'Registry of live host pids, used to warn about accumulated siblings', parse: nonEmpty },
  { name: 'trace-file', arg: '<path>', key: 'traceFile', help: 'Append one JSON line per boot stage to this file', parse: nonEmpty },
]

/** The settings of a run that passed no flag. */
export function defaultHostSettings(): HostSettings {
  return {
    cdpHost: DEFAULT_CDP_HOST,
    cdpPort: DEFAULT_CDP_PORT,
    userDataDir: undefined,
    listenPort: DEFAULT_LISTEN_PORT,
    listenHost: DEFAULT_LISTEN_HOST,
    transport: DEFAULT_TRANSPORT,
    idleShutdownMs: DEFAULT_IDLE_SHUTDOWN_MS,
    keepAlive: false,
    restartBrowser: false,
    monitor: false,
    pretty: false,
    verbose: false,
    checkHistory: false,
    logLevel: undefined,
    logFormat: undefined,
    logFile: undefined,
    logDir: undefined,
    dataDir: D.dataDir,
    auditPath: undefined,
    auditMaxBytes: D.auditMaxBytes,
    tripwireTtlMs: D.tripwireTtlMs,
    cooldownCaptchaMs: D.cooldownCaptchaMs,
    cooldownRateMs: D.cooldownRateMs,
    cooldownBannedMs: D.cooldownBannedMs,
    maxConcurrent: D.maxConcurrent,
    maxSiblings: D.maxSiblings,
    pidFile: undefined,
    traceFile: undefined,
  }
}

/** What `parseHostFlags` returns. */
export interface ParsedHostArgs {
  settings: HostSettings
  /** The settings the caller passed explicitly. */
  given: ReadonlySet<SettingKey>
  /** The first operand: the operation token (absent for the MCP host and for a bare `--help`). */
  operation: string | undefined
  /** Every token the host table does not own, in order: the operation's own flags. */
  rest: string[]
  /** `--help` or `-h` was passed. */
  help: boolean
}

/** commander's camelCase key of a long flag. */
function optionKey(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

/**
 * Parse the host flags out of `argv` (the tokens after the executable). A bad value or a flag
 * without its value raises HOST_FLAG_INVALID before anything else runs. The host flags may stand
 * before or after the operation token; the operation's own flags are returned untouched.
 */
export function parseHostFlags(argv: readonly string[], _host: HostKind): ParsedHostArgs {
  const program = new Command()
  program
    .exitOverride()
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .argument('[tokens...]')
  const parsers = new Map<string, FlagSpec>()
  for (const spec of HOST_FLAGS) {
    const flags = `--${spec.name}${spec.arg ? ` ${spec.arg}` : ''}`
    if (spec.arg && spec.parse) {
      const parse = spec.parse
      program.option(flags, spec.help, (raw: string) => parse(`--${spec.name}`, raw))
    } else {
      program.option(flags, spec.help)
    }
    parsers.set(optionKey(spec.name), spec)
  }
  try {
    program.parse([...argv], { from: 'user' })
  } catch (e) {
    if (e instanceof CommanderError) {
      const flag = /'(--[a-z-]+)/.exec(e.message)?.[1] ?? 'host flags'
      throw flagInvalid(flag, e.message.replace(/^error:\s*/, ''))
    }
    throw e
  }
  const opts = program.opts<Record<string, unknown>>()
  const settings = defaultHostSettings()
  const given = new Set<SettingKey>()
  for (const [k, spec] of parsers) {
    const v = opts[k]
    if (v === undefined) continue
    ;(settings as unknown as Record<string, unknown>)[spec.key] = v
    given.add(spec.key)
  }
  const tokens = [...program.args]
  const help = tokens.includes('--help') || tokens.includes('-h')
  const rest = tokens.filter((t) => t !== '--help' && t !== '-h')
  const first = rest[0]
  const operation = first !== undefined && !first.startsWith('-') ? first : undefined
  return { settings, given, operation, rest: operation === undefined ? rest : rest.slice(1), help }
}

/** The host-flag rows of `--help`: one line per flag, with its default where it has one. */
export function renderHostFlagRows(): string[] {
  const left = HOST_FLAGS.map((f) => `--${f.name}${f.arg ? ` ${f.arg}` : ''}`)
  const width = Math.max(...left.map((l) => l.length)) + 2
  return HOST_FLAGS.map((f, i) => `  ${(left[i] ?? '').padEnd(width)}${f.help}${f.shown === undefined ? '' : ` (default ${f.shown})`}`)
}

/** The full `--help` of the MCP host. */
export function renderMcpHelp(): string {
  return [
    'stealth-search-mcp: the stealth Chrome search and fetch tools as an MCP server',
    '',
    'Usage: stealth-search-mcp [host flags]',
    '',
    'Host flags:',
    ...renderHostFlagRows(),
    '',
    'Transports: stdio (default; the client spawns this process), sse and streaming-http (a daemon bound to the listen address).',
    'Logs go to stderr; stdout carries only the JSON-RPC stream.',
  ].join('\n')
}

/** The host-flag part of the CLI `--help` (the CLI host adds its operation list). */
export function renderCliHelpFlags(): string[] {
  return ['Host flags:', ...renderHostFlagRows()]
}

/**
 * The guard and tripwire settings the flags control, as `SearchHostConfig` overrides. Every field
 * is passed (the defaults of the table are the defaults of the config), so a flag can never be
 * lost between the parser and the guard.
 */
export function toSearchHostConfig(s: HostSettings): Partial<SearchHostConfig> {
  return {
    dataDir: s.dataDir,
    ...(s.auditPath === undefined ? {} : { auditPath: s.auditPath }),
    auditMaxBytes: s.auditMaxBytes,
    tripwireTtlMs: s.tripwireTtlMs,
    cooldownCaptchaMs: s.cooldownCaptchaMs,
    cooldownRateMs: s.cooldownRateMs,
    cooldownBannedMs: s.cooldownBannedMs,
    maxConcurrent: s.maxConcurrent,
    maxSiblings: s.maxSiblings,
  }
}
