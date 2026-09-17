/**
 * server.ts — apigen MOUNT wiring (DESIGN.md §7): extract() -> composeSchemas()
 * -> plugin.run(). NO `apigen generate`, no nx codegen executor, no
 * reimplemented API surface.
 *
 * `createClient` is invoked FRESH on every dispatched call
 * (`@adhd/apigen-engine-runtime`'s dispatch.ts: `schema.hasCtx ⇒ const ctx =
 * await createClient(envelope); … fns[fnName](ctx, ...args)`), not once at
 * server startup — so `createClient` here is a closure returning the SAME
 * already-open `BacklogCtx` on every call (one store, opened once, for the
 * process lifetime), never something that re-opens the DB per request.
 *
 * DEVIATION from the README's illustrative pattern (which points BOTH
 * `extract()` and the live `import()` at the same file path): `extract()`
 * needs real TYPE INFORMATION (ts-morph parses declarations + JSDoc) to
 * derive JSON Schemas, but a shipped npm package's `dist/api.js` is
 * stripped JavaScript with none. `dist/api.d.ts` (emitted by
 * vite-plugin-dts, mirroring `src/`) carries the SAME type graph as the
 * `.ts` source via ambient `declare function` nodes — a documented,
 * anticipated extraction path (`@adhd/apigen-core-client`'s
 * `pickFunctionDeclWithBody` explicitly falls back to a body-less
 * `FunctionDeclaration`, i.e. exactly an ambient declaration). So `extract()`
 * targets the built `.d.ts` (always present once `nx build backlog` has run
 * — nothing here needs the raw `.ts` source shipped in the npm package),
 * while the live function references come from a plain STATIC import of
 * `api.js` (resolved by the bundler/module loader at build/load time, not
 * a runtime dynamic `import()` of a computed path) — avoiding the runtime
 * dynamic-import-of-a-string entirely. `import.meta.url` resolves to the
 * OUTPUT chunk's own URL once bundled (rollup's documented behavior), so
 * `<packageRoot>/dist/api.d.ts` is reachable the same way whether this
 * module is executing from `dist/index.{js,mjs}` (production) or from
 * `src/server.ts` under vitest's transform (tests) — either way `dist/`
 * has already been built by the time this runs (nx `dependsOn`).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Scope } from '@adhd/environment-base-spec';
import {
  extract,
  composeSchemas,
  createExtractInvokerFromPlugins,
  type ExtractCall,
  type Operation,
  type Plugin,
  type Descriptor,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { HttpVerb } from '@adhd/apigen-engine-naming';
import { createIrCacheLayer } from '@adhd/apigen-plugin-ir-cache';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import { batchPlugin } from '@adhd/apigen-plugin-batch';
import * as clientMod from './api.js';
import type { BacklogCtx } from './api.js';
import {
  openGraphBacklogStore,
  closeGraphBacklogStoreSafe,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';
import { enableSemanticSearchFromConfig } from './store/semantic-search.js';
import {
  hasExternalSignalHandling,
  installSignalCleanup,
} from './store/signal-cleanup.js';
import {
  acquireServeLock,
  isLockableDbPath,
  type ServeLockHandle,
} from './store/serve-lock.js';
import {
  buildBacklogEnv,
  resolveBacklogDbPath,
  resolveIrCacheFile,
} from './env.js';
import { readBacklogVersionInfo } from './version-info.js';
import type { Logger, OutputPlugin, RunInput } from '@adhd/apigen-core-client';

/**
 * Guards a live-mount `plugin.run()` call. Exported (not local to this file)
 * because `cli.ts`'s `runBacklogCli` — the third transport, mounting
 * `@adhd/apigen-plugin-cli-output` the exact same way this file mounts
 * fastify/mcp — needs the identical guard; duplicating a 3-line assertion
 * across two files in the SAME package isn't worth a new `packages/`
 * extraction (CLAUDE.md's "Two-Use Refactor Rule" targets logic reusable
 * ACROSS packages, not an in-package private helper), so it's shared via a
 * plain re-export instead.
 */
export function requireRun(
  plugin: OutputPlugin
): (input: RunInput) => Promise<void> {
  if (!plugin.run)
    throw new Error(
      `@adhd/backlog: apigen plugin "${plugin.id}" declares no run() — cannot mount live`
    );
  return plugin.run;
}

/**
 * Test-only `RunInput.logger` override (exported for `cli.ts`'s identical
 * third-transport mount). Every one of the three apigen output plugins
 * (`apigen-plugin-api-fastify`, `-mcp`, `-cli-output`) falls back to its own
 * `createLogger()` — real pino, level `info`, writing jsonl to stderr —
 * whenever `input.logger` is absent, which floods the console on every test
 * run that actually mounts a transport (`server.spec.ts`, `server.mcp.spec.ts`,
 * `serve.spec.ts`, and `cli.spec.ts`'s spawned-binary cases, since
 * `spawnSync`'s `env: { ...process.env }` inherits vitest's own
 * `VITEST=true`). None of those specs assert on log content — they assert
 * status codes and response bodies — so under vitest this swaps in a no-op
 * logger. `mcpPlugin`/`cliPlugin` only ever call `.info`/`.error` on it, but
 * `apiFastifyPlugin` hands it straight to `Fastify({ logger })`, whose own
 * `validateLogger` (`fastify/lib/logger.js`) REQUIRES the full pino surface
 * (`info,error,debug,fatal,warn,trace,child`) or throws
 * `FST_ERR_LOG_INVALID_LOGGER` — confirmed empirically, not guessed, by a
 * first cut here that only stubbed `info`/`error` and blew up every
 * `server.spec.ts` HTTP test with exactly that error. `child()` returns the
 * same no-op instance (fastify calls it per-request to derive a child
 * logger; a self-referencing no-op keeps every descendant silent too).
 * Outside vitest (a real `backlog serve` or CLI invocation) this returns
 * `undefined` and the real pino default logger is used, unchanged.
 */
export function testSilentLogger(): Logger | undefined {
  if (!process.env['VITEST']) return undefined;
  const noop = (): void => {
    /* silenced under vitest — see doc comment above */
  };
  const silent: Record<string, unknown> = {
    info: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    warn: noop,
    trace: noop,
  };
  silent['child'] = () => silent;
  return silent as unknown as Logger;
}

// ---------------------------------------------------------------------------
// The one-package → four-mount surface (SPEC.md §6.7)
// ---------------------------------------------------------------------------

/**
 * SPEC.md §6.6's "host-command carve-out" — the commands that are
 * deliberately NOT part of the mounted data surface, pinned as a value so the
 * refusal is enforceable rather than prose.
 *
 * `install`/`install-skill` are pure filesystem/config operations that must
 * never open the store (cli.ts:243-256 special-cases them BEFORE the apigen
 * command table is ever built — that is what closes
 * DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001), and `serve` is a long-lived
 * listener launcher with a completely different lifecycle (cli.ts:262-265).
 * Neither is a data op, so neither may ever appear as an apigen operation on
 * ANY of the four mounts.
 *
 * `assertHostCarveOut` turns §6.6's negative assertion ("`install`/`serve` are
 * NOT among the mounted verbs") into a mount-time invariant: a future refactor that
 * accidentally exports a host command from the mounted client module fails at
 * `buildBacklogApigenPackage()` — in every transport at once — instead of
 * silently shipping a `backlog_serve` MCP tool that would open a second
 * writer against the store (the exact condition serve-lock.ts exists to make
 * impossible).
 */
export const BACKLOG_HOST_COMMANDS: readonly string[] = [
  'install',
  'install-skill',
  'serve',
];

/**
 * SPEC.md §6.7 — the data verbs the whole surface consolidates onto:
 * the nine issue verbs plus `lookup` and §3a's registry CRUD verbs, mounted
 * as `backlog_<verb>`. Pinned here, next to the carve-out it is the
 * complement of, because it is the ONE list four separate surfaces are
 * checked against: the three apigen mounts derive their names from the
 * operation descriptors via `describeMountedSurface`, and `cli.ts`'s argv
 * parser — which is deliberately NOT an apigen mount, because apigen's
 * `parseArgs` cannot express the §2.1b positional form, projects `string[]`
 * as a JSON-valued flag where §7.3 wants comma-separated, and only sets
 * `process.exitCode` on a thrown `ApiError` (so an `ok:false` envelope would
 * exit 0, contradicting `BACKLOG_EXIT_CODE`) — has to be checked against this list rather than
 * derived from the mount.
 *
 * That asymmetry is exactly how a split brain starts, and this repo already
 * has one open as BUG-BACKLOG-MCP-CLI-SPLIT-BRAIN-001. `server.verbs.spec.ts`
 * asserts BOTH sides against this constant so a verb added to one surface and
 * forgotten on the other fails a test instead of shipping.
 *
 * Order is the SPEC.md §4/§6 declaration order, not alphabetical; compare as sets.
 */
export const BACKLOG_VERBS: readonly string[] = [
  'get',
  'query',
  'lookup',
  'create',
  'update',
  'transition',
  'claim',
  'relate',
  'move',
  'upsert-project',
  'upsert-component',
  'upsert-location',
  'rm-location',
  'delete',
];

/**
 * One mounted operation, projected to all four transports backlog serves.
 *
 * Every field here is computed by `@adhd/apigen-engine-naming`'s `project()`
 * — the SAME function `apigen-plugin-api-fastify` (`run.ts:214-215` via
 * `routeFor`), `apigen-plugin-mcp` (tool registration), `apigen-plugin-cli-output`
 * (command table) and `@adhd/apigen-codegen-openapi`'s `toOpenApi`
 * (`to-openapi.ts:131` → `paths[route]`) each call independently. That shared
 * projector is *why* the four surfaces agree: there is one operation
 * descriptor list and one naming function, never a per-transport definition
 * and never a hand-maintained OpenAPI document.
 */
export interface IMountedOperationSurface {
  /** Canonical apigen operation id (e.g. `backlog/get-item`). */
  id: string;
  /** CLI command as a human types it, e.g. `backlog get-item`. */
  cliCommand: string;
  /** CLI command segments, e.g. `['backlog','get-item']`. */
  cliPath: string[];
  /** MCP tool name as a host loads it, e.g. `backlog_get_item`. */
  mcpTool: string;
  /** HTTP verb the fastify mount registers. */
  httpVerb: HttpVerb;
  /** HTTP route the fastify mount registers AND the OpenAPI `paths` key. */
  httpRoute: string;
}

/**
 * Projects the extracted operation descriptors onto the four transports
 * backlog mounts, returning the single expected surface.
 *
 * This is the mechanical statement of SPEC.md §6.7: *one* operation
 * definition serves CLI, MCP, REST and OpenAPI. A test (or an operator) can
 * call this once and compare it against what each live transport actually
 * advertises; a divergence means some transport grew its own definition,
 * which is precisely what §6.7 forbids.
 *
 * Only `kind: 'action'` operations are mounted — the same filter
 * `buildBacklogApigenPackage` applies when it builds `generated.schemas`, so
 * this never claims a surface the package does not actually compose.
 *
 * @param operations the descriptor list returned by `buildBacklogApigenPackage`
 * @returns one entry per mounted operation, sorted by canonical id for stable
 *   comparison
 */
export function describeMountedSurface(
  operations: readonly Operation[]
): IMountedOperationSurface[] {
  return operations
    .filter((op) => op.kind === 'action')
    .map((op) => {
      const proj = project(op);
      return {
        id: op.id,
        cliCommand: proj.cli.path.join(' '),
        cliPath: proj.cli.path,
        mcpTool: proj.mcp.name,
        httpVerb: proj.http.verb,
        httpRoute: proj.http.route,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * SPEC.md §6.6's negative assertion, enforced at mount time.
 *
 * Throws if any mounted operation's CLI leaf or MCP tool name collides with a
 * host command. Checked against the LEAF segment (`get-item` out of
 * `backlog get-item`) and against the full MCP tool name, because a host
 * command could be absorbed under either spelling.
 */
function assertHostCarveOut(
  surface: readonly IMountedOperationSurface[]
): void {
  const offenders = surface.filter((entry) => {
    const leaf = entry.cliPath[entry.cliPath.length - 1] ?? '';
    return (
      BACKLOG_HOST_COMMANDS.includes(leaf) ||
      BACKLOG_HOST_COMMANDS.some((cmd) =>
        entry.mcpTool.endsWith(`_${cmd.replace(/-/g, '_')}`)
      )
    );
  });
  if (offenders.length > 0) {
    throw new Error(
      `@adhd/backlog: host-command carve-out violated (SPEC.md §6.6) — ` +
        `${offenders
          .map((o) => o.id)
          .join(', ')} was mounted as a data operation. ` +
        `install/install-skill must never open the store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001) ` +
        `and serve must never be reachable as a tool (a second writer against the same store is ` +
        `the condition serve-lock.ts exists to prevent). Keep them host commands in cli.ts.`
    );
  }
}

/**
 * Derives the FULL set of MCP tool names the real `serve --transport mcp`
 * process advertises — every mounted `client.ts` verb (via
 * `describeMountedSurface`'s `mcpTool`, itself `project(op).mcp.name`) PLUS
 * every tool a mount plugin (currently just `apigen-plugin-batch`'s
 * `batch_action`) contributes, using the exact same `project(op).mcp.name`
 * derivation `cli.ts`'s `resolveMountNamespaces` uses for the CLI's own
 * top-level segments.
 *
 * Exists so a test can assert against a LIVE-derived tool set instead of a
 * hardcoded literal array/count — a hardcoded `['backlog_get', …]` (or a bare
 * `.length === 7`) silently stops meaning anything the moment a `client.ts`
 * export is added, renamed, or removed, and would then either falsely fail
 * (a legitimate, intended surface change) or — worse — falsely pass (typo'd
 * to match the wrong new count) with no signal that the assertion itself
 * needs updating. Deriving it here, from the same `operations`/`usePlugins`
 * every transport is actually built from, means the assertion tracks the
 * shipped surface automatically.
 */
export function resolveExpectedMcpToolNames(
  operations: readonly Operation[],
  usePlugins: readonly Plugin[] = [batchPlugin]
): string[] {
  const surface = describeMountedSurface(operations);
  const names = new Set<string>(surface.map((entry) => entry.mcpTool));
  const descriptor: Descriptor = {
    host: 'backlog',
    operations: operations as Operation[],
  };
  for (const plugin of usePlugins) {
    const mount = plugin.capabilities.mount;
    if (!mount) continue;
    for (const op of mount.operations(descriptor, undefined, undefined)) {
      names.add(project(op).mcp.name);
    }
  }
  return [...names].sort();
}

export interface StartOpts {
  transport: 'http' | 'mcp' | 'both';
  port?: number;
  host?: string;
  scope?: Scope;
  /** Test-only override — see `buildBacklogEnv`'s `BuildBacklogEnvOptions`. */
  adhdRoot?: string;
  cwd?: string;
  signal: AbortSignal;
}

/**
 * Resolves the directory that actually contains the built `api.d.ts` /
 * `api.js` artifacts, by PROBING for `api.d.ts` rather than assuming a
 * fixed relative path — because this module executes from THREE genuinely
 * different layouts and a single `../dist` computation cannot satisfy all
 * three (BUG confirmed live via `npm install @adhd/backlog@0.1.0`: it
 * crashed at mount with `.../node_modules/@adhd/dist/api.d.ts does not
 * exist`):
 *
 *  1. PUBLISHED (`node_modules/@adhd/backlog/…`): `@adhd/nx-build`'s
 *     `dist-manifest`/`publish` executors run `npm publish <distDir>` —
 *     `dist/` IS packed as the package root, so the shipped tarball has
 *     `index.js` and `api.d.ts` as SIBLINGS at the package root (there is
 *     no `dist/` subdirectory at all once installed). `dirname(import.meta.url)`
 *     here is already that root, so the OLD `join(here, '..', 'dist')` escaped
 *     one level too far, past the package root into
 *     `node_modules/@adhd/dist` — nonexistent.
 *  2. DEV-BUILT (`entrypoint/backlog/dist/index.{js,mjs}`, e.g. this repo's
 *     own `nx build backlog` output before packing): `api.d.ts` is ALSO a
 *     sibling of `index.js`, both living directly under `dist/`.
 *  3. VITEST (`src/server.ts` transformed and run in place): `api.d.ts`
 *     has not moved next to `src/` — it's still only in the built `dist/`,
 *     one level up and back down from `src/`.
 *
 * Layouts 1 and 2 are identical in shape (api.d.ts is a sibling of the
 * running module) and differ from layout 3 only in WHERE that sibling lives
 * relative to the module — so probing "is api.d.ts sitting right next to
 * me?" before falling back to the vitest-only `../dist` shape correctly
 * covers all three without needing to distinguish "published" from
 * "dev-built" explicitly.
 */
function backlogDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, 'api.d.ts'))) return here;
  return join(here, '..', 'dist');
}

/**
 * DEVIATION / real bug worked around here (filed as
 * BUG-APIGEN-RUNMODE-REF-UNRESOLVABLE-001): `client.ts`'s return types
 * (`CreateItemResult`, `BacklogItem[]`, ...) reference NAMED exported types
 * (`BacklogStatus`, `Priority`, `Citation`, `Note`) repeatedly — enough for
 * `@adhd/apigen-core-client`'s extraction (ts-json-schema-generator's
 * named-type lookup path) to hoist them into a `$ref` + `definitions` pair
 * rather than inlining every occurrence (confirmed directly against
 * `dist/index.js`'s real extracted output schema for `createItem`).
 *
 * That alone would be fine — JSON Schema `$ref`+`definitions` is completely
 * standard — EXCEPT `@adhd/apigen-engine-runtime`'s dispatch-time transcoder
 * (`apigen-base-logical`'s `runmode.ts` `buildCtx()`) hard-codes
 * `resolve: (ref) => { throw new Error('$ref ... cannot be resolved in
 * run-mode without a descriptor root. Supply a resolve() in the ctx
 * override...') }` and NEITHER `dispatch()` NOR the public `RunInput`/
 * `ComposedSchemas` surface exposes any way to supply that `resolve()`
 * override from a plugin/host — confirmed by direct reproduction: even
 * after hoisting `definitions` to the schema's own top level (where AJV, a
 * SEPARATE consumer, WOULD find it), `apigen-engine-runtime`'s own
 * `encodeResult`/`decodeArg` still throw, because its resolver is
 * unconditionally the throwing stub regardless of where `definitions`
 * lives. In other words: run-mode dispatch (as opposed to codegen-mode,
 * which does have a "descriptor root") CANNOT handle `$ref` at all today —
 * this is not something a `client.ts` schema shape can satisfy no matter
 * how it's hoisted.
 *
 * The only fix available from THIS package: never let a `$ref` reach
 * `composeSchemas()`/`dispatch()` in the first place. `dereferenceSchema`
 * fully INLINES every `$ref` against the (possibly nested-at-any-depth)
 * `definitions`/`$defs` it collects from the WHOLE fragment, recursively,
 * then drops the now-unused `definitions`/`$defs` — reproducing exactly the
 * fully-inlined shape `hoistNestedDefs`'s sibling "morph-walk" extraction
 * path already produces for less-frequently-reused types (client.ts has no
 * self-referential/recursive types, so this always terminates).
 */
function dereferenceSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;

  const definitions: Record<string, unknown> = {};
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of ['definitions', '$defs']) {
      const defs = obj[key];
      if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
        for (const [name, def] of Object.entries(
          defs as Record<string, unknown>
        )) {
          if (!(name in definitions)) definitions[name] = def;
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      collect(value);
    }
  };
  collect(schema);
  // Definitions can themselves reference other definitions — collect transitively.
  collect(definitions);
  if (Object.keys(definitions).length === 0) return schema;

  const inline = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, seen));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/(?:definitions|\$defs)\//, '');
      if (seen.has(name) || !(name in definitions)) return {}; // cycle/unknown guard — unreachable for client.ts's types
      return inline(definitions[name], new Set([...seen, name]));
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue;
      out[key] = inline(value, seen);
    }
    return out;
  };
  return inline(schema, new Set());
}

const requirePkg = createRequire(import.meta.url);

/**
 * FEAT-002: the extractor version stamped into every IR-cache entry — the
 * `@adhd/apigen-core-client` package version. Any change to the extractor's
 * output for the same input (a bug fix, new TS feature support, or a future
 * DEBT-003 fix making Path 2 correct for cross-referencing named types) bumps
 * this version, which changes the cache key and busts every stale entry — the
 * mechanism that keeps this cache from ever becoming a reason to defer DEBT-003.
 */
const CORE_CLIENT_VERSION: string = requirePkg(
  '@adhd/apigen-core-client/package.json'
).version;

/**
 * FEAT-002 Revision 2 (design doc R2.2/R2.3, implementation spec R2-4):
 * RUNTIME CACHE mode targets a single, literal file — not a directory of
 * many content-addressed entries. Env-overridable (the integration spec
 * points it at a fresh throwaway file); default resolves through
 * `resolveIrCacheFile` (`env.ts`) to a single stable absolute path under
 * `~/.adhd/backlog/production/cache/apigen/ir-cache/backlog-client.ir.json`
 * — NEVER `process.cwd()` (BUG-CACHE-CWD-001: the prior `join(process.cwd(),
 * 'tmp', 'apigen', 'ir-cache', ...)` default scattered a fresh, permanently-
 * cold cache directory into every repo/worktree `backlog` was ever run from).
 * `APIGEN_IR_CACHE_FILE` replaces the Revision-1 `APIGEN_IR_CACHE_DIR`.
 */
/**
 * BUG-BACKLOG-SANDBOX-IRCACHE-001: previously took no arguments and always
 * called `resolveIrCacheFile()` bare — which, absent an explicit `adhdRoot`,
 * resolves against the process's real `HOME`. That is correct isolation
 * ONLY along the `scope` axis (project vs global data — see this file's own
 * comment above about the cache staying "one stable machine-wide location
 * no matter which scope a given invocation resolved its backlog *data*
 * to"). It is NOT correct along the `--sandbox`/test-isolation axis:
 * `cli.ts`'s `runBacklogCli` and `startBacklogServer` both already thread an
 * `adhdRoot` override through `buildBacklogEnv` for every OTHER path (the
 * real store, `env.ensureDirs()`), but this cache file's own
 * `resolveIrCacheFile({ adhdRoot, instanceId })` parameters were simply never
 * wired to it — so a `--sandbox` invocation, despite reporting (and
 * genuinely using) an isolated store root, would still create
 * `~/.adhd/backlog/production/cache/apigen/ir-cache/...` on the real
 * machine `HOME` on its first extraction, defeating the isolation guarantee
 * `--sandbox` advertises (caught by `cli.spec.ts`'s
 * "--sandbox diverts the store away from the (fake) production HOME
 * entirely, and never creates anything under it" — a fake HOME stands in
 * for the real one there, but the bug is identical against a real HOME).
 * Now accepts the same `{ adhdRoot, instanceId }` test-isolation pair every
 * other resolver in this file already takes, and forwards it verbatim.
 */
function irCacheFile(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): string {
  return resolveIrCacheFile(opts);
}

/**
 * FEAT-002 Revision 2 (design doc R2.7): opt-out kill switch. Backlog's
 * three transports (HTTP/MCP/CLI) are a live mount, not a `--use`-flag-
 * parsed `apigen-cli` invocation, so there is no CLI surface for a human to
 * omit the plugin here — this env var is that surface for this host
 * specifically. Default enabled (`'1'`/unset); `'0'` disables caching
 * entirely (every call is a real extraction, no cache read/write at all).
 */
function irCacheEnabled(): boolean {
  return process.env['APIGEN_IR_CACHE_ENABLED'] !== '0';
}

/**
 * FEAT-002 Revision 2 (design doc R2.6 item 4 / implementation spec R2.7):
 * a `Plugin` object carrying ONLY the `extractLayer` capability, built from
 * `@adhd/apigen-plugin-ir-cache`'s `createIrCacheLayer(opts)` factory —
 * NOT the package's static `irCachePlugin` export, because that singleton's
 * `extractLayer.layer` resolves its cache file / extractor version lazily
 * from `APIGEN_IR_CACHE_FILE`/`APIGEN_IR_CACHE_EXTRACTOR_VERSION` env vars
 * with no per-call configuration hook (see that package's own `src/index.ts`
 * module doc) — backlog needs a DIFFERENT, fixed default file
 * (`backlog-client.ir.json` at one known path, not the plugin's per-source
 * hashed default files under `~/.adhd/apigen/default/cache/`)
 * and a specific `extractorVersion` (`CORE_CLIENT_VERSION`, the actual
 * installed `@adhd/apigen-core-client` version, not an env-var-overridable
 * value), so it builds its own `Plugin`-shaped instance around the factory
 * instead — exactly the escape hatch that module doc describes for a caller
 * wanting non-default configuration in the same process.
 */
function backlogIrCachePlugin(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): Plugin {
  return {
    id: 'ir-cache',
    description:
      'Extract-stage IR cache, configured for the backlog hot path (BUG-019).',
    language: 'ts',
    capabilities: {
      extractLayer: {
        layer: createIrCacheLayer({
          cache: irCacheFile(opts),
          extractorVersion: CORE_CLIENT_VERSION,
        }),
      },
    },
  };
}

/**
 * FEAT-002 Revision 2 (design doc R2.6 item 4): the extract-stage invoker,
 * composed through the GENERIC `createExtractInvokerFromPlugins` mechanism
 * (the same one `apigen-cli`'s orchestrator uses for `--use`-loaded plugins)
 * rather than hand-constructing a middleware array — the plugin list is
 * either `[backlogIrCachePlugin()]` (caching enabled, the default) or `[]`
 * (R2.7's `APIGEN_IR_CACHE_ENABLED=0` opt-out: extraction always runs live,
 * no cache read/write of any kind — `createExtractInvokerFromPlugins`
 * degrades to a pure pass-through to `runExtractor` on an empty/non-matching
 * plugin list). On a cache HIT the terminal `extract()` is never called (the
 * cached `Operation[]` is returned); on a MISS the result is written through
 * fire-and-forget. Built LAZILY on first use so callers/tests can point
 * `APIGEN_IR_CACHE_FILE`/`APIGEN_IR_CACHE_ENABLED` at test values before the
 * first extraction.
 *
 * BUG-BACKLOG-SANDBOX-IRCACHE-001: the memoized `extractInvoke` is
 * configured from whichever `opts` the FIRST caller in this process passes
 * — a pre-existing, unchanged constraint of the "lazy singleton" design
 * described above. This is safe for `runBacklogCli` (one-shot process, one
 * `adhdRoot` for its whole lifetime) and for `startBacklogServer` (long-
 * lived but likewise fixed to one `adhdRoot`/scope for its whole lifetime);
 * it is a latent hazard only for a hypothetical caller that invoked this
 * function twice, in the same process, with two DIFFERENT `adhdRoot`s — no
 * such caller exists today.
 */
let extractInvoke: ((call: ExtractCall) => Promise<Operation[]>) | undefined;
function getExtractInvoke(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): (call: ExtractCall) => Promise<Operation[]> {
  extractInvoke ??= createExtractInvokerFromPlugins(
    irCacheEnabled() ? [backlogIrCachePlugin(opts)] : [],
    (call: ExtractCall) =>
      extract({
        sourceFile: call.source,
        namespace: call.namespace,
        tsconfig:
          typeof call.extractorOptions?.tsconfig === 'string'
            ? call.extractorOptions.tsconfig
            : undefined,
        dropFileSegment: true,
      })
  );
  return extractInvoke;
}

async function extractApiOperations(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): Promise<Operation[]> {
  const clientDts = join(backlogDistDir(), 'api.d.ts');
  if (!existsSync(clientDts)) {
    throw new Error(
      `@adhd/backlog: cannot mount — ${clientDts} does not exist. ` +
        `Run "nx build backlog" first (extract() needs the built .d.ts for type information).`
    );
  }
  // `dropFileSegment: true` (`ExtractOptions`, `@adhd/apigen-core-client`):
  // without it every op's `path` would unconditionally start with the
  // `api.d.ts` extraction FILENAME artifact (`normalizeFileName` →
  // `'client-d'`), leaking into every transport's name — `backlog client-d
  // create-item` / `backlog_client_d_create_item` instead of the intended
  // `backlog create-item` / `backlog_create_item`. Safe here because every
  // `client.ts` export is extracted from this ONE file, so there is no
  // cross-file name to disambiguate against; a genuine same-name collision
  // would still be caught at extract time by `checkCollisions`
  // (`@adhd/apigen-engine-naming`).
  //
  // FEAT-002: extraction flows through the extract-stage invoker (BUG-019 hot
  // path) with the IR-cache layer — a cache HIT returns the cached
  // `Operation[]` without re-running `extract()`; a MISS runs `extract()` as
  // before and writes the result through to the cache fire-and-forget. The
  // cached value is byte-identical to what `extract()` would produce, so the
  // downstream `composeSchemas`/`dereferenceSchema` behavior is unchanged.
  return getExtractInvoke(opts)({
    source: clientDts,
    host: 'ts',
    namespace: 'backlog',
    extractorOptions: {},
  });
}

/**
 * Builds the composed, apigen-ready package descriptor for `client.ts`'s
 * exports. `ctx` may be a plain `BacklogCtx` (the store is already open —
 * `startBacklogServer`'s case, where a long-lived server needs its store
 * immediately regardless of what request comes first) OR a LAZY `() =>
 * BacklogCtx` thunk (`runBacklogCli`'s case) — `createClient` only calls it
 * when a dispatched command actually reaches the real function, which never
 * happens for `--help`/no-args/an unknown command. This is what closes
 * DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001: `operations`/`schemas` below are
 * computed purely from the built `api.d.ts` (via `extractApiOperations`)
 * and never touch `ctx` at all, so a lazy caller can defer opening the real
 * backing store until a command that actually needs it is dispatched.
 *
 * @param opts.adhdRoot/instanceId BUG-BACKLOG-SANDBOX-IRCACHE-001 — forwarded
 *   verbatim to `extractApiOperations`/the IR-cache plugin, so a caller
 *   already isolating its real store via `adhdRoot` (`--sandbox`, or any
 *   other test-isolation caller of `buildBacklogEnv`) gets the extract-stage
 *   IR cache isolated the SAME way, instead of it silently falling through
 *   to the real machine `HOME`. Optional and additive — every existing call
 *   site that omits it keeps its prior (real-`HOME`, shared-cache) behavior
 *   exactly.
 */
export async function buildBacklogApigenPackage(
  ctx: BacklogCtx | (() => BacklogCtx | Promise<BacklogCtx>),
  opts: { adhdRoot?: string; instanceId?: string } = {}
): Promise<{
  pkg: {
    id: string;
    version: string;
    schemas: ReturnType<typeof composeSchemas>;
    importPath: string;
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: () => Promise<BacklogCtx>;
  };
  /**
   * §6.7: the four-transport projection of `operations`, computed once here
   * so CLI, MCP, REST and OpenAPI are provably reading ONE definition. Callers
   * that need to know "what is mounted" must read this rather than
   * re-deriving names per transport.
   */
  surface: IMountedOperationSurface[];
  operations: Operation[];
}> {
  const getCtx: () => BacklogCtx | Promise<BacklogCtx> =
    typeof ctx === 'function' ? ctx : () => ctx;
  const operations = await extractApiOperations(opts);
  const generated = {
    metadata: { namespace: 'backlog', phase: '' },
    schemas: Object.fromEntries(
      operations
        .filter((op) => op.kind === 'action')
        .map((op) => [
          op.path[op.path.length - 1]?.raw ?? '',
          // NOTE: the field is `safe` (see `GeneratedSchemas.schemas[name].safe`
          // — `composeSchemas()` reads exactly that key). The
          // `apigen-core-client` README's illustrative snippet writes
          // `'x-apigen-safe': op.safe` here, which is a literal-copy mismatch
          // with the real type (harmless in practice today since `op.safe`
          // is always `false` for a `kind: 'action'` export either way, so
          // `composeSchemas()` falls through to its own
          // `isPrimitiveOnlyInputSchema` computation regardless of which key
          // this is stamped under — but using the real field name is correct
          // and future-proof).
          {
            input: dereferenceSchema(op.input) as Record<string, unknown>,
            output: dereferenceSchema(op.output) as Record<string, unknown>,
            hasCtx: op.hasCtx,
            safe: op.safe,
          },
        ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  // SPEC.md §6.7 — project the ONE descriptor list onto the four
  // transports here, at the single composition point, and enforce the §6
  // host-command carve-out before any transport mounts. Every mount below
  // (and `cli.ts`'s cli-output mount) is handed this same `operations` array,
  // so a name that appears here appears identically on all four.
  const surface = describeMountedSurface(operations);
  assertHostCarveOut(surface);
  // MCP handshake identity finding (P5-cli-serve-transport): read fresh from
  // `package.json` on every call, the SAME store-free path `backlog
  // version`/`readBacklogVersionInfo` already uses, so an agent's `initialize`
  // handshake reports which REAL published build it is talking to instead of
  // a hardcoded placeholder shared by every apigen-hosted MCP server.
  const { version } = readBacklogVersionInfo();
  return {
    pkg: {
      id: 'backlog',
      version,
      schemas,
      importPath: join(backlogDistDir(), 'api.js'),
      fns: clientMod as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >,
      createClient: async () => getCtx(),
    },
    operations,
    surface,
  };
}

/**
 * Opens (or reuses) the backlog store + env, mounts every `client.ts` export
 * live via `@adhd/apigen-plugin-api-fastify` and/or `@adhd/apigen-plugin-mcp`
 * — no code generation.
 */
export async function startBacklogServer(opts: StartOpts): Promise<void> {
  const env = buildBacklogEnv({
    scope: opts.scope,
    adhdRoot: opts.adhdRoot,
    cwd: opts.cwd,
  });
  env.ensureDirs();

  // BUG-BACKLOG-NO-SIGNAL-HANDLERS-001: `serve.ts`'s `runServeCommand`
  // registers its OWN SIGINT/SIGTERM handling (→ `AbortController.abort()`,
  // driving a graceful drain of whichever transports are mounted below)
  // BEFORE ever calling this function — checked here, at the top, before the
  // store even starts opening, so this only installs a SECOND, competing
  // handler for callers that reach `startBacklogServer` directly, with no
  // external SIGINT/SIGTERM coverage of their own (see
  // `hasExternalSignalHandling`'s doc comment for why installing both would
  // race the caller's graceful drain instead of helping it).
  let closePromise: Promise<void> | undefined;
  // Deliberately `let`, not folded into `const store = await
  // openGraphBacklogStore(...)` below: this must stay visible (and
  // `undefined`) to `closeStoreOnce`'s closure for the ENTIRE async open
  // window, so a signal arriving before the open finishes correctly closes
  // "nothing yet" (a documented no-op) instead of the closure capturing a
  // not-yet-existing binding.
  // eslint-disable-next-line prefer-const
  let store: GraphBacklogStore | undefined;
  // [inv:singleton] (docs/spec/service-lifecycle.md §5, sox-ecosystem) — see
  // serve-lock.ts's header for the full incident/rationale. Released ONLY
  // after the store is actually closed below (never merely on signal
  // receipt), so a second `serve` attempted while THIS one is mid-shutdown
  // is refused, not raced.
  const dbPath = resolveBacklogDbPath(env);
  const serveLock: ServeLockHandle | undefined = isLockableDbPath(dbPath)
    ? acquireServeLock(dbPath)
    : undefined;
  const closeStoreOnce = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeGraphBacklogStoreSafe(store).finally(() =>
        serveLock?.release()
      );
    }
    return closePromise;
  };
  const signalCleanup = hasExternalSignalHandling()
    ? undefined
    : installSignalCleanup(closeStoreOnce);

  // BUG-002: open through `resolveBacklogDbPath` so ADHD_BACKLOG_DATABASE_PATH
  // (→ config.db.path) actually redirects the store; `env.files.db` is only
  // the fallback.
  try {
    store = await openGraphBacklogStore(dbPath, env.config.db.busyTimeoutMs);
    // RAG-SPEC.md §1.6 — opt-in semantic search. A no-op (and silent) unless
    // `embedding.enabled`; never throws, so a missing/broken embedding stack
    // can never stop the server from starting. Deliberately INSIDE this
    // try/catch: if it ever did throw, the serve lock and signal handler
    // below must still be released rather than leaked.
    await enableSemanticSearchFromConfig(store, env.config.embedding);
  } catch (err) {
    // The lock was acquired but the store open itself failed (bad path,
    // corrupt file, etc.) — release the lock we're holding before propagating,
    // or the failed attempt would permanently block every subsequent `serve`.
    serveLock?.release();
    signalCleanup?.dispose();
    throw err;
  }
  const ctx: BacklogCtx = { store, env };

  // Everything from here on runs inside the try/finally below, NOT just the
  // `Promise.all(runs)` it originally wrapped. `buildBacklogApigenPackage`
  // can genuinely throw at mount-composition time — a missing built
  // `api.d.ts` (`extractApiOperations`), an extraction failure, or the
  // §6 host-carve-out violation `assertHostCarveOut` now raises — and every
  // one of those happens AFTER the serve lock is held and the store is open.
  // With the narrower scope, such a failure propagated without ever calling
  // `closeStoreOnce()`, so the lock file stayed on disk naming a dead pid and
  // every subsequent `backlog serve` against that store was refused until a
  // human deleted it by hand — the same leak the store-open `catch` above
  // already guards against, one step later in the sequence. Widening the
  // scope cannot regress the success path: the `finally` already ran there.
  try {
    const { pkg, operations } = await buildBacklogApigenPackage(ctx, {
      adhdRoot: opts.adhdRoot,
    });
    const logger = testSilentLogger();

    const runs: Promise<void>[] = [];
    // SPEC.md §6.7 — BOTH mounts below are handed the SAME
    // `pkg` and the SAME `operations` array produced by the single
    // `buildBacklogApigenPackage` call above; `cli.ts`'s cli-output mount
    // makes the same call for the same reason. `openapiPlugin` is a
    // `usePlugins` entry on the fastify mount rather than a separate
    // definition, and its handler derives the document from
    // `descriptor.operations` at request time
    // (`apigen-plugin-openapi/src/lib/plugin.ts:80-84` → `toOpenApi`), so the
    // OpenAPI paths cannot drift from the routes fastify registered. There is
    // no per-transport operation list anywhere in this function — that
    // absence is the contract.
    if (opts.transport === 'http' || opts.transport === 'both') {
      runs.push(
        requireRun(apiFastifyPlugin)({
          packages: [pkg],
          outputDir: '',
          options: {
            port: opts.port ?? 3300,
            host: opts.host ?? '127.0.0.1',
            usePlugins: [openapiPlugin, batchPlugin],
          },
          signal: opts.signal,
          // SPEC.md §6.7 — the SAME `operations` array the MCP
          // mount below receives. A per-transport operation list is exactly
          // what §6.7 forbids, because it lets the REST surface drift from
          // the MCP one silently.
          //
          // This line previously read
          // `operations.filter((op) => !op.id.endsWith('get-item'))`, labelled
          // "NEGATIVE CONTROL (temporary)" — a deliberate §6.7 violation
          // inserted to prove a parity assertion had teeth, which was never
          // reverted and shipped on main in 0cb37400. The published server's
          // REST/OpenAPI surface was therefore missing `get-item` entirely.
          // See BUG-BACKLOG-003.
          operations,
          logger,
        })
      );
    }
    if (opts.transport === 'mcp' || opts.transport === 'both') {
      runs.push(
        requireRun(mcpPlugin)({
          packages: [pkg],
          outputDir: '',
          options: { transport: 'stdio', usePlugins: [batchPlugin] },
          signal: opts.signal,
          operations,
          logger,
        })
      );
    }

    await Promise.all(runs);
  } finally {
    signalCleanup?.dispose();
    await closeStoreOnce();
  }
}
