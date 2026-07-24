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
 * `runBacklogCli` is deliberately symmetric with `startBacklogServer`:
 * same `buildBacklogEnv`/`ensureDirs`/`openGraphBacklogStore` setup, same
 * `requireRun()` guard (imported from `./server.js`, not duplicated — see
 * that export's doc comment), same `closeGraphBacklogStore` teardown. The
 * ONLY thing specific to the CLI transport is argv resolution and the
 * one-shot (non-listening) nature of `cliPlugin.run()`.
 */
import type { Scope } from '@adhd/environment-base-spec';
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import type { Operation } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { BacklogCtx } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import { buildBacklogApigenPackage, requireRun } from './server.js';

/**
 * Derives the internal command-path PREFIX every `client.ts` operation
 * shares in `@adhd/apigen-plugin-cli-output`'s command table
 * (`buildCommandTable()`: `cliPath = project(op).cli.path`, and
 * `project()`'s `cli.path = [namespace, ...path].map(toKebab)` —
 * `@adhd/apigen-engine-naming`'s `naming.ts`).
 *
 * NOT simply `['backlog']`. `extract()` (`@adhd/apigen-core-client`'s
 * `extract.ts`) unconditionally builds every operation's `path` as
 * `[fileSegment, exportSegment]`, where `fileSegment` is derived from the
 * EXTRACTED SOURCE FILE's own name (`normalizeFileName('client.d.ts')` →
 * `'client-d'` — strips one extension, then folds remaining `.`/`_` to `-`).
 * `server.ts`'s `extractClientOperations()` always points extraction at the
 * built `client.d.ts` (see that file's DEVIATION doc comment), so EVERY
 * `client.ts` export's real `cli.path` is
 * `['backlog', 'client-d', '<kebab-export-name>']` — confirmed empirically
 * (not assumed) by inspecting a real built `pkg`/`operations` pair; see
 * `cli.spec.ts`'s "command-prefix derivation" suite. The HTTP
 * (`apigen-plugin-api-fastify`) and MCP (`apigen-plugin-mcp`) transports
 * both route by bare `fnName` and never consult `project(op)` at all, so
 * this `client-d` segment is INVISIBLE on those two transports — it is
 * cli-output-specific, and would leak into every command a user types
 * (`backlog client-d get-item …`) if this file naively hardcoded a
 * single-segment `'backlog'` prefix instead of deriving the REAL prefix from
 * the live `operations` list.
 *
 * Since every `client.ts` export shares the same namespace + same source
 * file, every operation's `cli.path` differs ONLY in its final (export)
 * segment — so the shared prefix is simply "everything but the last
 * segment" of any one operation's projected `cli.path`. Computed fresh from
 * `operations` on every call (never cached as a literal), so a future change
 * to the extraction source file name, or to `apigen-core-client`'s file-
 * segment derivation, can never silently desync this from the real command
 * table the way a hardcoded constant would.
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
 * Prepends `prefix` (the real, namespace-qualified command path segments
 * every `client.ts` export shares — see {@link resolveCommandPrefix}) to a
 * user-typed argv, so `backlog get-item --repo … --human-id …` (what a
 * consumer actually types — the bin's own name is never part of `argv`)
 * resolves against the cli-output plugin's command table, which is keyed by
 * the FULL internal path (`['backlog', 'client-d', 'get-item']`).
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
 */
export function prefixCommand(userArgv: readonly string[], prefix: readonly string[]): string[] {
  if (userArgv.length === 0) return [...userArgv];
  if (userArgv[0]?.startsWith('-')) return [...userArgv];
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
  const env = buildBacklogEnv({ scope: opts.scope, adhdRoot: opts.adhdRoot, cwd: opts.cwd });
  env.ensureDirs();
  const store = openGraphBacklogStore(env.files.db, env.config.db.busyTimeoutMs);

  try {
    const ctx: BacklogCtx = { store, env };
    const { pkg, operations } = await buildBacklogApigenPackage(ctx);
    const userArgv = argv ?? process.argv.slice(2);
    const prefix = resolveCommandPrefix(operations);

    await requireRun(cliPlugin)({
      packages: [pkg],
      operations,
      outputDir: '',
      options: { argv: prefixCommand(userArgv, prefix) },
      signal: opts.signal ?? new AbortController().signal,
    });
  } finally {
    closeGraphBacklogStore(store);
  }
}
