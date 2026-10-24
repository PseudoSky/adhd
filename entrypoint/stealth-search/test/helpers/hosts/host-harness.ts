/**
 * Shared harness of the hosts unit lane. The package under test is the REAL apigen package built
 * from `src/api.ts` (`buildStealthSearchPackage`) with fake verbs bound to it, and the REAL
 * `runCli` / `startMcpHost` over fakes of everything outside the process: stdout, exit, stdin,
 * the Chrome lifecycle and the exit hooks. Nothing here spawns a process, opens a socket or touches
 * a real Chrome; port 9222 is never contacted.
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.16]
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliDeps, OutputSink, PromptInput } from '../../../src/cli.js'
import { configureSearch } from '../../../src/lib/search.js'
import type { ConfigureSearchOptions } from '../../../src/lib/search.js'
import { hitlResponse, input, makeFakeCore, makeWorld, scriptedEngine } from '../verbs/harness.js'
import type { World } from '../verbs/harness.js'
import { buildStealthSearchPackage, OPERATION_NAMES } from '../../../src/server.js'
import type { StealthSearchPackage, Verbs } from '../../../src/server.js'
import { expect } from 'vitest'

/** The declarations the operations are extracted from in the specs (the source of the same file the build ships as `api.d.ts`). */
export const API_SOURCE = join(__dirname, '..', '..', '..', 'src', 'api.ts')

/** The extraction costs seconds, so the specs share one cache file keyed by the declarations and the extractor. */
export const OPERATIONS_CACHE = join(tmpdir(), 'stealth-search-hosts-spec-operations.json')

/**
 * A verb error or a schema rejection reaches an MCP client as a tool result with `isError: true` and its code under
 * `_meta['adhd/error']` (apigen ADR-0018 D2), not as a thrown client error. Asserts that result, that its text matches
 * `pattern` and that the machine-readable `code` is in it: the whole text for an ApiError (`<code>: <message>`), or
 * the token right after the canonical code for a typed library error (`<canonical>: <CODE>: <message>`).
 */
/** A schema rejection reaches an MCP client as a tool result: `isError`, `invalid_argument: ...` text and the code under `_meta['adhd/error']`. */
export async function expectInvalidArgument(call: Promise<unknown>, pattern: RegExp): Promise<void> {
  const res = (await call) as { isError?: boolean; content?: Array<{ text?: string }>; _meta?: Record<string, unknown> }
  expect(res.isError).toBe(true)
  expect(res.content?.[0]?.text).toMatch(/^invalid_argument: /)
  expect(res.content?.[0]?.text).toMatch(pattern)
  expect(res._meta?.['adhd/error']).toMatchObject({ code: 'invalid_argument' })
}

export async function expectMcpToolError(call: Promise<unknown>, pattern: RegExp, code: string): Promise<void> {
  const res = (await call) as { isError?: boolean; content?: Array<{ text?: string }>; _meta?: Record<string, unknown> }
  expect(res.isError).toBe(true)
  const text = res.content?.[0]?.text ?? ''
  expect(text).toMatch(pattern)
  expect(text).toMatch(new RegExp(`^(?:[a-z_]+: )?${code}: |^${code}: `))
  expect(res._meta?.['adhd/error']).toBeDefined()
}

/** A generous bound for the first (extracting) build of a spec file. */
export const BUILD_TIMEOUT_MS = 180_000

/** A spy factory (`vi.fn` of the calling spec): the harness takes its spies from the spec and imports only `expect` from the runner. */
export type SpyFactory = (impl: (...args: never[]) => unknown) => (...args: never[]) => unknown

export type FakeVerbs = { [K in (typeof OPERATION_NAMES)[number]]: (...args: never[]) => unknown } & Verbs

/**
 * One schema-conformant answer per operation (synthetic): the validate layer strips what the output
 * schema does not declare, so a fake verb must answer in the declared shape to be seen on stdout.
 */
export const SAMPLES: Record<(typeof OPERATION_NAMES)[number], unknown> = {
  search: { provider: 'npm', query: 'zod', count: 1, results: [{ title: 'zod', url: 'https://www.npmjs.com/package/zod', snippet: 'TypeScript-first schema validation' }], outcome: 'success', tookMs: 12, attempts: 1, strategy: 'network' },
  listProviders: { providers: [{ id: 'npm', name: 'npm', help: 'npm packages', strategies: ['network'] }] },
  describeProvider: { id: 'npm', name: 'npm', help: 'npm packages', url: 'https://registry.npmjs.org/-/v1/search?text=demo', strategies: ['network'], qualifierExamples: [], bans: [], usage: 'search npm <query>' },
  tripwireStatus: {},
  clearTripwire: { provider: 'github', cleared: true },
  getPageContext: { found: false, context: null },
  chromeStatus: { running: false, managed: false },
  launchChrome: { ok: true, port: 19990 },
  shutdownChrome: { ok: true, running: false },
  listPageTargets: { targets: [{ id: 'tab-1', type: 'page', url: 'https://example.com/' }] },
  checkChromeActivity: { activePages: 0, pageTargets: [] },
}

/** Eleven fake verbs; each answers its SAMPLES document unless overridden. */
export function fakeVerbs(spy: SpyFactory, overrides: Partial<Record<(typeof OPERATION_NAMES)[number], (...args: never[]) => unknown>> = {}): FakeVerbs {
  const out: Record<string, (...args: never[]) => unknown> = {}
  for (const name of OPERATION_NAMES) {
    out[name] = spy((overrides[name] as ((...a: never[]) => unknown) | undefined) ?? (async () => SAMPLES[name]))
  }
  return out as unknown as FakeVerbs
}

/** The real package over the given verbs. */
export function packageFor(verbs: Verbs): Promise<StealthSearchPackage> {
  return buildStealthSearchPackage({ apiSource: API_SOURCE, verbs, cacheFile: OPERATIONS_CACHE })
}

/** A stdin stream: an object with the listener surface the prompter and the exit hooks use. */
export class FakeStdin implements PromptInput {
  isTTY: boolean | undefined
  readableEnded = false
  destroyed = false
  resumed = 0
  paused = 0
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()

  constructor(opts: { isTTY?: boolean; ended?: boolean } = {}) {
    this.isTTY = opts.isTTY
    this.readableEnded = opts.ended ?? false
  }

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  removeListener(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener))
    return this
  }

  setEncoding(): this {
    return this
  }

  resume(): this {
    this.resumed++
    return this
  }

  pause(): this {
    this.paused++
    return this
  }

  count(event: string): number {
    return (this.listeners.get(event) ?? []).length
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) (l as (...a: unknown[]) => void)(...args)
  }

  /** The client closes its end: `end`, then `close`. */
  close(): void {
    this.readableEnded = true
    this.emit('end')
    this.emit('close')
  }
}

export interface CliHarness {
  deps: CliDeps
  /** The chronological log of side effects: write, flush, close, exit(code). */
  events: string[]
  stdout: string[]
  stderr: string[]
  exits: number[]
  configured: unknown[]
  managers: unknown[]
  hooks: Array<{ target: unknown; options: Record<string, unknown> }>
  restarted: Array<{ host: string; port: number }>
  telemetry: unknown[]
  uninstalled: () => number
}

/** The CLI runner's dependencies, all faked, recording the order of every side effect. */
export function cliHarness(verbs: Verbs, extra: Partial<CliDeps> = {}): CliHarness {
  const events: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const configured: unknown[] = []
  const managers: unknown[] = []
  const hooks: CliHarness['hooks'] = []
  const restarted: CliHarness['restarted'] = []
  const telemetry: unknown[] = []
  let uninstalls = 0
  const sink: OutputSink = {
    write: (text) => {
      events.push('write')
      stdout.push(text)
      return new Promise<void>((resolve) =>
        setImmediate(() => {
          events.push('flush')
          resolve()
        })
      )
    },
  }
  const deps: CliDeps = {
    build: () => packageFor(verbs),
    stdout: sink,
    stderr: (line) => void stderr.push(line),
    exit: (code) => {
      events.push(`exit(${code})`)
      exits.push(code)
    },
    closeHandles: () => {
      events.push('close')
    },
    configure: (o) => void configured.push(o),
    configureManagers: ((s: unknown) => void managers.push(s)) as CliDeps['configureManagers'],
    installHooks: ((target: unknown, options: Record<string, unknown>) => {
      hooks.push({ target, options })
      return () => void uninstalls++
    }) as CliDeps['installHooks'],
    restartBrowser: async (input) => {
      events.push('restart')
      restarted.push(input)
    },
    stdin: new FakeStdin({ isTTY: false, ended: true }),
    entryPath: '/fake/core/index.js',
    nodeVersion: '22.12.0',
    initTelemetry: (o) => void telemetry.push(o),
    ...extra,
  }
  return { deps, events, stdout, stderr, exits, configured, managers, hooks, restarted, telemetry, uninstalled: () => uninstalls }
}

/**
 * Wire the REAL search service the way a host does (`configureSearch`), but over the world's memory
 * fs and clock and a scripted engine; the host's own `interaction` and flag-derived `config` are kept.
 */
export function wire(world: World, strategies: ReturnType<typeof scriptedEngine>['strategies']): (o: ConfigureSearchOptions) => void {
  return (o) =>
    configureSearch({
      ...(o.interaction ? { interaction: o.interaction } : {}),
      config: { ...o.config, dataDir: '/data', sessionId: 'sess-1', fs: world.fs, clock: () => world.clock.now },
      deps: { core: world.core.core, strategies, sleep: async () => undefined, now: () => world.clock.now, log: () => undefined },
    })
}

/** A world whose github provider is already tripped by a captcha (the lock a previous run left behind). */
export async function trippedWorld(): Promise<World> {
  const world = makeWorld({ strategies: scriptedEngine(hitlResponse('captcha')).strategies, core: makeFakeCore() })
  const first = await world.svc.search(input({ provider: 'github', query: 'vite' }))
  if (first.outcome !== 'hitl') throw new Error(`seeding the lock failed: ${first.outcome}`)
  return world
}
