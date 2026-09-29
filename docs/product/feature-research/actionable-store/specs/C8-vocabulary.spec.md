# C8 — Closed primitives / readable catalogs / self-describing surface

> **Ticket:** `4a12472e-f3d7-40da-94d0-404dc8d01ef6` (MEDIUM) · component `9a7bf578`
> **Design:** `../DESIGN.md` §2 Invariant 6, §5 AC8, §6 Vocabulary · **Conceptual test:** `../CONCEPTUAL_TEST.md` §D.3
> **ADRs read:** ADR-0001 (store atomicity; typed config never env toggles), ADR-0002 (correct the source), ADR-0003 (CJS-only), ADR-0004 (flat payload — a catalog view is a union/array return; no `{result}` envelope).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) + `packages/apigen/apigen-plugin-cli-output` (the help renderer is cross-package) · **Wave:** 3 · **Dependencies:** none (Wave 3). The catalog `kind`-merge and the read-path invariant guard must be sequenced so the guard is green **after** the reviewed one-shot repair · **Evidence requirement:** AC3 drives the **built** package (`nx run backlog:verify-dist-load`), not source; AC4 asserts the rendered CLI help string; AC1–AC7 each carry a negative control. The live count (`133 + 782`) must be re-verified against the store before it is hardcoded.

## Summary

Make the tool describe itself. Expose a readable, **generated** catalog view over the validating sources; publish a machine-readable verb surface that a test can enumerate and that agent specs read instead of hardcoding; render `namespace verb` and one-token `--input` verbs distinctly in CLI help; retire the borrowed vocabulary (`kind:EPIC`) and fold case-duplicate `kind` rows. Two of these cross a package boundary (`apigen-plugin-cli-output` help), so this spec has two package groups.

## Premise corrections (read before implementing)

1. **`get {registry:"kind"}` cannot be fixed by widening the union.** `IIssueGetRegistryInput.registry` (in `query/types.ts`) is a literal union, and apigen picks branches **structurally**, not by a literal discriminator (`pickUnionBranch`/`scoreUnionBranch` in `apigen-base-logical`). A `'kind'` literal would still be rejected at the schema boundary (the exact `oneOf`-must-match-exactly-one class the ticket observes). **Design decision: add a `query {view:"kinds"}` read view** (and a sibling `view:"catalogs"`), not a fourth `registry` branch. `get`'s union is left untouched.
2. **The `kind` merge cannot reuse `catalog-merge.ts` as-is.** That module is hard-scoped to `CatalogKind = 'status' | 'priority'` and its `isCanonicalSpelling` rule is per-kind (status→lowercase, priority→uppercase). `kind` is an **open** vocabulary (`resolve.ts`) with **no write-path canonical spelling** — the writer emits whatever the caller passes. So a `kind` group has no "write spelling" to merge into, and the existing planner would mark every such group `unmergeable`. AC5 needs an explicit canonical rule for `kind`.
3. **The invariant guard does not cover `kind`.** `catalog-invariant-guard.ts` guards `['status','priority']` only. Extending the case-fragment check to `kind` is required for AC5 to be detectable at read time.
4. **The 915-row count (`133 + 782`) is asserted in the ticket from the store** — verify it against the live store before wiring the test's expected constant; do not hardcode a number the store does not currently hold.
5. **`enrich` is not in this package.** No `enrich` token exists in `entrypoint/backlog/src` or `skill/`; the advertising source is an agent spec outside this repo. The AC3 mechanism is the **surface self-check** (enumerate the published surface), and the *fix* to the `enrich` claim is an edit at that spec's source (ADR-0002 D2).

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | src/query/types.ts | modify | 80 | 120 |
| entrypoint/backlog | src/query/views/catalog.ts | create | 0 | 300 |
| entrypoint/backlog | src/query/query.ts | modify | 120 | 160 |
| entrypoint/backlog | src/write/catalog.ts | modify | 160 | 180 |
| entrypoint/backlog | src/write/catalog-merge.ts | modify | 120 | 160 |
| entrypoint/backlog | src/store/catalog-invariant-guard.ts | modify | 80 | 120 |
| entrypoint/backlog | src/server.ts | modify | 60 | 120 |
| entrypoint/backlog | src/api.ts | modify | 40 | 120 |
| entrypoint/backlog | src/index.ts | modify | 30 | 40 |
| packages/apigen/apigen-plugin-cli-output | src/lib/run.ts | modify | 90 | 140 |
| docs | src/write/CONTRACT.md (+ catalog docs) | create/modify | 40 | 160 |

## Interface changes

### src/query/views/catalog.ts (new) — the generated catalog

```typescript
export type CatalogKindName = 'kind' | 'status' | 'priority' | 'relation' | 'field' | 'error_code' | 'location_type' | 'verb';

export interface ICatalogTerm {
  /** The term's canonical name. */
  name: string;
  /** Live row uid when a store row backs it; absent for in-code source terms. */
  uid?: string;
  /** Which vocabulary this term belongs to. */
  catalog: CatalogKindName;
  /** The validating source, named — so the catalog is provably generated, not hand-maintained. */
  source: 'store' | 'edge_kind_table' | 'reserved_terminal_status_names' | 'issue_field_union' | 'error_code_union' | 'valid_location_types' | 'mounted_verb_surface';
  lifecycle: 'active' | 'deprecated';
  /** Present when deprecated: the term to use instead. */
  replacedBy?: string;
  /** For `kind`/`status`/`priority`: the live callers count, read at call time. */
  usageCount?: number;
}

export interface ICatalogView {
  catalogs: CatalogKindName[];
  terms: ICatalogTerm[];
  /** True when any term is a case-fold collision of another within its catalog (the invariant the read layer depends on). */
  hasCaseCollisions: boolean;
}

/** ONE read view. Every non-`store` term is derived from its in-code source at call time — never a hand-written list. */
export async function catalogView(graph: GraphBackend): Promise<ICatalogView>;
export async function catalogFor(graph: GraphBackend, catalog: CatalogKindName): Promise<ICatalogTerm[]>;
```

### src/query/types.ts — the view union

```typescript
export type IIssueView =
  | 'list' | 'ready' | 'graph' | 'order' | 'stale' | 'similar' | 'overlap'
  | 'projects' | 'components' | 'locations'
  | 'kinds' | 'catalogs';   // NEW

export interface IIssueQueryInput {
  // ...existing...
  /** `view:'catalogs'` only: narrow to one catalog. */
  catalog?: CatalogKindName;
}
```
`IIssueQueryResult` gains `{ view: 'catalogs'; catalogs: ICatalogView }`. Per ADR-0004 this is a union return → flat payload on `content`; no `{result}` wrapper.

### src/write/catalog.ts — deprecation + canonical kind spelling

```typescript
// AFTER — on the mint path
export interface IMintOrResolveInput {
  catalogKind: FlatCatalogKind;
  ref: string;
  mintMetadata?: (tx) => Promise<Record<string, unknown>>;
  at?: string;
  /**
   * A deprecated catalog name (meta.lifecycle === 'deprecated') is rejected on
   * mint unless explicitly allowed. NOT an env var — a typed caller decision.
   */
  allowDeprecated?: boolean;
}
```
`mintOrResolveCatalogTx` (in `catalog.ts`) checks a resolved-or-minted row's `meta.lifecycle`; a `deprecated` row throws `InvalidArgumentError('kind', …)` naming `meta.replacedBy` unless `allowDeprecated`. Add `DEPRECATED_KIND_NAMES` (frozen in-code set, modelled on `RESERVED_TERMINAL_STATUS_NAMES` in `catalog.ts`) listing `EPIC`.

### src/write/catalog-merge.ts — extend to `kind`

```typescript
// BEFORE: export type CatalogKind = 'status' | 'priority';
// AFTER:  export type CatalogKind = 'status' | 'priority' | 'kind';
```
`isCanonicalSpelling` gains the `kind` rule. **Chosen canonical for `kind`: NFC-fold, lowercase.** Rationale (documented in the module): the in-code `EDGE_KIND_TABLE`/verb vocabulary and the dominant live spellings are lowercase; the write path has no fixed case, so a lowercase canonical is the one a case-insensitive mint guard can reliably re-find. This requires `mintOrResolveCatalogTx` to **case-fold the `(kind,name)` lookup for `kind` only** (add a folded-match SELECT before the exact-match INSERT), so the next ordinary `create` cannot re-mint a fragment — the same self-defeat guard the status branch has. This is the one substantive write-path change.

### src/store/catalog-invariant-guard.ts — guard `kind` too

```typescript
// BEFORE: const GUARDED_CATALOG_KINDS = ['status', 'priority'] as const;
// AFTER:  const GUARDED_CATALOG_KINDS = ['status', 'priority', 'kind'] as const;
```
`kind` joins the case-fragment uniqueness check (it is a name-grouped catalog like the other two).

### src/server.ts — the machine-readable surface

`describeMountedSurface()` (in `server.ts`) already returns `IMountedOperationSurface[]` (`{id, cliCommand, cliPath, mcpTool, httpVerb, httpRoute}`). Add a **published** accessor so a consumer (and a test) reads it instead of hardcoding:

```typescript
// AFTER — new export
/** The full advertised surface, each entry a real mounted operation. */
export function describeBacklogSurface(): IMountedOperationSurface[];
/** Throws naming any advertised verb absent from the mounted set (the `enrich` class). */
export function assertSurfaceIsReal(): void;
```
`assertSurfaceIsReal` is the AC3 mechanism: enumerate `BACKLOG_VERBS` (in `server.ts`) and `describeMountedSurface()`, assert the sets are equal and every advertised tool resolves in the built package. `index.ts` re-exports both.

### packages/apigen/apigen-plugin-cli-output/src/lib/run.ts — distinct help rendering

`formatUsage(routes)` (in `run.ts`) currently lists every route the same way. Modify it to render **two labelled sections**:
- `Namespaced verbs (namespace + verb, per-field flags):` — routes whose `cli.path.length > 1` (e.g. `batch action`).
- `Verbs (one-token, --input JSON envelope):` — routes whose `cli.path.length === 1` plus the calling convention.
`matchCommand` (longest non-flag prefix, in `run.ts`) already distinguishes them at dispatch; this makes the **help text** reflect that distinction. Cross-package because the renderer is shared by every apigen host — the change must be additive (both sections shown) so no other host regresses.

## Behavioral changes

- **`view:"kinds"` / `view:"catalogs"`** → `ICatalogView` / `ICatalogTerm[]`. Read-only; composes live rows + in-code sources.
- **`kind` mint** → case-folded lookup for `kind`; deprecated `EPIC` rejected on mint unless `allowDeprecated`.
- **`kind` merge** → the case-fragment repair now covers `kind`; `planCaseFragmentMerge`/`applyCaseFragmentMerge` unchanged in signature (only the `CatalogKind` union widened).
- **CLI help** → two sections; no dispatch change.
- **Surface** → `describeBacklogSurface`/`assertSurfaceIsReal` published.

## Data / migration steps

1. **`kind` case-fold merge:** run the (now `kind`-aware) `planCaseFragmentMerge`/`applyCaseFragmentMerge` against the live store as a **reviewed one-shot** (library-only surface, exported from the `index.ts` barrel, never mounted). Record the affected count (assert against the ticket's 133+782 = 915 **after verifying live**).
2. **`EPIC` retirement:** set `meta.lifecycle:'deprecated'`, `meta.replacedBy:'FEAT'` on the one `kind` row `841617b8` (already `SUPERSEDED`) with a migration note; add `EPIC` to `DEPRECATED_KIND_NAMES`. No re-keying (design §6: re-express in place).
3. **`undefined`/`MEDIUM` cleanup:** the live `kind` catalog holds a literal `undefined` and a priority value `MEDIUM` (`DESIGN` §2 Invariant 6). These are **retired** with reasons via the same reviewed repair: set `meta.lifecycle:'deprecated'` + `meta.retiredReason`; never hard-delete. Verify the exact rows in the store before writing the migration.
4. **Project/sox-store facts:** none. All adhd-store.

## Test list (each AC → a test, with its negative control)

| AC | Test | Negative control (must go RED) |
|----|------|-------------------------------|
| AC1 | `query {view:"kinds"}` returns ≥1 term with name + source + lifecycle | A build where the catalog is unreadable (today: no view exists) must fail |
| AC2 | Add a legal value via the validating registry (mint a `kind` row) → it appears in the catalog **with no separate edit** | A hand-maintained catalog list that misses a newly minted term must fail |
| AC3 | Enumerate `describeBacklogSurface()` and assert every advertised tool/verb is invocable in the built package | A spec advertising `enrich` (a verb the tool does not implement) must fail `assertSurfaceIsReal` |
| AC4 | CLI `--help` output names **both** the `batch action` namespace section and the one-token `--input` verbs | A renderer that lists both forms identically must fail |
| AC5 | After the `kind` merge, `kind:"bug"`/`"BUG"` reconcile to one canonical value; count assertion equals the independently-computed live count | A build that leaves two live rows under one fold must fail; an `unmergeable`-only plan must fail |
| AC6 | `kind:EPIC` is `deprecated` with a `replacedBy`; minting a new `EPIC` `kind` without `allowDeprecated` is refused | A build that mints `EPIC` silently must fail |
| AC7 | The five-part promotion gate is documented and referenced from the catalog surface (`ICatalogTerm`/`ICatalogView` doc + `CONTRACT.md`) | A catalog view with no gate reference must fail |

AC3's test must drive the **built** package (`nx run backlog:verify-dist-load`), not source, so a verb exported in source but dropped from `dist` is caught. AC4's test asserts on the rendered help string from the CLI plugin.

## Blast radius (gitnexus)

- `IIssueView` / `IIssueQueryResult` — the closed view union; adding `'kinds'`/`'catalogs'` requires the matching `IIssueQueryResult` member (an unhandled `view` must not fall through). `dispatchQueryView` (in `query.ts`) gains two cases.
- `CatalogKind` union (`catalog-merge.ts`) — widening it makes `assertMergeableKind` accept `kind`; `applyCaseFragmentMerge`'s status-only lowercase guard must be **generalized**, not bypassed, or a `kind` group merges into a re-defeatable spelling.
- `mintOrResolveCatalogTx` (`catalog.ts`) — every `kind`/`status`/`priority`/`agent` mint flows through it. The folded lookup is scoped to `kind`; status/priority keep their exact-match behaviour (their bug is repaired by the merge, not the mint — `catalog-invariant-guard.ts` documents this).
- `catalog-invariant-guard.ts` `GUARDED_CATALOG_KINDS` — wiring it into `queryHandle` (in `query.ts`) means a `kind` collision now **fails reads loudly**. That is intended, but it will surface any live collision on the next query — coordinate with the one-shot merge so the guard is green after the repair.
- `formatUsage` (`run.ts`) — shared by every apigen CLI host. Additive sections only.
- `index.ts` barrel — `describeBacklogSurface`/`assertSurfaceIsReal` are library-only (never mounted); but they must be derived from `BACKLOG_VERBS` so they cannot drift.

## Independent segments (execution order)

### Segment A — Catalog read view (files: `query/views/catalog.ts` create, `query/types.ts`, `query/query.ts`)
- Deps: none. Read: `types.ts:254-381`, `query.ts:1125-1188` (~150 tok). Out ~420 tok.
- Build the generated view from the in-code sources + live rows. **Do NOT** widen `get`'s registry union (premise correction 1).

### Segment B — Surface self-check (files: `server.ts`, `index.ts`)
- Deps: none. Read: `server.ts:188-260`, `index.ts:52-57` (~120 tok). Out ~180 tok.

### Segment C — CLI help sections (files: `packages/apigen/apigen-plugin-cli-output/src/lib/run.ts`; cross-package)
- Deps: none. Read: `run.ts:240-280`, `:680-710` (~100 tok). Out ~160 tok.
- Additive; run `nx affected -t test` for the plugin (it has dependents).

### Segment D — `kind` merge + mint fold + guard (files: `write/catalog.ts`, `write/catalog-merge.ts`, `store/catalog-invariant-guard.ts`)
- Deps: none. Read: `catalog.ts:281-333`, `catalog-merge.ts:100-137,274-321,357-526`, `catalog-invariant-guard.ts:57-90` (~260 tok). Out ~420 tok.
- Highest-risk segment (writing to live catalog rows + a read-path guard that fails loudly). Sequence: fold-lookup → merge extension → guard extension → **then** run the reviewed one-shot merge so the guard is green after.

### Segment E — Migration + docs (files: `write/CONTRACT.md`, catalog docs)
- Deps: Segments A/D. Read ~60 tok. Out ~200 tok.
- The one-shot repair runs here (Segment D's code), verified against the live count.

## Documentation

- `write/CONTRACT.md`: the five-part promotion gate (not-expressible / ≥2 in-repo consumers / rename-proof id / core-validatable / discoverable), the governed extension namespace (owner, register verb, discovery, lifecycle), and the `kind` canonical rule.
- `SKILL.md` / README: `view:"kinds"`/`"catalogs"`, the deprecated vocabulary + replacements, the surface self-check.
- The agent spec advertising `enrich` is corrected **at its source** (ADR-0002 D2) — file it as a spec edit, not a tool workaround.
