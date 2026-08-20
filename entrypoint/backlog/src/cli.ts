/**
 * cli.ts — apigen MOUNT wiring, THIRD transport (SPEC.md §7 / DESIGN.md §7's
 * pattern extended to `@adhd/apigen-plugin-cli-output`). Same architectural
 * rule as `server.ts`: NO `apigen generate`, no nx codegen executor, no
 * reimplemented argument-parsing/dispatch/exit-code surface — this file only
 * builds env → store → ctx, reuses `buildBacklogApigenPackage(ctx)`, and
 * hands the composed package + operations straight to the cli-output
 * plugin's `run()` (which owns command-table construction, flag parsing,
 * validation, dispatch, and `CLI_EXIT_CODE` mapping — see
 * `@adhd/apigen-plugin-cli-output`'s `run.ts`).
 *
 * `runBacklogCli` is deliberately symmetric with `startBacklogServer` in
 * shape (`buildBacklogEnv`/`openGraphBacklogStore`/`closeGraphBacklogStore`),
 * but diverges from it on purpose: the store is opened LAZILY, only if a
 * dispatched command actually reaches a real `client.ts` function
 * (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 — a bare `--help`/no-args/unknown-
 * command invocation used to open a real SQLite store, unconditionally,
 * before `argv` was ever inspected). `buildBacklogApigenPackage` accepts a
 * lazy `() => BacklogCtx` thunk for exactly this reason — see its own doc
 * comment.
 */
import type { Scope } from '@adhd/environment-base-spec';
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import { batchPlugin } from '@adhd/apigen-plugin-batch';
import type { Descriptor, Operation, Plugin } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { BacklogCtx } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStoreSafe, type GraphBacklogStore } from './store/graph-backlog-store.js';
import { installSignalCleanup } from './store/signal-cleanup.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import { buildBacklogApigenPackage, requireRun, testSilentLogger } from './server.js';
import { runInstallSkillCommand } from './install-skill.js';
import { runInstallCommand } from './install.js';
import { runServeCommand } from './serve.js';
import { readBacklogVersionInfo } from './version-info.js';
import { MIGRATION_PHASES, readBacklogMigrationStatus, setBacklogMigrationPhase } from './migration-phase.js';

/**
 * Derives the internal command-path PREFIX every `client.ts` operation
 * shares in `@adhd/apigen-plugin-cli-output`'s command table
 * (`buildCommandTable()`: `cliPath = project(op).cli.path`, and
 * `project()`'s `cli.path = [namespace, ...path].map(toKebab)` —
 * `@adhd/apigen-engine-naming`'s `naming.ts`).
 *
 * Currently simply `['backlog']`: `server.ts`'s `extractClientOperations()`
 * calls `extract({ …, dropFileSegment: true })`, so every `client.ts`
 * export's `path` is just `[exportSegment]` (no `client.d.ts`-derived
 * `'client-d'` segment — see that call site's doc comment for why it's safe
 * to drop here: one source file, no cross-file names to disambiguate), and
 * `project(op).cli.path` is `['backlog', '<kebab-export-name>']`.
 *
 * This is still derived from the live `operations` list rather than
 * hardcoded, on purpose: since every `client.ts` export shares the same
 * namespace + same source, every operation's `cli.path` differs ONLY in its
 * final (export) segment, so the shared prefix is simply "everything but the
 * last segment" of any one operation's projected `cli.path`. Computed fresh
 * on every call (never cached as a literal) so a future change to the
 * extraction call site (e.g. re-enabling the file segment, or adding a
 * second source file) can never silently desync this from the real command
 * table the way a hardcoded `['backlog']` constant would.
 */
export function resolveCommandPrefix(operations: readonly Operation[]): string[] {
  const first = operations.find((op) => op.kind === 'action');
  if (!first) {
    throw new Error(
      '@adhd/backlog: cli mount found zero "action" operations in client.ts — cannot derive a command prefix'
    );
  }
  return project(first).cli.path.slice(0, -1);
}

/**
 * The exact `--use` mount-plugin array `runBacklogCli` hands to
 * `cliPlugin.run()`'s `options.usePlugins` AND the array
 * {@link resolveMountNamespaces} derives reserved top-level segments from —
 * the SAME array reference, never two independently-written lists, so the
 * two can never drift apart (that drift is exactly what made the old
 * hand-maintained `MOUNT_COMMAND_NAMESPACES` constant go stale).
 */
export const USE_PLUGINS: readonly Plugin[] = [batchPlugin];

/**
 * Derives the set of top-level command segments reserved by every mount
 * plugin in `usePlugins`' own synthetic operations, registered SIBLING to
 * (never nested under) `backlog`'s own `['backlog', ...]` namespace.
 *
 * Previously this repo (BUG-BACKLOG-CLI-BATCH-PREFIX-CLOBBER-001) hand-
 * maintained a `MOUNT_COMMAND_NAMESPACES` constant with a doc comment
 * claiming a mount plugin's real synthetic namespace "can only be known by
 * actually invoking its `capabilities.mount.operations(descriptor, …)`, which
 * needs a real `Descriptor` this file does not have before dispatch" — that
 * claim was WRONG, verified by reading source rather than assumed:
 *
 *  1. `runBacklogCli` DOES have a real descriptor's ingredients at the exact
 *     point this is called — `operations` (from `buildBacklogApigenPackage`)
 *     is real, already-extracted `Operation[]`, and the host string is the
 *     same `pkg.id` (`'backlog'`) that
 *     `apigen-plugin-cli-output`'s `run()` itself uses for the identical
 *     purpose (`packages/apigen/apigen-plugin-cli-output/src/lib/run.ts`:
 *     `const mountHost = input.packages[0]?.id ?? 'ts';`).
 *  2. `batchPlugin.capabilities.mount.operations(descriptor, opts, hostBridge)`
 *     (`packages/apigen/apigen-plugin-batch/src/lib/plugin.ts`,
 *     `buildBatchOperations`) delegates to `buildBatchMountedOperations`
 *     (`packages/apigen/apigen-core-client/src/lib/batch.ts`) to compute
 *     every mounted operation's SHAPE — including `namespace`/`path`, since
 *     `MountedOperation extends Operation`
 *     (`apigen-core-client/src/lib/plugin.ts:422`) — and only uses
 *     `hostBridge` AFTERWARD, separately, to build each shape's `.handler`
 *     (`buildBatchHandler(shape.operationIds, hostBridge)`, same file). The
 *     handler closure simply captures `hostBridge` (including `undefined`)
 *     without dereferencing it — `buildBatchOperations`/`operations()` never
 *     throw when `hostBridge` is omitted; only actually CALLING the built
 *     handler with a missing bridge throws
 *     (`packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:148`,
 *     `if (!hostBridge) { throw … }` inside `buildBatchHandler`, never
 *     inside `operations()`). So calling `operations(descriptor, opts)` with
 *     `hostBridge` omitted is safe for path-derivation purposes: the
 *     returned ops' handlers would be broken if invoked, but this function
 *     never invokes them, only reads `.namespace`/`.path`.
 *  3. `buildBatchMountedOperations` (`apigen-core-client/src/lib/batch.ts`)
 *     is cheap — it groups already-extracted `descriptor.operations` by kind
 *     and derives JSON-Schema fragments from them; it does no ts-morph
 *     parsing or schema generation of its own, so calling it once per CLI
 *     invocation (in addition to the identical call `run()` itself makes
 *     later) has no measurable cost.
 *
 * So this is derived dynamically instead: for each plugin in `usePlugins`
 * exposing a `mount` capability, call `capabilities.mount.operations(...)`
 * (no `hostBridge`) and project each returned op's real CLI top-level
 * segment via `@adhd/apigen-engine-naming`'s `project(op).cli.path[0]` — the
 * SAME derivation `resolveCommandPrefix` above uses for `backlog`'s own
 * prefix. Adding a future mount plugin to {@link USE_PLUGINS} now
 * automatically and correctly extends the reserved set with zero separate
 * bookkeeping — it can never again silently go stale the way the old
 * hardcoded set did the moment a second mount plugin was added without
 * remembering to update it too.
 */
export function resolveMountNamespaces(
  usePlugins: readonly Plugin[],
  operations: readonly Operation[],
  host: string
): Set<string> {
  const descriptor: Descriptor = { host, operations: operations as Operation[] };
  const namespaces = new Set<string>();
  for (const plugin of usePlugins) {
    const mount = plugin.capabilities.mount;
    if (!mount) continue;
    const mountedOps = mount.operations(descriptor, undefined, undefined);
    for (const op of mountedOps) {
      const [first] = project(op).cli.path;
      if (first !== undefined) namespaces.add(first);
    }
  }
  return namespaces;
}

/**
 * Prepends `prefix` (the real, namespace-qualified command path segments
 * every `client.ts` export shares — see {@link resolveCommandPrefix}) to a
 * user-typed argv, so `backlog get-item --repo … --human-id …` (what a
 * consumer actually types — the bin's own name is never part of `argv`)
 * resolves against the cli-output plugin's command table, which is keyed by
 * the FULL internal path (`['backlog', 'get-item']`).
 *
 * Idempotent / defensive:
 *  - Empty argv is returned unchanged — `run()` treats `argv.length === 0`
 *    as the usage listing regardless of any prefix.
 *  - Argv already starting with the full `prefix` (in order) is returned
 *    unchanged — never double-prefixed.
 *  - A leading flag (`--help`, `-h`, or any other top-level `-`-prefixed
 *    token) is returned unchanged — `run()` special-cases `--help`/`-h`
 *    BEFORE ever consulting the command table
 *    (`if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h')`),
 *    so prefixing here would shadow that check and break `backlog --help`.
 *  - Argv whose first token is a reserved mount-namespace segment (per
 *    {@link resolveMountNamespaces}'s dynamically-derived set — currently
 *    just `batch`, from {@link USE_PLUGINS}) is returned unchanged — that
 *    command is registered at the CLI's top level by a mount plugin, never
 *    under `backlog`'s own namespace; prefixing it would make it
 *    unresolvable.
 *
 * `reservedNamespaces` has no default — the real call site
 * (`runBacklogCli`) always passes a freshly-derived
 * `resolveMountNamespaces(...)` result; the caller must supply one
 * explicitly (an empty `Set` for a caller with no mount plugins) so this
 * can never silently fall back to a stale hardcoded default.
 */
export function prefixCommand(
  userArgv: readonly string[],
  prefix: readonly string[],
  reservedNamespaces: ReadonlySet<string>
): string[] {
  if (userArgv.length === 0) return [...userArgv];
  if (userArgv[0]?.startsWith('-')) return [...userArgv];
  if (userArgv[0] !== undefined && reservedNamespaces.has(userArgv[0])) return [...userArgv];
  const alreadyPrefixed = prefix.length > 0 && prefix.every((seg, i) => userArgv[i] === seg);
  if (alreadyPrefixed) return [...userArgv];
  return [...prefix, ...userArgv];
}

export interface RunBacklogCliOpts {
  scope?: Scope;
  /** Test-only override — see `buildBacklogEnv`'s `BuildBacklogEnvOptions`. */
  adhdRoot?: string;
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * The one migration-phase command that takes a flag: `set-migration-phase`'s
 * `phase` is a required domain param, so its flags list is exactly `--phase`
 * (a `migration-status` invocation with any flag is an error — zero legal
 * flags). Hardcoded here because these commands never reach the apigen
 * command table (see the short-circuit in {@link runBacklogCli}), where the
 * flag table would otherwise come from the extracted schema.
 */
const SET_MIGRATION_PHASE_FLAG = 'phase' as const;

/**
 * Store-free dispatch for `migration-status`/`set-migration-phase`
 * (DEBT-BACKLOG-CLI-STORE-OPEN-001). Both commands only read/write the
 * `migration.phase` config cascade, so this never calls `getCtx()` or opens
 * the SQLite store — `migration-status` reports
 * `env.config.migration.phase` via `readBacklogMigrationStatus()`,
 * `set-migration-phase` persists through `setBacklogMigrationPhase()` →
 * `migration-admin.ts`'s `writeMigrationPhase`. Argv parsing + error/exit
 * semantics deliberately mirror `@adhd/apigen-plugin-cli-output`'s
 * `parseArgs`/validate-Layer byte-for-byte, so the short-circuit accepts and
 * rejects EXACTLY what the apigen dispatch would:
 *
 *  - `--phase <value>` and `--phase=<value>` both parse (BUG-APIGEN-031
 *    parity); any other flag → `Unknown option: --X. Available: --phase`;
 *    a non-flag token → `Unexpected positional argument: "X"`; a missing
 *    `--phase` value → `Missing value for --phase`; a missing flag →
 *    validate-Layer's "required property 'phase'" message; a non-enum value
 *    → validate-Layer's "must be equal to one of the allowed values"
 *    message. All failures print `{"code":"invalid_argument","message":…}`
 *    as the last stderr line and set `process.exitCode = 2`
 *    (`CLI_EXIT_CODE['invalid_argument']` in `@adhd/apigen-base-errors`).
 *  - `--help`/`-h` anywhere in the rest prints the same usage line the
 *    apigen path renders from `paramsText` (exit 0), with the flag list
 *    (`{ phase: enum }` — the extracted schema's type text) for the
 *    flag-taking command.
 *
 * Success prints the identical `console.log(JSON.stringify(...))` shape the
 * apigen path's `writeResult` emits (BUG-APIGEN-015 parity); the returned
 * `SetMigrationPhaseResult` spreads `configPath` FIRST to match the
 * schema-order re-serialization the apigen dispatch applies (see
 * `setBacklogMigrationPhase`'s own doc comment in `migration-phase.ts`).
 */
function runMigrationPhaseCommand(
  command: 'migration-status' | 'set-migration-phase',
  rest: readonly string[],
  opts: RunBacklogCliOpts
): void {
  const fail = (message: string): void => {
    console.error(JSON.stringify({ code: 'invalid_argument', message }));
    process.exitCode = 2;
  };

  // `rest.includes('--help')` mirrors cli-output's own pre-dispatch check —
  // a `--help` anywhere after the command shows usage, never an error.
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(
      command === 'set-migration-phase'
        ? `backlog ${command}  { ${SET_MIGRATION_PHASE_FLAG}: enum }`
        : `backlog ${command}`
    );
    return;
  }

  // `buildBacklogEnv` is pure path/config resolution — no fs writes, no
  // store — so constructing it here is the store-free env the two commands
  // need (the `getCtx()` thunk the apigen path would otherwise invoke also
  // calls `ensureDirs()`/`openGraphBacklogStore`, which is exactly what
  // must NOT happen for these two commands).
  const env = buildBacklogEnv({ scope: opts.scope, adhdRoot: opts.adhdRoot, cwd: opts.cwd });

  if (command === 'migration-status') {
    if (rest.length > 0) {
      const token = rest[0] as string;
      fail(
        token.startsWith('--')
          ? `Unknown option: ${token}. Available: ` // migration-status has zero legal flags (empty list, like parseArgs renders)
          : `Unexpected positional argument: "${token}"`
      );
      return;
    }
    console.log(JSON.stringify(readBacklogMigrationStatus(env)));
    return;
  }

  // set-migration-phase: walk the tokens exactly like parseArgs walks argv
  // against a one-flag table (`--phase`), including the `--phase=value`
  // inline form.
  let phaseValue: string | undefined;
  let i = 0;
  while (i < rest.length) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      fail(`Unexpected positional argument: "${token}"`);
      return;
    }
    let name = token.slice(2);
    let inlineValue: string | undefined;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name !== SET_MIGRATION_PHASE_FLAG) {
      fail(`Unknown option: --${name}. Available: --${SET_MIGRATION_PHASE_FLAG}`);
      return;
    }
    i += 1;
    if (inlineValue !== undefined) {
      phaseValue = inlineValue;
    } else {
      if (i >= rest.length) {
        fail(`Missing value for --${SET_MIGRATION_PHASE_FLAG}`);
        return;
      }
      phaseValue = rest[i] as string;
      i += 1;
    }
  }
  if (phaseValue === undefined) {
    // validate-Layer's missing-required message, verbatim.
    fail(`Validation failed: /data must have required property 'phase' — Example: {"data":{"phase":"not-started"}}`);
    return;
  }
  if (!MIGRATION_PHASES.includes(phaseValue as (typeof MIGRATION_PHASES)[number])) {
    // validate-Layer's enum message, verbatim.
    fail(`Validation failed: /data/phase must be equal to one of the allowed values — Example: {"data":{"phase":"not-started"}}`);
    return;
  }
  console.log(JSON.stringify(setBacklogMigrationPhase(env, phaseValue as (typeof MIGRATION_PHASES)[number])));
}

/**
 * Opens (or reuses) the backlog store + env, then dispatches EXACTLY ONE CLI
 * command live through `@adhd/apigen-plugin-cli-output`'s `run()` — no code
 * generation, no bespoke argument parsing. Mirrors `startBacklogServer`'s
 * env→store→ctx→`buildBacklogApigenPackage` setup precisely; the only
 * divergence is transport-specific: `cliPlugin.run()` is one-shot (it
 * resolves after dispatching a single command rather than listening), so
 * there is no `Promise.all` of long-lived transports to await here.
 *
 * @param argv Command + flags, WITHOUT the `backlog` bin name (e.g.
 *   `['get-item', '--repo', 'org/repo', '--human-id', 'BUG-1']`). Defaults
 *   to `process.argv.slice(2)` — the real CLI invocation's own argv — when
 *   omitted, matching `cliPlugin.run()`'s own `resolveArgv()` fallback
 *   convention.
 */
export async function runBacklogCli(argv?: string[], opts: RunBacklogCliOpts = {}): Promise<void> {
  const userArgvEarly = argv ?? process.argv.slice(2);
  // BUG-BACKLOG-001: `install-skill`/`install`/`serve` are intercepted below,
  // BEFORE the apigen package/command table is built, so `cliPlugin.run()`'s
  // own `--help`/`-h` rendering (and the identical no-args listing) can never
  // show them. Surface them explicitly here — this branch runs only for
  // help/no-args, opens no store (see DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001),
  // and falls through to the apigen program for the full command listing.
  const helpRequested =
    userArgvEarly.length === 0 || userArgvEarly[0] === '--help' || userArgvEarly[0] === '-h';
  if (helpRequested) {
    console.log('Special commands (handled before the apigen command table):');
    console.log('  install-skill [options]  Install the backlog skill for a host (alias: install)');
    console.log('  serve [options]          Start the long-lived HTTP/MCP server (--transport http|mcp|both)');
    console.log('');
  }
  // `install-skill` (MIGRATION.md §4.2) is a PURE filesystem operation — copy
  // the packaged `skill/SKILL.md` to a per-host path — not an apigen-
  // dispatched `client.ts` export (it needs no store/ctx at all), so it is
  // special-cased here, before ever building the apigen package/command
  // table, exactly the way `cliPlugin.run()` itself special-cases `--help`/
  // `-h` before consulting its own route table.
  if (userArgvEarly[0] === 'install-skill') {
    await runInstallSkillCommand(userArgvEarly.slice(1));
    return;
  }
  // `install` (BUG-013 feature half) is the richer successor to
  // `install-skill` above: same "pure filesystem/config operation, no
  // store/ctx" shape, so it is special-cased identically, before ever
  // building the apigen package/command table. By default it installs BOTH
  // the skill AND registers the `backlog` MCP server into the requested
  // host config(s) — see `install.ts`'s own doc comment.
  if (userArgvEarly[0] === 'install') {
    await runInstallCommand(userArgvEarly.slice(1));
    return;
  }
  // `serve` (MIGRATION.md §4.5) starts the long-lived HTTP/MCP listener
  // (`startBacklogServer`) — a different lifecycle shape than every other
  // one-shot `client.ts` op (dispatch, print one JSON result, exit), so it
  // is special-cased the same way `install-skill` is, before ever building
  // the one-shot apigen CLI-output package.
  if (userArgvEarly[0] === 'serve') {
    await runServeCommand(userArgvEarly.slice(1), opts);
    return;
  }
  // `version` (client.ts §5.7) reads this package's own `package.json` — it
  // never touches the graph store. But it is a `hasCtx` action (its signature
  // carries `ctx` for the `ctx-name-only` invariant), so dispatching it
  // through the apigen command table would call `createClient` → `getCtx()`
  // and open the real SQLite store for no reason
  // (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 — the exact store-open telemetry
  // this fix eliminates). Short-circuit it here, before the apigen
  // package/command table is built, using the SAME store-free reading path
  // `client.ts`'s own `version()` delegates to (`version-info.ts`), and print
  // the identical `console.log(JSON.stringify(...))` JSON shape every other
  // CLI command emits (BUG-APIGEN-015 parity).
  if (userArgvEarly[0] === 'version') {
    console.log(JSON.stringify(readBacklogVersionInfo()));
    return;
  }
  // `migration-status`/`set-migration-phase` (client.ts §5.6) read/write the
  // `migration.phase` config cascade — `migration-status` reads
  // `env.config.migration.phase`, `set-migration-phase` persists through
  // `migration-admin.ts`'s `writeMigrationPhase` — neither ever touches the
  // graph store. But both are `hasCtx` client.ts actions (their signatures
  // carry `ctx` for the `ctx-name-only` invariant), so dispatching them
  // through the apigen command table would call `createClient` → `getCtx()`
  // and open the real SQLite store for no reason
  // (DEBT-BACKLOG-CLI-STORE-OPEN-001 — the exact store-open telemetry this
  // fix eliminates). Short-circuit them here, before the apigen
  // package/command table is built, using the SAME store-free paths
  // `client.ts`'s own exports delegate to (`migration-phase.ts`), and print
  // the identical `console.log(JSON.stringify(...))` JSON shape every other
  // CLI command emits (BUG-APIGEN-015 parity).
  if (userArgvEarly[0] === 'migration-status' || userArgvEarly[0] === 'set-migration-phase') {
    runMigrationPhaseCommand(userArgvEarly[0], userArgvEarly.slice(1), opts);
    return;
  }

  // Opened lazily, at most once, only if `getCtx()` is actually invoked (a
  // dispatched command reaching a real function) — never for `--help`,
  // no-args, an unknown command, or a bad-flag rejection, all of which `run()`
  // resolves entirely from the static `operations`/`schemas` below.
  let opened: { store: GraphBacklogStore; ctx: BacklogCtx } | undefined;
  const getCtx = async (): Promise<BacklogCtx> => {
    if (!opened) {
      const env = buildBacklogEnv({ scope: opts.scope, adhdRoot: opts.adhdRoot, cwd: opts.cwd });
      env.ensureDirs();
      // BUG-002: open through `resolveBacklogDbPath` so ADHD_BACKLOG_DATABASE_PATH
      // (→ config.db.path) actually redirects the store; `env.files.db` is only
      // the fallback.
      const store = await openGraphBacklogStore(resolveBacklogDbPath(env), env.config.db.busyTimeoutMs);
      opened = { store, ctx: { store, env } };
    }
    return opened.ctx;
  };

  // `closeStoreOnce` memoizes the actual close so the signal handler (which
  // may fire concurrently with, or just before, the normal-path `finally`
  // below) and the normal-path `finally` can both unconditionally call it
  // without racing a double `adapter.close()` — the SECOND caller just
  // awaits the SAME in-flight/settled promise the first one kicked off.
  let closePromise: Promise<void> | undefined;
  const closeStoreOnce = (): Promise<void> => {
    if (!closePromise) closePromise = closeGraphBacklogStoreSafe(opened?.store);
    return closePromise;
  };

  // BUG-BACKLOG-NO-SIGNAL-HANDLERS-001: installed BEFORE the store open even
  // starts (`getCtx()`'s `openGraphBacklogStore` await is entirely inside
  // `buildBacklogApigenPackage`/`requireRun` below), covering the whole
  // async window a Ctrl-C/SIGTERM could otherwise land in with zero handler
  // registered — see signal-cleanup.ts's doc comment for the full rationale
  // and its stated (SIGKILL/native-panic) limit. `cleanup` reads `opened` by
  // closure at signal time, not at install time, so it correctly sees
  // whichever store (if any) had actually finished opening by then.
  const signalCleanup = installSignalCleanup(closeStoreOnce);

  try {
    const { pkg, operations } = await buildBacklogApigenPackage(getCtx);
    const userArgv = userArgvEarly;
    const prefix = resolveCommandPrefix(operations);
    // Derived from the SAME `USE_PLUGINS` array passed to `options.usePlugins`
    // below — see {@link resolveMountNamespaces}'s doc comment — never a
    // separately hand-maintained list.
    const reservedNamespaces = resolveMountNamespaces(USE_PLUGINS, operations, pkg.id);

    await requireRun(cliPlugin)({
      packages: [pkg],
      operations,
      outputDir: '',
      // `usePlugins: USE_PLUGINS` mirrors `server.ts`'s MCP-transport wiring
      // exactly (both are single-transport mounts with no separate "openapi"
      // concept the way HTTP's `usePlugins: [openapiPlugin, batchPlugin]`
      // has) — without this the `_batch/<kind>` synthetic mount
      // (`@adhd/apigen-plugin-batch`) is reachable over HTTP/MCP but not the
      // CLI, since `@adhd/apigen-plugin-cli-output`'s `run()` only mounts
      // plugins it's explicitly handed via `readUsePlugins(input.options)`.
      options: { argv: prefixCommand(userArgv, prefix, reservedNamespaces), usePlugins: [...USE_PLUGINS] },
      signal: opts.signal ?? new AbortController().signal,
      logger: testSilentLogger(),
    });
  } finally {
    // Normal-path completion: dispose the signal handler FIRST so a signal
    // arriving after this point (once we're already closing/closed) is not
    // double-handled, then close through the same memoized lease-release path.
    signalCleanup.dispose();
    await closeStoreOnce();
  }
}
