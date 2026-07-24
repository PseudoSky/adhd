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
import type { Scope } from '@adhd/environment-base-spec';
import { extract, composeSchemas, type Operation } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import * as clientMod from './client.js';
import type { BacklogCtx } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';
import type { OutputPlugin, RunInput } from '@adhd/apigen-core-client';

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

function backlogDistDir(): string {
  // Resolves to `<packageRoot>/dist` whether this module runs bundled from
  // `dist/index.{js,mjs}` (rollup rewrites `import.meta.url` to the output
  // chunk's own URL) or from `src/server.ts` under vitest — see the
  // file-level DEVIATION doc comment above.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
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

async function extractClientOperations(): Promise<Operation[]> {
  const clientDts = join(backlogDistDir(), 'client.d.ts');
  if (!existsSync(clientDts)) {
    throw new Error(
      `@adhd/backlog: cannot mount — ${clientDts} does not exist. ` +
        `Run "nx build backlog" first (extract() needs the built .d.ts for type information).`
    );
  }
  return extract({ sourceFile: clientDts, namespace: 'backlog' });
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

  const runs: Promise<void>[] = [];
  if (opts.transport === 'http' || opts.transport === 'both') {
    runs.push(
      requireRun(apiFastifyPlugin)({
        packages: [pkg],
        outputDir: '',
        options: { port: opts.port ?? 3300, host: opts.host ?? '127.0.0.1', usePlugins: [openapiPlugin] },
        signal: opts.signal,
        operations,
      })
    );
  }
  if (opts.transport === 'mcp' || opts.transport === 'both') {
    runs.push(
      requireRun(mcpPlugin)({
        packages: [pkg],
        outputDir: '',
        options: { transport: 'stdio' },
        signal: opts.signal,
        operations,
      })
    );
  }

  try {
    await Promise.all(runs);
  } finally {
    closeGraphBacklogStore(store);
  }
}
