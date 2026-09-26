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
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Scope } from '@adhd/environment-base-spec';
import {
  composeSchemas,
  type Operation,
  type Plugin,
  type Descriptor,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { HttpVerb } from '@adhd/apigen-engine-naming';
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
import {
  hasExternalSignalHandling,
  installSignalCleanup,
} from './store/signal-cleanup.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
// The BAKE-AT-BUILD artifact reader (design doc Revision 3). Deliberately
// ts-morph-free: this is the module `extractApiOperations` prefers on the hot
// startup path, so importing it must never drag the extractor in. The
// ts-morph-touching fallback lives behind a dynamic `import()` instead.
import { backlogDistDir, readBakedIrArtifact } from './ir-artifact.js';
import {
  backlogConfigLayerFiles,
  createEmbeddingLiveConfig,
} from './write/embedding-config.js';
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
 * concurrent writer against the store via a completely different lifecycle
 * path than the one `startBacklogServer` itself expects.
 */
export const BACKLOG_HOST_COMMANDS: readonly string[] = [
  'install',
  'install-skill',
  'serve',
];

/**
 * SPEC.md §6.7 — the data verbs the whole surface consolidates onto:
 * the nine issue verbs plus `lookup`, §3a's registry CRUD verbs, and the
 * three §5 stats/rollup reads (`priority-matrix`/`part-of-rollup`/
 * `open-curve`), mounted as `backlog_<verb>`. Pinned here, next to the
 * carve-out it is the complement of, because it is the ONE list four separate
 * surfaces are
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
  'priority-matrix',
  'part-of-rollup',
  'open-curve',
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
  'embedding-status',
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
        `and serve must never be reachable as a tool — it has a completely different lifecycle ` +
        `than a mounted data operation. Keep them host commands in cli.ts.`
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
  /** Explicit-parameter-first namespace override — see
   *  `BuildBacklogEnvOptions.namespace`'s doc comment. */
  namespace?: string;
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

/**
 * Derives `client.ts`'s mounted operations for the hot startup path.
 *
 * BAKE-AT-BUILD (design doc Revision 3,
 * `docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md`): `nx build
 * backlog` emits `dist/api.ir.json` — the `Operation[]` for `dist/api.d.ts` —
 * in the SAME build target that emits the `.d.ts`. This function prefers that
 * pre-built artifact and never loads the extractor, so `backlog --help` / an
 * MCP `initialize` no longer pay the synchronous ts-morph extraction that made
 * startup exceed the MCP client deadline. Only a missing or STALE artifact
 * falls back to a live extraction.
 *
 * Three-step read:
 *  1. `dist/api.d.ts` MUST exist — nothing can be derived without the built
 *     declarations (`nx build backlog` produces it).
 *  2. `readBakedIrArtifact(distDir)` returns the baked `Operation[]` on a
 *     content-hash-validated hit. `./ir-artifact.js` is ts-morph-free by
 *     construction, so the baked path's module graph never reaches the
 *     extractor.
 *  3. On a miss, DYNAMICALLY import `./extract-live.js` — the only module in
 *     this package that statically imports extractor-touching code — and run
 *     the runtime IR-cache fallback there. The dynamic import is what keeps
 *     ts-morph out of the baked path entirely.
 *
 * The baked `operations` are byte-identical to the fallback's (both go through
 * the same `dropFileSegment: true` / `namespace: 'backlog'` call — see
 * `extract-live.ts`'s `buildBakedOperations`), so downstream
 * `composeSchemas`/`dereferenceSchema` behavior is unchanged either way.
 */
async function extractApiOperations(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): Promise<Operation[]> {
  const distDir = backlogDistDir();
  const clientDts = join(distDir, 'api.d.ts');
  if (!existsSync(clientDts)) {
    throw new Error(
      `@adhd/backlog: cannot mount — ${clientDts} does not exist. ` +
        `Run "nx build backlog" first (the mounted surface is derived from the built .d.ts).`
    );
  }
  // Prefer the baked artifact. `readBakedIrArtifact` never throws and returns
  // `undefined` on missing/corrupt/format-mismatch/extractor-mismatch/
  // source-hash-mismatch, so ANY doubt degrades to the live fallback rather
  // than serving stale operations.
  const baked = readBakedIrArtifact(distDir);
  if (baked) return baked;
  return (await import('./extract-live.js')).extractApiOperationsLive(opts);
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
 *   already isolating its real store via `adhdRoot` (`--namespace sandbox`, or any
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
    namespace: opts.namespace,
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
   
  let store: GraphBacklogStore | undefined;
  const dbPath = resolveBacklogDbPath(env);
  const closeStoreOnce = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeGraphBacklogStoreSafe(store);
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
  } catch (err) {
    signalCleanup?.dispose();
    throw err;
  }
  // The `embedding.*` config family is the one RELOADABLE family: the
  // `Environment` above resolved its whole cascade once at construction, so a
  // long-lived server would otherwise never see an operator's `config.yaml`
  // edit. The holder re-resolves ONLY `embedding.*` — `db.*`/`logging.level`
  // stay resolve-once (swapping the whole env mid-process would move an
  // already-open store) and `ctx.env` is never reassigned. See
  // `write/embedding-config.ts` and `api.ts`'s `ensureSemanticReady`.
  const ctx: BacklogCtx = {
    store,
    env,
    embeddingConfig: createEmbeddingLiveConfig({
      baseline: env,
      rebuild: () =>
        buildBacklogEnv({
          scope: opts.scope,
          adhdRoot: opts.adhdRoot,
          cwd: opts.cwd,
          namespace: opts.namespace,
        }),
      layerFiles: () =>
        backlogConfigLayerFiles({
          scope: opts.scope,
          adhdRoot: opts.adhdRoot,
          cwd: opts.cwd,
          namespace: opts.namespace,
        }),
      // The write layer's only sink is stderr (`write/bootstrap.ts`'s own
      // latched notices); a structured logger is out of scope for this slice.
      // eslint-disable-next-line no-console
      log: (_level, message) => console.error(message),
    }),
  };

  // Everything from here on runs inside the try/finally below, NOT just the
  // `Promise.all(runs)` it originally wrapped. `buildBacklogApigenPackage`
  // can genuinely throw at mount-composition time — a missing built
  // `api.d.ts` (`extractApiOperations`), an extraction failure, or the
  // §6 host-carve-out violation `assertHostCarveOut` now raises — and every
  // one of those happens AFTER the store is open. With the narrower scope,
  // such a failure propagated without ever calling `closeStoreOnce()`,
  // leaking the open store handle and signal-cleanup registration — the same
  // leak the store-open `catch` above already guards against, one step later
  // in the sequence. Widening the scope cannot regress the success path: the
  // `finally` already ran there.
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
