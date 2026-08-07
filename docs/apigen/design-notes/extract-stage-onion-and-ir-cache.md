# Design Proposal: Extract-Stage Onion + Shareable IR-Cache Plugin

Status: PROPOSAL — not implemented, not approved. Written for review before any code change.

Author: architect-reviewer (dispatched), 2026-08-01.

## 0. Grounding — what exists today (verified by direct read, not summary)

- `packages/apigen/apigen-core-client/src/lib/plugin.ts` — the v2 `Plugin<Opts>` interface
  (`plugin.ts:623-698`) has exactly four optional capabilities: `target` (`:254-288`), `layer`
  (`:302-327`), `mount` (`:387-...`), `envelope` (`:554-...`). `LayerCapability.layer` (`:326`) has
  signature `(call: Call, next: Next) => Promise<Result> | AsyncIterable<Chunk>` where `Call`
  (`:93`) and `Next`/`Result` (`:132-150`) are the SPEC-level (host-neutral) shapes.
- `packages/apigen/apigen-engine-runtime/src/lib/invoke.ts` — the concrete TS runtime
  implementation of the onion: `createInvoker(layers: readonly Layer[]) => InvokeFn` (`:176-209`).
  `Layer = (call: Call, next: Next) => Promise<LayerResult>` (`:121`), composed
  outermost-first via `reduceRight` (`:202-205`) around a `coreService` that calls `dispatch(...)`
  (`:190-198`). This is dispatch-specific: `coreService` is hardwired to the `dispatch` Service
  and `InvokeOptions` (`:133-140`) is the dispatch runtime's `fns`/`createClient`/`schemas`.
- `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts` — `createPackageInvoker`
  (`:124-137`) is the composition entrypoint real hosts call: loads `--use` plugins'
  `capabilities.layer` (adapted via `adaptCoreLayer`, `:108-116`), pushes the mandatory
  `validate-Layer` innermost (`:135`), and calls `createInvoker`. This is the ONLY place
  `createInvoker` is instantiated for dispatch today.
- `packages/apigen/apigen-core-client/src/lib/extract.ts` — `extract(opts: ExtractOptions):
  Promise<Operation[]>` (`:90`). `ExtractOptions` (`:48-79`) is `{sourceFile, namespace?,
  dropFileSegment?, tsconfig?, session?}`. Already TS-specific in its literal option names
  (`sourceFile`, `tsconfig`) but the RETURN type (`Operation[]`) is already the host-neutral
  descriptor shape from SPEC §4 — extraction's *output* contract is already polyglot-shaped, only
  its *input* options are TS-shaped today.
- `packages/apigen/apigen-core-client/src/lib/extraction-session.ts` — `ExtractionSession`
  (`:67-72` public, `:81-107` internal) is an EXISTING per-run, in-process, non-persistent cache:
  one ts-morph `Project` per tsconfig, one `ts-json-schema-generator` generator per
  `(file, tsconfig)`, and a `schemaCache` keyed `${sfPath}\0${tsconfig}\0${typeText}` (`:88-98`)
  storing in-flight/resolved promises (dedupes concurrent identical requests, `:90-98`). Critically:
  the generator-cache "version" key is `mtimeMs:size` (`extraction-session.ts:74`,
  `statVersion` `:106`) — **mtime-based, process-local, never shared across runs or machines.**
  This is the thing the new plugin's cache must sit *alongside*, not duplicate: the session cache
  answers "don't recompute twice within one process run"; the new plugin answers "don't recompute
  at all if another run/machine/CI job already computed the identical schema."
- `docs/apigen/SPEC.md` §1 (`:41-69`), §12 (`:470-505`), §13 (`:508-...`): three pipeline stages
  (extract → generate/run), protoc-plugin extraction model (`apigen-<lang>-extractor` subprocess,
  merge JSON), and the packaging layout naming `@adhd/apigen-ts-extractor` (`SPEC.md:490`) as a
  not-yet-built, separately-packaged, **drivable subprocess** — parallel to a future
  `apigen-python-extractor`/`apigen-rust-extractor`/etc. Today this package does not exist; TS
  extraction lives directly in `apigen-core-client` and is called in-process (verified: no
  `apigen-ts-extractor` directory under `packages/apigen/`, confirmed via `ls`).
- `DEBT-003` (backlog, OPEN, filed same investigation thread as this task): Path 2 (`morph-walk.ts`,
  the ts-morph-only fast schema path) silently collapses to `{}` for named types that reference
  OTHER named types (verified: `BacklogItem` → correct 1751–5055 byte schema via Path 1, exactly
  `{}` via forced Path 2). Path 1 (`ts-json-schema-generator`'s own `createProgram()`, the ~2.6–2.8s
  cost) is the only currently-CORRECT path for such types. This is the load-bearing correctness
  constraint on the whole cache design below: **the cache must persist whatever the correct path
  produces today (Path 1 for cross-referencing named types), and must never become a de facto
  argument for switching the default extraction path before DEBT-003 is independently fixed.**

---

## 1. The unified shape — the extract-stage invoker

### 1.1 Decision: parallel sibling, sharing the generic composition primitive — not the same `createInvoker`

`createInvoker` (`invoke.ts:176`) is not reusable as literally written: its `coreService` closure
is hardwired to `dispatch(opts.fns, opts.createClient, schema, fnName, call.envelope,
call.domainArgs)` (`:190-198`), and its `InvokeFn` signature bakes in dispatch's specific
`Call`/`InvokeOptions` shapes. Reusing it literally for extraction would mean overloading `Call`
with meaningless `domainArgs`/`envelope`/dispatch-`operation` fields for something that doesn't
dispatch — a "does not generalize cleanly" smell.

The right move is to extract the one truly generic piece — **right-fold composition of an onion
around an arbitrary innermost service** — into a shared, stage-agnostic helper, and have both
today's dispatch invoker and the new extract invoker built from it:

```ts
// packages/apigen/apigen-engine-runtime/src/lib/onion.ts  (NEW, shared primitive)

/** A stage-agnostic middleware step: receives the call, owns the continuation. */
export type Middleware<TCall, TResult> =
  (call: TCall, next: () => Promise<TResult>) => Promise<TResult>;

/**
 * Compose `middlewares` outermost-first around `core`. Identical composition
 * algebra to today's `createInvoker` (`invoke.ts:202-205`) — lifted out so
 * BOTH the dispatch invoker and the extract invoker are literally the same
 * fold, parameterized only by what `TCall`/`TResult` mean for that stage.
 */
export function composeOnion<TCall, TResult>(
  middlewares: readonly Middleware<TCall, TResult>[],
  core: (call: TCall) => Promise<TResult>
): (call: TCall) => Promise<TResult> {
  const composed = middlewares.reduceRight<() => Promise<TResult>>(
    (innerNext, mw) => () => mw(lastCall, innerNext), // see note below
    () => core(lastCall)
  );
  // (illustrative — real impl closes over `call` per invocation, not module state;
  // shown inline in invoke.ts today by capturing `call` in the reduceRight closure
  // per-call. The production version below preserves that per-call closure.)
  return async (call: TCall) => {
    const coreStep = () => core(call);
    const chain = middlewares.reduceRight<() => Promise<TResult>>(
      (innerNext, mw) => () => mw(call, innerNext),
      coreStep
    );
    return chain();
  };
}
```

`invoke.ts`'s `createInvoker` becomes a thin specialization:

```ts
export function createInvoker(layers: readonly Layer[] = []): InvokeFn {
  return async (fnName, call, opts) => {
    const schema = opts.schemas[fnName];
    if (!schema) throw new Error(`apigen/invoke: no schema found for operation "${fnName}"`);
    const core = (c: Call) =>
      dispatch(opts.fns, opts.createClient, schema, fnName, c.envelope, c.domainArgs);
    return composeOnion(layers, core)(call);
  };
}
```

Zero behavior change — `reduceRight` order, short-circuit rule, error-propagation rule are
byte-identical to today. This refactor is optional groundwork, not required to ship the cache
plugin (see §4), but it is the honest answer to "same `createInvoker` or a parallel sibling":
**a parallel sibling that shares the actual generic algebra**, not a literal reuse of the
dispatch-shaped function, and not a from-scratch reimplementation either.

### 1.2 The extract-stage call/result contract — kept subprocess-agnostic from the start

This is the one place TS-specificity must NOT leak in, because §3 depends on it. The extract call
shape must describe *what* is being extracted, not *how*:

```ts
// packages/apigen/apigen-core-client/src/lib/extract-invoker.ts (NEW)

/** One source unit to extract from. Deliberately NOT `{sourceFile, tsconfig}` —
 *  those are ts-morph's option names, not a neutral contract. */
export interface ExtractCall {
  /** Absolute path to the source artifact for this language's extractor
   *  (a .d.ts/.ts file today; a directory/module root for a future
   *  subprocess-based extractor — the contract doesn't care which). */
  source: string;
  /** Declared owning language runtime tag, e.g. 'ts', 'py', 'rust' — SPEC §4 `host`. */
  host: string;
  /** Namespace segment (SPEC §4). */
  namespace?: string;
  /** Free-form, extractor-specific options (tsconfig path for TS today;
   *  a venv path for Python tomorrow) — opaque to the onion, read only by
   *  the terminal extractor step. */
  extractorOptions?: Record<string, unknown>;
  /** A caller-supplied version/identity tag for cache-key purposes (§2) —
   *  e.g. package.json version + content digest of the source tree. Optional:
   *  absence just means a cache layer can't key on it. */
  versionHint?: string;
}

/** Extraction's *result* is already the host-neutral shape SPEC §4 defines —
 *  reuse it verbatim, do not invent a parallel result type. */
export type ExtractResult = Operation[]; // from `./descriptor`

export type ExtractMiddleware = Middleware<ExtractCall, ExtractResult>;

/**
 * Compose an extract-stage invoker: `--use` layer plugins wrapping the
 * terminal extractor step. Mirrors `createPackageInvoker` (`package-invoker.ts:124`)
 * but for the extract stage: the terminal step is "run the real extractor for
 * `call.host`" instead of "run dispatch".
 */
export function createExtractInvoker(
  middlewares: readonly ExtractMiddleware[],
  runExtractor: (call: ExtractCall) => Promise<ExtractResult>
): (call: ExtractCall) => Promise<ExtractResult> {
  return composeOnion(middlewares, runExtractor);
}
```

Today, `runExtractor` for `host: 'ts'` is just `(call) => extract({ sourceFile: call.source,
namespace: call.namespace, tsconfig: call.extractorOptions?.tsconfig, session: ... })` — an
in-process function wrapping the existing `extract()` from `extract.ts:90`. Tomorrow, for a real
`apigen-ts-extractor` subprocess (SPEC §12) or a Python/Rust extractor, `runExtractor` becomes
"spawn subprocess, write `ExtractCall` as its stdin JSON, parse `Operation[]` from stdout." **The
onion — and every layer wired into it, including the cache plugin — does not change at all**
between these two implementations of `runExtractor`. This is the concrete test of "kept
subprocess-agnostic": nothing in `ExtractCall`/`ExtractResult`/`ExtractMiddleware` mentions
ts-morph, ts-json-schema-generator, or an in-process function call. See §3 for why this matters
more than it might look.

### 1.3 Wiring — same pattern as dispatch's `--use`, no new CLI concept

`LayerCapability` (`plugin.ts:302`) is reused as-is for extract-stage plugins too — a plugin's
`capabilities.layer` function does not know or care which invoker it ends up in. What differs is
only which *array* the host code puts it into:

```ts
// host code (apigen-cli orchestrator, backlog's server.ts, etc.)
const extractLayers = usePlugins
  .filter(p => p.capabilities.layer)
  .map(p => adaptExtractLayer(p.capabilities.layer!)); // signature-adapter, mirrors adaptCoreLayer

const dispatchLayers = usePlugins
  .filter(p => p.capabilities.layer)
  .map(p => adaptCoreLayer(p.capabilities.layer!));

const extractInvoke = createExtractInvoker(extractLayers, runTsExtractor);
const dispatchInvoke = createPackageInvoker(schemas, usePlugins); // unchanged
```

A single `--use ir-cache` plugin, loaded once, can therefore be wired into the extract invoker
only (the common case — see §4), the dispatch invoker only, or both, purely by which array(s) the
host composes it into. This is exactly today's `--use` mental model (a plugin is part of a
package's invoker *because the caller included it*, nothing self-declared on the plugin) extended
to a second stage — no new capability field, no `stage` discriminator, matching what the user and
I already converged on and rejecting the earlier `beforeExtract`/`afterExtract` over-design.

One adapter distinction worth flagging honestly: `adaptCoreLayer` (`package-invoker.ts:108-116`)
works because dispatch's runtime `Call` (`invoke.ts:68-82`) and the SPEC `Call` (`plugin.ts:93`)
are structurally close enough to view-cast (`Object.assign(call, {data: call.domainArgs})`). The
extract-stage `Call` a plugin author writes against would need its own adapter
(`adaptExtractLayer`) because `ExtractCall` (§1.2) has no `domainArgs`/`envelope`/`operation` at
all — a plugin author writing a layer meant for extraction needs a *different* `Call`-shaped view.
Practically this means: **an extract-layer plugin is written against `ExtractCall`/`ExtractResult`,
not against the SPEC `Call`/`Result` from `plugin.ts`.** That is a real, if modest, second surface
a plugin author who wants to target both stages must learn — flagged as an open question in §5,
not hidden.

---

## 2. The IR-cache plugin

### 2.1 Shape — a `layer` capability wired into the extract invoker

```ts
// packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts (NEW package, per §4 naming)

export interface IrCacheBackend {
  /** Fetch a cached entry by key, or undefined on miss. Must not throw on miss. */
  get(key: string): Promise<CachedExtractEntry | undefined>;
  /** Store an entry. Backends may fire-and-forget (don't block extraction on write). */
  put(key: string, entry: CachedExtractEntry): Promise<void>;
}

export interface CachedExtractEntry {
  /** Schema version of the cache entry format itself — bump on any breaking
   *  change to what's stored, so old entries are ignored rather than misread. */
  formatVersion: number;
  /** The extraction result exactly as `runExtractor` would have produced it. */
  operations: Operation[];
  /** Provenance for debugging/audit — which extractor build produced this. */
  extractorVersion: string; // e.g. apigen-core-client's package.json version
  createdAt: string; // ISO timestamp
}

export function createIrCacheLayer(backend: IrCacheBackend): ExtractMiddleware {
  return async (call, next) => {
    const key = await computeCacheKey(call);
    const hit = await backend.get(key);
    if (hit && hit.formatVersion === CURRENT_FORMAT_VERSION) {
      return hit.operations;
    }
    const result = await next();
    // fire-and-forget: a slow/unreachable remote backend must never add
    // latency to a cache MISS, only skip the benefit of a future HIT.
    void backend.put(key, {
      formatVersion: CURRENT_FORMAT_VERSION,
      operations: result,
      extractorVersion: EXTRACTOR_VERSION,
      createdAt: new Date().toISOString(),
    }).catch(() => { /* cache write failures are non-fatal, log at debug */ });
    return result;
  };
}
```

Wired exactly as §1.3 describes: `--use ir-cache` puts this into `extractLayers`, never into
`dispatchLayers` (caching a dispatch call doesn't make sense here — that's a different, existing
concern, not this plugin's job).

### 2.2 Cache key design — content/version-addressed, not mtime

The existing `ExtractionSession` generator cache already demonstrates the WRONG key for this job:
`mtimeMs:size` (`extraction-session.ts:74`) is fine for "don't recompute twice in the same run on
the same machine within the same second" but actively wrong for "share across machines/CI" —
mtime is not preserved by git clones, CI checkouts, or `rsync` without `-t`, and two developers
building identical source produce different mtimes trivially. The cache key must be:

```
key = hash(
  extractorVersion,          // e.g. "@adhd/apigen-core-client@0.4.2" — a code change
                             // to the extractor itself must invalidate every entry it produced
  formatVersion,             // CachedExtractEntry schema version (§2.1)
  call.host,
  call.namespace ?? '',
  contentHash(call.source),  // sha256 of the source file's bytes — NOT mtime
  contentHash(every locally-imported file, transitively)  // see below
)
```

The transitive-import piece is the subtle, must-not-skip part: `extraction-session.ts`'s own
`collectReferencedFiles` (`:120+`) already walks local (non-`node_modules`) imports recursively
for its OWN invalidation purposes — the cache key computation should reuse that exact traversal
(not reinvent it) and hash the concatenated content of every file it finds, not just the entry
file. Skipping this would let a cache incorrectly HIT after editing a type in an imported file that
the entry file's own bytes didn't change — a straightforward correctness bug for any multi-file
TS project (which is nearly all of them). `node_modules` dependency versions (from
`package.json`/lockfile) should also fold into the key for a fully rigorous design, but reusing
the *existing* local-import walk is the pragmatic first cut and already closes the obvious gap.

`versionHint` (§1.2) exists as an opt-in escape hatch for callers who already have a cheaper
identity signal (e.g. a monorepo's own content-addressed build hash) and don't want the plugin to
redundantly re-hash files it can already answer from elsewhere — the plugin must compute its own
hash when absent, never trust an unverified hint from an untrusted caller for a *shared* cache (see
§2.4's security note).

### 2.3 What gets cached — both levels, but the plugin only needs to cache one

The user's brief asks "full `Descriptor`? per-type schema fragments? both?" The honest answer:
**cache at the `ExtractResult` (full `Operation[]` for one `ExtractCall`) level, not per-type schema
fragments — and don't build a second, finer-grained cache inside this plugin.** Reasoning:

- The extract-stage onion's unit of work IS one `ExtractCall → ExtractResult` — that's the seam
  this plugin sits on, and caching at that seam requires no new invalidation logic beyond §2.2's
  key.
- A per-type schema fragment cache already exists, in-process, as `ExtractionSession.schemaCache`
  (`extraction-session.ts:88-98`) — keyed `sfPath\0tsconfig\0typeText`. That's a legitimate, useful,
  *different* cache (dedupes concurrent identical requests within one run) that should keep
  existing at the level it already works at. Building a SECOND, persistent, cross-process
  fragment-level cache inside the new plugin would mean maintaining two overlapping invalidation
  stories for the same underlying data, for no proven benefit — the `Operation[]`-level cache
  already captures every fragment inside it. If a future profiling pass shows a large monorepo has
  enough near-duplicate individual named types across UNRELATED source files that fragment-level
  sharing would meaningfully help, that's a follow-on optimization to consider then, evidenced by
  data — not something to build speculatively now.
- The merged multi-source `Descriptor` (`plugin.ts:218`, operations from *every* source file in a
  run) is a poor cache unit: it changes whenever ANY one source in the run changes, so caching at
  that level would give a near-100% miss rate the moment any file in a multi-file project is
  touched. Caching per-`ExtractCall` (one source file's operations) is the right granularity
  because each source file's own edit only invalidates its own cache entry — exactly how per-file
  incremental builds work everywhere else.

### 2.4 Backend plug-in point — local vs shared, and why the plugin interface must not pick one

`IrCacheBackend` (§2.1) is the seam. Two concrete backends are worth naming (not fully designing —
per the task's own instruction not to over-design a remote-cache PRODUCT here):

- **Local backend** (ship first): a content-addressed directory under `tmp/apigen/ir-cache/<key>`
  — consistent with this repo's own `tmp/` convention (AGENTS.md §10) and simplest correctness
  story (no network, no auth, no cross-machine skew to reason about).
- **Remote/shared backend** (design the seam for, don't build the server): an HTTP
  GET/PUT-by-content-hash store — structurally identical to how Nx's own remote cache works
  (content-addressed blob store, read-through on miss, write-through on compute) and to how
  `nx-tooling-001`'s separate thread already treats Nx-cache-alignment as a value (noted only as
  context per the task brief, not designed here). `IrCacheBackend.get`/`put` being plain
  `async`/Promise-returning means an HTTP-backed implementation is a same-shape drop-in — no
  interface change needed to add one later.

Taking "share" seriously, as asked: a **local-only cache is the wrong default target** for this
plugin's flagship value proposition. The whole point of a content-addressed key (§2.2) is that
it's valid across machines — throwing that away by only ever writing to a local directory wastes
the harder design work for no reason. The recommendation is: ship the local filesystem backend
first (§4's smallest slice), but design `IrCacheBackend` so a shared backend is a pure
implementation swap, and treat "does this repo/team want a shared cache" as a *deployment*
decision (which backend instance gets configured), not an architectural one.

Security/trust note (a real open question, not resolved here): a *shared* cache accepts entries
written by other machines/CI runs. `extractorVersion` + `formatVersion` gate against
version-skew poisoning, but nothing here gates against a maliciously-written cache entry (a poisoned
shared cache serving fabricated schemas). This is the same trust model Nx's own remote cache
accepts (trusting your CI to be the writer) — acceptable to inherit implicitly, but should be
called out explicitly in the plugin's own README once built, not left silent.

### 2.5 Invalidation summary

| Trigger | Handled by |
|---|---|
| Source file content changes | `contentHash(call.source)` in the key (§2.2) |
| An imported file's content changes | transitive import-content-hash in the key (§2.2) |
| The extractor itself changes (bug fix, new TS feature support) | `extractorVersion` in the key |
| The cache entry format changes | `formatVersion` gate at read time (§2.1) |
| DEBT-003 gets fixed and Path 2 becomes safe for named types | `extractorVersion` bump — the fix changes `runExtractor`'s output for the same input, so it MUST bump the extractor's version to invalidate stale Path-1-shaped cache entries. This is the concrete mechanism that prevents the landmine the task flagged: the cache never becomes an argument for skipping DEBT-003, because *fixing* DEBT-003 is itself a normal version bump that busts the cache exactly like any other extractor change. |

---

## 3. Does idea 3 constrain idea 2, or does it fall out for free?

Honest answer: **it falls out correctly, but only because §1.2's `ExtractCall`/`ExtractResult`
contract was deliberately kept free of any TS-specific field** — this was a design choice made
*in* this proposal, not something that happens automatically. If `ExtractCall` had instead been
`{sourceFile, tsconfig, session}` (i.e., `extract.ts`'s literal `ExtractOptions`, `extract.ts:48`),
then building the extract-stage onion now WOULD be premature and TS-specific: `tsconfig` and
`session` (an `ExtractionSession` — an in-process ts-morph handle, `extraction-session.ts:67`) are
meaningless for a subprocess-based extractor that hasn't loaded ts-morph at all. A future
`apigen-rust-extractor` has no tsconfig and no ts-morph session to share.

Two things make this genuinely load-bearing for the cache plugin specifically, not just a
nice-to-have generality:

1. **The cache key (§2.2) must not depend on TS-specific identity.** If the extract invoker's
   `Call` type baked in `tsconfig`/`session`, the cache-key computation would naturally reach for
   those fields — and then the same plugin literally could not be reused, unmodified, for a future
   Python/Rust extractor, because there is no tsconfig to hash. Keeping the contract to
   `source`/`host`/`namespace`/opaque `extractorOptions` means `computeCacheKey` only ever needs
   `contentHash(source)` + transitively-imported files (a per-language-defined notion resolvable
   generically for any text-based extractor) + `host` + `extractorVersion` — none of which assume
   TS.
2. **`runExtractor` being swappable (in-process fn today, subprocess tomorrow) is exactly what
   makes the cache layer's placement correct.** The cache layer sits in the onion ABOVE
   `runExtractor` (§1.2's `createExtractInvoker(middlewares, runExtractor)`), so a cache HIT never
   invokes `runExtractor` at all — it doesn't matter whether that function would have been an
   in-process ts-morph call or a subprocess spawn; the cache plugin cannot regress on a still-unbuilt
   subprocess implementation for the simple reason that it never reaches it.

Where I'd flag genuine premature-ness, to be honest rather than paper over it: building the FULL
generalized `composeOnion` shared primitive (§1.1) ahead of a second real consumer (only one stage,
extract, would use it beyond dispatch) is a mild YAGNI risk — it's a ~15-line pure function, so the
cost of being "wrong" about needing it is low, but I would not block shipping the cache plugin on
landing that refactor first (see §4's sequencing — it's explicitly optional/deferred). The
`ExtractCall`/`ExtractResult` contract shape, by contrast, is NOT optional groundwork — it is the
one piece of idea 2 that idea 3 genuinely requires to be right from the start, because a cache
plugin built against the wrong (TS-coupled) contract would need a breaking rewrite the day a real
second-language extractor arrives, exactly repeating the mistake SPEC §12 is trying to design away
from.

---

## 4. Sequencing / scope recommendation

**Smallest correct slice that ships "a plugin that lets users share a performance-improving IR
cache," without requiring the full per-language extractor split first:**

1. **Add `ExtractCall`/`ExtractResult`/`ExtractMiddleware`/`createExtractInvoker`** to
   `apigen-core-client` (or a new thin file inside it — no new package needed for just the types
   and the compose function; `composeOnion` itself can live inline here too, deferring the
   `apigen-engine-runtime` refactor from §1.1 since dispatch doesn't need to change to unblock
   this). This is the minimum contract idea 2 needs and the one place idea 3's constraint (§3) must
   be honored — keep it TS-agnostic even though only a TS `runExtractor` exists yet.
2. **Wire ONE call site** — `entrypoint/backlog`'s `extractClientOperations()`
   (`server.ts:231-249`) is the ideal first consumer: it's the exact function whose cost (BUG-019,
   ~3.4s) motivated this whole thread, it's a single, simple, already-isolated call, and it doesn't
   require touching `apigen-cli`'s more complex multi-source orchestrator (`orchestrator.ts`) in
   this first slice. Wrap it: `createExtractInvoker([irCacheLayer], (call) => extract({sourceFile:
   call.source, namespace: call.namespace, tsconfig: call.extractorOptions?.tsconfig}))`.
3. **Build the `IrCacheBackend` interface + a local filesystem backend** (§2.1, §2.4) as a new
   package: `apigen-plugin-ir-cache` (a `plugin` tier under `packages/apigen/`, per this repo's own
   `--tier plugin` convention — scaffold via `@adhd/workspace-codegen-nx`, never hand-created, per
   AGENTS.md §1). Ship with the local backend only; leave the remote backend as a documented,
   unimplemented extension point (§2.4) — do not build a remote-cache server in this slice.
4. **Prove it with a real behavioral test** (per AGENTS.md §7's verification standard): run
   `runBacklogCli(['--help'])` twice in the same test — assert the SECOND run's extraction is
   answered from the cache (not merely "fast," but assert the underlying `runExtractor` was NOT
   called a second time, e.g. via a call-counting spy on the wrapped function, or timing with a
   generous deadline as a secondary signal only) — and assert a THIRD run, after touching the
   source `.d.ts`'s mtime but not its content, still HITS (proving the key is content- not
   mtime-based, the whole point of §2.2) while a FOURTH run, after touching content, MISSES.
5. **Defer, explicitly, to a later slice**: the `apigen-cli` orchestrator's multi-source `--use`
   wiring (bigger surface, more sources to key correctly), the `composeOnion` shared-primitive
   refactor of `apigen-engine-runtime` (§1.1 — nice-to-have, not blocking), a remote cache backend
   implementation, per-type fragment sharing (§2.3 — explicitly not recommended without profiling
   evidence), and the actual `apigen-ts-extractor`/subprocess split (SPEC §12 — the full idea 3,
   which this design deliberately does NOT require to exist first, per §3's proof).

This ordering delivers the user's stated flagship ("share a performance-improving IR cache") in
the smallest slice that touches the fewest existing systems, while the one piece that MUST be right
from day one (the extract-call contract staying host-neutral, §1.2/§3) is cheap to get right up
front and expensive to retrofit later — so it's the one thing not deferred.

---

## 5. Explicit risks / open questions (not resolved here)

1. **The `adaptExtractLayer` second-surface problem (§1.3).** A plugin author wanting a layer that
   works at both dispatch and extract stages must write against two different `Call` shapes today
   under this design (SPEC `Call`/`Result` for dispatch via `adaptCoreLayer`, `ExtractCall`/
   `ExtractResult` for extract via a new `adaptExtractLayer`). This is honest, not hidden, but it
   is a real ergonomics gap the user should be aware they're accepting — no unified `Call` type
   spans both stages meaningfully (a dispatch `Call` has `domainArgs`/`envelope`/`operation.id`; an
   extract `Call` has none of those and needs `source`/`host` instead), so I don't see an
   unforced way to unify them further without genericizing `Call` itself into something vaguer.
2. **Transitive import hashing cost.** §2.2's cache-key computation requires hashing every
   locally-imported file transitively, every time, to safely detect a miss. For a large fan-in
   file this could itself become a non-trivial cost, partially undermining the plugin's own value
   proposition on a cache-miss path (though never on a hit, since the hash is needed before we know
   hit/miss either way). Not measured in this proposal — should be profiled during
   implementation, not assumed cheap.
3. **`node_modules`/lockfile identity is out of scope for the first slice** (§2.2) — a dependency
   version bump that changes a named type's shape without changing any locally-tracked file would
   be a false cache HIT under the v1 key design. Flagged, not fixed here; likely acceptable given
   `extractorVersion` at least catches an extractor-side fix, but a real dependency-shape change
   slipping through is a genuine gap until addressed.
4. **Shared-cache trust model (§2.4)** is inherited, not solved: nothing stops a compromised or
   buggy CI writer from poisoning a shared backend for every other reader. Acceptable to punt
   given Nx's own remote cache accepts the same model, but should be stated explicitly, not
   silently assumed, when a shared backend actually ships.
5. **Whether `composeOnion` (§1.1) is worth the refactor of existing, working, tested
   `createInvoker` code at all**, versus just writing `createExtractInvoker` as a small
   independent function that happens to look structurally similar. I lean toward "worth it, low
   risk, do it" but flag this as a judgment call the implementer/reviewer should make explicitly
   rather than treat as settled by this document.
6. **Where a fixed DEBT-003 leaves the cache's role long-term.** Once Path 2 is made correct for
   cross-referencing named types (DEBT-003's own scope), extraction itself becomes fast enough
   that the cache's marginal benefit for the *single-machine* case shrinks substantially — its
   value proposition shifts almost entirely to the *cross-machine/CI-sharing* case. Worth
   re-affirming, once DEBT-003 lands, that the shared-backend work (§2.4, deferred in §4) is still
   wanted before investing further there.

---

## Related backlog

`DEBT-003` (OPEN) — Path 2 (`morph-walk.ts`) correctness gap for nested named-type references;
independently tracked, referenced throughout this design as the landmine this proposal must not
paper over (§2.5's `extractorVersion` row is the concrete mechanism keeping the cache honest once
DEBT-003 is fixed). No new backlog item filed by this review — no new defect was found during
this investigation; DEBT-003 was already filed by the same investigation thread that produced this
task's context.

---

## Revision 2 (2026-08-05): unified cache config + generic CLI wiring

Status: PROPOSAL — revises §2 and §4 above after a review of the shipped worktree
(`.worktrees/wt-2c81b7`, branch `wip-b917d3`, HEAD `d8aa76ec`, **unmerged** — not on `main`)
surfaced four gaps: (1) `entrypoint/backlog/src/server.ts:276-295`'s `getExtractInvoke()` wires
the cache layer unconditionally, with no opt-out; (2) `fs-backend.ts:35-38`'s `put` is a plain
`writeFile`, not atomic; (3) even on a HIT, `computeCacheKey` (`ir-cache-layer.ts:91-107`) pays
real I/O — a full `sha256File` of the source plus every transitive local import — on *every*
call, which is the exact "extraction is slow, so cache it" cost the plugin was supposed to
eliminate, just moved from ts-morph to `crypto`; (4) the directory-shaped content-addressed store
leaves an orphaned `.json` entry behind for every historical content-version of a source file,
with no eviction anywhere in the diff. This revision keeps §1 (the onion / `ExtractCall` contract)
and §3 (the subprocess-agnosticism argument) unchanged — both are sound and unaffected — and
replaces §2's single "content-addressed directory" cache shape with **two explicit modes** behind
one option, plus a generic composition mechanism closing the "backlog is the only consumer" gap
this section's own §5.1 already flagged.

### R2.1 — Why one directory-shaped cache wasn't the whole answer

§2.2's design was correct as far as it went — content-hash, not mtime, is the right key — but
conflated two different jobs under one shape:

- A **runtime, write-through cache** (what §2 actually built): pay the cost once, reuse it across
  process invocations, on the SAME machine or a machine sharing the same filesystem/mount. This is
  BUG-019's actual hot path — the backlog CLI re-extracting `client.d.ts` on every `--help`.
- A **build-time artifact**: a JSON file produced once, at `nx build`/CI time, that ships
  alongside the compiled output and is read (or statically imported) by the consumer with **zero**
  extraction machinery in the runtime path at all — not even a cache lookup.

Forcing both through one content-addressed-directory shape is why gap (3) above exists: a
directory-of-many-keyed-files design *needs* the full content hash to know which file to open,
so there's no way to shortcut the hash even on a HIT. A **single, literal, pre-agreed file path**
doesn't have this problem — the caller already knows exactly which file to open; the only question
left is "is what's in it still fresh," which is a much cheaper question than "which of N possible
files is the answer."

### R2.2 — The unified `cache` option

```ts
// apigen-plugin-ir-cache's Plugin options (replaces the current constructor-argument-only shape)
export interface IrCacheOptions {
  /**
   * Either:
   *  - An absolute or relative file path: RUNTIME CACHE mode (R2.3). The plugin
   *    treats this as a single-entry cache at that literal file — not a
   *    content-addressed directory of many keyed files.
   *  - The literal string `'artifact'`: ARTIFACT mode (R2.4). Signals "produce
   *    a build-time artifact via the target/generate capability," not a
   *    runtime cache. No extraction happens at request/CLI-invocation time in
   *    this mode — the artifact is produced by a separate, prior `apigen
   *    generate --type ir-cache` step.
   *
   * The literal string `'artifact'` is reserved and cannot name a real cache
   * file relative to cwd without the `./` prefix (`cache: './artifact'`) —
   * an accepted, documented ambiguity (see R2.6 open questions), not a type-
   * level guarantee. `IrCacheOptions.cache` stays `string` rather than a
   * `{mode,path}` discriminated union specifically because the task's own
   * unification goal is "one option, two modes inferred from its value" —
   * not two options a caller could set inconsistently.
   */
  cache: string;
  /** Filename for the emitted artifact in ARTIFACT mode. Default: `ir-cache.json`.
   *  Ignored in RUNTIME CACHE mode (the `cache` value itself IS the path). */
  filename?: string;
  /** Override for `extractorVersion` (defaults to `@adhd/apigen-core-client`'s
   *  own `package.json` version, read via `createRequire` — same mechanism
   *  `server.ts:252-254` already uses). */
  extractorVersion?: string;
}
```

Both modes read/write the **same** `CachedExtractEntry` shape (R2.5) — a consumer can start in
RUNTIME CACHE mode and switch to ARTIFACT mode (or vice versa) later with zero format migration,
and `extractorVersion` keeps DEBT-003's correctness invariant (§2.5's table, unchanged) honored
identically in both modes.

### R2.3 — RUNTIME CACHE mode (`cache: <file-path>`) — the `layer` capability

**Staleness-check strategy — the concrete decision R2.1 motivated.** A HIT still needs *some*
staleness check (a cache that never invalidates isn't a cache, it's a permanent wrong answer
waiting to happen) — the design decision is *how cheap* that check can be made for the common
"nothing changed" case, which is the overwhelmingly common case for a CLI invoked repeatedly in
a dev loop.

Decision: **store a cheap mtime snapshot inside the entry at write time, gate on it first, and
only fall back to the expensive full content rehash when the mtime snapshot itself has changed.**

```ts
export interface CachedExtractEntry {
  formatVersion: number;
  operations: Operation[];          // unchanged from §2.1/R2.5
  extractorVersion: string;         // unchanged
  createdAt: string;                // unchanged
  /**
   * RUNTIME CACHE mode only (absent/undefined for an ARTIFACT-mode entry —
   * a build artifact is never staleness-checked at read time, R2.4). Absent
   * also for an entry written by a future directory-mode backend reusing
   * this same interface — its reader just always takes the full-rehash path,
   * which is correct, just not fast. This is what keeps the "same shape,
   * either mode" promise: the field is additive, never required.
   */
  staleness?: {
    /** The full content/version-addressed key (R2.2's old §2.2 formula,
     *  unchanged) computed at write time — compared only on the slow path. */
    contentKey: string;
    /** Absolute path + mtimeMs of the source file at write time. */
    source: { path: string; mtimeMs: number };
    /** Absolute path + mtimeMs of every transitive local import at write
     *  time (same `collectLocalImportPaths` walk §2.2 already specified). */
    deps: Array<{ path: string; mtimeMs: number }>;
  };
}
```

Read path (`createIrCacheLayer`'s `layer` function) for `cache: <file-path>`:

1. `stat()` the configured file. Missing → MISS (run extractor, write R2.3's atomic write below).
2. Missing/mismatched `formatVersion`/`extractorVersion` → MISS (identical gate to today's §2.1).
3. **Fast gate**: `stat()` `entry.staleness.source.path` and every `entry.staleness.deps[].path`
   directly (no `collectLocalImportPaths` call, no hashing — just `fs.stat` on a short, already-known
   list of paths). If every current `mtimeMs` matches the recorded one *and* `call.source` matches
   `entry.staleness.source.path` → **HIT**, return `entry.operations`. This is the path that
   eliminates gap (3): a clean repeated `--help` invocation costs `N` cheap `stat()` calls (`N`
   = 1 + dep count, typically single digits for `client.d.ts`), not `N` full file reads + SHA-256.
4. **Slow gate (mtime changed, or `staleness` absent)**: recompute the full `contentKey` — R2.2's
   old §2.2 formula, i.e. `collectLocalImportPaths(call.source)` + `sha256File` of the source and
   every dep — and compare against `entry.staleness.contentKey`. Match → HIT (a `touch` with no
   real edit; e.g. a fresh git checkout or CI restore that didn't preserve mtimes) — return
   `entry.operations` AND fire-and-forget rewrite the entry's `staleness` mtimes to the current
   values (so the NEXT read takes the fast path again, not the slow one forever). Mismatch → MISS.
5. MISS in either case → run the real extractor (`next()`), then write R2.3's atomic entry.

This is an explicit tradeoff, stated plainly: step 3's fast gate trusts mtime as a *sufficient*
condition for freshness (matching the OS's own build-tool convention — make, Nx, tsc's own
incremental builds all do exactly this), while step 4's fallback is what makes an mtime-only
scheme *safe* against the exact class of false-negative BUG-019/§2.2 was written to avoid
(content genuinely unchanged, mtime bumped by a checkout) — the fallback is only ever reached when
the fast gate's premise (mtime tracks content) has already been violated, so its cost is paid
rarely, not on every call. This closes gap (3) (no cost on the common HIT) without reopening the
mtime-correctness gap §2.2 explicitly rejected (a *genuine* content change still MISSes, because
step 4's fallback recomputes the real hash whenever mtimes disagree, and step 3 never runs without
a `staleness` snapshot recorded by a prior real extraction).

**Atomic write (closes the review-flagged non-atomic-write gap).** Replace `fs-backend.ts:35-38`'s
plain `writeFile(path, ...)` with temp-file + rename, at the single-file backend used by RUNTIME
CACHE mode:

```ts
import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, path); // atomic on the same filesystem (POSIX rename(2))
  } catch (err) {
    await unlink(tmp).catch(() => {}); // best-effort cleanup; never mask the real error
    throw err;
  }
}
```

`rename()` on the same filesystem is atomic (POSIX guarantee) — a reader mid-`get()` either sees
the old complete file or the new complete file, never a half-written one. The `pid + randomUUID()`
suffix avoids two concurrent writers (e.g. two CLI invocations racing on a cache MISS) colliding
on the same temp path; the *last* `rename()` wins, which is an acceptable, documented race (both
writers computed the extraction independently and would have written byte-identical
`operations` for identical input — losing one temp write costs nothing but a redundant extraction
that already happened).

### R2.4 — ARTIFACT mode (`cache: 'artifact'`) — the `target` capability

**Why a `target` capability, not a Vite/rollup build hook.** A build-hook approach (e.g. a rollup
`writeBundle`/`generateBundle` plugin that both derives the IR *and* participates in the same
build that imports it) was explicitly considered and rejected in the conversation that produced
this revision: rollup resolves **static imports before `writeBundle` fires** — a chunk containing
`import data from './client.ir.json'` is resolved and inlined *before* any hook that could
generate `client.ir.json` for the first time has run, producing an unresolvable
chicken-and-egg failure the first time (and on any subsequent run where the artifact was deleted).
Reusing the *existing* `TargetCapability` shape (`plugin.ts:254-288`) and the *existing*
`apigen generate --type <plugin-id> --out-dir <path>` CLI invocation
(`entrypoint/apigen-cli/src/lib/commands/generate.ts:178-294`) sidesteps this entirely by making
artifact production a **separate command, a separate process, run strictly before** the consumer's
own build — not a hook inside it.

```ts
// apigen-plugin-ir-cache's target capability (new; the plugin becomes BOTH
// a --use-loadable layer AND a --type-selectable target — see R2.6 for how
// one Plugin object carries both without conflict)
capabilities: {
  target: {
    name: 'ir-cache',
    generate(descriptor: Descriptor, opts: IrCacheOptions): File[] {
      if (opts.cache !== 'artifact') {
        throw new Error(
          `apigen-plugin-ir-cache: --type ir-cache requires --opt cache=artifact ` +
          `(got "${opts.cache}"). RUNTIME CACHE mode (a file path) is a --use ` +
          `layer, not a --type target — see docs/apigen/design-notes/` +
          `extract-stage-onion-and-ir-cache.md Revision 2.`
        );
      }
      const entry: CachedExtractEntry = {
        formatVersion: CURRENT_FORMAT_VERSION,
        operations: descriptor.operations,
        extractorVersion: opts.extractorVersion ?? readCoreClientVersion(),
        createdAt: new Date().toISOString(),
        // no `staleness` — an artifact is never read-time-staleness-checked (R2.3's
        // note); its freshness comes from WHEN the generating command was run.
      };
      return [{ path: opts.filename ?? 'ir-cache.json', content: JSON.stringify(entry, null, 2) }];
    },
    // no `serve()` — codegen-only, per `plugin.ts:280`'s documented convention
    // (`apigen-plugin-openapi` is the reference example: mount-only, no target
    // at all; this plugin is the mirror case — target-only for this capability,
    // `layer`-only for the other, never both on the same invocation).
  },
},
```

**The critical ordering constraint — stated prominently, per the review's own flag that this is
the single most important thing in this whole design.** ARTIFACT mode MUST run as a separate,
*prior* build step whose output already exists on disk before the consumer's own build/import
runs. Concretely, for an Nx-built consumer:

```json
// packages/<consumer>/project.json — a new target, NOT folded into "build"
"generate-ir-cache": {
  "executor": "nx:run-commands",
  "options": {
    "command": "apigen generate --source {projectRoot}/src/client.ts --type ir-cache --out-dir {projectRoot}/src --opt cache=artifact"
  },
  "dependsOn": ["^build"]  // needs the consumer's OWN deps built, not the consumer itself
},
"build": {
  // ...existing build config...
  "dependsOn": ["generate-ir-cache", "^build"]  // artifact MUST exist before build starts
}
```

A consumer's `import data from './client.ir.json'` (or `.json` resolved via `resolveJsonModule`)
then sees a real, already-on-disk file the moment its own build starts — never a build racing to
both generate and consume the same artifact in one pass. **Do not attempt to fold artifact
generation into the SAME build invocation that imports it** — that is exactly the ordering hazard
this mode exists to avoid, restated once more because it is the one design constraint in this
revision that, if violated, silently reintroduces the exact rollup chicken-and-egg failure this
mode was built to sidestep.

### R2.5 — Shared entry shape (unchanged core, additive field)

`CachedExtractEntry` (R2.3) keeps §2.1's original four fields (`formatVersion`, `operations`,
`extractorVersion`, `createdAt`) byte-for-byte, and adds one **optional** field, `staleness`,
populated only by RUNTIME CACHE mode. This is what makes "switch modes without a migration" true:
an ARTIFACT-mode-written entry read by a RUNTIME-CACHE-mode reader has `staleness` absent, which
the reader's step 4 (R2.3) already treats as "always take the slow, correct, full-rehash path" —
never a MISS on absent metadata, never a crash, just no fast-path benefit until the next
RUNTIME-CACHE-mode write repopulates it.

### R2.6 — Generic `--use`/`--type`-driven composition (closing "only backlog gets this")

**The gap, restated concretely.** Today, exactly one call site in the entire repo gets IR caching:
`entrypoint/backlog/src/server.ts:276-295`'s `getExtractInvoke()`, which hand-constructs
`createExtractInvoker([createIrCacheLayer(...)], (call) => extract({...}))` directly — no `--use`
flag, no plugin registry involvement, no way for a different command (`apigen generate`,
`apigen run`, `generate-registry`, `run-registry`) to opt in without duplicating that same
hand-wiring. This is the dispatch-side onion's situation *before* `package-invoker.ts`'s
`createPackageInvoker`/`UsePlugin`/`readUsePlugins` existed — the exact gap this revision closes
for the extract side, by the same pattern.

**Where it plugs in.** `entrypoint/apigen-cli/src/lib/orchestrator.ts`'s `extractSource()`
(`:282-313`) is the **single** call site of `extract()` reached by every apigen-cli command that
performs extraction — `buildDescriptor()` (`:388+`) calls it once per `SourceEntry`, and
`buildDescriptor()` is itself the shared core every one of `generate`/`generate-registry`/
`run`/`run-registry` funnels through. `OrchestratorOptions` (`:114+`) already carries
`usePluginObjects?: Plugin[]` (`:133`) — the *loaded* `--use` plugin objects, already threaded
into `buildDescriptor()` (destructured `:391`) and already dispatched for the **envelope**
capability via `pluginsToEnvelopeMiddlewares(usePluginObjects)` (`:396`). Extraction is the one
capability class that ISN'T dispatched there yet — this revision adds it, using the exact same
already-loaded `usePluginObjects` array, no new CLI flag, no new loading mechanism.

**What changes, concretely:**

1. **New capability field**, `extractLayer`, added to `Plugin.capabilities` in
   `packages/apigen/apigen-core-client/src/lib/plugin.ts` (sibling to `layer`/`target`/`mount`/
   `envelope` at `:667-699`):

   ```ts
   export interface ExtractLayerCapability {
     /** Wraps the extract-stage invoker — same algebra as LayerCapability.layer
      *  (`:326`), but typed against ExtractCall/ExtractResult (extract-invoker.ts),
      *  NOT the dispatch-shaped Call/Result. This is the deliberate, accepted
      *  "two Call shapes" asymmetry §1.3/§5.1 already flagged, made concrete
      *  and type-safe rather than papered over with an unsafe duck-typed view:
      *  ExtractCall has no domainArgs/envelope/operation.id to view-cast INTO
      *  a dispatch Call, so — unlike adaptCoreLayer's `Object.assign(call,
      *  {data: call.domainArgs})` trick, which works because the two Call
      *  shapes are structurally close — an extract-stage plugin needs its own
      *  field, not a coercion of `layer`. */
     layer: ExtractMiddleware;
   }
   // Plugin.capabilities gains: extractLayer?: ExtractLayerCapability;
   ```

2. **New composition helper**, alongside `createExtractInvoker` in
   `packages/apigen/apigen-core-client/src/lib/extract-invoker.ts` (this package already owns
   `Plugin`, `ExtractCall`/`ExtractResult`/`ExtractMiddleware`, and `createExtractInvoker` — no new
   package, no upward dependency onto `apigen-engine-runtime` needed, unlike the dispatch side's
   `adaptCoreLayer`/`createPackageInvoker` which legitimately live one tier up because they touch
   the runtime `Call`/`InvokeFn` shapes):

   ```ts
   import type { Plugin } from './plugin';

   /** Mirrors createPackageInvoker's (`package-invoker.ts:124`) role for the
    *  extract stage: pulls every loaded plugin's `extractLayer` capability
    *  (in declaration order, outermost-first — identical composition rule to
    *  `--use` layer ordering on the dispatch side) and wraps `runExtractor`. */
   export function createExtractInvokerFromPlugins(
     plugins: readonly Plugin[],
     runExtractor: (call: ExtractCall) => Promise<ExtractResult>
   ): (call: ExtractCall) => Promise<ExtractResult> {
     const middlewares = plugins
       .filter((p): p is Plugin & { capabilities: { extractLayer: ExtractLayerCapability } } =>
         Boolean(p.capabilities.extractLayer)
       )
       .map((p) => p.capabilities.extractLayer.layer);
     return createExtractInvoker(middlewares, runExtractor);
   }
   ```

3. **`orchestrator.ts`'s `extractSource()`** gains a `usePluginObjects?: Plugin[]` parameter
   (threaded from `buildDescriptor()`'s already-destructured `:391` value, no new plumbing at the
   command layer) and wraps its existing `extract({...})` call (`:296-301`) with
   `createExtractInvokerFromPlugins(usePluginObjects, (call) => extract({sourceFile: call.source, namespace: call.namespace, tsconfig: call.extractorOptions?.tsconfig, session: call.extractorOptions?.session}))`
   instead of calling `extract()` directly — a MISS behaves byte-identically to today (same
   `extract()` call, same arguments); a plugin supplying `extractLayer` (e.g. `apigen-plugin-
   ir-cache` with `--use ir-cache --opt cache=<path>`) now transparently wraps every apigen-cli
   command's extraction, not just backlog's hand-wired one.

4. **`entrypoint/backlog/src/server.ts`** stops hand-constructing the invoker (see the
   implementation spec's Revision 2 section for the exact diff) and instead loads `apigen-plugin-
   ir-cache`'s exported `Plugin` object the same way any `--use`-style consumer would, passing it
   through `createExtractInvokerFromPlugins` — collapsing backlog's bespoke `getExtractInvoke()`
   onto the same generic mechanism every other apigen-cli command now uses, and gaining an opt-out
   for free (see R2.7).

This closes the ergonomics gap §1.3/§5.1 already flagged rather than hiding it: an extract-stage
plugin author writes against `ExtractCall`/`ExtractResult` via the new, explicit `extractLayer`
capability; a dispatch-stage plugin author writes against `Call`/`Result` via the existing `layer`
capability; a plugin wanting BOTH declares both capabilities on the same `Plugin` object (as R2.4's
`apigen-plugin-ir-cache` now does for `target`+`extractLayer`) — no unification of the two `Call`
shapes is attempted, matching §5.1 finding 1's own conclusion that no unforced unification exists.

### R2.7 — The opt-out (closing the "no runtime kill switch" review flag)

Because R2.6 makes `extractLayer` composition **opt-in via `--use`** (or, for backlog's non-CLI
server/MCP mount path, via an explicit plugin list backlog itself constructs), the "unconditional,
no opt-out" gap dissolves structurally rather than needing a bespoke env-var check: backlog's
`server.ts` decides whether to include the ir-cache plugin in the list it passes to
`createExtractInvokerFromPlugins` at all. The implementation spec's Revision 2 section specifies
this as `APIGEN_IR_CACHE_ENABLED` (default `'1'`; `'0'` omits the plugin from the list entirely) —
kept as an explicit env-var gate on backlog's side specifically because backlog's three transports
(HTTP/MCP/CLI) are not driven through `apigen-cli`'s `--use` flag parsing at all (they're a live
mount, not a `generate`/`run` invocation), so there is no `--use`/`--no-use` CLI surface for a
human to flip there — an env var is the only available knob for that specific host, not a
general pattern this revision is proposing repo-wide.

### R2.8 — Open questions carried forward / newly raised (not resolved here)

1. **The `'artifact'` sentinel string collision** (R2.2) is a real, if narrow, ambiguity — a
   caller who wants a RUNTIME CACHE file literally named `artifact` (no extension, cwd-relative,
   no `./` prefix) cannot express that. Accepted as documented behavior, not fixed by a type-level
   guarantee; flagged for a human to confirm is acceptable rather than assumed.
2. **Concurrent-writer races in RUNTIME CACHE mode** (R2.3's atomic write): `rename()` makes each
   individual write atomic, but two concurrent MISSes both racing to write the same path are not
   coordinated (no lock) — the design accepts "last writer wins, both computed the same answer" as
   sufficient, but this has not been verified true for a NON-deterministic extractor output (see
   original §5's open question 2 on transitive-hash cost — the same "is extraction actually
   deterministic for identical input" assumption underlies this too and was never independently
   proven, only asserted).
3. **`filename` default (`ir-cache.json`) collision across multiple sources** in ARTIFACT mode:
   if a future multi-source `generate-registry`-driven artifact build runs the ir-cache target once
   per source into the same `--out-dir`, every source produces `ir-cache.json` and the last one
   wins silently. Not exercised by the smallest slice (single-source `generate`, matching the
   original design's own §4 sequencing decision to defer multi-source orchestrator wiring), but a
   real gap the moment ARTIFACT mode is used from `generate-registry`.
4. **Whether `extractLayer` should also gain an `envelopeFields`-style declarative surface**
   (mirroring `LayerCapability.envelopeFields`, `plugin.ts:310`) is left unaddressed — no extract-
   stage equivalent of envelope fields is proposed here, because no concrete plugin need for one
   has surfaced yet (YAGNI, consistent with the original design's own §3 closing paragraph on not
   over-building `composeOnion` ahead of a second real consumer).
