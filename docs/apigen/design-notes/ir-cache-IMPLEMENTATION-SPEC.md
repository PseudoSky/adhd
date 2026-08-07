# Implementation Spec — FEAT-002: extract-stage onion + shareable IR-cache plugin

Status: APPROVED FOR IMPLEMENTATION (architect stage, chain product→architect→typescript→review).
Implements the "smallest correct slice" of `docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md`
(the 515-line PROPOSAL — every line below that cites the codebase was re-verified by the architect
against source, not copied from the proposal).

Backlog: FEAT-002 (OPEN, HIGH, claimed). Ordering constraint: DEBT-003 stays OPEN — this slice
must NOT change extraction-path behavior and must key on `extractorVersion` so a future DEBT-003
fix invalidates the cache like any other extractor change.

## 0. Verified facts (architect re-check)

- `extract.ts:48-79` `ExtractOptions = {sourceFile, namespace?, dropFileSegment?, tsconfig?, session?}` — TS-shaped input, `Operation[]` output. `extract()` at `:90`.
- `extraction-session.ts:120-142` `collectReferencedFiles(sf: SourceFile, seen)` — private, ts-morph-typed walk of local (non-node_modules) transitive imports. The thing to reuse.
- `extraction-session.ts:74,106` existing in-process cache is `mtimeMs:size`-keyed — the wrong key for cross-process sharing (the anti-pattern this feature replaces, not duplicates).
- `server.ts:231-250` `extractClientOperations()` — module-private, called ONLY at `server.ts:276` inside `buildBacklogApigenPackage()`. Zero external blast radius. Hot path of BUG-019.
- `server.ts:140-144` `backlogDistDir()` — probes for the built `client.d.ts` (published / dev-built / vitest layouts).
- `package-invoker.ts:108-116` `adaptCoreLayer` — dispatch-layer adapter precedent; extract needs its own shape (no `domainArgs`/`envelope`).
- `client.ts` imports `./model.js`, `./env.js`, `./store/*.js`, `@adhd/environment` — the built `client.d.ts` therefore has a real transitive local-import graph; the cache key MUST cover it (multi-file case is not hypothetical here).
- Backlog test target `dependsOn: ["^build","build","assets"]` (`project.json`) — the built `dist/client.d.ts` is present when `nx test backlog` runs.
- Scaffolding: `npx nx g @adhd/workspace-codegen-nx:plugin --name=ir-cache --group=apigen --nxLayer=logic --platform=node` → `packages/apigen/apigen-plugin-ir-cache` (verified via dry-run; tags `domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain`). Model package: `apigen-plugin-batch` (platform:node, layer:logic).
- gitnexus MCP not available in this session — blast radius established by direct grep: `extractClientOperations` referenced only in `server.ts` + spec comments; new exports have zero consumers.

## 1. Strategy

Add the host-neutral extract-stage contract (`ExtractCall`/`ExtractResult`/`ExtractMiddleware`/
`composeOnion`/`createExtractInvoker`) to `apigen-core-client`; add a reusable transitive-local-
import path collector (`collectLocalImportPaths`) beside the existing walk it wraps; ship a new
`apigen-plugin-ir-cache` package (content-hash-keyed `IrCacheBackend` seam + local filesystem
backend + a cache layer); wire ONE real call site — `entrypoint/backlog`'s
`extractClientOperations()` (the BUG-019 hot path) — through the invoker with the cache layer.
Prove HIT/MISS semantics with a call-counting behavioral test that goes RED if the key is
mtime-based, plus a real-CLI integration test proving the cache writes/hits on the actual hot
path. Everything else from the proposal (apigen-cli orchestrator wiring, `composeOnion` refactor
of `apigen-engine-runtime`'s `createInvoker`, remote backend, per-type fragments, `apigen-ts-
extractor` subprocess split) is explicitly DEFERRED.

## 2. Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| packages/apigen/apigen-core-client/src/lib/extract-invoker.ts | create | 0 | ~120 |
| packages/apigen/apigen-core-client/src/lib/extraction-session.ts | modify | ~60 (lines 108-155) | ~35 |
| packages/apigen/apigen-core-client/src/index.ts | modify | ~10 | ~6 |
| packages/apigen/apigen-plugin-ir-cache/* | create (scaffold) | 0 | generator |
| packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts | create | 0 | ~150 |
| packages/apigen/apigen-plugin-ir-cache/src/lib/backends/fs-backend.ts | create | 0 | ~45 |
| packages/apigen/apigen-plugin-ir-cache/src/index.ts | create | 0 | ~6 |
| packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.spec.ts | create | 0 | ~160 |
| packages/apigen/apigen-plugin-ir-cache/src/lib/apigen-apigen-plugin-ir-cache.ts | delete (scaffold placeholder) | 0 | 0 |
| packages/apigen/apigen-plugin-ir-cache/src/lib/apigen-apigen-plugin-ir-cache.spec.ts | delete (scaffold placeholder) | 0 | 0 |
| entrypoint/backlog/src/server.ts | modify | ~60 (lines 35-48, 231-250) | ~30 |
| entrypoint/backlog/src/ir-cache.integration.spec.ts | create | 0 | ~110 |
| docs/apigen/design-notes/ir-cache-IMPLEMENTATION-SPEC.md | create (this doc) | 0 | done |

Also: bump `apigen-core-client` package version (new public exports → minor bump) and
`entrypoint/backlog` package version (new dependency). Run `npx nx affected -t test lint` at the end.

## 3. Interface changes

### New: packages/apigen/apigen-core-client/src/lib/extract-invoker.ts

```typescript
// Pure TS, no node imports — safe for platform:shared core-client.
import type { Operation } from './descriptor';

/** One source unit to extract. Deliberately host-neutral: source/host/namespace +
 *  opaque extractor options — NOT {sourceFile, tsconfig} (ts-morph's option names). */
export interface ExtractCall {
  /** Absolute path to the source artifact (a .d.ts/.ts file today; a module root
   *  for a future subprocess extractor — the contract doesn't care which). */
  source: string;
  /** Declared language runtime tag, e.g. 'ts' | 'py' | 'rust' (SPEC §4 host). */
  host: string;
  /** Namespace segment (SPEC §4). */
  namespace?: string;
  /** Extractor-specific options (tsconfig path for TS) — opaque to the onion. */
  extractorOptions?: Record<string, unknown>;
  /** Opt-in caller identity tag for cache-key purposes (never trusted unverified). */
  versionHint?: string;
}

/** Extraction's result is already the host-neutral descriptor shape — reuse verbatim. */
export type ExtractResult = Operation[];

/** Stage-agnostic middleware step. Same algebra as dispatch's Layer. */
export type ExtractMiddleware = (
  call: ExtractCall,
  next: () => Promise<ExtractResult>
) => Promise<ExtractResult>;

/** Generic right-fold onion composition around an arbitrary innermost service.
 *  Identical composition algebra to invoke.ts's createInvoker reduceRight
 *  (outermost-first; a middleware returning without calling next short-circuits). */
export function composeOnion<TCall, TResult>(
  middlewares: readonly ((call: TCall, next: () => Promise<TResult>) => Promise<TResult>)[],
  core: (call: TCall) => Promise<TResult>
): (call: TCall) => Promise<TResult> {
  return async (call: TCall) => {
    const coreStep = () => core(call);
    const chain = middlewares.reduceRight(
      (innerNext, mw) => () => mw(call, innerNext),
      coreStep
    );
    return chain();
  };
}

/** Compose an extract-stage invoker: layer plugins wrapping the terminal extractor.
 *  A cache layer sits ABOVE runExtractor, so a HIT never invokes it. */
export function createExtractInvoker(
  middlewares: readonly ExtractMiddleware[],
  runExtractor: (call: ExtractCall) => Promise<ExtractResult>
): (call: ExtractCall) => Promise<ExtractResult> {
  return composeOnion(middlewares, runExtractor);
}
```

### Modify: packages/apigen/apigen-core-client/src/lib/extraction-session.ts

Add (exported; reuse the existing private walk — do NOT reinvent it):

```typescript
// AFTER (new export, appended near collectReferencedFiles/fileVersion):
/**
 * Absolute paths of every LOCAL (non-node_modules) file transitively imported by
 * `entryPath`, in deterministic (sorted) order. Host-neutral, path-in/paths-out —
 * reuses the same collectReferencedFiles walk the session uses, via a
 * process-lifetime minimal Project (syntactic module resolution only, no lib.d.ts,
 * no type checking). Cache-key companion: content-hash each returned path.
 * Cleared by clearPersistentProjectCache().
 */
export function collectLocalImportPaths(entryPath: string): string[]: // ...
```

Implementation note: build the walk on a module-level singleton
`new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { noLib: true } })`
(created lazily; cleared in `clearPersistentProjectCache()`); `addSourceFileAtPath(entryPath)`
then run the existing `collectReferencedFiles(sf, seen)`; return `[...seen].sort()`.
If `noLib` breaks `getModuleSpecifierSourceFile()` resolution, fall back to a Project WITHOUT
`noLib` but created once per process (the ~1-2s lib.d.ts parse then happens once per process,
not per call — still negligible vs the ~3.4s extraction it protects). Never call
`new Project(...)` per key computation.

### Modify: packages/apigen/apigen-core-client/src/index.ts

Add to the existing export block (near `extract` exports):
`export { composeOnion, createExtractInvoker, collectLocalImportPaths } from './lib/...';`
plus `export type { ExtractCall, ExtractResult, ExtractMiddleware }`.

### New: packages/apigen/apigen-plugin-ir-cache (scaffold via workspace-codegen-nx, then fill)

`src/lib/ir-cache-layer.ts`:

```typescript
import type { ExtractCall, ExtractMiddleware, ExtractResult, Operation,
  collectLocalImportPaths } from '@adhd/apigen-core-client';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const CURRENT_FORMAT_VERSION = 1;

export interface CachedExtractEntry {
  formatVersion: number;
  operations: Operation[];
  extractorVersion: string;
  createdAt: string;
}

export interface IrCacheBackend {
  /** Fetch by key; undefined on miss. MUST NOT throw on miss. */
  get(key: string): Promise<CachedExtractEntry | undefined>;
  /** Store an entry. May fire-and-forget. */
  put(key: string, entry: CachedExtractEntry): Promise<void>;
}

/** Content/version-addressed key — NOT mtime. Includes extractorVersion so a
 *  DEBT-003 fix (extractor output change) naturally busts every stale entry. */
export async function computeCacheKey(
  call: ExtractCall,
  extractorVersion: string
): Promise<string>; // sha256 over {formatVersion, extractorVersion, host, namespace,
                   //   sourceHash: sha256(content(call.source)),
                   //   deps: [{path, sha256(content)} ...] via collectLocalImportPaths}

export function createIrCacheLayer(
  backend: IrCacheBackend,
  opts: { extractorVersion: string }
): ExtractMiddleware; // get → formatVersion gate → hit? return : next() → put (fire-and-forget, catch)
```

`src/lib/backends/fs-backend.ts`:

```typescript
import { IrCacheBackend, CachedExtractEntry } from '../ir-cache-layer';
/** Content-addressed dir: <dir>/<key>.json. get returns undefined on missing file
 *  (never throws on miss). put is writeFile (fire-and-forget by the layer). */
export function createLocalFsBackend(dir: string): IrCacheBackend;
```

`src/index.ts`: `export { createIrCacheLayer, computeCacheKey, CURRENT_FORMAT_VERSION } from './lib/ir-cache-layer'; export type { IrCacheBackend, CachedExtractEntry } from './lib/ir-cache-layer'; export { createLocalFsBackend } from './lib/backends/fs-backend';`

### Modify: entrypoint/backlog/src/server.ts

- Add imports: `createExtractInvoker, type ExtractCall` from `@adhd/apigen-core-client`; `createIrCacheLayer, createLocalFsBackend` from `@adhd/apigen-plugin-ir-cache`; `createRequire` from `node:module`.
- Module-level wiring (built once per process, mirroring `USE_PLUGINS` composition style):

```typescript
const require2 = createRequire(import.meta.url);
const CORE_CLIENT_VERSION: string = require2('@adhd/apigen-core-client/package.json').version;
// fallback if the bundler rejects createRequire on package.json:
//   import coreClientPkg from '@adhd/apigen-core-client/package.json' + resolveJsonModule

const extractInvoke = createExtractInvoker(
  [createIrCacheLayer(createLocalFsBackend(irCacheDir()), { extractorVersion: CORE_CLIENT_VERSION })],
  (call: ExtractCall) => extract({
    sourceFile: call.source,
    namespace: call.namespace,
    tsconfig: typeof call.extractorOptions?.tsconfig === 'string' ? call.extractorOptions.tsconfig : undefined,
    dropFileSegment: true,
  })
);

function irCacheDir(): string {
  return process.env['APIGEN_IR_CACHE_DIR'] ?? join(process.cwd(), 'tmp', 'apigen', 'ir-cache');
}
```

- Change `extractClientOperations()` (lines 231-250): replace the final
  `return extract({ sourceFile: clientDts, namespace: 'backlog', dropFileSegment: true });`
  with
  `return extractInvoke({ source: clientDts, host: 'ts', namespace: 'backlog', extractorOptions: {} });`
  Signature MAY gain an optional `cacheDir?: string` param for tests (default via `irCacheDir()`);
  if so, thread it to the module-level layer via a `withCacheDir()` — simplest: make
  `irCacheDir()` respect `APIGEN_IR_CACHE_DIR` only, and have the integration test SET that env var.

## 4. Behavioral changes

### server.ts — extractClientOperations()
- **Change:** extraction now flows through `createExtractInvoker([irCacheLayer], runTsExtractor)`.
- **On cache HIT:** `extract()` is never invoked — `extractInvoke` returns the cached `Operation[]`.
- **On cache MISS:** `extract()` runs as today; result is written to the fs backend fire-and-forget.
- **Default behavior unchanged for output correctness:** identical `Operation[]` either way
  (the cache stores exactly what `extract()` would have produced — no schema post-processing is
  cached; `dereferenceSchema`/`composeSchemas` still run on the returned operations downstream).
- **Backward compat:** `extract()`/`ExtractOptions` untouched; every other consumer of
  `apigen-core-client` unaffected (new exports only).
- **Determinism:** `Operation[]` contains no timestamps — serialized entries are stable.

### ir-cache-layer — key semantics (the contract that must never regress)
- Key = f(extractorVersion, formatVersion, host, namespace, sha256(source content),
  sha256(every transitive local import's content)). NO mtime anywhere.
- A cache hit must return byte-identical operations to a fresh extraction of identical content.
- `put` failures are swallowed (logged at debug) — a cache write must never fail a CLI run.

## 5. Independent segments

### Segment A — core-client contract (extract-invoker.ts + index.ts)
- **Files:** extract-invoker.ts (create), index.ts (modify ~2 lines).
- **Dependencies:** none (pure TS, imports only `Operation` type from sibling descriptor).
- **Read tokens:** 0 new-file; ~10 index.ts. **Output:** ~130.
- **Verify:** `npx nx test apigen-core-client` stays green (additive only).

### Segment B — collectLocalImportPaths (extraction-session.ts + index.ts)
- **Files:** extraction-session.ts (modify ~30 lines), index.ts (modify ~1 line).
- **Dependencies:** Segment A not required (independent of extract-invoker).
- **Read tokens:** ~60 (lines 108-155 region). **Output:** ~40.
- **Verify:** add 2 unit tests (transitive walk returns sorted absolute paths; node_modules
  excluded; entry with no imports → [entry]).

### Segment C — apigen-plugin-ir-cache package
- **Files:** scaffold via generator; fill ir-cache-layer.ts, backends/fs-backend.ts, index.ts;
  delete the two scaffold placeholder files; package.json deps += `@adhd/apigen-core-client`.
- **Dependencies:** Segments A + B (imports `Operation`, `createExtractInvoker` types,
  `collectLocalImportPaths`).
- **Read tokens:** 0 (model on apigen-plugin-batch). **Output:** ~360 + generator output.
- **Verify:** `npx nx test apigen-plugin-ir-cache` + `npx nx lint apigen-plugin-ir-cache`.

### Segment D — backlog hot-path wiring
- **Files:** server.ts (modify lines 35-48 imports + lines 231-250 + module wiring).
- **Dependencies:** Segments A + C (invoker + layer + backend).
- **Read tokens:** ~60. **Output:** ~35.
- **Verify:** `npx nx build backlog` + `npx nx test backlog`.

### Segment E — behavioral + integration tests
- **Files:** plugin spec (create), backlog integration spec (create).
- **Dependencies:** C + D.
- **Read tokens:** 0. **Output:** ~270.

## 6. Execution strategy (typescript agent — surgical, in a fresh worktree from `main`)

1. `git worktree add <tmp>/feat-002 main` — branch `feat-002`; NEVER touch `main` directly.
2. Scaffold the plugin: dry-run first, then
   `npx nx g @adhd/workspace-codegen-nx:plugin --name=ir-cache --group=apigen --nxLayer=logic --platform=node`.
   Read the CREATE list. Then replace placeholders per Segment C.
3. Implement Segments A → B → C → D in order (each compiles/testable before the next).
4. Write Segment E tests LAST — then run the full suite. Confirm the anti-pattern test goes RED
   when you temporarily make the key mtime-based (then revert — proving the teeth).
5. Version bumps: `apigen-core-client` minor (new exports), `backlog` patch (new dep),
   `apigen-plugin-ir-cache` 0.1.0. `npx nx affected -t sync-deps` if dependency-checks complains.
6. Commits: `FEAT-002: <segment>` per segment (clear FEAT-002 prefixed messages).
7. Final gate: `npx nx affected -t test lint build` green; `npx nx run backlog:verify-dist-load`
   if it exists for the entrypoint.
8. Do NOT: touch `morph-walk.ts` / `ts-json-schema.ts` / `extract.ts` internals (DEBT-003 scope);
   do NOT refactor `apigen-engine-runtime`'s `createInvoker`; do NOT build a remote backend;
   do NOT wire apigen-cli's orchestrator.

## 7. Test cases

### Plugin unit/behavioral (apigen-plugin-ir-cache/src/lib/ir-cache-layer.spec.ts) — default-running, deterministic, no sleep
Real fs backend in `mkdtemp(<repo>/tmp/apigen/ir-cache-test-)`. Real temp source + imported files.
`runExtractor` = `vi.fn()` returning a fixture `Operation[]`. Invoker via `createExtractInvoker`.
1. First call → MISS: spy called once; result === fixture.
2. Second call, same content → HIT: spy NOT called again; result deep-equals fixture.
3. `utimesSync(source)` (mtime touch, content same) → HIT: spy NOT called. **RED if key is mtime-based.**
4. Edit imported file content → MISS: spy called again.
5. Edit source content → MISS: spy called again.
6. Pre-seed entry with `formatVersion: 999` → treated as MISS (format gate).
7. Backend: `get` on missing key → `undefined`, no throw; `put` then `get` round-trips.
8. `computeCacheKey`: deterministic across calls; differs on content change; differs on
   extractorVersion change; covers transitive imports (change only the imported file → key changes).

### Backlog integration (entrypoint/backlog/src/ir-cache.integration.spec.ts) — real components
Real `runBacklogCli(['--help'])` (built dist present via test `dependsOn`), with
`APIGEN_IR_CACHE_DIR` set to a fresh tmp dir:
1. Run 1 → resolves; cache dir contains exactly 1 entry file; record its `mtimeMs`.
2. Run 2 → resolves; entry file count still 1 AND its mtime UNCHANGED (no `put` ⇒ HIT, not
   merely "same key overwritten" — the hit-proof).
3. `utimesSync(<backlogDistDir>/client.d.ts)` (mtime only) → Run 3 → resolves; count still 1,
   mtime still unchanged (content-addressed key proven on the REAL hot path).
Assert via exit/resolution, not stdout greps. No sleeps, no timing.

### Regression
`npx nx affected -t test` — all apigen + backlog suites green (existing 208 core-client tests
must pass unchanged; backlog's cli/server/mcp/serve specs must pass unchanged).

## 8. Risks / open questions (accepted for this slice, from proposal §5)

1. **Two Call shapes** (dispatch `Call` vs `ExtractCall`): accepted asymmetry, documented in the
   proposal. Extract-layer plugins write against `ExtractCall` — no unification attempted.
2. **Transitive-hash cost on miss:** mitigated by reusing the existing walk + singleton project;
   on HIT the hash is computed anyway (unavoidable — needed before hit/miss is known). Profiled
   during implementation; if a large fan-in file makes the hash itself slow, that's a follow-up,
   not a blocker.
3. **Lockfile/dependency drift not in the v1 key:** a dep version bump changing a type's shape
   without touching local files = false HIT. Accepted for v1; `extractorVersion` covers
   extractor-side changes; noted in the plugin README.
4. **`collectLocalImportPaths` Project construction:** risk of a per-call `new Project` cost.
   Spec mandates a process-lifetime singleton; `noLib` first, fallback documented.
5. **Shared-cache trust model:** inherited from Nx's remote-cache model, NOT built here (local
   backend only). The remote backend remains a documented seam (`IrCacheBackend`), unimplemented.
6. **DEBT-003 interaction:** this cache persists whatever `extract()` produces today (Path 1 for
   cross-referencing named types). Fixing DEBT-003 later is an ordinary `extractorVersion` bump
   that busts the cache — the mechanism that keeps this cache honest. No action in this slice
   beyond that invariant.

## 9. Disclosure

No new bugs/gaps discovered during architect verification; DEBT-003 (already filed) is the known
deferral this slice deliberately does not fix. Backlog note appended to FEAT-002 by the product
agent at claim time. No open bugs/deferrals beyond FEAT-002's own deferred sub-scope (listed in §1).

---

## Revision 2 (2026-08-05): unified cache config + generic CLI wiring

Status: SUPERSEDES §§1-8 above where they conflict. §§0/1-8 described what SHIPPED in
`.worktrees/wt-2c81b7` (branch `wip-b917d3`, HEAD `d8aa76ec`, **still unmerged**) — this section
is the corrected plan for what an implementer picks up next, after a review of that worktree found
four real gaps (no opt-out, non-atomic writes, hash cost paid on every HIT not just MISS, no GC for
orphaned directory entries) and the user separately converged on a two-mode unified `cache` option.
Full rationale for every decision below: `docs/apigen/design-notes/extract-stage-onion-and-ir-cache.md`
Revision 2 (R2.1-R2.8) — this section is the "what to actually change in the repo" companion to
that design rationale; read that section first if the "why" isn't obvious from a bullet below.

### R2-0. What stays exactly as-is (no changes)

- `CachedExtractEntry`'s core four fields (`formatVersion`, `operations`, `extractorVersion`,
  `createdAt`) — unchanged. Revision 2 adds exactly one new **optional** field, `staleness`
  (design doc R2.3/R2.5) — additive, no migration.
- `computeCacheKey`'s existing directory-mode formula (`ir-cache-layer.ts:91-107`) — kept, unused
  by default, retained as `computeCacheKey`'s current export for a possible future multi-key/
  directory-backend use case (e.g. a shared remote backend keyed by many entries, §2.4's original,
  still-deferred remote backend). Nothing calls it from the new single-file path except as the
  slow-path fallback (R2.3 step 4), which reuses it verbatim.
- `packages/apigen/apigen-core-client/src/lib/extract-invoker.ts`'s `ExtractCall`/`ExtractResult`/
  `ExtractMiddleware`/`composeOnion`/`createExtractInvoker` — unchanged; Revision 2 only ADDS
  `createExtractInvokerFromPlugins` (R2-3 below) alongside them.
- `collectLocalImportPaths` (`extraction-session.ts`) — unchanged; still the transitive-import walk
  both the slow-path fallback (R2.3 step 4) and any future directory-mode use reuse.
- The `Operation[]`-level cache granularity decision (§2.3 of the original design) — unchanged.

### R2-1. `packages/apigen/apigen-plugin-ir-cache` — what must change

**`src/lib/ir-cache-layer.ts`:**
- Extend `CachedExtractEntry` with the optional `staleness` field (design doc R2.3's shape:
  `{ contentKey: string; source: {path, mtimeMs}; deps: Array<{path, mtimeMs}> }`).
- Add `IrCacheOptions` (design doc R2.2): `{ cache: string; filename?: string; extractorVersion?: string }`.
- Replace `createIrCacheLayer(backend, opts)`'s current directory-backend-only signature with a
  RUNTIME-CACHE-mode-specific constructor, e.g. `createIrCacheLayer(opts: IrCacheOptions & {
  extractorVersion: string })` that internally builds a **single-file backend** (R2-2) from
  `opts.cache` — the `IrCacheBackend` interface (`get`/`put` by key) stays but is now instantiated
  once per configured file path, not once per configured directory. The existing
  `computeCacheKey(call, extractorVersion)` export stays for the slow-path fallback and any future
  directory-mode caller; the layer's HIT/MISS logic (design doc R2.3 steps 1-5) replaces the
  current unconditional `computeCacheKey` → `backend.get` → check `formatVersion` flow with: stat
  the configured file → format/extractor-version gate → fast mtime gate → slow contentKey-rehash
  fallback → MISS.
- Reject `cache === 'artifact'` at the `createIrCacheLayer` entry point with a clear error (that
  value selects the `target` capability, R2-4 below — passing it to the `layer` constructor is a
  caller mistake the layer should catch, not silently mis-cache against).

**`src/lib/backends/single-file-backend.ts` (NEW — replaces per-directory usage of `fs-backend.ts`
for RUNTIME CACHE mode; `fs-backend.ts` itself is NOT deleted, see below):**
- `createSingleFileBackend(path: string): IrCacheBackend` — `get()` reads and JSON-parses exactly
  `path` (any error → `undefined`, never throw, matching `fs-backend.ts`'s existing MISS
  contract); `put()` writes via the atomic temp-file-then-`rename()` sequence (design doc R2.3) —
  this is the concrete fix for the review-flagged non-atomic-write gap. `mkdir(dirname(path), {
  recursive: true })` before the temp write, mirroring `fs-backend.ts:36`'s existing directory
  creation.

**`src/lib/backends/fs-backend.ts` (KEEP, apply the same atomic-write fix):**
- The directory-shaped backend stays exported (R2-0's "keep for possible future multi-key use") —
  apply the SAME atomic temp-file-then-`rename()` fix here too, since a non-atomic write is a real
  defect regardless of which mode uses the backend, and the fix is a strict improvement with zero
  behavior change to callers (`get`/`put`'s signatures are untouched).

**`src/lib/target.ts` (NEW):**
- `buildIrCacheArtifact(descriptor: Descriptor, opts: IrCacheOptions): File[]` (design doc R2.4) —
  throws if `opts.cache !== 'artifact'`; otherwise builds one `CachedExtractEntry` (no `staleness`
  field) from `descriptor.operations` and returns a single `File` at `opts.filename ??
  'ir-cache.json'`.

**`src/index.ts` — export a real `Plugin<IrCacheOptions>` object** (the current package exports
raw functions only — `createIrCacheLayer`, `computeCacheKey`, `createLocalFsBackend` — with **no**
`Plugin` object at all, which is precisely why nothing can `--use ir-cache` or `--type ir-cache`
today; this is the concrete gap R2-3/R2-4 close):

```ts
export const irCachePlugin: Plugin<IrCacheOptions> = {
  id: 'ir-cache',
  description: 'Extract-stage IR cache: runtime write-through cache (--use, cache=<path>) or build-time artifact (--type, cache=artifact)',
  language: 'ts',
  optionsSchema: { type: 'object', properties: {
    cache: { type: 'string' }, filename: { type: 'string' }, extractorVersion: { type: 'string' },
  }, required: ['cache'], additionalProperties: false },
  capabilities: {
    extractLayer: { layer: /* built from opts.cache at load time — see note below */ },
    target: { name: 'ir-cache', generate: buildIrCacheArtifact },
  },
};
```

Implementation note flagged, not hand-waved: `capabilities.extractLayer.layer` needs `opts` (the
resolved `--opt cache=<path>` value) to build its file-backed closure, but `Plugin.capabilities` is
a static object built at plugin-load time, before CLI `--opt` parsing resolves options. Resolve
this the same way `apigen-plugin-openapi`'s `mount.operations(descriptor, opts)` already does
(`plugin.ts:114-123` — the capability function itself RECEIVES `opts` as a parameter, it is not
closed over at plugin-definition time): change `ExtractLayerCapability.layer`'s signature to accept
opts, i.e. `layer(call: ExtractCall, next: () => Promise<ExtractResult>, opts: IrCacheOptions):
Promise<ExtractResult>` (a three-arg extension of `ExtractMiddleware`, or a plugin-specific
`(opts) => ExtractMiddleware` factory the loader calls once at composition time — pick whichever
matches how `adaptCoreLayer`/`createPackageInvoker`'s options-threading is conventionally done
elsewhere in this codebase; not resolved further here — flag as an implementation decision for
whoever picks this up, since it's a real but narrow API-shape choice, not an open design question).

**Deps:** `package.json` gains no new runtime deps (still `node:crypto`, `node:fs/promises`,
`node:path`, `@adhd/apigen-core-client`).

### R2-2. `packages/apigen/apigen-core-client` — what must change

**`src/lib/plugin.ts`:**
- Add `ExtractLayerCapability` interface (design doc R2.6, item 1) — imports `ExtractMiddleware`
  from `./extract-invoker`.
- Add `extractLayer?: ExtractLayerCapability` to `Plugin.capabilities` (`:667-699`), sibling to
  the existing `target`/`layer`/`mount`/`envelope` fields.

**`src/lib/extract-invoker.ts`:**
- Add `createExtractInvokerFromPlugins(plugins, runExtractor)` (design doc R2.6, item 2) — imports
  `Plugin` from `./plugin`. (Note: `plugin.ts` importing a type FROM `extract-invoker.ts`, and
  `extract-invoker.ts` importing a type FROM `plugin.ts`, is a same-package sibling-file cycle at
  the type level only — verify the build tolerates this via `import type` on both sides, the same
  pattern `plugin.ts` already uses for its other capability-adjacent imports; if the bundler
  complains, hoist `ExtractLayerCapability` into `extract-invoker.ts` itself instead and have
  `plugin.ts` import it from there — either placement is correct, this is a build-mechanics detail
  to resolve during implementation, not a design fork.)

**`src/index.ts`:** export `ExtractLayerCapability` (type) and `createExtractInvokerFromPlugins`.

Version bump: minor (new exports), same as the original slice.

### R2-3. `entrypoint/apigen-cli` — what must change

**`src/lib/orchestrator.ts`:**
- `extractSource()` (`:282-313`) gains a `usePluginObjects: Plugin[] = []` parameter.
- Its call sites inside `buildDescriptor()` (Step 2, wherever `extractSource(entry, logger,
  session)` is currently invoked per source) pass the already-destructured `usePluginObjects`
  (`:391`) through.
- The body's `const ops = await extract({...})` (`:296-301`) becomes `const ops = await
  createExtractInvokerFromPlugins(usePluginObjects, (call) => extract({ sourceFile: call.source,
  namespace: call.namespace, tsconfig: typeof call.extractorOptions?.['tsconfig'] === 'string' ?
  call.extractorOptions['tsconfig'] : undefined, session: call.extractorOptions?.['session'] as
  ExtractionSession | undefined }))({ source: entry.file, host: 'ts', namespace, extractorOptions:
  { tsconfig, session } })` — behaviorally identical to today when `usePluginObjects` carries no
  `extractLayer`-capable plugin (the common case today, since nothing implements that capability
  yet) — this is a pure-addition, zero-regression change for every existing caller until a plugin
  actually declares `extractLayer`.
- Import `createExtractInvokerFromPlugins` from `@adhd/apigen-core-client`.

No changes needed to `entrypoint/apigen-cli/src/lib/commands/generate.ts` or `plugin-registry.ts`
— `--type ir-cache` (ARTIFACT mode) is already fully supported by the EXISTING `--type <plugin-id>`
CLI surface (`generate.ts:185`) the moment `apigen-plugin-ir-cache` is registered into the CLI's
`plugins` map (`generate.ts:180`, wherever that map is assembled for the `apigen-cli` entrypoint —
the SAME registration every other `--type`-selectable plugin (`apigen-plugin-openapi`,
`apigen-plugin-py-flask`, etc.) already goes through); `--use ir-cache` (RUNTIME CACHE mode) is
already fully supported by the EXISTING `--use <plugin>` CLI surface (`generate.ts:205-210`) the
moment R2-2's `extractLayer` capability is composed by R2-3's `orchestrator.ts` change above — no
new CLI flags, no new commands.

### R2-4. `entrypoint/backlog/src/server.ts` — what must change

Replace the current hand-wired `getExtractInvoke()` (`:275-295`) with:

```ts
import { irCachePlugin } from '@adhd/apigen-plugin-ir-cache';
import { createExtractInvokerFromPlugins, type Plugin } from '@adhd/apigen-core-client';

/** FEAT-002 Revision 2: opt-out kill switch (design doc R2.7) — backlog's three
 *  transports (HTTP/MCP/CLI) are a live mount, not a `--use`-flag-parsed apigen-cli
 *  invocation, so there is no CLI surface for a human to omit the plugin; this env
 *  var is that surface for this host specifically. */
function extractStagePlugins(): Plugin[] {
  if (process.env['APIGEN_IR_CACHE_ENABLED'] === '0') return [];
  return [irCachePlugin]; // opts resolved via APIGEN_IR_CACHE_DIR-derived `cache` (below)
}

let extractInvoke: ((call: ExtractCall) => Promise<Operation[]>) | undefined;
function getExtractInvoke(): (call: ExtractCall) => Promise<Operation[]> {
  extractInvoke ??= createExtractInvokerFromPlugins(
    extractStagePlugins(), // resolved with cache: irCacheFile(), extractorVersion: CORE_CLIENT_VERSION
    (call: ExtractCall) =>
      extract({
        sourceFile: call.source,
        namespace: call.namespace,
        tsconfig: typeof call.extractorOptions?.['tsconfig'] === 'string' ? call.extractorOptions['tsconfig'] : undefined,
        dropFileSegment: true,
      })
  );
  return extractInvoke;
}
```

- `irCacheDir()` (`:261-266`) is replaced by `irCacheFile()`, returning a single file path (design
  doc R2.2/R2.3 — RUNTIME CACHE mode targets one literal file, not a directory):
  `process.env['APIGEN_IR_CACHE_FILE'] ?? join(process.cwd(), 'tmp', 'apigen', 'ir-cache',
  'backlog-client.ir.json')`. The integration test (`ir-cache.integration.spec.ts`) must switch
  from setting `APIGEN_IR_CACHE_DIR` to `APIGEN_IR_CACHE_FILE` and assert against ONE file's
  presence/mtime, not "exactly 1 entry in a directory" (the directory-count assertion in the
  original §7's integration test plan no longer applies to the single-file backend — the test's
  *intent*, "same file, unchanged mtime ⇒ real HIT, not a rewrite," carries over unchanged).
- `APIGEN_IR_CACHE_ENABLED=0` closes the review-flagged "no opt-out" gap — this is a NEW env var,
  additive, defaulting to enabled (`'1'`/unset), so no behavior changes for an existing deployment
  that has never heard of it.

### R2-5. Test changes required

- `ir-cache-layer.spec.ts`: the existing 8 test cases (§7's original list) still apply
  conceptually but must be rewritten against the single-file backend + fast/slow gate logic (R2.3):
  case 3 ("mtime touch, content same → HIT, spy NOT called") now specifically exercises the SLOW
  gate (mtime changed → contentKey rehash → matches → HIT + mtime-refresh write) rather than the
  old flat "hash always computed" path — add a NEW case proving the FAST gate: two back-to-back
  calls with `utimesSync` **never invoked** between them must show ZERO `fs.stat` calls beyond the
  small fixed set (source + deps), not a full `readFile`+`sha256` of every file (assert via a spy
  on `readFile`/`sha256File`, not just on `runExtractor` — the original test suite only proved the
  extractor wasn't re-run, not that the expensive hash was skipped, which is the exact gap this
  revision closes).
- ARTIFACT mode needs its own new spec (`target.spec.ts` or folded into `ir-cache-layer.spec.ts`):
  `buildIrCacheArtifact` on a fixture `Descriptor` produces one `File` whose parsed JSON content
  round-trips through `CachedExtractEntry`'s shape with `operations` matching `descriptor.operations`
  and no `staleness` field; `buildIrCacheArtifact` with `cache !== 'artifact'` throws.
- A NEW cross-mode compatibility test: write an entry via the ARTIFACT-mode path, then read it via
  the RUNTIME-CACHE-mode `createIrCacheLayer` reader pointed at that same file — must MISS-safely
  fall to the slow gate (no `staleness`), successfully rehash, and match — proving R2.5's "switch
  modes without a migration" claim isn't just asserted in prose.
- `entrypoint/backlog/src/ir-cache.integration.spec.ts`: switch `APIGEN_IR_CACHE_DIR` → `APIGEN_IR_CACHE_FILE`;
  add a 4th run with `APIGEN_IR_CACHE_ENABLED=0` proving extraction runs for real (no cache
  involvement at all) — the opt-out's behavioral proof.
- `entrypoint/apigen-cli`: at least one test proving `createExtractInvokerFromPlugins` wired into
  `orchestrator.ts`'s `extractSource()` is a no-op when `usePluginObjects` is empty (regression
  guard for every existing `generate`/`run` test) AND one proving a fixture `extractLayer`-capable
  plugin's middleware actually gets invoked when passed via `--use` end-to-end through
  `orchestrateGenerate`/`buildDescriptor` — not just unit-tested against `extractSource` in
  isolation (per AGENTS.md §7's "verify through real components" standard).

### R2-6. Execution note

This is a **revision of an unmerged, unimplemented-on-main slice** — there is no already-shipped
behavior on `main` to preserve backward compatibility with. The correct execution path is: either
(a) amend the existing `wip-b917d3` branch/worktree in place before it ever merges (cheapest — no
one has built on top of the current shape yet), or (b) if `wip-b917d3` merges before this revision
is picked up, treat R2-1..R2-5 above as an ordinary follow-up change against the merged code with
the SAME segment-by-segment execution discipline §6 of the original spec used (independent,
individually-testable segments; version bumps per touched package; `npx nx affected -t test lint`
at the end). Do not touch `morph-walk.ts`/`ts-json-schema.ts`/`extract.ts` internals (DEBT-003
scope, unchanged exclusion from §6 item 8 of the original spec).
