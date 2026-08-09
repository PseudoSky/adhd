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
 * derive JSON Schemas, but a shipped npm package's `dist/client.js` is
 * stripped JavaScript with none. `dist/client.d.ts` (emitted by
 * vite-plugin-dts, mirroring `src/`) carries the SAME type graph as the
 * `.ts` source via ambient `declare function` nodes — a documented,
 * anticipated extraction path (`@adhd/apigen-core-client`'s
 * `pickFunctionDeclWithBody` explicitly falls back to a body-less
 * `FunctionDeclaration`, i.e. exactly an ambient declaration). So `extract()`
 * targets the built `.d.ts` (always present once `nx build backlog` has run
 * — nothing here needs the raw `.ts` source shipped in the npm package),
 * while the live function references come from a plain STATIC import of
 * `client.js` (resolved by the bundler/module loader at build/load time, not
 * a runtime dynamic `import()` of a computed path) — avoiding the runtime
 * dynamic-import-of-a-string entirely. `import.meta.url` resolves to the
 * OUTPUT chunk's own URL once bundled (rollup's documented behavior), so
 * `<packageRoot>/dist/client.d.ts` is reachable the same way whether this
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
} from '@adhd/apigen-core-client';
import { createIrCacheLayer } from '@adhd/apigen-plugin-ir-cache';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import { batchPlugin } from '@adhd/apigen-plugin-batch';
import * as clientMod from './client.js';
import type { BacklogCtx } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
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
export function requireRun(plugin: OutputPlugin): (input: RunInput) => Promise<void> {
  if (!plugin.run) throw new Error(`@adhd/backlog: apigen plugin "${plugin.id}" declares no run() — cannot mount live`);
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
  const silent: Record<string, unknown> = { info: noop, error: noop, debug: noop, fatal: noop, warn: noop, trace: noop };
  silent['child'] = () => silent;
  return silent as unknown as Logger;
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
 * Resolves the directory that actually contains the built `client.d.ts` /
 * `client.js` artifacts, by PROBING for `client.d.ts` rather than assuming a
 * fixed relative path — because this module executes from THREE genuinely
 * different layouts and a single `../dist` computation cannot satisfy all
 * three (BUG confirmed live via `npm install @adhd/backlog@0.1.0`: it
 * crashed at mount with `.../node_modules/@adhd/dist/client.d.ts does not
 * exist`):
 *
 *  1. PUBLISHED (`node_modules/@adhd/backlog/…`): `@adhd/nx-build`'s
 *     `dist-manifest`/`publish` executors run `npm publish <distDir>` —
 *     `dist/` IS packed as the package root, so the shipped tarball has
 *     `index.js` and `client.d.ts` as SIBLINGS at the package root (there is
 *     no `dist/` subdirectory at all once installed). `dirname(import.meta.url)`
 *     here is already that root, so the OLD `join(here, '..', 'dist')` escaped
 *     one level too far, past the package root into
 *     `node_modules/@adhd/dist` — nonexistent.
 *  2. DEV-BUILT (`entrypoint/backlog/dist/index.{js,mjs}`, e.g. this repo's
 *     own `nx build backlog` output before packing): `client.d.ts` is ALSO a
 *     sibling of `index.js`, both living directly under `dist/`.
 *  3. VITEST (`src/server.ts` transformed and run in place): `client.d.ts`
 *     has not moved next to `src/` — it's still only in the built `dist/`,
 *     one level up and back down from `src/`.
 *
 * Layouts 1 and 2 are identical in shape (client.d.ts is a sibling of the
 * running module) and differ from layout 3 only in WHERE that sibling lives
 * relative to the module — so probing "is client.d.ts sitting right next to
 * me?" before falling back to the vitest-only `../dist` shape correctly
 * covers all three without needing to distinguish "published" from
 * "dev-built" explicitly.
 */
function backlogDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, 'client.d.ts'))) return here;
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
        for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
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
 * points it at a fresh throwaway file); default under the repo's canonical
 * `tmp/` (AGENTS.md §10 — gitignored, removable with `nx reset`).
 * `APIGEN_IR_CACHE_FILE` replaces the Revision-1 `APIGEN_IR_CACHE_DIR`.
 */
function irCacheFile(): string {
  return (
    process.env['APIGEN_IR_CACHE_FILE'] ??
    join(process.cwd(), 'tmp', 'apigen', 'ir-cache', 'backlog-client.ir.json')
  );
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
 * module doc) — backlog needs a DIFFERENT default file
 * (`backlog-client.ir.json`, not the plugin's own generic `default.ir.json`)
 * and a specific `extractorVersion` (`CORE_CLIENT_VERSION`, the actual
 * installed `@adhd/apigen-core-client` version, not an env-var-overridable
 * value), so it builds its own `Plugin`-shaped instance around the factory
 * instead — exactly the escape hatch that module doc describes for a caller
 * wanting non-default configuration in the same process.
 */
function backlogIrCachePlugin(): Plugin {
  return {
    id: 'ir-cache',
    description: 'Extract-stage IR cache, configured for the backlog hot path (BUG-019).',
    language: 'ts',
    capabilities: {
      extractLayer: {
        layer: createIrCacheLayer({
          cache: irCacheFile(),
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
 */
let extractInvoke: ((call: ExtractCall) => Promise<Operation[]>) | undefined;
function getExtractInvoke(): (call: ExtractCall) => Promise<Operation[]> {
  extractInvoke ??= createExtractInvokerFromPlugins(
    irCacheEnabled() ? [backlogIrCachePlugin()] : [],
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

async function extractClientOperations(): Promise<Operation[]> {
  const clientDts = join(backlogDistDir(), 'client.d.ts');
  if (!existsSync(clientDts)) {
    throw new Error(
      `@adhd/backlog: cannot mount — ${clientDts} does not exist. ` +
        `Run "nx build backlog" first (extract() needs the built .d.ts for type information).`
    );
  }
  // `dropFileSegment: true` (`ExtractOptions`, `@adhd/apigen-core-client`):
  // without it every op's `path` would unconditionally start with the
  // `client.d.ts` extraction FILENAME artifact (`normalizeFileName` →
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
  return getExtractInvoke()({
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
 * computed purely from the built `client.d.ts` (via `extractClientOperations`)
 * and never touch `ctx` at all, so a lazy caller can defer opening the real
 * backing store until a command that actually needs it is dispatched.
 */
export async function buildBacklogApigenPackage(ctx: BacklogCtx | (() => BacklogCtx)): Promise<{
  pkg: {
    id: string;
    schemas: ReturnType<typeof composeSchemas>;
    importPath: string;
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: () => Promise<BacklogCtx>;
  };
  operations: Operation[];
}> {
  const getCtx: () => BacklogCtx = typeof ctx === 'function' ? ctx : () => ctx;
  const operations = await extractClientOperations();
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
  return {
    pkg: {
      id: 'backlog',
      schemas,
      importPath: join(backlogDistDir(), 'client.js'),
      fns: clientMod as unknown as Record<string, (...args: unknown[]) => unknown>,
      createClient: async () => getCtx(),
    },
    operations,
  };
}

/**
 * Opens (or reuses) the backlog store + env, mounts every `client.ts` export
 * live via `@adhd/apigen-plugin-api-fastify` and/or `@adhd/apigen-plugin-mcp`
 * — no code generation.
 */
export async function startBacklogServer(opts: StartOpts): Promise<void> {
  const env = buildBacklogEnv({ scope: opts.scope, adhdRoot: opts.adhdRoot, cwd: opts.cwd });
  env.ensureDirs();
  const store = openGraphBacklogStore(env.files.db, env.config.db.busyTimeoutMs);
  const ctx: BacklogCtx = { store, env };

  const { pkg, operations } = await buildBacklogApigenPackage(ctx);
  const logger = testSilentLogger();

  const runs: Promise<void>[] = [];
  if (opts.transport === 'http' || opts.transport === 'both') {
    runs.push(
      requireRun(apiFastifyPlugin)({
        packages: [pkg],
        outputDir: '',
        options: { port: opts.port ?? 3300, host: opts.host ?? '127.0.0.1', usePlugins: [openapiPlugin, batchPlugin] },
        signal: opts.signal,
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

  try {
    await Promise.all(runs);
  } finally {
    closeGraphBacklogStore(store);
  }
}
