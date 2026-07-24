import type {
  RunInput,
  Operation,
  MountedOperation,
  ComposedSchemas,
} from '@adhd/apigen-core-client';
import {
  createLogger,
  buildOpPlan,
  createPackageInvoker,
  dispatchForPlan,
  readUseOptions,
  readUsePlugins,
  isApiStream,
} from '@adhd/apigen-engine-runtime';
import type {
  Call as RuntimeCall,
  Logger,
  OpPlan,
  OpPlanCliFlag,
  ParamInfo,
  TransportAdapter,
  InvokeOptions,
  LayerResult,
  UseOptions,
  UsePlugin,
} from '@adhd/apigen-engine-runtime';
import { ApiError, isApiError, CLI_EXIT_CODE } from '@adhd/apigen-base-errors';

// ---------------------------------------------------------------------------
// run() — serve-core migration (cli-adapter).
//
// `cli-output` is now a `TransportAdapter<CliRawCall>` ([iface:transport-
// adapter]) consuming `OpPlan` ([iface:op-plan]) exactly like the fastify
// reference adapter (`apigen-plugin-api-fastify/src/lib/run.ts`):
//
//   - `buildOpPlan` resolves EVERY transport-facing fact for a command
//     (nested kebab `cli.path`, the precomputed `--flag` table `cliFlags`,
//     §9.1 envelope bindings, `streaming`) ONCE, at wiring time. The former
//     hand-rolled `buildFlagTable`/`FlagSpec` ([cli-adapter.1] — DELETED, see
//     below) and the direct naming-authority projection call ([cli-adapter.2]
//     — DELETED) are both gone; `readCall` is pure argv-walking over
//     `plan.cliFlags`.
//   - `createPackageInvoker` composes the `--use` layer stack + validate-
//     Layer ONCE per package (dod.11 — see below).
//   - `dispatchForPlan` fills in `operation`/`ctx` and stamps
//     `Call.transport` from `plan.transport` (F3 [fix:transport-stamping] —
//     stamped `'cli'` below, never inferred).
//
// [fix:use-capability-explicit] (dod.11) — RESOLVED: cli-output previously
// had ZERO `--use` capability. This migration ADDS it, consistent with
// fastify/express: both the `layer` capability (an auth/logging `--use`
// plugin now wraps every CLI dispatch, mount or source op alike) and the
// `mount` capability (a `--use health`-style plugin's `MountedOperation`s are
// now resolvable AND dispatchable as ordinary nested CLI commands — e.g.
// `--use health` mounts `meta health`). This was a deliberate choice over
// declaring cli-output `--use`-incapable: `dispatchForPlan`'s mount branch
// and `buildOpPlan`'s cli-path/cliFlags projection already work uniformly for
// ANY `Operation` (mounted or extracted) with zero CLI-specific mount
// plumbing needed — unlike fastify, a CLI mount command needs no route-
// collision handling or special URL preservation (there is no pre-migration
// CLI mount behavior to stay byte-identical to), so the marginal cost of
// adding real support was near zero. See this state's report for the
// decision record.
//
// [fix:streaming-wired]: CLI explicit REJECTS a `streaming:true` op (never
// silently `JSON.stringify`s an `AsyncIterable` into `{}`) — a flagged,
// reviewed behavior CHANGE from the pre-migration CLI (which had no
// streaming awareness at all and would have silently mis-serialized one).
//
// Unlike a server transport, a CLI invocation is one-shot — it dispatches
// exactly one command then resolves; it does not wait on `input.signal`
// (there is no long-lived listener to tear down), though an
// *already*-aborted signal is honored as a no-op (BUG-APIGEN-CLI-RUN: a
// caller that races an abort against `run()` should not have a stray command
// execute after cancellation was requested).
// ---------------------------------------------------------------------------

/**
 * One resolvable CLI command: a package's function reached under a nested
 * kebab path, plus its fully-resolved `OpPlan` ([iface:op-plan]) — the single
 * source of truth for its `cli.path`/`cliFlags`/`envelope`/`streaming` facts.
 */
export interface CommandEntry {
  pkgId: string;
  fnName: string;
  schema: ComposedSchemas[string];
  /** Ordered kebab command segments, e.g. `['backlog', 'get-item']` (`plan.cli.path`). */
  cliPath: string[];
  /**
   * The resolved `OpPlan` for this command — carries the precomputed
   * `--flag` table (`cliFlags`), §9.1 envelope bindings, and `streaming`.
   * `readCall`/dispatch consume this instead of re-deriving anything from
   * `schema` directly ([cli-adapter.1]).
   */
  plan: OpPlan;
}

// ---------------------------------------------------------------------------
// argv resolution — unchanged surface (pure helpers, no OpPlan involvement).
// ---------------------------------------------------------------------------

/**
 * Splits a shell-like command-line string into tokens, honoring single- and
 * double-quoted segments (so a value containing spaces can be passed through
 * the `--opt argv=…` single-string delivery path — kept for back-compat now
 * that `apigen run --type cli -- …` also accepts a native positional
 * passthrough directly into `options['argv']` as a real `string[]`, see
 * {@link resolveArgv}; BACKLOG DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001 is
 * RESOLVED).
 */
export function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Resolves the argv to route + dispatch.
 *
 * - `input.options['argv']` as a real `string[]` is the primary, fully
 *   general API — populated natively by `apigen run`/`run-registry`'s
 *   trailing `-- <command> <args>` positional passthrough
 *   (`entrypoint/apigen-cli/src/lib/commands/{run,run-registry}.ts`), and
 *   also what a programmatic `@adhd/apigen-core-client` consumer
 *   (`cliPlugin.run({ options: { argv: [...] } })`) should pass directly.
 * - `input.options['argv']` as a `string` is tokenized shell-style — the
 *   OLDER `apigen` CLI delivery mechanism, `--opt argv=…` (kept for
 *   back-compat; the native `--` passthrough above takes precedence when
 *   both are supplied).
 * - Absent — falls back to the real process's own argv (`process.argv.slice(2)`),
 *   matching the generated CLI's own `program.parseAsync()` convention: when
 *   this plugin's `run()` IS the whole process (a small dedicated wrapper
 *   script), the process's argv already *is* the command line.
 */
export function resolveArgv(options: Record<string, unknown>): string[] {
  const raw = options['argv'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return tokenizeShellLike(raw);
  return process.argv.slice(2);
}

// ---------------------------------------------------------------------------
// Command table — pkg.schemas × operations → nested kebab CLI paths
// ---------------------------------------------------------------------------

/**
 * Synthesizes a minimal `Operation` for `buildOpPlan()` when no matching real
 * `Operation` is available (`RunInput.operations` omitted, or the pkg/fn pair
 * has no corresponding merged Operation — e.g. a unit test that constructs
 * `RunInput` directly without extraction). ONLY used to resolve
 * envelope/cliFlags/streaming off the composed schema; `namespace`/`path` are
 * deliberately collapsed to a SINGLE untokenized segment carrying the bare
 * `fnName` verbatim (`path: []`) so `buildOpPlan`'s naming-authority-derived
 * `cli.path` degrades to the exact legacy flat `[fnName]` command (never
 * kebab-cased/namespaced) this fallback has always produced — see
 * `buildCommandTable`'s "falls back to a flat [fnName] command" contract,
 * proven by `run.spec.ts`.
 */
function synthesizeOperation(
  fnName: string,
  schema: ComposedSchemas[string]
): Operation {
  return {
    id: fnName,
    host: 'ts',
    namespace: { raw: fnName, words: [fnName] },
    path: [],
    kind: 'action',
    async: false,
    streaming: false,
    safe: (schema['x-apigen-safe'] as boolean | undefined) ?? false,
    input: schema.input ?? {},
    output: schema.output ?? {},
    envelope: {},
    typeText: null,
  };
}

/**
 * Builds the routing table for every dispatchable function across every
 * package. Prefers the naming authority's nested-kebab cli path projection
 * (namespace-qualified — SPEC §5), resolved via `buildOpPlan` ([iface:op-plan])
 * rather than calling the naming-authority projector directly here
 * ([cli-adapter.2] — no inline projection call), whenever a matching
 * {@link Operation} is available; falls back to a synthesized single-segment
 * `[fnName]` `Operation` ({@link synthesizeOperation}) when `input.operations`
 * doesn't carry a matching entry (e.g. a unit test that constructs `RunInput`
 * directly without extraction, or any future non-TS run path — see
 * `RunInput.operations`'s doc comment). Either way, `buildOpPlan` resolves
 * `cliFlags`/envelope/streaming ONCE here — never re-derived at dispatch time.
 */
export function buildCommandTable(
  input: Pick<RunInput, 'packages' | 'operations'>
): Map<string, CommandEntry> {
  const opsByKey = new Map<string, Operation>();
  for (const op of input.operations ?? []) {
    const last = op.path[op.path.length - 1];
    if (!last) continue;
    opsByKey.set(`${op.namespace.raw}:${last.raw}`, op);
  }

  const commands = new Map<string, CommandEntry>();
  for (const pkg of input.packages) {
    for (const [fnName, schema] of Object.entries(pkg.schemas)) {
      const op =
        opsByKey.get(`${pkg.id}:${fnName}`) ??
        synthesizeOperation(fnName, schema);
      const plan = buildOpPlan({ op, schema, transport: 'cli' });
      const cliPath = plan.cli.path;
      commands.set(cliPath.join(' '), {
        pkgId: pkg.id,
        fnName,
        schema,
        cliPath,
        plan,
      });
    }
  }
  return commands;
}

/**
 * Resolves the longest registered command-path prefix of `argv` (nested
 * kebab command matching). Only tokens before the first `-`-prefixed flag
 * are eligible path segments — everything from there on is `rest` (the
 * flags to parse for this command).
 *
 * Generic over the entry type so the SAME longest-prefix algorithm serves
 * both `buildCommandTable`'s pure `Map<string, CommandEntry>` (unit-tested
 * directly) and `run()`'s live dispatch table (`Map<string, CliRoute>`,
 * regular ops + `--use` mount ops combined).
 */
export function matchCommand<T>(
  argv: string[],
  commands: Map<string, T>
): { entry: T; rest: string[] } | null {
  let end = 0;
  while (end < argv.length && !argv[end].startsWith('-')) end++;
  for (let len = end; len >= 1; len--) {
    const entry = commands.get(argv.slice(0, len).join(' '));
    if (entry) return { entry, rest: argv.slice(len) };
  }
  return null;
}

/** `name?: type` summary text for a plan's domain params — mirrors the former `describeParams(schema).text`, sourced from the already-resolved `plan.params` (no schema re-derivation). */
function paramsText(params: ParamInfo[] | undefined): string {
  if (!params || params.length === 0) return '';
  return params
    .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
    .join(', ');
}

/** Human-readable command listing, derived from the live OpPlan-keyed route table (never hardcoded). */
function formatUsage(routes: Map<string, CliRoute>): string {
  const lines = ['Available commands:', ''];
  const sorted = [...routes.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, { plan }] of sorted) {
    const text = paramsText(plan.params);
    lines.push(`  ${key}${text ? `  { ${text} }` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Argv → {data:{...}} / envelope mapping — pure argv-walking over OpPlan.cliFlags
// ---------------------------------------------------------------------------

/** Thrown by {@link parseArgs} for any argv shape the flag table can't explain. */
function usageError(message: string): ApiError {
  return new ApiError('invalid_argument', message);
}

/**
 * Parses the flags following a matched command into `{ domainArgs, envelope }`
 * — the same split `dispatch()` expects. Supports `--flag value`,
 * `--flag=value`, bare boolean `--flag`, and `--no-flag` negation for any
 * boolean-typed flag (domain or envelope). Array/object-typed domain params
 * are JSON.parse'd from their raw string value (BUG-APIGEN-031 parity).
 *
 * [cli-adapter.1]: `flags` is always `plan.cliFlags` — the precomputed
 * `OpPlan` flag table (`@adhd/apigen-engine-runtime`). This function does NOT
 * derive flag shape/typing itself; it only WALKS argv against a table someone
 * else resolved.
 */
export function parseArgs(
  rest: string[],
  flags: Map<string, OpPlanCliFlag>
): { domainArgs: Record<string, unknown>; envelope: Record<string, unknown> } {
  const domainArgs: Record<string, unknown> = {};
  const envelope: Record<string, unknown> = {};

  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw usageError(`Unexpected positional argument: "${token}"`);
    }
    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    let negated = false;
    let lookupName = name;
    if (name.startsWith('no-') && flags.get(name.slice(3))?.valueKind === 'boolean') {
      negated = true;
      lookupName = name.slice(3);
    }

    const spec = flags.get(lookupName);
    if (!spec) {
      throw usageError(
        `Unknown option: --${name}. Available: ${[...flags.keys()]
          .sort()
          .map((f) => `--${f}`)
          .join(', ')}`
      );
    }
    i++;

    let value: unknown;
    if (spec.valueKind === 'boolean') {
      if (negated) value = false;
      else if (inlineValue === undefined) value = true;
      else value = inlineValue !== 'false';
    } else {
      const raw = inlineValue !== undefined ? inlineValue : rest[i++];
      if (raw === undefined) {
        throw usageError(`Missing value for --${name}`);
      }
      if (spec.valueKind === 'json') {
        try {
          value = JSON.parse(raw);
        } catch (err) {
          throw usageError(`Invalid JSON for --${name}: ${(err as Error).message}`);
        }
      } else {
        value = raw;
      }
    }

    if (spec.kind === 'domain') {
      domainArgs[spec.camelKey] = value;
    } else {
      envelope[spec.camelKey] = value;
    }
  }

  // §9.1: flag takes precedence over env var — fill in any envelope field the
  // caller didn't pass a flag for from its bound env var, when one exists.
  for (const spec of flags.values()) {
    if (spec.kind !== 'envelope' || !spec.envVar) continue;
    if (envelope[spec.camelKey] !== undefined) continue;
    const fromEnv = process.env[spec.envVar];
    if (fromEnv !== undefined) envelope[spec.camelKey] = fromEnv;
  }

  return { domainArgs, envelope };
}

// ---------------------------------------------------------------------------
// Error → stderr JSON + exit code (§9 CLI_EXIT_CODE table)
// ---------------------------------------------------------------------------

function reportFailure(err: unknown): void {
  const body = isApiError(err)
    ? err.toJSON()
    : { code: 'internal' as const, message: err instanceof Error ? err.message : String(err) };
  console.error(JSON.stringify(body));
  process.exitCode = isApiError(err) ? CLI_EXIT_CODE[err.code] : CLI_EXIT_CODE.internal;
}

// ---------------------------------------------------------------------------
// CliTransportAdapter — the cli `TransportAdapter` port implementation.
// ---------------------------------------------------------------------------

/** The transport-native carrier the cli adapter marshals to/from: the matched command's remaining (post-command) argv tokens. */
export interface CliRawCall {
  rest: string[];
}

/** One registered command: its `OpPlan` plus the dispatch closure bound to it (`(call) => dispatchForPlan(plan, invoke, call, opts)`). */
interface CliRoute {
  plan: OpPlan;
  dispatch: (call: Omit<RuntimeCall, 'operation' | 'ctx'>) => Promise<LayerResult>;
}

/**
 * The cli `TransportAdapter` ([iface:transport-adapter]). `readCall` is pure
 * argv-walking over `plan.cliFlags` ([cli-adapter.1]); `writeResult` is
 * stdout + `undefined→null` JSON (BUG-APIGEN-015 parity with the HTTP
 * transports); `writeError` is stderr JSON + `process.exitCode` (§9
 * `CLI_EXIT_CODE`).
 *
 * Unlike fastify/express (a long-lived listening server dispatching many
 * requests through ONE `registerRoute`-populated router), a CLI invocation is
 * one-shot: `registerRoute` is called once per resolvable command at wiring
 * time (`run()`, below), then exactly one matched command is read/dispatched/
 * written before the process exits.
 */
class CliTransportAdapter implements TransportAdapter<CliRawCall> {
  private readonly routes = new Map<string, CliRoute>();

  constructor(private readonly signal?: AbortSignal) {}

  registerRoute(
    plan: OpPlan,
    dispatch: (call: Omit<RuntimeCall, 'operation' | 'ctx'>) => Promise<LayerResult>
  ): void {
    this.routes.set(plan.cli.path.join(' '), { plan, dispatch });
  }

  /** All registered commands (regular ops + `--use` mounts) — consumed by `run()`'s longest-prefix matcher + usage listing. */
  routeTable(): Map<string, CliRoute> {
    return this.routes;
  }

  readCall(raw: CliRawCall, plan: OpPlan): Omit<RuntimeCall, 'operation' | 'ctx'> {
    const { domainArgs, envelope } = parseArgs(raw.rest, plan.cliFlags);
    return { domainArgs, envelope, signal: this.signal };
  }

  writeResult(_raw: CliRawCall, result: LayerResult, plan: OpPlan): void {
    // [fix:streaming-wired] defense-in-depth: `run()` already rejects a
    // `plan.streaming` command before ever dispatching it, but a stray
    // AsyncIterable reaching here (e.g. a `--use` mount handler that streams
    // despite the plan saying otherwise) must never be silently
    // `JSON.stringify`'d into `{}` — surface it as a clear, actionable error.
    if (isApiStream(result)) {
      throw new ApiError(
        'invalid_argument',
        `Command "${plan.cli.path.join(' ')}" produced a streaming result, which is not supported over the cli transport.`
      );
    }
    // BUG-APIGEN-015 parity: `undefined` (a void op) becomes `null` — canonical
    // JSON, never the bare word `undefined` (not valid JSON output on a wire).
    console.log(JSON.stringify(result === undefined ? null : result));
  }

  writeError(_raw: CliRawCall, err: unknown, _plan: OpPlan): void {
    reportFailure(err);
  }
}

// ---------------------------------------------------------------------------
// `--use` mount collection (dod.11) — mirrors fastify's
// `collectMountedOperations`, filtered to plugins that expose a mount to the
// `'cli'` transport (a `MountedOperation.transports` filter that omits `'cli'`
// is honored, matching HTTP's own `'http'` filter).
// ---------------------------------------------------------------------------

function collectMountedCliOperations(
  usePlugins: UsePlugin[],
  useOptions: UseOptions,
  host: string,
  operations: Operation[]
): MountedOperation[] {
  const result: MountedOperation[] = [];
  const descriptor = { host, operations: operations as unknown[] };
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.mount;
    if (!cap) continue;
    const ops = cap.operations(descriptor, useOptions[plugin.id]);
    for (const op of ops) {
      if (op.transports && !op.transports.includes('cli')) continue;
      result.push(op as unknown as MountedOperation);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

export async function run(input: RunInput): Promise<void> {
  const logger: Logger = input.logger ?? createLogger();

  // An already-aborted signal means the caller cancelled before we started —
  // honor it as a no-op rather than executing a command nobody wants anymore.
  if (input.signal?.aborted) {
    logger.info('cli run: signal already aborted before dispatch — skipping');
    return;
  }

  let argv = resolveArgv(input.options);
  // Tolerate a stray leading `--` end-of-options marker if one made it
  // through (harmless either way — Commander's own `.argument('[cliArgs...]')`
  // passthrough, DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001, already strips it
  // in the common case, but a programmatic caller could still pass one).
  if (argv[0] === '--') argv = argv.slice(1);

  const usePlugins = readUsePlugins(input.options);
  const useOptions = readUseOptions(input.options);
  const adapter = new CliTransportAdapter(input.signal);

  // Resolve every op's OpPlan ONCE (buildCommandTable), then compose ONE
  // `--use`-aware invoker per package (BUG-APIGEN-009 / dod.11) and register
  // each resolved command on the adapter.
  const commands = buildCommandTable(input);
  const byPkg = new Map<string, CommandEntry[]>();
  for (const entry of commands.values()) {
    const list = byPkg.get(entry.pkgId);
    if (list) list.push(entry);
    else byPkg.set(entry.pkgId, [entry]);
  }
  for (const pkg of input.packages) {
    const entries = byPkg.get(pkg.id);
    if (!entries || entries.length === 0) continue;
    if (!pkg.fns) {
      throw new Error(`apigen-plugin-cli-output: package "${pkg.id}" has no functions`);
    }
    const pkgFns = pkg.fns;

    // `dispatchForPlan` dispatches by `plan.op.id` (and the validate-Layer
    // keys `schemas` by `call.operation.id`), so the package's fn-name-keyed
    // `fns`/`schemas` are remapped to be keyed by `plan.op.id` (matching the
    // fastify/express reference adapters) — for a synthesized fallback op
    // this is simply `fnName` itself (see `synthesizeOperation`).
    const schemasByOpId: ComposedSchemas = {};
    const fnsByOpId: Record<string, (...args: unknown[]) => unknown> = {};
    for (const entry of entries) {
      schemasByOpId[entry.plan.op.id] = entry.schema;
      fnsByOpId[entry.plan.op.id] = pkgFns[entry.fnName];
    }

    const invoke = createPackageInvoker(schemasByOpId, usePlugins);
    const invokeOpts: InvokeOptions = {
      fns: fnsByOpId,
      createClient: pkg.createClient,
      schemas: schemasByOpId,
    };

    for (const entry of entries) {
      adapter.registerRoute(entry.plan, (call) =>
        dispatchForPlan(entry.plan, invoke, call, invokeOpts)
      );
    }
  }

  // [fix:use-capability-explicit] (dod.11) — `--use` mount ops (e.g. `--use
  // health`) are now real, dispatchable CLI commands, flowing through the
  // SAME composed `--use` invoker as source ops ([fix:mount-through-layers]).
  const mountHost = input.packages[0]?.id ?? 'ts';
  const mountedOps = collectMountedCliOperations(
    usePlugins,
    useOptions,
    mountHost,
    input.operations ?? []
  );
  if (mountedOps.length > 0) {
    const mountInvoke = createPackageInvoker({}, usePlugins);
    const mountInvokeOpts: InvokeOptions = { fns: {}, schemas: {} };
    for (const mountedOp of mountedOps) {
      // F3 [fix:transport-stamping]: stamp 'cli' here — the mechanism
      // (`dispatchForPlan` reading `plan.transport` back) is generic; never a
      // hardcoded literal downstream.
      const plan = buildOpPlan({ op: mountedOp, transport: 'cli' });
      adapter.registerRoute(plan, (call) =>
        dispatchForPlan(plan, mountInvoke, call, mountInvokeOpts)
      );
    }
  }

  const routes = adapter.routeTable();

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(formatUsage(routes));
    return;
  }

  const match = matchCommand(argv, routes);
  if (!match) {
    // Distinct from a bad-flag `usageError` (invalid_argument, CLI_EXIT_CODE
    // 2) — an unrecognized command maps to `not_found` (CLI_EXIT_CODE 4),
    // mirroring the HTTP 404 an unknown route gets on the fastify/express
    // transports.
    reportFailure(
      new ApiError(
        'not_found',
        `Unknown command: ${argv.join(' ')}\n\n${formatUsage(routes)}`
      )
    );
    return;
  }
  const { entry: route, rest } = match;
  const { plan, dispatch } = route;
  const commandLabel = plan.cli.path.join(' ');

  if (rest.includes('--help') || rest.includes('-h')) {
    const text = paramsText(plan.params);
    console.log(`${commandLabel}${text ? `  { ${text} }` : ''}`);
    return;
  }

  const raw: CliRawCall = { rest };
  try {
    // [fix:streaming-wired]: CLI explicitly REJECTS a `streaming:true` op —
    // never silently `JSON.stringify`s an `AsyncIterable` into `{}`.
    if (plan.streaming) {
      throw new ApiError(
        'invalid_argument',
        `Command "${commandLabel}" is a streaming operation and is not supported over the cli transport (DEBT-APIGEN-SERVE-CORE-002 cli half).`
      );
    }

    // BUG-APIGEN-009: validate-Layer runs before the target function is ever
    // called — malformed input is rejected as ApiError{invalid_argument}.
    // [inv:dispatch-single-path]
    const call = await adapter.readCall(raw, plan);
    const start = Date.now();
    const result = await dispatch(call);
    await adapter.writeResult(raw, result, plan);
    logger.info({ command: commandLabel, ms: Date.now() - start }, `→ ${commandLabel}`);
  } catch (err) {
    logger.error({ command: commandLabel, err }, `✗ ${commandLabel}`);
    await adapter.writeError(raw, err, plan);
  }
}
