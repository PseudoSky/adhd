/**
 * extract-live.ts — the FALLBACK extraction path (design doc Revision 3,
 * `docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md`).
 *
 * This is the ONLY module in `entrypoint/backlog` that statically imports
 * extractor-touching code (`extract`, `createExtractInvokerFromPlugins`,
 * `createIrCacheLayer`). It is reached EXCLUSIVELY through a dynamic
 * `import('./extract-live.js')` from `server.ts` / `cli.ts`'s fallback, so the
 * baked-artifact startup path neither loads this module nor ever loads
 * ts-morph. Keeping the separation physical — a separate module behind a
 * dynamic import, not merely a lazy call inside a shared module — is what makes
 * the `server.startup-path.e2e.ts` require-probe meaningful.
 *
 * Two entry points:
 *  - {@link buildBakedOperations} — DETERMINISTIC, cache-bypassing extraction
 *    used by the `ir-artifact` build subcommand to author `dist/api.ir.json`.
 *  - {@link extractApiOperationsLive} — the runtime FALLBACK: the IR-cache
 *    invoker wrapping `extract()`, used only when the baked artifact is
 *    missing or stale.
 */
import { join } from 'node:path';
import {
  extract,
  createExtractInvokerFromPlugins,
  type ExtractCall,
  type Operation,
  type Plugin,
} from '@adhd/apigen-core-client';
import { createIrCacheLayer } from '@adhd/apigen-plugin-ir-cache';
import { resolveIrCacheFile } from './env.js';
import { backlogDistDir, EXPECTED_EXTRACTOR_VERSION } from './ir-artifact.js';

/**
 * FEAT-002: the extractor version stamped into every IR-cache entry — the
 * `@adhd/apigen-core-client` package version. Any change to the extractor's
 * output for the same input (a bug fix, new TS feature support, or a future
 * DEBT-003 fix making Path 2 correct for cross-referencing named types) bumps
 * this version, which changes the cache key and busts every stale entry — the
 * mechanism that keeps this cache from ever becoming a reason to defer DEBT-003.
 *
 * Sourced from {@link EXPECTED_EXTRACTOR_VERSION} (`./ir-artifact.js`) rather
 * than re-read here, so the version a runtime-cache entry is stamped with and
 * the version a baked artifact is validated against can never disagree.
 */
const CORE_CLIENT_VERSION: string = EXPECTED_EXTRACTOR_VERSION;

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
 * to"). It is NOT correct along the `--namespace sandbox`/test-isolation axis:
 * `cli.ts`'s `runBacklogCli` and `startBacklogServer` both already thread an
 * `adhdRoot` override through `buildBacklogEnv` for every OTHER path (the
 * real store, `env.ensureDirs()`), but this cache file's own
 * `resolveIrCacheFile({ adhdRoot, instanceId })` parameters were simply never
 * wired to it — so a `--namespace sandbox` invocation, despite reporting
 * (and genuinely using) an isolated store root, would still create
 * `~/.adhd/backlog/production/cache/apigen/ir-cache/...` on the real
 * machine `HOME` on its first extraction, defeating the isolation guarantee
 * `--namespace sandbox` advertises (caught by `cli.spec.ts`'s
 * "--namespace sandbox diverts the store away from the (fake) production
 * HOME entirely, and never creates anything under it" — a fake HOME stands
 * in for the real one there, but the bug is identical against a real HOME).
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
 *
 * SCOPE (design doc Revision 3): this switch governs the RUNTIME CACHE only.
 * It does NOT bypass the baked `dist/api.ir.json` artifact — that artifact is
 * the correctness/startup path, not a cache, and a caller cannot opt out of
 * it (there is no equivalent to "run a slower, live extraction" that would be
 * correct-but-slower here; the artifact is produced by the same build as the
 * `.d.ts` it describes).
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
 * AWAITED and durably (Revision 3) — a failing write is swallowed, never
 * fatal, but a successful one is complete before the caller resumes. Built
 * LAZILY on first use so callers/tests can point
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

/**
 * DETERMINISTIC, cache-bypassing extraction of `apiDts`.
 *
 * Runs the EXACT extraction {@link extractApiOperationsLive} would run on a
 * cache MISS — same `namespace`, same `dropFileSegment: true`, same (absent)
 * `tsconfig` — with no invoker and no cache in the path. Used by the
 * `ir-artifact` build subcommand to author `dist/api.ir.json`; the artifact's
 * operations are therefore byte-identical to what the runtime fallback would
 * produce for the same file, which is what lets `server.ts` prefer the artifact
 * without changing downstream schema composition.
 */
export async function buildBakedOperations(
  apiDts: string
): Promise<Operation[]> {
  return extract({
    sourceFile: apiDts,
    namespace: 'backlog',
    tsconfig: undefined,
    dropFileSegment: true,
  });
}

/**
 * The runtime FALLBACK extraction: derive `client.ts`'s mounted operations by
 * running the IR-cache invoker (a cache HIT returns the cached `Operation[]`
 * without re-running `extract()`; a MISS runs `extract()` and writes the
 * result through). Imported dynamically, and only when the baked artifact is
 * missing/stale — never on the hot path.
 */
export async function extractApiOperationsLive(
  opts: { adhdRoot?: string; instanceId?: string } = {}
): Promise<Operation[]> {
  const clientDts = join(backlogDistDir(), 'api.d.ts');
  // `dropFileSegment: true` (`ExtractOptions`, `@adhd/apigen-core-client`):
  // without it every op's `path` would unconditionally start with the
  // `api.d.ts` extraction FILENAME artifact (`normalizeFileName` →
  // `'client-d'`), leaking into every transport's name — `backlog client-d
  // create-item` / `backlog_client_d_create_item` instead of the intended
  // `backlog create-item` / `backlog_create_item`. Safe here because every
  // `client.ts` export is extracted from this ONE file, so there is no
  // cross-file name to disambiguate against; a genuine same-name collision
  // would still be caught at extract time by `checkCollisions`
  // (`@adhd/apigen-engine-naming`). `buildBakedOperations` uses the identical
  // call, so the baked and fallen-back operation sets match byte-for-byte.
  return getExtractInvoke(opts)({
    source: clientDts,
    host: 'ts',
    namespace: 'backlog',
    extractorOptions: {},
  });
}
