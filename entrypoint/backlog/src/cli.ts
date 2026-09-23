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
 * command invocation opened a real store through the adapter, unconditionally,
 * before `argv` was ever inspected). `buildBacklogApigenPackage` accepts a
 * lazy `() => BacklogCtx` thunk for exactly this reason — see its own doc
 * comment.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { Scope } from '@adhd/environment-base-spec';
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import { batchPlugin } from '@adhd/apigen-plugin-batch';
import type { Descriptor, Operation, Plugin } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { BacklogCtx } from './api.js';
import {
  openGraphBacklogStore,
  closeGraphBacklogStoreSafe,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';
import { installSignalCleanup } from './store/signal-cleanup.js';
import {
  buildBacklogEnv,
  resolveBacklogDbPath,
  backlogEnvironmentSpec,
} from './env.js';
import {
  buildBacklogApigenPackage,
  requireRun,
  testSilentLogger,
} from './server.js';
import { runInstallSkillCommand } from './install-skill.js';
import { runInstallCommand } from './install.js';
import { runServeCommand } from './serve.js';
import { readBacklogVersionInfo } from './version-info.js';
import { errorEnvelope, exitCodeForEnvelope, isOutcomeEnvelope } from './envelope.js';
import { buildSearchArgv } from './search-shortcut.js';
import { suggestClosestCatalogNames } from './query/resolve.js';
import {
  inspectStoreVocabulary,
  RECOGNIZED_NODE_KINDS,
  StoreVocabularyMismatchError,
} from './store/vocabulary-guard.js';

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
export function resolveCommandPrefix(
  operations: readonly Operation[]
): string[] {
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
  const descriptor: Descriptor = {
    host,
    operations: operations as Operation[],
  };
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
 * every `api.ts` export shares — see {@link resolveCommandPrefix}) to a
 * user-typed argv, so `backlog get --input '{"uid":"…"}'` (what a consumer
 * actually types — the bin's own name is never part of `argv`) resolves
 * against the cli-output plugin's command table, which is keyed by the FULL
 * internal path (`['backlog', 'get']`).
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
  if (userArgv[0] !== undefined && reservedNamespaces.has(userArgv[0]))
    return [...userArgv];
  const alreadyPrefixed =
    prefix.length > 0 && prefix.every((seg, i) => userArgv[i] === seg);
  if (alreadyPrefixed) return [...userArgv];
  return [...prefix, ...userArgv];
}

export interface RunBacklogCliOpts {
  scope?: Scope;
  /** Test-only override — see `buildBacklogEnv`'s `BuildBacklogEnvOptions`. */
  adhdRoot?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Explicit-parameter-first namespace override — see
   *  `BuildBacklogEnvOptions.namespace`'s doc comment and `--namespace`
   *  (SPEC.md §5c). A parsed `--namespace <value>` (or a programmatic
   *  caller's `optsIn.namespace`) sets this directly; a programmatic caller
   *  may also pass it without going through argv at all. */
  namespace?: string;
}

/**
 * backlog CLI had no isolation mode at all originally, so trying a
 * destructive or unfamiliar command meant either risking the real graph or
 * hand-rolling env-var isolation (`ADHD_BACKLOG_SCOPE`/`ADHD_ROOT`) from
 * scratch. `--namespace <value>` (SPEC.md §5c), recognized ANYWHERE in argv
 * (like `--help`), strips itself out and validates against
 * `backlogEnvironmentSpec.namespaces` (`'production'` | `'test'` |
 * `'sandbox'`). Omitted ⇒ `'production'` (D2) — no behavior change for the
 * overwhelmingly common case.
 *
 * `--namespace sandbox` additionally layers ephemeral-root-minting on top of
 * namespace selection (D5): it points the SAME `adhdRoot` test-isolation
 * knob `BuildBacklogEnvOptions` already exposes (previously test-only —
 * `cli.spec.ts`'s `runBin` is the proof this mechanism genuinely isolates)
 * at a freshly created, per-invocation temp directory: `backlog --namespace
 * sandbox create …` writes into a throwaway store, never the real one, and
 * prints exactly where so a caller can inspect or clean it up. It is NOT
 * auto-deleted — a caller may want to re-run further commands against the
 * SAME sandbox by passing `ADHD_ROOT=<printed path>` explicitly on a later
 * invocation; deleting it behind the caller's back the moment this process
 * exits would defeat that.
 */
// Exported (BUG-BACKLOG-SANDBOX-TELEMETRY-001) so `index.ts`'s bin-entry
// guard can detect `--namespace sandbox` BEFORE its own `initTelemetry(...)`
// call — which happens before `runBacklogCli` is ever invoked — and redirect
// the telemetry file sink away from the real production `~/.adhd` tree too.
// See that call site's own comment for the full rationale.
export function stripNamespaceFlag(argv: readonly string[]): {
  argv: string[];
  namespace: string | undefined;
  /** `true` iff `--namespace`/`--namespace=` was present but supplied no
   *  value (bare trailing flag, or `--namespace=` with nothing after `=`) —
   *  distinct from "flag absent" so the caller can reject it (D3) instead of
   *  silently falling through to the default. */
  missingValue: boolean;
  /** `true` iff `--namespace`/`--namespace=` appeared MORE THAN ONCE with
   *  two DIFFERING values. Every occurrence is always stripped from the
   *  returned `argv` regardless of count. Two occurrences with the SAME
   *  value are not a conflict (idempotent). */
  conflicting: boolean;
} {
  const values: string[] = [];
  const rest: string[] = [];
  let missingValue = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--namespace=')) {
      const value = arg.slice('--namespace='.length);
      if (value === '') missingValue = true;
      else values.push(value);
      continue;
    }
    if (arg === '--namespace') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        missingValue = true;
      } else {
        values.push(next);
        i++; // consume the value token too
      }
      continue;
    }
    rest.push(arg);
  }
  const distinct = new Set(values);
  return {
    argv: rest,
    namespace: values[values.length - 1],
    missingValue,
    conflicting: distinct.size > 1,
  };
}

export async function runBacklogCli(
  argvIn?: string[],
  optsIn: RunBacklogCliOpts = {}
): Promise<void> {
  const {
    argv: userArgvEarly,
    namespace: parsedNamespace,
    missingValue,
    conflicting,
  } = stripNamespaceFlag(argvIn ?? process.argv.slice(2));
  const opts: RunBacklogCliOpts = { ...optsIn };

  // D1/D3: reject a malformed `--namespace` BEFORE doing anything else with
  // it — never silently fall through to `buildBacklogEnv`'s own default (an
  // explicit-but-broken ask silently ignored), and never let an unvalidated
  // string reach `EnvironmentOptions.namespace` (an ungoverned root segment).
  if (missingValue) {
    const env = errorEnvelope(
      'invalid_argument',
      'Invalid argument "namespace": a value is required (e.g. --namespace production)'
    );
    console.log(JSON.stringify(env));
    process.exitCode = exitCodeForEnvelope(env);
    return;
  }
  if (conflicting) {
    // Recompute the distinct values purely for the message — stripNamespaceFlag
    // already stripped every occurrence from userArgvEarly regardless of this.
    const raw = argvIn ?? process.argv.slice(2);
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const arg = raw[i];
      if (arg === undefined) continue;
      if (arg.startsWith('--namespace=')) seen.add(arg.slice('--namespace='.length));
      else if (arg === '--namespace' && raw[i + 1] !== undefined)
        seen.add(raw[i + 1] as string);
    }
    const env = errorEnvelope(
      'invalid_argument',
      `Invalid argument "namespace": conflicting values ${[...seen]
        .map((v) => `"${v}"`)
        .join(', ')}`
    );
    console.log(JSON.stringify(env));
    process.exitCode = exitCodeForEnvelope(env);
    return;
  }
  if (
    parsedNamespace !== undefined &&
    !backlogEnvironmentSpec.namespaces?.includes(parsedNamespace)
  ) {
    const valid = backlogEnvironmentSpec.namespaces ?? [];
    const suggestions = suggestClosestCatalogNames(parsedNamespace, valid);
    const detail =
      `must be one of ${valid.map((v) => `"${v}"`).join(', ')}` +
      (suggestions.length > 0
        ? ` (did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?)`
        : '');
    const env = errorEnvelope(
      'invalid_argument',
      `Invalid argument "namespace": ${detail}`
    );
    console.log(JSON.stringify(env));
    process.exitCode = exitCodeForEnvelope(env);
    return;
  }
  if (parsedNamespace !== undefined) opts.namespace = parsedNamespace;
  const namespace = opts.namespace ?? 'production';

  // BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001: the very message printed two
  // lines below has always told the caller to "pass ADHD_ROOT=<path> to
  // reuse it" — but nothing in this codebase ever read `process.env['ADHD_ROOT']`
  // (confirmed via `rg -n "ADHD_ROOT" --type ts -g '!*.spec.ts'`: every hit
  // was this file's own comments/console.error string, never a read). A
  // caller following that printed instruction got silently ignored and a
  // BRAND NEW random sandbox minted instead — the exact "looks like
  // isolation but isn't" trap this feature exists to avoid, just inverted
  // (a caller who WANTS to reuse a specific sandbox can't). Reading it here,
  // before the mint-a-fresh-one branch below, makes the printed promise real:
  // an explicit `optsIn.adhdRoot` (a programmatic caller) still wins outright.
  if (opts.adhdRoot === undefined && process.env['ADHD_ROOT']) {
    opts.adhdRoot = process.env['ADHD_ROOT'];
  }
  // BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001: `--namespace sandbox` is an
  // explicit, deliberate ask for isolation from the live production store.
  // The reuse path above (an ambient `ADHD_ROOT` wins when `opts.adhdRoot`
  // is still unset) previously ran unconditionally, so ANY `ADHD_ROOT`
  // already set — which is the tool's own documented normal way to invoke
  // it — silently defeated `--namespace sandbox`: no banner, no warning, exit 0, and
  // the write landed in that ADHD_ROOT store exactly as if `--namespace
  // sandbox` had never been passed. Confirmed: `ADHD_ROOT=<real> backlog
  // --namespace sandbox upsert-project ...` followed by a second
  // non-sandboxed call against the same `ADHD_ROOT` returned the identical
  // uid with `created:false` — proof the "isolated" write was never
  // isolated.
  //
  // `--namespace sandbox` must always win UNLESS the already-set
  // `ADHD_ROOT` is recognizably one of this tool's own sandbox tmpdirs (the
  // caller resuming a specific sandbox they were handed earlier, per this
  // function's own printed instruction). Anything else — including a real
  // production root — gets overridden with a freshly minted sandbox and a
  // loud warning, never a silent write into whatever ADHD_ROOT happened to
  // be set.
  const looksLikeOwnSandboxDir = (p: string): boolean =>
    p.includes(`${sep}backlog-sandbox-`);
  if (namespace === 'sandbox') {
    if (opts.adhdRoot !== undefined && !looksLikeOwnSandboxDir(opts.adhdRoot)) {
      console.error(
        `[backlog] --namespace sandbox: ADHD_ROOT=${opts.adhdRoot} is set but ` +
          `is not a sandbox this tool created — ignoring it and minting a ` +
          `fresh isolated store instead, so --namespace sandbox never writes ` +
          `into an unrecognized (possibly production) location.`
      );
      opts.adhdRoot = undefined;
    }
    if (opts.adhdRoot === undefined) {
      opts.adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-sandbox-'));
      console.error(
        `[backlog] --namespace sandbox: isolated store at ${opts.adhdRoot} (not auto-deleted — pass ADHD_ROOT=${opts.adhdRoot} to reuse it, or remove it yourself when done)`
      );
    }
    opts.namespace = 'sandbox';
    // D8: write a REAL config.yaml, not an in-code override — an isolated
    // invocation must get `embedding.enabled: false` DELIBERATELY, not as an
    // accident of an empty directory. Targets exactly the file
    // `layer-files.ts`'s `loadLayerFiles` reads for the `global` root, which
    // for a sandbox invocation is `join(adhdRoot, 'backlog', 'sandbox')` —
    // the identical path `resolveRoots` computes since `adhdRoot` overrides
    // the global-root base directly. Written UNCONDITIONALLY on every
    // sandbox invocation, before `buildBacklogEnv` ever reads file layers —
    // overwrites (by mtime) any stray leftover file at that exact path,
    // including one this same tool wrote and the caller reused via
    // `ADHD_ROOT=<path>` above. `ADHD_BACKLOG_EMBEDDING_ENABLED` (the env
    // var) still outranks this file — that is intended (D8): an explicit env
    // var is a deliberate ask, a stray file is not.
    const sandboxConfigDir = join(opts.adhdRoot, 'backlog', 'sandbox');
    mkdirSync(sandboxConfigDir, { recursive: true });
    writeFileSync(
      join(sandboxConfigDir, 'config.yaml'),
      '# Written by --namespace sandbox on every invocation — DELIBERATE, not\n' +
        "# an absence-of-file default. embedding.enabled is off so a sandboxed\n" +
        '# run never pays a real model-load cost or opens a real vector store.\n' +
        'embedding:\n' +
        '  enabled: false\n'
    );
  }
  // BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001: `--namespace sandbox`'s promise is
  // "diverts the store away from the (fake) production HOME entirely, and
  // never creates anything under it" (`cli.spec.ts`) — but `server.ts`'s
  // `irCacheFile()` calls `resolveIrCacheFile()` with no arguments, so its
  // module-level lazy singleton (`getExtractInvoke`, built on first
  // extraction) always resolves the REAL, HOME-anchored default
  // (`~/.adhd/backlog/production/cache/apigen/ir-cache/backlog-client.ir.json`)
  // regardless of `opts.adhdRoot`. `server.ts`'s own doc comment on that
  // singleton documents exactly this escape hatch — "Built LAZILY on first
  // use so callers/tests can point `APIGEN_IR_CACHE_FILE`… at test values
  // before the first extraction" — so this redirects it into the same
  // sandbox tmpdir rather than inventing a second isolation mechanism.
  // Guarded on `adhdRoot` (not the namespace name) so an explicit
  // `runBacklogCli(argv, {adhdRoot})` caller (tests) gets the same
  // isolation `--namespace sandbox` gets on the CLI. Never overrides an
  // already-set `APIGEN_IR_CACHE_FILE` — an explicit caller override (e.g.
  // an integration test pointing at its own throwaway file) always wins.
  if (
    opts.adhdRoot !== undefined &&
    process.env['APIGEN_IR_CACHE_FILE'] === undefined
  ) {
    process.env['APIGEN_IR_CACHE_FILE'] = join(
      opts.adhdRoot,
      'ir-cache',
      'backlog-client.ir.json'
    );
  }
  // `sandbox-path` (store-free diagnostic — DEBT-BACKLOG-001's narrower real
  // instance / P5-cli-serve-transport's sandbox finding) reports the
  // resolved isolation root + effective db path WITHOUT ever opening the
  // store, so a caller can confirm `--namespace sandbox` (or a manually-set
  // `ADHD_ROOT`) actually redirects storage before running anything
  // destructive. Uses the SAME `buildBacklogEnv`/`resolveBacklogDbPath`
  // path every store-open site resolves through (BUG-002 parity).
  if (userArgvEarly[0] === 'sandbox-path') {
    const env = buildBacklogEnv({
      scope: opts.scope,
      adhdRoot: opts.adhdRoot,
      cwd: opts.cwd,
      namespace: opts.namespace,
    });
    console.log(
      JSON.stringify({
        adhdRoot: opts.adhdRoot,
        // The real, effective namespace this invocation resolved through
        // (`'production'`/`'test'`/`'sandbox'`) — a child-process-observable
        // proof point for the bypass-bug regression test (cli.spec.ts)
        // without reaching inside the spawned process.
        namespace: opts.namespace ?? 'production',
        dbPath: resolveBacklogDbPath(env),
        // D6: NEW, not a rename — read straight off `env.config.embedding.enabled`
        // (the same `env` this diagnostic already builds to compute `dbPath`)
        // so D8's guarantee has a structural, non-timing assertion point.
        embeddingEnabled: env.config.embedding.enabled,
      })
    );
    return;
  }
  // `store-check` (BUG-BACKLOG-005) — the explicit, operator-facing diagnostic for
  // a store whose node vocabulary this build does not recognize. It opens the
  // store (read-only) and reports the expected vocabulary against the kinds
  // actually present, exiting non-zero on a mismatch. Without it a full store
  // whose items sit under another build's vocabulary reads as
  // `{ok:true, total:0}`, leaving an operator guessing why a healthy store
  // looks empty. `openGraphBacklogStore` runs the same guard, so a mismatch
  // surfaces here as a structured report rather than an open-time stack trace.
  if (userArgvEarly[0] === 'store-check') {
    const env = buildBacklogEnv({
      scope: opts.scope,
      adhdRoot: opts.adhdRoot,
      cwd: opts.cwd,
      namespace: opts.namespace,
    });
    env.ensureDirs();
    const dbPath = resolveBacklogDbPath(env);
    let store: GraphBacklogStore | undefined;
    try {
      store = await openGraphBacklogStore(dbPath, env.config.db.busyTimeoutMs);
      const { total, observed } = await inspectStoreVocabulary(store.adapter);
      console.log(
        JSON.stringify({
          ok: true,
          dbPath,
          total,
          kinds: observed,
          expectedKinds: [...RECOGNIZED_NODE_KINDS],
        })
      );
      return;
    } catch (err) {
      if (err instanceof StoreVocabularyMismatchError) {
        console.error(
          JSON.stringify({
            ok: false,
            dbPath,
            error: { code: 'store_vocabulary_mismatch', message: err.message },
            observed: err.observed,
            expectedKinds: err.recognized,
          })
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      if (store) await closeGraphBacklogStoreSafe(store);
    }
  }
  // BUG-BACKLOG-001: `install-skill`/`install`/`serve` are intercepted below,
  // BEFORE the apigen package/command table is built, so `cliPlugin.run()`'s
  // own `--help`/`-h` rendering (and the identical no-args listing) can never
  // show them. Surface them explicitly here — this branch runs only for
  // help/no-args, opens no store (see DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001),
  // and falls through to the apigen program for the full command listing.
  const helpRequested =
    userArgvEarly.length === 0 ||
    userArgvEarly[0] === '--help' ||
    userArgvEarly[0] === '-h';
  if (helpRequested) {
    console.log('Special commands (handled before the apigen command table):');
    console.log(
      '  install-skill [options]  Install the backlog skill for a host (alias: install)'
    );
    console.log(
      '  serve [options]          Start the long-lived HTTP/MCP server (--transport http|mcp|both)'
    );
    console.log(
      '  search "<query>" [flags]  Natural-language search — `query --input` with the options as flags'
    );
    console.log(
      '  sandbox-path             Report the resolved store path (store-free) — see --namespace below'
    );
    console.log(
      '  store-check              Report the store vocabulary this build expects vs. the kinds present; non-zero on a mismatch'
    );
    console.log('');
    console.log(
      '  --namespace <value>  Global flag, valid before ANY command: selects which'
    );
    console.log(
      '                       declared store instance to use — "production" (default),'
    );
    console.log(
      '                       "test" (a persisted, non-ephemeral store), or "sandbox"'
    );
    console.log(
      '                       (a fresh throwaway store minted per invocation, never'
    );
    console.log(
      '                       the live production one).'
    );
    console.log('');
  }
  // `install-skill` (SPEC.md §6.6) is a PURE filesystem operation — copy
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
  // `serve` (SPEC.md §6.6) starts the long-lived HTTP/MCP listener
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
  // and open the real store through the adapter for no reason
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

  // `search` is NOT a seventh operation and NOT a store-free short-circuit
  // like the five above — it is an argv TRANSLATION. `buildSearchArgv` turns
  // `search "<text>" --limit 5 --status open` into the
  // `['query', '--input', '<json>']` the mounted `query` verb already
  // accepts, and everything below (lazy store open, signal cleanup,
  // `exitCodeForEnvelope`, output shape) then runs unchanged. See
  // `search-shortcut.ts`'s header for why this is a translation rather than
  // a new `client.ts` export (SPEC.md §6's issue verb mount surface).
  // `--help` and every rejection resolve HERE, before the store is opened.
  let searchArgv: string[] | undefined;
  if (userArgvEarly[0] === 'search') {
    const outcome = buildSearchArgv(userArgvEarly.slice(1));
    if (outcome.kind === 'help') {
      console.log(outcome.text);
      return;
    }
    if (outcome.kind === 'error') {
      // Same rejection shape `install-skill.ts`'s `failUsage` emits, and
      // the same `CLI_EXIT_CODE['invalid_argument']` the apigen path uses.
      console.error(
        JSON.stringify({ code: 'invalid_argument', message: outcome.message })
      );
      process.exitCode = 2;
      return;
    }
    searchArgv = outcome.argv;
  }

  // Opened lazily, at most once, only if `getCtx()` is actually invoked (a
  // dispatched command reaching a real function) — never for `--help`,
  // no-args, an unknown command, or a bad-flag rejection, all of which `run()`
  // resolves entirely from the static `operations`/`schemas` below.
  let opened: { store: GraphBacklogStore; ctx: BacklogCtx } | undefined;
  const getCtx = async (): Promise<BacklogCtx> => {
    if (!opened) {
      const env = buildBacklogEnv({
        scope: opts.scope,
        adhdRoot: opts.adhdRoot,
        cwd: opts.cwd,
        namespace: opts.namespace,
      });
      env.ensureDirs();
      // BUG-002: open through `resolveBacklogDbPath` so ADHD_BACKLOG_DATABASE_PATH
      // (→ config.db.path) actually redirects the store; `env.files.db` is only
      // the fallback.
      const store = await openGraphBacklogStore(
        resolveBacklogDbPath(env),
        env.config.db.busyTimeoutMs
      );
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
    const { pkg, operations } = await buildBacklogApigenPackage(getCtx, {
      adhdRoot: opts.adhdRoot,
    });
    const userArgv = searchArgv ?? userArgvEarly;
    const prefix = resolveCommandPrefix(operations);
    // Derived from the SAME `USE_PLUGINS` array passed to `options.usePlugins`
    // below — see {@link resolveMountNamespaces}'s doc comment — never a
    // separately hand-maintained list.
    const reservedNamespaces = resolveMountNamespaces(
      USE_PLUGINS,
      operations,
      pkg.id
    );

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
      options: {
        argv: prefixCommand(userArgv, prefix, reservedNamespaces),
        usePlugins: [...USE_PLUGINS],
        // The issue verbs (api.ts's `IOutcomeEnvelope` shape) REPORT failure in the envelope
        // rather than throwing, so without this hook every `{ok:false}` still
        // exited 0 and a scripted caller read a failure as a success
        // (BUG-BACKLOG-GETITEM-NULL-EXIT-ZERO-001). `exitCodeForEnvelope` is
        // the single source of the code table for every transport.
        exitCode: (result: unknown) =>
          isOutcomeEnvelope(result) ? exitCodeForEnvelope(result) : undefined,
      },
      signal: opts.signal ?? new AbortController().signal,
      logger: testSilentLogger(),
    });

    // BUG-BACKLOG-BATCH-DISCOVERABILITY-001: a per-verb `--help` (e.g.
    // `backlog create --help`) only ever prints that one command's own
    // schema (@adhd/apigen-plugin-cli-output's run(), a shared package this
    // repo's own policy forbids patching for a single-consumer concern) —
    // it has no "see also" for `batch action`, so an agent that explores
    // incrementally (per-verb --help only, never the bare top-level --help)
    // never discovers it. Surfaced here instead, backlog-local, with zero
    // apigen changes. Excludes `batch` itself (no self-referential hint) and
    // the bare top-level `--help`/`-h` (userArgv.length === 1), which already
    // gets the full command table via formatUsage(routes).
    const isPerVerbHelp =
      userArgv.length > 1 &&
      userArgv[0] !== 'batch' &&
      (userArgv.includes('--help') || userArgv.includes('-h'));
    if (isPerVerbHelp) {
      console.log(
        'See also: `adhd-backlog batch action` — run this SAME operation over ' +
          'many items in one call instead of N one-at-a-time invocations ' +
          '(skill/SKILL.md §5).'
      );
    }
    // BUG-BACKLOG-QUERY-SIMILAR-ANCHOR-UNDOCUMENTED-001: `query`'s per-verb
    // `--help` (same shared-package limitation as the `batch action` note
    // above — `paramsText` renders `view?: enum` values but has no field-
    // level "this view additionally requires ..." annotation surface) never
    // told a caller that `view:"similar"` throws unless `filter.anchor` OR
    // `filter.semantic` is also given, and unless `filter.project`/
    // `filter.component` narrows the registry views' listing. Surfaced here,
    // backlog-local, mirroring the `batch action` precedent exactly — zero
    // apigen changes.
    if (isPerVerbHelp && userArgv[0] === 'query') {
      console.log(
        'Notes:\n' +
          '  - view:"similar" additionally requires filter.anchor (uid of the ' +
          'reference issue) OR filter.semantic (free text) — neither given ' +
          'throws invalid_argument.\n' +
          '  - view:"projects" | "components" | "locations" list the project/' +
          'component/location registry (optionally scoped by filter.project/' +
          'filter.component) — see skill/SKILL.md §3a for worked examples.'
      );
    }
  } finally {
    // Normal-path completion: dispose the signal handler FIRST so a signal
    // arriving after this point (once we're already closing/closed) is not
    // double-handled, then close through the same memoized lease-release path.
    signalCleanup.dispose();
    await closeStoreOnce();
  }
}
