# Implementation Spec — FEAT-002 v1 Slice: Extract-Stage Invoker + `apigen-plugin-ir-cache`

Status: APPROVED-FOR-IMPLEMENTATION (v1 slice). Validates and amends
`docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md` (PROPOSAL).
Author: architect (content-first chain), 2026-08-02. Backlog: `adhd::FEAT-002` (HIGH, claimed).

## Summary

Ship the smallest correct slice of FEAT-002: a host-neutral extract-stage call contract
(`ExtractCall`/`ExtractResult`/`ExtractMiddleware`/`createExtractInvoker`) in
`@adhd/apigen-core-client`; a new plugin package `@adhd/apigen-plugin-ir-cache` (layer
capability + content-hash-keyed local filesystem backend); and wire it into `entrypoint/backlog`'s
`extractClientOperations()` — the exact function on BUG-019's measured ~4.2s CLI cold-start path —
so repeated invocations reuse the extracted `Operation[]` instead of re-running
ts-json-schema-generator. Proven by a call-counting behavioral test that goes RED if the cache key
reverts to mtime-based.

## Validation verdict (proposal claims vs. real code)

Every load-bearing citation in the proposal was re-read and **verified exact**:

| Proposal claim | Verified |
|---|---|
| `plugin.ts:623-698` `Plugin` has target/layer/mount/envelope | ✅ `plugin.ts:623-700` |
| `plugin.ts:302-327` `LayerCapability.layer(call, next)` with short-circuit | ✅ `plugin.ts:302-327` (`layer` at 326) |
| `plugin.ts:93` SPEC `Call` (has `.data`, no `.domainArgs`) vs `invoke.ts:68-82` runtime `Call` (has `.domainArgs`) | ✅ both read |
| `invoke.ts:176-209` `createInvoker`: schema lookup 182-187, dispatch `coreService` 190-198, `reduceRight` 202-205 | ✅ exact |
| `package-invoker.ts:124-137` `createPackageInvoker`; validate-Layer innermost at 135; `adaptCoreLayer` 108-116 | ✅ exact |
| `extract.ts:48-79` TS-shaped `ExtractOptions`; `extract()` at 90 | ✅ exact |
| `extraction-session.ts:74` mtime-based `mtimeMs:size` generator key; `schemaCache` 88-98; `statVersion` 106; `collectReferencedFiles` 120+ | ✅ exact |
| `server.ts:231-249` `extractClientOperations()` → `extract({sourceFile: clientDts, namespace: 'backlog', dropFileSegment: true})` at 249 | ✅ exact; reached via `buildBacklogApigenPackage` at 276 |
| SPEC §12 names `@adhd/apigen-ts-extractor` "drivable subprocess" | ✅ SPEC.md:490 |

**Amendment 1 — hot-path citation.** The proposal cites `cli.ts:150-177` as the BUG-019 call
site; that range is actually `resolveMountNamespaces`/`prefixCommand` (cli.ts:135-189), which is
also **another agent's uncommitted in-flight work** — do not touch it. The real, single call site
is `extractClientOperations()` at `server.ts:231-249`, reached unconditionally from
`runBacklogCli` (`cli.ts:283`, including for `--help` — the store opens lazily but extraction runs
eagerly, so the cache genuinely helps `--help` on every run after the first). Wiring point:
**`server.ts:231-249` + `buildBacklogApigenPackage` signature (server.ts:265).**

**Amendment 2 — cache directory.** The proposal suggests `tmp/apigen/ir-cache`. Correct that: an
IR cache is a persistent cross-process store, not ephemeral test output — repo AGENTS.md §10 puts
persistent app stores in the user home (`~/.adhd/…`). Default dir: `~/.adhd/apigen/ir-cache`
(env-overridable, see §3). Content-addressed keys make it valid across checkouts/machines.

**Amendment 3 — "reuse collectReferencedFiles".** The proposal says reuse `extraction-session.ts`'s
`collectReferencedFiles` walk. It cannot be reused as-is: it takes a **ts-morph `SourceFile`** and
is session-bound, and the cache-key computation on a HIT must run **without ever loading ts-morph**
(that is the whole point). v1 ships a small path-level walker inside the plugin (regex-scan of
`import … from '…'`/`export … from '…'` specifiers, relative-path resolution with extension
probing, `node_modules` skipped). Documented limitation: no tsconfig path-mapping/alias resolution
(backlog's generated `client.d.ts` has zero relative imports, so the v1 call site is unaffected).
Extracting a path-level walker into core-client later (for reuse by future hosts) is the follow-on.

## Files

| Path | Change | Notes |
|---|---|---|
| `packages/apigen/apigen-core-client/src/lib/extract-invoker.ts` | **create** | Contract + `composeOnion` + `createExtractInvoker` + `EXTRACTOR_VERSION` |
| `packages/apigen/apigen-core-client/src/index.ts` | modify | Export the 6 new symbols |
| `packages/apigen/apigen-plugin-ir-cache/` | **create** (generator) | `plugin` tier, `--group apigen --nxLayer logic --platform node` |
| `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts` | create | `IrCacheBackend`, `CachedExtractEntry`, `createIrCacheLayer` |
| `packages/apigen/apigen-plugin-ir-cache/src/lib/compute-cache-key.ts` | create | Content-hash key (sha256), path-level import walk |
| `packages/apigen/apigen-plugin-ir-cache/src/lib/local-fs-backend.ts` | create | `createFileSystemIrCacheBackend` (atomic write) |
| `packages/apigen/apigen-plugin-ir-cache/src/index.ts` | create | Barrel (generator emits; extend) |
| `packages/apigen/apigen-plugin-ir-cache/README.md` | create | Usage, trust note (shared-cache poisoning, per proposal §2.4) |
| `packages/apigen/apigen-plugin-ir-cache/src/lib/*.spec.ts` | create | Unit + behavioral (red-test first) |
| `entrypoint/backlog/src/server.ts` | modify | Wire layer into `extractClientOperations`; optional `opts` on `buildBacklogApigenPackage` |
| `entrypoint/backlog/src/cli.ts` | modify | `RunBacklogCliOpts.irCacheDir?` passthrough (ONE additive hunk; do NOT touch the uncommitted batch-prefix hunks in this file) |
| `entrypoint/backlog/src/__tests__/ir-cache.integration.spec.ts` | create | Real `runBacklogCli` twice, entry-count stability |
| `entrypoint/backlog/package.json` | modify | Add `"@adhd/apigen-plugin-ir-cache": "^0.2.0"`; `nx run backlog:sync-deps` |

## Interface changes

### New: `packages/apigen/apigen-core-client/src/lib/extract-invoker.ts`

```ts
import type { Operation } from './descriptor';

/** One source unit to extract from — host-neutral, deliberately NOT ts-morph-shaped. */
export interface ExtractCall {
  /** Absolute path to the source artifact (a .ts/.d.ts today; a module root for a future subprocess extractor). */
  source: string;
  /** Owning language runtime tag: 'ts' today; 'py' | 'rust' tomorrow (SPEC §4 host). */
  host: string;
  /** Namespace segment (SPEC §4). */
  namespace?: string;
  /** Opaque extractor-specific options (tsconfig/dropFileSegment for TS today). Read only by the terminal extractor step. */
  extractorOptions?: Record<string, unknown>;
  /** Opt-in caller identity hint (cache-key purposes). Never trusted for a shared cache without re-hashing. */
  versionHint?: string;
}

/** Extraction's result is already the host-neutral shape: reuse Operation[] verbatim. */
export type ExtractResult = Operation[];

export type ExtractMiddleware =
  (call: ExtractCall, next: () => Promise<ExtractResult>) => Promise<ExtractResult>;

/** Stage-agnostic right-fold (identical algebra to invoke.ts:202-205). Dispatch-side refactor deferred. */
export function composeOnion<TCall, TResult>(
  middlewares: readonly ((call: TCall, next: () => Promise<TResult>) => Promise<TResult>)[],
  core: (call: TCall) => Promise<TResult>
): (call: TCall) => Promise<TResult>;

export function createExtractInvoker(
  middlewares: readonly ExtractMiddleware[],
  runExtractor: (call: ExtractCall) => Promise<ExtractResult>
): (call: ExtractCall) => Promise<ExtractResult>;

/**
 * Cache-key identity of the extractor implementation. DEBT-003's eventual fix MUST bump this
 * (it changes extractor output for identical input → stale entries must invalidate).
 * Keep in sync with package.json version.
 */
export const EXTRACTOR_VERSION: string; // '0.2.2' today
```

### New: `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts`

```ts
import type { ExtractCall, ExtractMiddleware, ExtractResult, EXTRACTOR_VERSION } from '@adhd/apigen-core-client';

export const CURRENT_FORMAT_VERSION = 1;

export interface CachedExtractEntry {
  formatVersion: number;      // gate at read time: mismatches are ignored (miss)
  operations: ExtractResult;  // exactly what runExtractor would have produced
  extractorVersion: string;
  createdAt: string;          // ISO timestamp (provenance)
}

export interface IrCacheBackend {
  get(key: string): Promise<CachedExtractEntry | undefined>; // must not throw on miss
  put(key: string, entry: CachedExtractEntry): Promise<void>; // callers fire-and-forget
}

export interface IrCacheLayerOptions {
  backend: IrCacheBackend;
  /** Defaults to EXTRACTOR_VERSION; tests override to prove key sensitivity. */
  extractorVersion?: string;
}

/** Layer: on hit (format-valid) return cached operations WITHOUT calling next();
 *  on miss run next(), then fire-and-forget put(). Write failures are non-fatal. */
export function createIrCacheLayer(opts: IrCacheLayerOptions): ExtractMiddleware;
```

### New: `packages/apigen/apigen-plugin-ir-cache/src/lib/local-fs-backend.ts`

```ts
export interface FileSystemIrCacheBackendOptions { dir: string; }
/** key = hex sha256 → <dir>/<key>.json; ENOENT → undefined; atomic write (tmp + rename). */
export function createFileSystemIrCacheBackend(opts: FileSystemIrCacheBackendOptions): IrCacheBackend;
```

### Modify: `entrypoint/backlog/src/server.ts`

```ts
// BEFORE (line 39): import { extract, composeSchemas, type Operation } from '@adhd/apigen-core-client';
// AFTER:            import { extract, composeSchemas, createExtractInvoker, type Operation, type ExtractCall } from '@adhd/apigen-core-client';
// ADD:              import { createIrCacheLayer, createFileSystemIrCacheBackend } from '@adhd/apigen-plugin-ir-cache';

// BEFORE (line 265):
export async function buildBacklogApigenPackage(ctx: BacklogCtx | (() => BacklogCtx)): Promise<{…}>
// AFTER:
export interface BacklogPackageOpts { irCacheDir?: string; } // 'off' disables the cache
export async function buildBacklogApigenPackage(
  ctx: BacklogCtx | (() => BacklogCtx),
  opts: BacklogPackageOpts = {}
): Promise<{…}>
```

`extractClientOperations` (server.ts:231-249) becomes:

```ts
const RUN_EXTRACTOR = (call: ExtractCall) =>
  extract({
    sourceFile: call.source,
    namespace: call.namespace,
    dropFileSegment: call.extractorOptions?.dropFileSegment === true,
  });

let irCacheLayer: ExtractMiddleware | undefined; // module-level lazy singleton
function resolveIrCacheLayer(dir: string | undefined): ExtractMiddleware | undefined {
  const effective = dir ?? process.env.BACKLOG_IR_CACHE_DIR;
  if (effective === undefined || effective === '' || effective === 'off') return undefined;
  return (irCacheLayer ??= createIrCacheLayer({
    backend: createFileSystemIrCacheBackend({ dir: effective }),
  }));
}
// default dir when unset: join(os.homedir(), '.adhd', 'apigen', 'ir-cache')

async function extractClientOperations(irCacheDir?: string): Promise<Operation[]> {
  // …existing client.d.ts existence check unchanged…
  const call: ExtractCall = {
    source: clientDts,
    host: 'ts',
    namespace: 'backlog',
    extractorOptions: { dropFileSegment: true },
  };
  const layer = resolveIrCacheLayer(irCacheDir);
  if (!layer) return extract({ sourceFile: clientDts, namespace: 'backlog', dropFileSegment: true });
  return createExtractInvoker([layer], RUN_EXTRACTOR)(call);
}
// call site (line 276): const operations = await extractClientOperations(opts.irCacheDir);
```

### Modify: `entrypoint/backlog/src/cli.ts` (ONE additive hunk only)

```ts
// RunBacklogCliOpts gains: irCacheDir?: string;
// Line 283: const { pkg, operations } = await buildBacklogApigenPackage(getCtx, { irCacheDir: opts.irCacheDir });
```

## Behavioral changes

- **Default ON in backlog.** Every `runBacklogCli`/`startBacklogServer` invocation reuses the
  cached `Operation[]` when the content-hash key matches. First run after a clean state (or after
  any content/extractor change) still pays full extraction; every subsequent run skips it. This is
  safe for backlog because `client.d.ts` is one file with zero relative imports (miss-path hashing
  cost ≈ hashing one file) and the store remains lazily opened (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001
  unaffected).
- **Key = sha256(extractorVersion, formatVersion, host, namespace, contentHash(entry),
  contentHash(sorted concatenated relative imports))** — never mtime/size. Imported-file content
  changes invalidate; mtime-only changes do not.
- **Hit path never touches ts-morph** (no session, no Project) — the layer short-circuits above
  `runExtractor`.
- **Cache failure is invisible:** backend `get` throw → miss → recompute; `put` rejection →
  fire-and-forget, result still returned.
- **`formatVersion` mismatch → miss** (stale entries ignored, not misread).
- **DEBT-003 coupling honored:** extraction path is UNCHANGED (still Path-1-correct for
  cross-referencing named types). The cache persists whatever the correct path produces.
  `EXTRACTOR_VERSION` is the single constant DEBT-003's fix must bump. DEBT-003 stays OPEN and
  tracked; this slice does not mask it.
- **Other hosts unaffected:** apigen-cli orchestrator wiring, dispatch-side `composeOnion`
  refactor, remote backend, per-type fragment cache, `apigen-ts-extractor` subprocess — all
  explicitly deferred (proposal §4.5).

## Independent segments & execution order

### Segment 1 — core-client contract (foundation)
- Files: `extract-invoker.ts` (create), `src/index.ts` (add exports).
- No deps. ~120 lines. Commit: `feat(apigen-core-client): host-neutral extract-stage contract (FEAT-002)`.
- Verify: `CI=true npx nx test apigen-core-client` (208 existing tests must stay green — additive only).

### Segment 2 — plugin package (scaffold + logic)
- `npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node --dry-run` first, then for real. Set version `0.2.0` in package.json (apigen family). Mirror `apigen-plugin-batch` tags (`domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain`).
- Implement `compute-cache-key.ts`, `local-fs-backend.ts`, `ir-cache-layer.ts`, barrel, README.
- **Write the behavioral spec FIRST (red), then implement (green).** Prove the mtime negative control goes red against an mtime-keyed stub.
- Verify: `CI=true npx nx test apigen-plugin-ir-cache`; `npx nx build apigen-plugin-ir-cache`; `verify-dist-load` if the target exists.
- Commit: `feat(apigen-plugin-ir-cache): content-hash IR cache layer + fs backend (FEAT-002)`.

### Segment 3 — backlog wiring + integration test
- `server.ts` (imports, opts, `extractClientOperations`), `cli.ts` (one additive hunk), `package.json` dep, `npx nx run backlog:sync-deps`.
- New `src/__tests__/ir-cache.integration.spec.ts`.
- Verify: `CI=true npx nx test backlog` (197 existing tests stay green), new integration test green, `npx nx lint backlog apigen-plugin-ir-cache` (after `corepack yarn install` in the worktree).
- Commit: `feat(backlog): wire IR cache into extractClientOperations (FEAT-002)`.

## Test cases

### `apigen-plugin-ir-cache` — `ir-cache-layer.spec.ts` (call-counting, deterministic, no timers)
1. Miss then hit: extractor spy called 1× across two identical calls; backend `get` returns entry on 2nd.
2. **mtime negative control (the teeth):** run once → touch file mtime only (`fs.utimes`) → run again → extractor still 1× (HIT). Revert key to `statVersion`/mtime → this test goes RED.
3. Content change → extractor 2× (MISS).
4. `extractorVersion` change (layer option) → MISS (key sensitivity).
5. `formatVersion` mismatch → MISS (stale ignored).
6. `backend.get` throws → MISS, `next()` still runs, result returned.
7. `backend.put` rejects → result still returned (non-fatal).

### `compute-cache-key.spec.ts`
- Same content ⇒ same key (deterministic, cross-call).
- Namespace/host change ⇒ different key.
- Entry file content change ⇒ different key.
- Relative-import file content change ⇒ different key (transitive).
- `node_modules`/bare specifier imports ignored; missing relative import skipped (no throw).

### `local-fs-backend.spec.ts`
- put → get roundtrip; missing key → undefined; concurrent put of distinct keys; read never sees a partial file (atomic write); all under a `tmp/` test dir, cleaned in teardown.

### `entrypoint/backlog/src/__tests__/ir-cache.integration.spec.ts` (real components)
- Set `BACKLOG_IR_CACHE_DIR` to a per-test `tmp/` dir (and `build backlog` via `dependsOn`).
- Drive `runBacklogCli(['get-item','--repo','adhd','--human-id','FEAT-002'])` twice.
- Assert both exit 0 AND the cache dir contains exactly **1** entry after the second run (entry-count stability = HIT proxy; deterministic, no wall-clock).
- Negative control: rerun after disabling (`irCacheDir:'off'`) → still exits 0.
- Teardown removes the tmp cache dir.

## Risks / open items (carried, not resolved)

1. Two `Call` shapes for extract vs dispatch layers — accepted asymmetry (proposal §5.1).
2. Path-level import walker: no tsconfig path-mapping/alias resolution in v1; bare specifiers skipped. Documented. Backlog's `client.d.ts` has no relative imports.
3. Lockfile/dependency-version drift not covered by the v1 key (proposal §5.3) — `extractorVersion` catches extractor-side changes only.
4. Shared-cache trust model (poisoning) — inherits Nx's model; MUST be stated in the plugin README.
5. Miss-path hashing cost on large fan-in files unmeasured — negligible for the v1 call site (single file).
6. `composeOnion` dispatch-side refactor stays deferred (proposal §1.1/§4).

## Do NOT touch

- `entrypoint/backlog/src/cli.ts` lines 135-189 (`resolveMountNamespaces`/`prefixCommand`) and any other uncommitted hunks in that file — **another agent's in-flight batch-prefix work**; integrate additively in the non-overlapping `runBacklogCli` opts region only.
- `.mcp.json`, `entrypoint/agent-mcp/src/__tests__/mcpjson-registration.test.ts`, `packages/ai/*` (dead paths).
- Never `git reset --hard`, `git stash`, `git clean -f`; never `git add -A`. Worktree only under `.worktrees/`.
