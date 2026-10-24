/**
 * @adhd/stealth-search: src/cli.ts
 *
 * The human CLI host `stealth-search <operation> [verb flags] [host flags]`. It runs the apigen
 * `cliPlugin` over the very package the MCP host serves (`buildStealthSearchPackage`) with the one
 * `adhd` tracing plugin mounted, so a verb behaves identically on both hosts. The CLI adds what a
 * terminal needs:
 *
 *  - verb flags: `--provider duckduckgo --query "x"` (kebab-case of the input property, camelCase
 *    also accepted) or a whole `--input '<json>'`; the host flags (`--cdp-port`, ...) fill the
 *    `host`/`port` of every operation that takes them;
 *  - one JSON document on stdout per run and nothing else on stdout (inventory I-36): a verb that
 *    ends with an empty or undefined result is a typed HOST_BOOT_FAILED failure, never a silent
 *    exit 0 (backlog 86ed154e);
 *  - a typed failure is ONE stderr line `<CODE>: <message>` and `exitCodeFor(code)`, never a stack;
 *  - exit discipline (backlog abeedba8): the JSON is written and flushed, the browser handles are
 *    closed, then the process exits; nothing keeps the loop alive;
 *  - interactive prompts only on a TTY (backlog 657bd597): the tripwire gate and the solved
 *    confirmation use `InteractionPort`; with a closed or non-interactive stdin they reject at once
 *    with HITL_ABORTED, which the CLI reports as one `hitl` JSON line with attempts 0 and exit 2
 *    (backlog 591e1a7), and the provider stays tripped;
 *  - `tripwireStatus` is the verb's own answer: the CLI holds no expiry predicate (backlog 9d05e8b2).
 *
 * Inventory rows: I-33, I-35, I-36, I-37, I-38, I-39.
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.4] [search-hosts.5] [search-hosts.10]
 * [search-hosts.13] [search-hosts.18] [search-hosts.19] [search-hosts.20] [search-hosts.21] [search-hosts.22]
 */
import { join } from 'node:path'
import { cliPlugin } from '@adhd/apigen-plugin-cli-output'
import type { Plugin, RunInput } from '@adhd/apigen-core-client'
import { createLogger } from '@adhd/apigen-engine-runtime'
import { lifecycle, shutdownChrome } from '@adhd/stealth-core-browser'
import { HostBootFailedError, asHostError, bootFailed, flagInvalid, nodeTooOldError, renderHostError } from './host-errors.js'
import { defaultHostSettings, renderCliHelpFlags, parseHostFlags, toSearchHostConfig } from './host-flags.js'
import type { HostSettings, ParsedHostArgs } from './host-flags.js'
import { StealthSearchError, exitCodeFor, searchError } from './errors.js'
import type { GateDecision, GatePromptInfo, InteractionPort, SolvedAnswer, SolvedPromptInfo } from './lib/config.js'
import { configureSearch } from './lib/search.js'
import type { ConfigureSearchOptions } from './lib/search.js'
import { FORCE_EXIT_MS, OPERATION_NAMES, buildStealthSearchPackage, resolveCoreEntry, stderrLine, stderrLogger } from './server.js'
import type { BuildPackageOptions, OperationName, StealthSearchPackage, SurfaceEntry } from './server.js'
import { traceRejection, tracingPlugin } from './tracing.js'

// ─── Node preflight ───────────────────────────────────────────────────────────

/** The oldest supported Node.js. */
export const MIN_NODE = { major: 22, minor: 5 } as const

/** True when `version` (a `process.versions.node` string) is at least 22.5; false for an unparsable one. */
export function nodeVersionSupported(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
}

/** Throw the typed NODE_TOO_OLD for a runtime below Node.js 22.5 (the bins run the same comparison first, before they load this module). */
export function assertSupportedNode(version: string): void {
  if (!nodeVersionSupported(version)) throw nodeTooOldError(version)
}

// ─── Interactive prompts ──────────────────────────────────────────────────────

/** The part of a readable the prompter uses. */
export interface PromptInput {
  isTTY?: boolean
  readableEnded?: boolean
  destroyed?: boolean
  on(event: 'data' | 'end' | 'close' | 'error', listener: (...args: never[]) => void): unknown
  removeListener(event: 'data' | 'end' | 'close' | 'error', listener: (...args: never[]) => void): unknown
  setEncoding?(encoding: BufferEncoding): unknown
  resume?(): unknown
  pause?(): unknown
}

/** A prompt must settle (answer or reject) well within this many milliseconds once stdin cannot answer. */
export const PROMPT_ABORT_BUDGET_MS = 1000

export interface PrompterDeps {
  stdin: PromptInput
  /** Where the question is written: stderr, never stdout. */
  ask: (text: string) => void
}

function promptAborted(why: string, detail: Record<string, unknown>): StealthSearchError {
  return searchError('HITL_ABORTED', `no answer was possible: ${why}`, { detail })
}

/** Read one line from `stdin`; rejects with HITL_ABORTED when stdin is not interactive or ends first. */
function readAnswer(deps: PrompterDeps, detail: Record<string, unknown>): Promise<string> {
  const { stdin } = deps
  if (stdin.isTTY !== true) return Promise.reject(promptAborted('stdin is not a TTY', detail))
  if (stdin.readableEnded === true || stdin.destroyed === true) return Promise.reject(promptAborted('stdin is closed', detail))
  return new Promise<string>((resolve, reject) => {
    let buffer = ''
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.removeListener('close', onEnd)
      stdin.removeListener('error', onEnd)
      stdin.pause?.()
    }
    const onData = (chunk: string | Buffer): void => {
      buffer += String(chunk)
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      cleanup()
      resolve(buffer.slice(0, nl).trim())
    }
    const onEnd = (): void => {
      cleanup()
      reject(promptAborted('stdin closed before an answer', detail))
    }
    stdin.setEncoding?.('utf8')
    stdin.on('data', onData as (...args: never[]) => void)
    stdin.on('end', onEnd)
    stdin.on('close', onEnd)
    stdin.on('error', onEnd)
    stdin.resume?.()
  })
}

/**
 * The CLI's `InteractionPort`. A non-TTY or closed stdin rejects immediately (no timer, no wait)
 * with HITL_ABORTED carrying the provider and reason; a TTY is asked on stderr and answered with a
 * line.
 */
export function createTtyPrompter(deps: PrompterDeps): InteractionPort {
  return {
    async promptTripwireGate(info: GatePromptInfo): Promise<GateDecision> {
      const detail = { provider: info.provider, reason: info.reason, pageUrl: info.pageUrl }
      if (deps.stdin.isTTY !== true || deps.stdin.readableEnded === true || deps.stdin.destroyed === true) await readAnswer(deps, detail)
      deps.ask(
        `${info.provider} is locked (${info.reason}, tripped ${info.trippedAt}, blocked ${info.blockedCount} time(s)). ` +
          `Solve it at ${info.pageUrl || 'the provider page'} and choose: [r]etry now, [c]lear the lock, [a]bort: `
      )
      const answer = (await readAnswer(deps, detail)).toLowerCase()
      if (answer.startsWith('r')) return 'retry'
      if (answer.startsWith('c')) return 'clear'
      return 'abort'
    },
    async confirmSolved(info: SolvedPromptInfo): Promise<SolvedAnswer> {
      const detail = { provider: info.provider, reason: info.reason, pageUrl: info.pageUrl }
      if (deps.stdin.isTTY !== true || deps.stdin.readableEnded === true || deps.stdin.destroyed === true) await readAnswer(deps, detail)
      deps.ask(`${info.provider} needs you (${info.reason}) at ${info.pageUrl}. Solve it in the browser window, then press Enter (or type a to abort): `)
      const answer = (await readAnswer(deps, detail)).toLowerCase()
      return answer.startsWith('a') ? 'abort' : 'solved'
    },
  }
}

// ─── The verb flags ───────────────────────────────────────────────────────────

type Json = Record<string, unknown>

/** One property of an operation's input, as the flags see it. */
export interface InputProperty {
  name: string
  flag: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'json'
  description: string
  enumValues: string[] | undefined
  required: boolean
}

/** The input shape of one operation: its properties and whether the call must carry an input at all. */
export interface InputShape {
  properties: InputProperty[]
  inputRequired: boolean
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function propertyType(schema: Json): InputProperty['type'] {
  const t = schema['type']
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') return t
  const variants = (schema['anyOf'] ?? schema['oneOf']) as Json[] | undefined
  if (Array.isArray(variants) && variants.length > 0 && variants.every((v) => typeof v === 'object' && v !== null && 'const' in v)) return 'string'
  return 'json'
}

function propertyEnum(schema: Json): string[] | undefined {
  if (Array.isArray(schema['enum'])) return (schema['enum'] as unknown[]).map(String)
  const variants = (schema['anyOf'] ?? schema['oneOf']) as Json[] | undefined
  if (Array.isArray(variants) && variants.length > 0 && variants.every((v) => typeof v === 'object' && v !== null && 'const' in v)) return variants.map((v) => String(v['const']))
  return undefined
}

/** Read the input shape of `operation` from the composed schema of the package. */
export function inputShape(pkg: StealthSearchPackage, operation: string): InputShape {
  const schema = pkg.pkg.schemas[operation] as { input?: Json } | undefined
  const data = ((schema?.input?.['properties'] as Json | undefined)?.['data'] ?? undefined) as Json | undefined
  const input = ((data?.['properties'] as Json | undefined)?.['input'] ?? undefined) as Json | undefined
  if (!input) return { properties: [], inputRequired: false }
  const required = new Set((input['required'] as string[] | undefined) ?? [])
  const props = (input['properties'] as Record<string, Json> | undefined) ?? {}
  const properties = Object.entries(props).map(([name, p]) => ({
    name,
    flag: kebab(name),
    type: propertyType(p),
    description: typeof p['description'] === 'string' ? p['description'] : '',
    enumValues: propertyEnum(p),
    required: required.has(name),
  }))
  const inputRequired = ((data?.['required'] as string[] | undefined) ?? []).includes('input')
  return { properties, inputRequired }
}

function coerce(prop: InputProperty, raw: string): unknown {
  switch (prop.type) {
    case 'number':
    case 'integer': {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n) || (prop.type === 'integer' && !Number.isInteger(n))) throw flagInvalid(`--${prop.flag}`, `"${raw}" is not a ${prop.type === 'integer' ? 'whole number' : 'number'}`)
      return n
    }
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw flagInvalid(`--${prop.flag}`, `"${raw}" is not true or false`)
    case 'json':
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw flagInvalid(`--${prop.flag}`, `"${raw}" is not valid JSON`)
      }
    default:
      if (prop.enumValues && !prop.enumValues.includes(raw)) throw flagInvalid(`--${prop.flag}`, `"${raw}" is not one of ${prop.enumValues.join(', ')}`)
      return raw
  }
}

/**
 * Translate the operation's own tokens into its input object. `--name value`, `--name=value`, a
 * bare boolean `--flag`, `--no-flag`, or `--input '<json>'` (the flags override it). An unknown
 * flag or a stray operand is HOST_FLAG_INVALID. The host's `--cdp-host` and `--cdp-port` fill the
 * `host` and `port` of an operation that takes them, and `--user-data-dir` its `userDataDir`.
 */
export function buildVerbInput(shape: InputShape, tokens: readonly string[], settings: HostSettings, given: ReadonlySet<string>): Json | undefined {
  const byFlag = new Map<string, InputProperty>()
  for (const p of shape.properties) {
    byFlag.set(p.flag, p)
    byFlag.set(p.name, p)
  }
  let input: Json = {}
  let sawInput = false
  const flagged: Json = {}
  const operands: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (!token.startsWith('--')) {
      operands.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = token.slice(2, eq === -1 ? undefined : eq)
    const inline = eq === -1 ? undefined : token.slice(eq + 1)
    if (name === 'input') {
      const raw = inline ?? tokens[++i]
      if (raw === undefined) throw flagInvalid('--input', 'missing value')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw flagInvalid('--input', 'the value is not valid JSON')
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw flagInvalid('--input', 'the value must be a JSON object')
      input = parsed as Json
      sawInput = true
      continue
    }
    const negated = name.startsWith('no-') && byFlag.get(name.slice(3))?.type === 'boolean'
    const prop = byFlag.get(negated ? name.slice(3) : name)
    if (!prop) {
      const known = shape.properties.map((p) => `--${p.flag}`).concat('--input').join(', ')
      throw flagInvalid(`--${name}`, `unknown flag for this operation (accepted: ${known})`)
    }
    if (prop.type === 'boolean') {
      if (negated) flagged[prop.name] = false
      else if (inline !== undefined) flagged[prop.name] = coerce(prop, inline)
      else if (tokens[i + 1] === 'true' || tokens[i + 1] === 'false') flagged[prop.name] = tokens[++i] === 'true'
      else flagged[prop.name] = true
      continue
    }
    const raw = inline ?? tokens[++i]
    if (raw === undefined) throw flagInvalid(`--${prop.flag}`, 'missing value')
    flagged[prop.name] = coerce(prop, raw)
  }
  const merged: Json = { ...input, ...flagged }
  // Operands fill the required properties that no flag set, in the order the input declares them:
  // `search duckduckgo "a query"` is `--provider duckduckgo --query "a query"`.
  const open = shape.properties.filter((p) => p.required && merged[p.name] === undefined)
  if (operands.length > open.length) {
    throw flagInvalid(operands[open.length] as string, `unexpected operand; this operation takes ${open.length === 0 ? 'no operands' : `${open.length} (${open.map((p) => p.name).join(', ')})`}, pass anything else as a --flag`)
  }
  operands.forEach((raw, i) => {
    const prop = open[i] as InputProperty
    merged[prop.name] = coerce(prop, raw)
  })
  const has = (name: string): boolean => shape.properties.some((p) => p.name === name)
  if (has('host') && merged['host'] === undefined && given.has('cdpHost')) merged['host'] = settings.cdpHost
  if (has('port') && merged['port'] === undefined && given.has('cdpPort')) merged['port'] = settings.cdpPort
  if (has('userDataDir') && merged['userDataDir'] === undefined && settings.userDataDir !== undefined) merged['userDataDir'] = settings.userDataDir
  if (Object.keys(merged).length === 0 && !sawInput && !shape.inputRequired) {
    if (shape.properties.some((p) => p.required)) throw flagInvalid('input', `missing required flag(s): ${shape.properties.filter((p) => p.required).map((p) => `--${p.flag}`).join(', ')}`)
    return undefined
  }
  const missing = shape.properties.filter((p) => p.required && merged[p.name] === undefined)
  if (missing.length > 0) throw flagInvalid('input', `missing required flag(s): ${missing.map((p) => `--${p.flag}`).join(', ')}`)
  return merged
}

// ─── Help ─────────────────────────────────────────────────────────────────────

/** The `--help` of the CLI: usage, the eleven operations and the whole host-flag table. */
export function renderCliHelp(surface: readonly SurfaceEntry[]): string {
  const width = Math.max(...surface.map((s) => s.operation.length)) + 2
  return [
    'stealth-search: search the web and read pages through a stealth Chrome',
    '',
    'Usage: stealth-search <operation> [operation flags] [host flags]',
    '       stealth-search <operation> --help',
    '',
    'Operations:',
    ...surface.map((s) => `  ${s.operation.padEnd(width)}${firstSentence(s.description)}`),
    '',
    'Operation flags: --<input-property> <value> (kebab-case), or --input <json> for the whole input object.',
    'Required inputs may also be given as operands in order: stealth-search search duckduckgo "typescript generics".',
    'Output: one JSON document on stdout; a failure is one "<CODE>: <message>" line on stderr.',
    '',
    ...renderCliHelpFlags(),
  ].join('\n')
}

function firstSentence(text: string): string {
  const m = /^[^.]*\./.exec(text)
  return m ? m[0] : text
}

/** The `--help` of one operation. */
export function renderOperationHelp(entry: SurfaceEntry, shape: InputShape): string {
  const rows = shape.properties.map((p) => {
    const kind = p.enumValues ? p.enumValues.join('|') : p.type
    return `  --${p.flag} <${kind}>${p.required ? ' (required)' : ''}${p.description ? `  ${p.description}` : ''}`
  })
  return [
    `stealth-search ${entry.operation}`,
    '',
    entry.description,
    '',
    rows.length > 0 ? 'Operation flags:' : 'This operation takes no input.',
    ...rows,
    ...(rows.length > 0 ? ['  --input <json>  the whole input object (flags override it)'] : []),
    '',
    'Host flags apply to every operation; run "stealth-search --help" for the table.',
  ].join('\n')
}

// ─── The runner ───────────────────────────────────────────────────────────────

/** A sink whose write resolves once the bytes were handed to the OS (flush). */
export interface OutputSink {
  write(text: string): Promise<void>
}

/** Everything `runCli` touches outside this module, injectable for specs. */
export interface CliDeps {
  build?: (options: BuildPackageOptions) => Promise<StealthSearchPackage>
  runPlugin?: (input: RunInput) => Promise<void>
  configure?: (options: ConfigureSearchOptions) => void
  configureManagers?: typeof lifecycle.configureManagers
  installHooks?: typeof lifecycle.installProcessExitHooks
  restartBrowser?: (input: { host: string; port: number }) => Promise<unknown>
  /** Closes the browser handles (the CDP connections and the manager lease). */
  closeHandles?: () => Promise<void> | void
  stdout?: OutputSink
  stderr?: (line: string) => void
  exit?: (code: number) => void
  stdin?: PromptInput
  proc?: lifecycle.ExitHookProcess
  entryPath?: string
  nodeVersion?: string
  /** Called once with the parsed settings before the first dispatch (the bin passes its telemetry initializer). */
  initTelemetry?: (opts: { role: 'cli'; logDir?: string }) => void
  /** Replace the TTY prompter (specs). */
  interaction?: InteractionPort
  /** Parse hook (specs). */
  parse?: (argv: readonly string[]) => ParsedHostArgs
}

/** The `--log-dir` value of an argument list (`--log-dir x` or `--log-dir=x`), read before the flags are validated. */
function scanLogDir(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--log-dir') {
      const next = argv[i + 1]
      return next !== undefined && next.length > 0 ? next : undefined
    }
    if (token.startsWith('--log-dir=') && token.length > '--log-dir='.length) return token.slice('--log-dir='.length)
  }
  return undefined
}

/**
 * A host flag failed validation before the dispatch: write the start and error span of the operation the command
 * line names. No span when no operation is named (there is no operation id to record) or the package cannot be built.
 */
async function traceRejectedFlag(argv: readonly string[], err: unknown, build: (o: BuildPackageOptions) => Promise<StealthSearchPackage>): Promise<void> {
  const named = argv.find((t) => (OPERATION_NAMES as readonly string[]).includes(t))
  if (named === undefined) return
  try {
    const built = await build({ cacheFile: join(defaultHostSettings().dataDir, 'cache', 'operations.json') })
    const entry = built.surface.find((s) => s.operation === named)
    if (entry) await traceRejection(entry.id, 'cli', err)
  } catch {
    // tracing a rejection is best effort: the typed flag error is what the caller reports
  }
}

/** What one run produced, before it is written. */
interface Outcome {
  stdout: string | undefined
  stderr: string | undefined
  code: number
}

/** The host layer: records what the verb returned or threw, so the CLI can type it. */
interface Capture {
  value: unknown
  error: unknown
  done: boolean
}

function captureLayer(capture: Capture): Plugin {
  return {
    id: 'stealth-search-host',
    description: 'Captures the verb result or error of one CLI dispatch so the host can type it.',
    language: 'ts',
    capabilities: {
      layer: {
        layer: async (_call: unknown, next: () => Promise<unknown>) => {
          try {
            const value = await next()
            capture.value = value
            capture.done = true
            return value
          } catch (e) {
            capture.error = e
            capture.done = true
            throw e
          }
        },
      },
    },
  } as unknown as Plugin
}

/** The cliPlugin prints with the console and sets `process.exitCode`: one run at a time, both restored. */
let dispatchChain: Promise<unknown> = Promise.resolve()

async function withCapturedConsole<T>(body: () => Promise<T>): Promise<{ value: T; out: string[]; err: string[] }> {
  const run = dispatchChain.then(async () => {
    const out: string[] = []
    const err: string[] = []
    const realLog = console.log
    const realError = console.error
    const realExitCode = process.exitCode
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '))
    console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '))
    process.exitCode = undefined
    try {
      const value = await body()
      return { value, out, err }
    } finally {
      console.log = realLog
      console.error = realError
      process.exitCode = realExitCode
    }
  })
  dispatchChain = run.catch(() => undefined)
  return run
}

function isHitlResult(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { outcome?: unknown }).outcome === 'hitl'
}

function hitlAbortDocument(e: StealthSearchError, operation: string, verbInput: Json | undefined): Json {
  const d = (e.detail ?? {}) as Json
  const provider = String(d['provider'] ?? verbInput?.['provider'] ?? '')
  const query = String(verbInput?.['query'] ?? '')
  return {
    provider,
    query,
    count: 0,
    results: [],
    outcome: 'hitl',
    attempts: 0,
    error: e.message,
    hitl: { reason: String(d['reason'] ?? 'unknown'), pageUrl: String(d['pageUrl'] ?? ''), provider, query },
    operation,
  }
}

function apiErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Map what the dispatch captured onto stdout, stderr and an exit status. */
function outcomeOf(capture: Capture, entry: SurfaceEntry, verbInput: Json | undefined, consoleErr: readonly string[], pretty: boolean): Outcome {
  if (capture.done && capture.error === undefined) {
    const v = capture.value
    const empty = v === undefined || v === null || (typeof v === 'string' && v.length === 0)
    if (empty) {
      return { stdout: undefined, stderr: renderHostError(bootFailed(`${entry.operation} produced no output`, undefined, { operation: entry.operation })), code: exitCodeFor('HOST_BOOT_FAILED') }
    }
    const text = JSON.stringify(v, null, pretty ? 2 : undefined)
    if (text === undefined || text.length === 0) {
      return { stdout: undefined, stderr: renderHostError(bootFailed(`${entry.operation} produced an unserializable result`)), code: exitCodeFor('HOST_BOOT_FAILED') }
    }
    return { stdout: text, stderr: undefined, code: isHitlResult(v) ? exitCodeFor('HITL_ABORTED') : 0 }
  }
  if (capture.done) {
    const e = capture.error
    if (e instanceof StealthSearchError && String(e.code) === 'HITL_ABORTED') {
      return { stdout: JSON.stringify(hitlAbortDocument(e, entry.operation, verbInput)), stderr: undefined, code: exitCodeFor('HITL_ABORTED') }
    }
    if (e instanceof StealthSearchError) return { stdout: undefined, stderr: renderHostError(e), code: exitCodeFor(e.code) }
    const code = (e as { code?: unknown } | null)?.code
    if (code === 'invalid_argument') return { stdout: undefined, stderr: renderHostError(flagInvalid('input', apiErrorMessage(e))), code: exitCodeFor('HOST_FLAG_INVALID') }
    const typed = asHostError(e)
    return { stdout: undefined, stderr: renderHostError(typed), code: exitCodeFor(typed.code) }
  }
  // The plugin failed before the verb ran (routing, flag table): it printed a JSON error on its stderr.
  const first = consoleErr[0] ?? ''
  let message = first
  try {
    const parsed = JSON.parse(first) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    // keep the raw line
  }
  const err = message.length > 0 ? flagInvalid(entry.operation, message) : bootFailed(`${entry.operation} produced no output`)
  return { stdout: undefined, stderr: renderHostError(err), code: exitCodeFor(err.code) }
}

const stdoutSink: OutputSink = {
  write: (text) => new Promise<void>((resolve) => void process.stdout.write(text, () => resolve())),
}

/**
 * Run the CLI once: parse, boot, dispatch, write the one JSON document, close the browser handles
 * and `exit`. Returns the status it exited with (the injected `exit` of a spec returns). Order of a
 * successful run: write stdout, flush it, close the handles, `exit(0)`.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const sink = deps.stdout ?? stdoutSink
  const warn = deps.stderr ?? stderrLine
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const closeHandles = deps.closeHandles ?? (() => lifecycle.chromeExitTarget.release())
  let uninstall: (() => void) | undefined

  const finish = async (outcome: Outcome, monitorSince?: number): Promise<number> => {
    if (outcome.stdout !== undefined) await sink.write(`${outcome.stdout}\n`)
    if (outcome.stderr !== undefined) warn(outcome.stderr)
    if (monitorSince !== undefined) {
      const mem = process.memoryUsage()
      warn(`[monitor] elapsedMs=${Math.round(performance.now() - monitorSince)} rssMb=${(mem.rss / 1048576).toFixed(1)} heapUsedMb=${(mem.heapUsed / 1048576).toFixed(1)}`)
    }
    try {
      await closeHandles()
    } catch {
      // closing is best effort: the answer is already written
    }
    exit(outcome.code)
    uninstall?.()
    return outcome.code
  }
  const failure = (e: unknown): Promise<number> => {
    const err = asHostError(e)
    return finish({ stdout: undefined, stderr: renderHostError(err), code: exitCodeFor(err.code) })
  }

  try {
    assertSupportedNode(deps.nodeVersion ?? process.versions.node)
    const build = deps.build ?? buildStealthSearchPackage
    // Telemetry starts before any flag is validated, so a rejected flag still leaves its span. `--help` is not a
    // dispatch: it starts no telemetry and writes no span.
    const dispatching = argv.length > 0 && !argv.some((t) => t === '--help' || t === '-h')
    if (dispatching) {
      const logDir = scanLogDir(argv)
      deps.initTelemetry?.({ role: 'cli', ...(logDir ? { logDir } : {}) })
    }
    let parsed: ParsedHostArgs
    try {
      parsed = (deps.parse ?? ((a) => parseHostFlags(a, 'cli')))(argv)
    } catch (e) {
      if (dispatching) await traceRejectedFlag(argv, e, build)
      throw e
    }
    const built = await build({ cacheFile: join(parsed.settings.dataDir, 'cache', 'operations.json') })
    const surface = built.surface

    if (parsed.operation === undefined) {
      if (parsed.help || parsed.rest.length === 0) return await finish({ stdout: renderCliHelp(surface), stderr: undefined, code: 0 })
      throw flagInvalid(parsed.rest[0] as string, 'expected an operation first (see --help)')
    }
    const entry = surface.find((s) => s.operation === parsed.operation)
    if (!entry) throw flagInvalid(parsed.operation, `unknown operation (one of ${OPERATION_NAMES.join(', ')})`)
    const shape = inputShape(built, entry.operation)
    if (parsed.help) return await finish({ stdout: renderOperationHelp(entry, shape), stderr: undefined, code: 0 })
    let verbInput: Json | undefined
    try {
      verbInput = buildVerbInput(shape, parsed.rest, parsed.settings, parsed.given as ReadonlySet<string>)
    } catch (e) {
      await traceRejection(entry.id, 'cli', e)
      throw e
    }

    const settings = parsed.settings

    const log = stderrLogger('[stealth-search]')
    const quiet = settings.verbose ? log : (): void => undefined
    const configureManagers = deps.configureManagers ?? lifecycle.configureManagers
    configureManagers({
      idleTimeoutMs: settings.idleShutdownMs,
      keepAlive: settings.keepAlive,
      checkHistory: settings.checkHistory,
      entryPath: deps.entryPath ?? resolveCoreEntry(),
      logger: quiet,
    })
    const interaction =
      deps.interaction ??
      createTtyPrompter({
        stdin: deps.stdin ?? (process.stdin as unknown as PromptInput),
        ask: (text) => void process.stderr.write(text),
      })
    const configure = deps.configure ?? configureSearch
    configure({ interaction, config: toSearchHostConfig(settings) })

    if (settings.restartBrowser) {
      const restart = deps.restartBrowser ?? ((input) => shutdownChrome(input))
      await restart({ host: settings.cdpHost, port: settings.cdpPort })
    }
    const installHooks = deps.installHooks ?? lifecycle.installProcessExitHooks
    uninstall = installHooks(lifecycle.chromeExitTarget, {
      forceExitMs: FORCE_EXIT_MS,
      logger: quiet,
      ...(deps.proc ? { proc: deps.proc } : {}),
      ...(deps.exit ? { exit: deps.exit } : {}),
    })

    const startedAt = performance.now()
    const capture: Capture = { value: undefined, error: undefined, done: false }
    const level = settings.logLevel ?? (settings.verbose ? 'info' : 'silent')
    const logger = createLogger({ level, format: settings.logFormat ?? 'json', ...(settings.logFile ? { destination: settings.logFile } : {}) })
    const argvForPlugin = [...entry.cliPath, ...(verbInput === undefined ? [] : ['--input', JSON.stringify(verbInput)])]
    const input: RunInput = {
      packages: [built.pkg],
      outputDir: '',
      options: { argv: argvForPlugin, usePlugins: [tracingPlugin, captureLayer(capture)] },
      operations: built.operations,
      logger,
    }
    const runPlugin = deps.runPlugin ?? cliPlugin.run?.bind(cliPlugin)
    if (!runPlugin) throw bootFailed('the apigen CLI plugin declares no run()')
    const { err: consoleErr } = await withCapturedConsole(() => runPlugin(input))
    return await finish(outcomeOf(capture, entry, verbInput, consoleErr, settings.pretty), settings.monitor ? startedAt : undefined)
  } catch (e) {
    return failure(e)
  }
}

export { HostBootFailedError }
export type { OperationName }
