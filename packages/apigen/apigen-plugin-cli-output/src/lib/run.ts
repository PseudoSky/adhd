import type {
  RunInput,
  Operation,
  ComposedSchemas,
} from '@adhd/apigen-core-client';
import {
  createInvoker,
  makeValidateLayer,
  createLogger,
  describeParams,
  needsEnvelopeField,
  LayerContext,
} from '@adhd/apigen-engine-runtime';
import type { Call as RuntimeCall, Logger } from '@adhd/apigen-engine-runtime';
import { project } from '@adhd/apigen-engine-naming';
import { ApiError, isApiError, CLI_EXIT_CODE } from '@adhd/apigen-base-errors';
import {
  envelopeBindings,
  isJsonTypedProp,
  isBooleanTypedProp,
  dataSchemaProps,
  kebabCase,
} from './schema-introspect';

// ---------------------------------------------------------------------------
// run() — execute the CLI plugin's surface LIVE, in-process, one shot.
//
// Mirrors `apigen-plugin-mcp`/`apigen-plugin-api-fastify`'s `run.ts`: read
// `input.packages[].{fns,schemas}`, compose the validate-Layer around
// `dispatch` via `createInvoker`, resolve one call, print the JSON result.
// Unlike a server transport, a CLI invocation is one-shot — it dispatches
// exactly one command then resolves; it does not wait on `input.signal`
// (there is no long-lived listener to tear down), though an
// *already*-aborted signal is honored as a no-op (BUG-APIGEN-CLI-RUN: a
// caller that races an abort against `run()` should not have a stray command
// execute after cancellation was requested).
// ---------------------------------------------------------------------------

/** One resolvable CLI command: a package's function reached under a nested kebab path. */
interface CommandEntry {
  pkgId: string;
  fnName: string;
  schema: ComposedSchemas[string];
  /** Ordered kebab command segments, e.g. `['backlog', 'get-item']` (SPEC §5 `project().cli.path`). */
  cliPath: string[];
}

/**
 * A single known `--flag` for one command, resolved ahead of parsing so the
 * argv walker never has to guess whether a bare `--foo` is boolean or
 * value-taking (SPEC §9.1 / generated-CLI parity — see generate.ts).
 */
interface FlagSpec {
  /** The domain param name or envelope field name in camelCase. */
  camelKey: string;
  kind: 'domain' | 'envelope';
  valueKind: 'boolean' | 'json' | 'string';
  /** (envelope only) APIGEN_<PLUGINID>_<FIELD> fallback when the flag is absent. */
  envVar?: string;
}

// ---------------------------------------------------------------------------
// argv resolution
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
 * Builds the routing table for every dispatchable function across every
 * package. Prefers the naming authority's `project(op).cli.path` (nested
 * kebab segments, namespace-qualified — SPEC §5) whenever a matching
 * {@link Operation} is available; falls back to the bare function name when
 * `input.operations` doesn't carry a matching entry (e.g. a unit test that
 * constructs `RunInput` directly without extraction, or any future non-TS
 * run path — see `RunInput.operations`'s doc comment).
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
      const op = opsByKey.get(`${pkg.id}:${fnName}`);
      const cliPath = op ? project(op).cli.path : [fnName];
      commands.set(cliPath.join(' '), {
        pkgId: pkg.id,
        fnName,
        schema,
        cliPath,
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
 */
export function matchCommand(
  argv: string[],
  commands: Map<string, CommandEntry>
): { entry: CommandEntry; rest: string[] } | null {
  let end = 0;
  while (end < argv.length && !argv[end].startsWith('-')) end++;
  for (let len = end; len >= 1; len--) {
    const entry = commands.get(argv.slice(0, len).join(' '));
    if (entry) return { entry, rest: argv.slice(len) };
  }
  return null;
}

/** Human-readable command listing, derived from the live command table (never hardcoded). */
export function formatUsage(commands: Map<string, CommandEntry>): string {
  const lines = ['Available commands:', ''];
  const sorted = [...commands.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, entry] of sorted) {
    const { text } = describeParams(entry.schema);
    lines.push(`  ${key}${text ? `  { ${text} }` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Flag table + argv → {data:{...}} / envelope mapping (generated-CLI parity)
// ---------------------------------------------------------------------------

/**
 * Builds the known `--flag` table for one command's schema: domain params
 * (kebab-cased) plus §9.1 envelope bindings, exactly the same flag-naming
 * rules `generate.ts` bakes into the emitted Commander program (via the
 * shared `./schema-introspect` helpers) — so a live `run()` invocation and
 * the equivalent generated CLI accept identical flags for identical schemas.
 *
 * Deliberately does NOT enforce "required" here — that's the validate-Layer's
 * job (SPEC §6), run **after** this table only decides flag *shape* (boolean
 * vs value vs JSON), so malformed/missing input is rejected by the single
 * canonical validation path instead of a bespoke CLI-only check.
 */
export function buildFlagTable(schema: ComposedSchemas[string]): Map<string, FlagSpec> {
  const flags = new Map<string, FlagSpec>();
  const { props } = dataSchemaProps(schema);
  for (const param of Object.keys(props)) {
    const prop = props[param];
    let valueKind: FlagSpec['valueKind'] = 'string';
    if (isBooleanTypedProp(prop)) valueKind = 'boolean';
    else if (isJsonTypedProp(prop)) valueKind = 'json';
    flags.set(kebabCase(param), { camelKey: param, kind: 'domain', valueKind });
  }

  const bindings = envelopeBindings(schema as Record<string, unknown>);
  for (const b of bindings) {
    const flagName = b.flag.replace(/^--/, '');
    flags.set(flagName, {
      camelKey: b.field,
      kind: 'envelope',
      valueKind: 'string',
      envVar: b.envVar,
    });
  }
  // Legacy backwards-compat path (generate.ts parity): a 'session' envelope
  // field with no explicit x-apigen-envelope binding still gets a plain
  // `--session` flag (no env-var fallback — that's the §9.1 binding's job).
  if (needsEnvelopeField(schema, 'session') && !bindings.some((b) => b.field === 'session')) {
    flags.set('session', { camelKey: 'session', kind: 'envelope', valueKind: 'string' });
  }
  return flags;
}

/** Thrown by {@link parseArgs} for any argv shape the flag table can't explain. */
function usageError(message: string): ApiError {
  return new ApiError('invalid_argument', message);
}

/**
 * Parses the flags following a matched command into `{ domainArgs, envelope }`
 * — the same split `dispatch()` expects. Supports `--flag value`,
 * `--flag=value`, bare boolean `--flag`, and `--no-flag` negation for any
 * boolean-typed flag (domain or envelope). Array/object-typed domain params
 * are JSON.parse'd from their raw string value (BUG-APIGEN-031 parity — see
 * `./schema-introspect`'s `isJsonTypedProp` doc comment).
 */
export function parseArgs(
  rest: string[],
  flags: Map<string, FlagSpec>
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

  const commands = buildCommandTable(input);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(formatUsage(commands));
    return;
  }

  const match = matchCommand(argv, commands);
  if (!match) {
    // Distinct from a bad-flag `usageError` (invalid_argument, CLI_EXIT_CODE
    // 2) — an unrecognized command maps to `not_found` (CLI_EXIT_CODE 4),
    // mirroring the HTTP 404 an unknown route gets on the fastify/express
    // transports.
    reportFailure(
      new ApiError(
        'not_found',
        `Unknown command: ${argv.join(' ')}\n\n${formatUsage(commands)}`
      )
    );
    return;
  }
  const { entry, rest } = match;

  if (rest.includes('--help') || rest.includes('-h')) {
    const { text } = describeParams(entry.schema);
    console.log(`${entry.cliPath.join(' ')}${text ? `  { ${text} }` : ''}`);
    return;
  }

  try {
    const pkg = input.packages.find((p) => p.id === entry.pkgId);
    if (!pkg) {
      throw new Error(`apigen-plugin-cli-output: package "${entry.pkgId}" not found`);
    }
    if (!pkg.fns) {
      throw new Error(`apigen-plugin-cli-output: package "${entry.pkgId}" has no functions`);
    }

    const flags = buildFlagTable(entry.schema);
    const { domainArgs, envelope } = parseArgs(rest, flags);

    // BUG-APIGEN-009: validate-Layer is innermost (the only Layer here), so
    // malformed input is rejected — as ApiError{invalid_argument} — before
    // the target function is ever called. [inv:dispatch-single-path]
    const invoke = createInvoker([makeValidateLayer(pkg.schemas)]);
    const call: RuntimeCall = {
      operation: { id: entry.fnName },
      ctx: new LayerContext(),
      envelope,
      domainArgs,
      signal: input.signal,
    };

    const start = Date.now();
    const result = await invoke(entry.fnName, call, {
      fns: pkg.fns,
      createClient: pkg.createClient,
      schemas: pkg.schemas,
    });
    logger.info(
      { command: entry.cliPath.join(' '), ms: Date.now() - start },
      `→ ${entry.cliPath.join(' ')}`
    );
    // `undefined` (a void op) becomes `null` — canonical JSON, never the bare
    // word `undefined` (which is not valid JSON output on a wire).
    console.log(JSON.stringify(result === undefined ? null : result));
  } catch (err) {
    logger.error({ command: entry.cliPath.join(' '), err }, `✗ ${entry.cliPath.join(' ')}`);
    reportFailure(err);
  }
}
