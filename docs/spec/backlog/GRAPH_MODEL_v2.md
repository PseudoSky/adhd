# `@adhd/backlog` — Graph Model v2 (Dimensional First-Class)

**Version:** v2.0
**Date:** 2026-08-08
**Status:** Design basis for EPIC-A. Written against `@adhd/sox-graph-store` 0.6.0; the
package now depends on `^0.8.6` (`entrypoint/backlog/package.json`), so version-specific
claims below need re-verification against 0.8.x before implementation.

**EPIC-F has landed.** §6's "`db` becomes `adapter: StoreAdapter`; all store functions
become async" is already true in the code (`graph-backlog-store.ts` opens through
`@adhd/sox-store-adapter`; store functions are async). Any sequencing note in this
document that treats EPIC-F as a prerequisite is stale.

---

## 1. Why the model is dimensional

The backlog's working queries are dimensional: "give me bugs for X repo by Z author", "all open items in project Y", "everything reported by A", "items touching package P". In the v1 model every one of these dimensions is a **scalar string on the item node** (`repo`, `projectPath`, `plan`, `assignee` are JSON fields in `metadata`), so composing dimensions means fetching items and filtering in JS. That fails at scale, produces the fork-key defect (one repo stored as two strings, `adhd` and `PseudoSky/adhd`, with no reconciliation), and makes cross-repo dependency queries impossible.

The v2 model promotes every query dimension to a **first-class graph node**, links items to those nodes with **role-typed edges**, and answers dimensional queries in **one SQL statement** — never a post-filter.

## 2. The model

### 2.1 Node types

All dimension nodes are `kind: 'entity'` (within `DEFAULT_NODE_KINDS`), distinguished by tag:

| Node | tag | name | metadata |
|---|---|---|---|
| Repo | `backlog-repo` | `canonicalKey` | `{ canonicalKey, aliases: string[] }` |
| Project | `backlog-project` | `projectKey` | `{ projectKey }` |
| Package | `backlog-package` | `${repoKey}::${projectPath}` | `{ repoKey, projectPath }` |
| Identity (author / reporter / assignee) | `backlog-identity` | `canonicalIdentityKey` | `{ canonicalKey, aliases: string[], claimOnly?: boolean }` |

### 2.1.1 Identity: two roles, one canonical node

Identity serves **two distinct roles** that must not be conflated:

- **Claim identity** — who holds the CAS lease on an item (`claimedBy`). This is *ephemeral and per-instance*: `${agentName}:${instanceId}` (per-process, e.g. `researcher:a1b2c3`). It exists for CAS correctness and attribution of *transitions*; it must never be aggregated.
- **Author/reporter identity** — who authored or reported the item. This is *stable and canonicalized*: the agent/person name with the `:instanceId` suffix stripped (`researcher`), so two runs of the same agent aggregate into one author bucket.

`canonicalIdentityKey(raw)` mirrors `canonicalRepoKey`: strip any `:instanceId` suffix (the identity's `claimOnly` flag marks nodes minted solely as claim-leases), resolve aliases, return the canonical node. `by` stays a per-call parameter (§INTERFACE §4); the *node resolution* canonicalizes. **Derivation on create is explicit:** when `CreateItemInput.author` is absent, it **defaults to `canonicalIdentityKey(by)`** — the filing actor becomes the author. AC-14's aggregate stability depends entirely on this default, so it is a stated contract, not an implementation guess. **Aggregation invariants:** two items filed by `researcher:x` and `researcher:y` land on one author node — the AC (AC-14) proves aggregate-by-author is stable across agent runs, never per-process buckets.

### 2.2 Edge types

New rels (registered in `backlogTypePolicy`, extending `DEFAULT_EDGE_RELS`):

| Edge | Direction | Meaning |
|---|---|---|
| `IN_REPO` | item → repo | the item lives in this repo |
| `IN_PACKAGE` | item → package | the item is scoped to this package |
| `PROJECT_OF` | repo → project | the repo belongs to this project |
| `AUTHORED_BY` | item → identity | the item's author |
| `REPORTED_BY` | item → identity | the item's reporter |

Reused rels: `ASSIGNED_TO` (item → identity), `MEMBER_OF` (item → plan; the node kind disambiguates plan-membership from any other `MEMBER_OF` use), `DEPENDS_ON` / `RELATES_TO` (item-level, and repo/project-level for cross-repo dependencies), `PART_OF`, `SAME_AS`, `SUPERSEDES`, `DERIVED_FROM`.

The type policy registers the five new rels in `DEFAULT_EDGE_RELS` — not `PUBLIC_EDGE_RELS` (a separate, smaller constant; the two must not be conflated). The rel vocabulary is enforced by `TypePolicy` only (fresh 0.6.0 DDL has no rel CHECK), so extending it is a policy object, not a schema migration.

### 2.3 Field decisions

- `repo` on the item becomes the **canonical key stamp**; the raw string a caller passes is resolved through the repo-node alias map (§3). The `namespace` column is migrated to match the canonical key.
- `family` is **derived** from the humanId (`FEAT-BACKLOG-*` prefix) — never stored, never edged. It is a pure function of the id.
- `importedFrom` remains a metadata scalar (provenance, not a query dimension).
- `claimedBy` / `claimedAt` remain metadata-only (lease semantics, unchanged).
- humanId allocation is an atomic counter, not a scan (§5.2). The dense sequential
  `FAMILY-NNN` form is retained for readability, but nothing in this model depends on ids
  being gapless — treat gaplessness as a display convention, never an invariant to
  enforce with a read-max.

## 3. Repo identity and fork-key reconciliation

`canonicalRepoKey(raw)`: trim; strip `.git`; bare-name = last path segment. The bare name wins **iff no other known repo shares that segment**; an ambiguous bare name resolves to a new repo node plus a soft warning. Every public store entry that takes `repo` resolves it through `canonicalRepoKeyFor(store, raw)` = alias-map lookup → deterministic normalization → (create if absent) → canonical repo node.

The repo node carries `aliases: string[]` — every string ever used to address it, so `adhd` and `PseudoSky/adhd` (and any future spelling) resolve to one node. Reconciliation re-points item edges to the winner, folds loser aliases into the winner's alias list, invalidates loser repo nodes with `reason: 'repo reconciliation'`, and re-stamps `metadata.repo`, `name`, the content uniqueness marker, `content_hash`, and `namespace`. **Item rowids never change** — the RAG vector join key (`node_id`) and all content-bearing audit links are untouched. The raw-SQL escape hatch (the sanctioned mechanism for such rewrites) is used for the re-stamps.

**Ambiguity is surfaced on BOTH the create and query paths.** On create, an ambiguous bare name resolves to a new repo node plus a soft warning (below). On query, the same canonical resolution **never silently narrows**: if the bare name matches more than one known repo node, the query returns an envelope `warnings` entry (INTERFACE §7) naming the ambiguity and the node chosen — the "wrong data with no error" class is forbidden by the design's own correctness principle. Deterministic normalization (trim, strip `.git`, last path segment) runs first; only genuine cross-repo ambiguity triggers the warning.

## 4. Query layer — `store/dimensional.ts`

The centerpiece. Two primitives:

**`queryDimensionalItems(store, filter)`** — composes `buildNodeFilterClause(liveOnly=true)` with one `EXISTS (SELECT 1 FROM edge WHERE src = n.rowid AND rel = ? AND dst = ?)` subquery per dimension present in the filter (repo, author, reporter, project, package, plan, assignee). Author/reporter resolution goes through `canonicalIdentityKey` (§2.1.1) — a filter on `author: "researcher"` matches items authored by any `researcher:*` instance, stable across agent runs. The motivating query — "bugs for X repo by Z author" — is **one SQL statement**: live-item predicates ANDed with edge-membership predicates, limit/offset pushed down. Because the edge predicates are in the WHERE (not a JS post-filter), the pagination composition defect (limit × post-filter) is structurally fixed: filters apply before limit.

**`aggregateByDimension(store, dimension, filter)`** — for edge-backed dimensions: `SELECT e.dst, COUNT(*) FROM edge e JOIN node n ON n.rowid = e.src WHERE <live item + filter> AND e.rel = ? GROUP BY e.dst`. Serves FEAT-012's aggregate-by-reporter, FEAT-007 group-bys, `view: "grouped"`, and the stats by\* maps. Metadata-backed dimensions reuse `countByKey`.

`listItems`, `spotlight`, `readyItems`, `staleClaims`, and `dependencyGraph` route repo / projectPath / author / reporter / packagePath filters through `dimensional.ts`. The v1 filter surface stays API-compatible: `repo`/`projectPath` now resolve through canonicalization instead of exact string match; `author`, `reporter`, `project`, `packagePath` are additive filter fields.

> **Naming note:** this is a dimension *aggregate*. It is distinct from the per-item two-axis rollup (FEAT-005's `childrenClosed` + `selfVerified` read projection) — one is group-level counting, the other is per-item derivation. Keep the two concepts named apart (`aggregateByDimension` / rollup) in every call site and spec so they are never conflated.

## 5. The two live bugs as designed fixes

### 5.1 BUG-1 — silent dedup drop (CRITICAL)

`writeNode` dedupes on global `content_hash` and returns the existing rowid silently; the create path lost the fact that a drop happened. The v2 contract makes suppression visible on **every** path:

- `CreateItemResult` gains `reason?: 'duplicate-suppressed' | 'id-collision' | 'content-collision'`.
- `splitItemNode` returns `{ created: BacklogItem[], suppressed: Array<{ item, reason }> }` and writes `PART_OF` only for actually-created children.
- `supersedeItemNode` runs the dedupe scan **before** minting and returns `{ ok, created, item?, humanId?, duplicateCandidates?, reason? }` — it never mints on suppression.
- The interface shape is `{ ok, created, humanId?, duplicateCandidates?, reason? }` everywhere a create variant can suppress.

### 5.2 BUG-2 — humanId re-mint (HIGH) — **SUPERSEDED, and the original prescription was wrong**

This section previously required `computeNextHumanId` to derive the next id from **full
bi-temporal history** — live nodes and `t_invalid` rows — via
`buildNodeFilterClause(liveOnly=false)` over `(canonicalRepo, family)`, taking the max
trailing `-NNN`.

That prescription shipped (`ids.ts:169` passes `liveOnly=false`) and it did **not** fix
the class of bug it belongs to. Widening the scan cures re-mint-after-invalidation while
leaving the actual defect untouched: **allocation was still a read-max-then-write**, so
every `create` in the system read a globally shared maximum and then wrote it back. Two
writers on separate connections read the same max from their own WAL snapshots and both
mint it (BUG-039). A wider scan reads a wider stale value; it is still stale.

That single read-modify-write is what coupled every writer to every other writer, and it
is what pulled in `.immediate()` escalation, `withImmediateRetry`, and the partial unique
index over live rows — an entire concurrency-control apparatus downstream of one
allocation decision.

**Current design (commit `f2c70452`):** allocation is an atomic counter, not a scan.

```sql
UPDATE backlog_humanid_counter SET n = n + 1 WHERE namespace = ? AND family = ? RETURNING n
```

The engine evaluates `n + 1` against the row it writes, under the write lock, so no
snapshot is involved and there is nothing to read stale. The counter is monotonic, which
makes the tombstone-visibility question this section was originally about **structurally
impossible** rather than merely mitigated — a monotonic counter cannot re-mint an id
whether or not it can see invalidated rows. The bi-temporal scan survives only as
`scanMaxOrdinal`, a one-time cold-path seed for a family that has no counter row yet
(the production-upgrade path: existing items, no counter). `reconcileCounterForOverride`
moves the counter forward (`MAX(n, excluded.n)`) when a caller supplies an explicit
`humanId`, so overrides can never collide with a later auto-allocation.

**What this section does NOT resolve.** The counter seeds from the same graph-only scan,
so ids that exist only in markdown/CHANGELOG history and were never imported into the
graph remain invisible to it — see `BL-476` and
`BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001`, both still open.

**The premise that was never examined.** §2.3's "humanId allocation survives; only its
scan scope changes" is the sentence that kept the defect. The dense sequential
`FAMILY-NNN` id is *why* a shared maximum had to be read at all; nothing in the model
requires ids to be gapless. Any future change here should question that first, not widen
a scan again.

## 6. Interface changes

- `BacklogFilter` (model.ts): adds `author?`, `reporter?`, `project?`, `packagePath?`; `repo` / `projectPath` resolve canonically (API-compatible).
- `CreateItemInput`: adds `author?`, `reporter?`.
- `CreateItemResult`: adds `reason?`.
- New result types: `SplitItemResult`, `SupersedeResult`, `RollupResult = Record<string, number>`, `MigrateModelV2Result { dryRun, itemCount, edgeCount, repoReconciliations, collisions, parityOk }`.
- `GraphBacklogStore`: `db` becomes `adapter: StoreAdapter` (0.6.0); all store functions become async (EPIC-F mechanical conversion).
- New client operations: `queryItems` (extends `listItems` with dimensional filters), `aggregateBy`, `reconcileRepos`, `migrateGraphModelV2`.
- New admin/CLI commands: `migrate-model-v2`, `reconcile-repo`.

## 7. Migration

`migrateGraphModelV2`:

1. `adapter.backupTo` (a backup is taken before any write).
2. **Legacy edge-schema reopen (pre-0.6.0 stores only).** `ensureCheckConstraints` will
   NOT rebuild a legacy edge table whose rel CHECK already constrains rels (graph-store
   index.ts:989-993) — a v1 backlog store keeps its closed rel CHECK and **rejects the
   five new rels (`IN_REPO`, `IN_PACKAGE`, `PROJECT_OF`, `AUTHORED_BY`, `REPORTED_BY`)
   at the DDL level**. Before building dimension edges, the migration reopens the edge
   schema (the sanctioned open-schema migration / edge-table rebuild), sequenced with
   EPIC-F's schema work. Fresh 0.6.0 stores need no such step (their `INLINE_MIGRATION_DDL`
   has no rel CHECK, index.ts:209-222) — the "policy object, not schema migration" claim
   holds for them; legacy stores are the explicit exception.
3. Dry-run parity against a temp copy: old model vs new model — item count, per-item humanId/repo/status/plan, edge count by rel (the diff normalizes the content-marker rewrite).
4. Build dimension nodes + role edges + metadata stamps.
5. Repo reconciliation with a collision report.
6. Verify parity — zero drift.
7. Commit.

Rowids and content-bearing audit links are never rewritten. The only content touch is the canonical marker/name/hash re-stamp; FTS re-indexes via trigger. Per-item verify and old-vs-new parallel diff apply to every legacy corpus (including the 85 sox-ecosystem PKT items); the migration never allocates ids.

Because the migration changes item content (canonical repo string in the marker), a **re-embed-on-content-change sweep** ships with it: any item whose `content_hash` changed gets its embedding regenerated (reusing the backfill batching). The projection-manifest filters that reference pre-canonical repo strings are reconciled by `reconcile-repo` — the parity gate runs after migration with the expected-diff allowance documented.

## 8. Test cases (real Turso adapter, default-running, negative controls)

1. **Motivating query**: 2 repos × 2 authors; `{ repo: X, author: Z }` returns exactly the intersecting subset.
2. **Fork-key reconciliation**: items filed under `adhd` and `PseudoSky/adhd` reconcile to one repo node; querying via either key returns the full set.
3. **BUG-1**: split/supersede with a duplicate returns `{ created: false, reason }` — never a silent drop. Negative control: strip the guard, the created-flag loss makes the test go red.
4. **BUG-2**: allocation is atomic. Two genuinely separate OS processes each creating N items against one shared store produce exactly 2N distinct ids, zero rejections (`humanid-counter-concurrency.spec.ts`); and a populated store with no counter row seeds at `max + 1`, so existing items survive the upgrade without a migration. Negative controls: restore the read-max scan and the concurrency assertion goes red; reset the seed to 1 and the upgrade assertion goes red. Superseding the max-id item cannot re-mint it — the counter is monotonic, so this is structural, not a scan-scope property.
5. **Migration parity**: legacy-shape store → migrate → zero drift; reopen verifies.
6. **`aggregateBy('reporter')`** matches a manual count.
7. **Cross-repo**: repo A item `DEPENDS_ON` repo B item → the project-level "which projects depend on repo B" query returns project of A.
8. **Invariants survive migration**: RAG join key resolves, `DERIVED_FROM` audit links intact, evidence-gated terminal transitions still throw without a citation.

## 9. Documentation

- `AGENTS.md` backlog package context: new model, migration phase.
- `RAG-SPEC.md` §0/§3.2: 0.6.0 construction, unchanged `node_id` join key.
- `INTERFACE_v2.md` §2.1/§3/§4: dimensional filters, suppression contract.
- `CHANGELOG.md`: model v2, migration.

## 10. Boundaries

- The 6-tool interface wrapping, FEAT-010 window mechanics, EPIC-G embeddings, claim edges, and wave/turn-budget modeling are out of scope — the model must not break them, and the vector join key, audit trail, and evidence gate are load-bearing invariants.
