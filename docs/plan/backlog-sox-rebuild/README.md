# Project Plan — `backlog-sox-rebuild` (full hard replacement)

**Plan slug:** `backlog-sox-rebuild`
**Status:** DRAFT — awaiting operator review before any code is touched in a worktree.
**Scope:** `entrypoint/backlog` (the `@adhd/backlog` package) only. No library-tier
code changes (the sox library tier is published and frozen for this plan).

---

## 0. The goal, stated once

> At the end of this there is **exactly one version** of the backlog tool, with
> **zero references to `v1`, `v2`, or `legacy`** anywhere in code, file names,
> or comments. We are **rebuilding the tool on a better base** (the published
> sox library tier) and then **transplanting the reclaimable data** from the old
> store into the new system. The old application code is **wiped**, not
> side-by-side retired.

This is a **full hard replacement**, not a migration with a coexistence window.
There is no dual-write bridge, no legacy-id fallback, no gradual deprecation.
One surface, one naming, one store schema. The only thing carried forward is
**data** (via a one-time ETL), never code.

---

## 1. Non-negotiables

1. **One version.** After cutover, `rg 'v1|v2|legacy'` over `entrypoint/backlog/src`
   returns zero hits (excluding the ETL's historical-comment references, which are
   scoped and renamed — see §6).
2. **Zero `v1`/`v2`/`legacy` naming.** The `src/v2/` directory, `ops-v1.ts`, and every
   `v1`/`v2`/`legacy` identifier and comment are renamed to neutral terms.
3. **Rebuilt on the sox library tier.** The app layer consumes the *published*
   `@adhd/sox-*` packages directly. No reimplementation of storage, embedding,
   vector search, or ranking logic in the app layer.
4. **Data transplant, not data rewrite.** The old store file is read once by the ETL
   and written into the new store. The old file is never mutated in place and is
   never deleted as part of the rebuild (it is left in place as the rollback source
   until the operator confirms cutover).
5. **Executed in a worktree.** The reimplementation happens in a `git worktree`
   (`.worktrees/`), never on the live checkout, so the currently-live system keeps
   running untouched until the operator approves the cutover.
6. **This plan is reviewed before execution.** No code is written until the operator
   has read and approved this document.

---

## 2. The better base (frozen)

Published and npm-verified this session (consumed via `workspace:^` inside the
monorepo, real versions on publish):

| Package | Version | Role in the rebuild |
|---|---|---|
| `@adhd/sox-graph-store` | `0.9.0` | node/edge graph, open-schema kinds, `NodeUniquenessPolicy`, transactions |
| `@adhd/sox-store-adapter` | `0.8.0` | storage adapter, dialect-owned LIMIT, pure top-K query |
| `@adhd/sox-vector-store` | `0.6.0` | vector persistence, pure `{ids}` filter, `deleteMany` |
| `@adhd/sox-hybrid-search` | `0.4.2` | N-signal RRF ranker (`searchRanked`) |
| `@adhd/sox-semantic` | `0.1.2` | semantic facade, `createEmbeddingObserver` (on-write embeddings) |
| `@adhd/sox-memory-core` | `0.9.2` | recall orchestration |
| `@adhd/sox-embedding-provider` | `0.4.1` | embedding model (optional dep) |

The current `entrypoint/backlog/package.json` already depends on `sox-graph-store
^0.8.6`, `sox-store-adapter ^0.7.0`, `sox-vector-store ^0.5.0` (optional),
`sox-embedding-provider ^0.4.0` (optional), and is **missing** `hybrid-search`,
`semantic`, and `memory-core`. The bump + adds are part of Phase 1 (not separable —
the old API surface those versions expose is exactly what is being replaced).

---

## 3. Current state (the "before")

Two entangled surfaces live in `entrypoint/backlog/src/`:

- **The old app surface** (the "v1" of this plan, though mostly unnamed): `cli.ts`,
  `server.ts`, `serve.ts`, `markdown.ts`, `install.ts`, `install-skill.ts`,
  `migration-admin.ts`, `migration-phase.ts`, `ops-v1.ts`, `version-info.ts`,
  `model.ts`, `env.ts`, and the v1 store modules under `src/store/` (`crud.ts`,
  `claim.ts`, `lifecycle.ts`, `ids.ts`, `repo-migration.ts`, `embed-queue.ts`,
  `rag-ops.ts`, `serve-lock.ts`, `signal-cleanup.ts`, `store-backup.ts`,
  `backup-manifest.ts`, `enrichment.ts`, `immediate-retry.ts`,
  `mutate-metadata.ts`, `hooks.ts`, `query.ts`).
- **The new interface** (the "v2" of this plan), already wired into `client.ts`:
  `src/v2/admin.ts` (1,827 lines), `src/v2/query.ts` (2,720), `src/v2/get.ts` (717),
  with full spec suites. `client.ts` already re-exports
  `backlogGet`/`backlogQuery`/`backlogAdmin` from `./v2/*`.

Both surfaces share store-access infrastructure that is **not** purely old: the
new interface imports `src/store/graph-backlog-store.ts`, `mapping.ts`,
`repo-nodes.ts`, `structure.ts`, `semantic-search.ts`, `audit-log.ts`, and
`query.ts` (the store query, distinct from `v2/query.ts`). The rebuild decouples
the new interface from the old surface's modules and from the old store API shape.

The old store API shape being left behind includes: the `humanId` allocator and
`idOverride`/`importedFrom` machinery, the closed `kind` enum, the
migration-phase state machine, the repo-migration module, and the six-verb
`client.ts` surface. These are replaced by the library tier's DB-generated `uid`
identity, open-schema kinds + `NodeUniquenessPolicy`, and the new
`backlog_get`/`backlog_query`/`backlog_admin` surface.

---

## 4. Target state (the "after")

- `entrypoint/backlog/src/` holds a single, neutrally-named surface:
  - `write.ts` (or `admin.ts` — final name decided in Phase 2, see §7) — the
    mutation surface: `create`, `update`, `relate`, `transition`, plus automatic
    audit logging and on-write embeddings.
  - `query.ts` — the list/search surface: filters, pagination (keyset `after`),
    semantic `searchRanked`.
  - `read.ts` (or `get.ts`) — the single-item deep-read surface.
  - `client.ts` — the public barrel, exporting exactly those three + types.
  - `store/` — retained **only** the store-access modules the new surface needs,
    re-pointed at the library tier's current API (`graph-backlog-store.ts`,
    `mapping.ts`, `repo-nodes.ts`, `structure.ts`, `semantic-search.ts`,
    `audit-log.ts`, and the store query module under a neutral name).
- No `src/v2/`, no `ops-v1.ts`, no `v1`/`v2`/`legacy` strings.
- The store schema is the library tier's open schema; identity is `uid`; there is
  no `humanId`, no `idOverride`, no `importedFrom`, no repo-migration module.

---

## 5. Data transplant

The reclaimable data is the existing backlog graph (items, plans, assignees,
catalogs, transitions, citations). It is transplanted, not left behind:

- One-time ETL (BUG-040, already proven in prototype): read the old store, write
  into the new store with `skipDedupe:true`, natural content, DB-generated `uid`s.
  Restores 1339 transitions + 7 identical-title issues, preserving every
  transition's `agent`+`note`+`sha` and per-issue citation sets.
- The old store file is the rollback source and is **not deleted** during rebuild.
- Cutover = point the tool at the new store; the old store remains on disk until
  the operator confirms and separately deletes it.

---

## 6. Execution plan (worktree, phased)

All work happens in a worktree under `.worktrees/`, branched from `main`, so the
live checkout is untouched until cutover.

**Phase 0 — Worktree + dependency bump + old-surface freeze**
- Create `.worktrees/backlog-sox-rebuild`.
- Bump `entrypoint/backlog/package.json`: `graph-store`→`0.9.0`,
  `store-adapter`→`0.8.0`, `vector-store`→`0.6.0`, `embedding-provider`→`0.4.1`;
  **add** `hybrid-search 0.4.2`, `semantic 0.1.2`, `memory-core 0.9.2`.
- Snapshot the old-surface build+test baseline for the parity gate (§9).

**Phase 1 — Promote the new interface to the single surface (naming + file move)**
- Move `src/v2/{admin,query,get}.ts` (and their specs) to neutrally-named
  locations, removing the `v2` directory.
- Rename `ops-v1.ts` and every `v1`/`v2`/`legacy` identifier/comment.
- Re-point `client.ts` and `index.ts` at the new locations.
- Gate: `rg 'v1|v2|legacy'` clean; `nx build backlog` + `nx test backlog` green.

**Phase 2 — Decouple from the old store surface (the real rebuild)**
- Rewrite the retained `store/` modules against the library tier's current API:
  DB-generated `uid` identity (drop the `humanId` allocator, `idOverride`,
  `importedFrom`), open-schema kinds + `NodeUniquenessPolicy`, dialect-owned
  LIMIT, pure `{ids}` vector filter, `searchRanked` for semantic read.
- Delete the old-surface-only modules (`crud.ts`, `claim.ts`, `lifecycle.ts`,
  `ids.ts`, `repo-migration.ts`, `embed-queue.ts`, `rag-ops.ts`, `serve-lock.ts`,
  `signal-cleanup.ts`, `store-backup.ts`, `backup-manifest.ts`, `enrichment.ts`,
  `immediate-retry.ts`, `mutate-metadata.ts`, `hooks.ts`, `migration-admin.ts`,
  `migration-phase.ts`, `cli.ts`, `server.ts`, `serve.ts`, `markdown.ts`,
  `install.ts`, `install-skill.ts`, `version-info.ts`, `model.ts`, `env.ts`).
- Finalize the write/query/read module names (write/admin, read/get) — the only
  naming decision left open, resolved here.
- Gate: full build + test green; no dangling imports; `nx verify-dist-load`.

**Phase 3 — Data transplant + parity**
- Re-run the BUG-040 ETL against a fresh new-schema store.
- Assert parity (§9 checks 6): issue count, terminal-closed count, 100-sampled
  citation sets, `getSubgraph(project)` counts, every transition carries
  `agent`+`note`+`sha`.

**Phase 4 — Acceptance + cutover proposal**
- Run the full negative-control acceptance suite (§9) on the new store.
- Run `gx raw detect-changes` to confirm the change scope is confined to the
  expected surface.
- Report to the operator with the parity numbers + acceptance results; **do not
  merge or delete the old store until the operator approves cutover.**

---

## 7. Open decision (resolved in Phase 2, surfaced now for review)

- **Final module names.** `admin` vs `write` for the mutation surface, and `get`
  vs `read` for the single-item read. Recommendation: `write.ts` / `read.ts` /
  `query.ts` — fully neutral and self-describing (no "admin" ambiguity), and
  matches the SPEC-v2 `v2-write`/`v2-query` intent without the `v2` prefix. This
  is the only open naming decision; everything else is fixed by §1.

---

## 8. Acceptance gates (negative-control teeth)

1. `rg 'v1|v2|legacy' entrypoint/backlog/src` → zero (ETL historical comments
   renamed; see §6).
2. **Identity:** two `createIssue` with identical body → two distinct `uid`s
   (skipDedupe on the live path, not just ETL). No `humanId` anywhere.
3. **Automatic audit:** every transition/update/move/invalidate/embedding write
   produces one audit node (`actor`+`action`+`sha`); a transition missing
   `agent`/`note`/`sha` is rejected (red without the check).
4. **On-write embedding:** writing an issue produces its vector via the observer;
   invalidating removes it.
5. **Uniqueness policy:** duplicate `project.name` rejects; duplicate
   `component.name` across different projects accepts (edge-scoped), same project
   rejects — via `NodeUniquenessPolicy`, not app-layer scans.
6. **Parity (ETL):** issue count, terminal-closed count, per-issue citation sets
   (100 sampled), `getSubgraph(project)` counts match the old store; every
   transition has `agent`+`note`+`sha`.
7. **Semantic:** `searchRanked` returns text+vector fused results.
8. **Keyset:** `queryNodes({after, limit})` pages stably, no gaps/dupes.
9. **BUG-039 write safety:** the cross-process harness (committed in
   `concurrency-scale.spec.ts`) goes green — DB-generated `uid`s + uniqueness
   policy eliminate the silent write loss, confirmed not assumed.
10. **`nx verify-dist-load`** passes — the shipped `dist/` loads the way a
    consumer loads it, not just the source-resolved test suite.

---

## 9. Risks & mitigations

- **R1 — Entanglement.** The new interface and old surface share `store/` modules.
  *Mitigation:* Phase 2 rewrites the retained modules in place before deleting the
  old-only ones; `nx test` + `nx verify-dist-load` after every sub-step.
- **R2 — Data loss on cutover.** *Mitigation:* the old store file is never
  mutated or deleted during rebuild; it is the rollback source until the operator
  confirms.
- **R3 — Naming drift.** "v1/v2/legacy" creeps back in comments. *Mitigation:*
  the `rg` gate is part of the DoD, not a courtesy check.
- **R4 — Library API churn.** The bump from `graph-store 0.8.6`→`0.9.0` changes
  the kind schema (open TEXT + TypePolicy) and adds `NodeUniquenessPolicy`.
  *Mitigation:* the SPEC-v2 §0 anti-antipatterns already enumerate the exact
  differences; Phase 2 is scoped to those.

---

## 10. Deliverables when this plan is approved

1. A worktree `.worktrees/backlog-sox-rebuild` with the full rebuild.
2. Parity + acceptance results (the numbers from §8 checks 1-10).
3. A cutover proposal (new store path + rollback path) for operator approval.
4. Updated docs (the backlog README/CLAUDE surface) reflecting the single version.

**Nothing is merged, and the old store is not deleted, until the operator reviews
and approves the cutover.**

---

## 11. Feature inventory (live system) → disposition in the new design

Every feature in the live `@adhd/backlog` package, item by item, with what
supersedes it in the rebuild or why it is being dropped as poor design.
Convention: **→** = superseded by; **KEPT** = carried forward (possibly
reimplemented); **DELETED — poor design** = removed with the reason stated.
Ground truth was read from the source files (not filenames); symbols and paths
are cited inline.

### A. Six-verb client (`src/client.ts`)

| Feature | Disposition |
|---|---|
| `get` (item by `humanId`) | → `read` keyed by `uid`; `humanId`→`uid` |
| `query` (list/search) | → `query` keyed by `uid`; + registry views (§3a) |
| `create` (create/split/supersede) | → `write` `createIssue` + registry `create`; `duplicateAction:"comment"` DELETED — poor design: declared-but-unimplemented (FEAT-013 never landed) |
| `update` (all mutations) | → `write` `updateIssue` (`touch`/`supersede`/`transition`) |
| `relate` (edges) | → `relate` (typed uid rels); `remove` add-only for `related`/`plan` — poor design: half-implemented inverse, fixed in new design (typed rels + real `noop`/`changed` outcome) |
| `admin` (bulk/maintenance) | → `admin` (pruned — see C) |
| `BacklogCtx` / `BacklogVersionInfo` | KEPT |

### B. 37 legacy operations (`src/ops-v1.ts` — library-only, no longer mounted)

| Feature | Disposition |
|---|---|
| `createItem`/`getItem`/`updateItem`/`listItems`/`softDeleteItem` | → `write`/`read`/`query` (uid); `humanId` DELETED |
| `stats`/`spotlight`/`readyItems`/`blockers`/`dependencyGraph`/`topoOrder`/`staleClaims` | → `query` views (`summary`/`list`/`ready`/`order`/`graph`/`stale`) |
| `claimItem`/`renewClaim`/`releaseClaim`/`assignItem` | → `update` claim/release/renew; `assignItem` → `write` assignee edge |
| `startWork`/`transitionStatus`/`addCitation`/`appendNote`/`resolveItem`/`archiveResolved` | → `transition` + `write` note/citation nodes + `admin archive` |
| `addDependency`/`removeDependency`/`linkRelated`/`supersedeItem`/`splitItem`/`mergeItems`/`setPriority`/`attachToPlan` | → `relate` (typed rels) + `write`; `attachToPlan` → registry/plan membership |
| `importFromMarkdown`/`renderToMarkdown`/`exportJson`/`auditTrail` | import DELETED (→ one-time ETL); render/export/audit KEPT (projection) |
| `migrateRepo`/`migrationStatus`/`setMigrationPhase`/`version` | migrate/migration DELETED (→ ETL + registry); `version` KEPT |

### C. `backlogAdmin` actions (`src/v2/admin.ts`)

| Action | Disposition |
|---|---|
| `doctor` | KEPT (integrity report over uid graph) |
| `prune` / `archive` | KEPT (over `status.terminal` + `closed_at`) |
| `merge` (`SAME_AS`) | DELETED — poor design: `SAME_AS` dedup of humanId-era duplicates; uid + ETL removes the need |
| `export` / `render` | KEPT (projection) |
| `import` | DELETED (→ one-time ETL) |
| `migration_status` / `set_migration_phase` | DELETED (migration-phase machinery retired) |
| `version` | KEPT |
| `batch` | KEPT (transport fan-out) |
| `reconcile_repo` | DELETED (→ ETL + registry; nothing to reconcile) |
| `embedding_health` / `embedding_backfill` | → library semantic (`SemanticBackend.health()` / observer) |
| `list_near_duplicates` / `run_dedup_sweep` | → library hybrid-search/semantic; `run_dedup_sweep` DELETED (`SAME_AS` dedup retired) |
| `cluster_into_plans` / `promote_cluster_to_plan` | → library semantic clustering + plan membership |

### D. Store capabilities (`src/store/*.ts`)

| Module | Disposition |
|---|---|
| `crud.ts` (`createItemNode` + `dedupeScan`) | → `write` `createIssue`; `dedupeScan` DELETED — poor design: FTS+exact+semantic triple scan was part of the BUG-039 write-loss surface |
| `claim.ts` | KEPT — reimplemented as item metadata (`claimedBy`/`claimedAt`) + claim audit; CAS semantics preserved |
| `lifecycle.ts` (`transitionStatusNode` + terminal knobs) | → `transition` + `status.terminal` (data) + `project_policy` |
| `ids.ts` (`allocateHumanIdAndInsert` + counter + partial unique index) | DELETED — poor design: allocator + dedupe-scan-in-transaction IS the BUG-039 race; DB-generated `uid` replaces it |
| `structure.ts` (edges + `renameHumanId`) | → `relate`/`write` (typed rels); `renameHumanId` DELETED (no humanId) |
| `repo-nodes.ts` (`parseRepoKey`/`resolveRepository`/`dimensionGraph`/`setRepositoryFork`/package-key) | → registry §3a; DELETED — poor design: repo-string identity + `namespace`/metadata dual-write + a second GraphBackend (`dimensionGraph`) |
| `repo-migration.ts` | DELETED (→ ETL + registry) |
| `migration-phase.ts` / `migration-admin.ts` | DELETED (retired) |
| `embed-queue.ts` (`scheduleEmbed`/`flushEmbeds`) | → library `createEmbeddingObserver` (on-write embeddings) |
| `rag-ops.ts` + `semantic-search.ts` | → library `@adhd/sox-semantic` + `@adhd/sox-hybrid-search` |
| `audit-log.ts` | KEPT — reimplemented as write-layer `writeAudit` helper |
| `mapping.ts` (`BacklogNodeMeta`/`toBacklogItem`/`humanId*`) | → direct node/kind model; `humanId` fields DELETED |
| `mutate-metadata.ts` | → library `touch` (in write layer) |
| `hooks.ts` | → library observer (`createEmbeddingObserver`) + audit |
| `serve-lock.ts` | KEPT (singleton serve lock) |
| `signal-cleanup.ts` | KEPT (signal handling) |
| `store-backup.ts` + `backup-manifest.ts` | KEPT (backup/restore; note: no admin action dispatches them yet) |
| `enrichment.ts` (gitnexus blast radius) | KEPT (best-effort citation enrichment) |
| `immediate-retry.ts` | KEPT (busy/locked retry) |
| `graph-backlog-store.ts` | → direct `@adhd/sox-graph-store@0.9.0` (open schema) |
| `epic-a-backfill.ts` (dimension edges, raw SQL upsert) | DELETED — poor design: `dimensionGraph` second store + raw SQL; → registry + ETL |

### E. Data-model / identity

| Feature | Disposition |
|---|---|
| `humanId` + `(repo, humanId)` composite | DELETED — poor design: composite identity + allocator race (BUG-039) |
| `idOverride` | DELETED — poor design: import-time identity hack; provenance = audit event |
| `importedFrom` | DELETED — poor design: provenance stamp vs audit event |
| repo-string identity (`namespace` + `metadata.repo` dual-write) | DELETED — poor design: dual-write divergence source; → `project` node |
| `firstTerminalTransitionAt` / `closedAt` reconstruction | DELETED — stored `closed_at` (reconstructed once by ETL) |
| hardcoded terminal/citation/reason knobs | → `status.terminal` + `project_policy` (data) |
| migration-phase (7 states, `config.yaml`) | DELETED (retired) |
| `canonicalIdentityKey` / `suggestClaimantIdentity` / `assertAttribution` | KEPT (attribution `by` required) |

### F. Markdown (`src/markdown.ts`)

| Feature | Disposition |
|---|---|
| parse/import (`parseBacklogMarkdown`/`toImportItems`) | import DELETED (→ ETL); parse KEPT for diagnostics |
| render/export (`renderItemsToMarkdown`/`renderCitationsLine`) | KEPT (projection; `uid` not rendered) |
| `buildChangelogSection` / `parseChangelogIds` | KEPT (CHANGELOG projection) |
| `classifyStatus`/`detectStatus`/`detectPriority`/`normalizeLegacyStatus` | `normalizeLegacyStatus` DELETED (legacy vocabulary); classify/detect KEPT (import diagnostics) |

### G. Install / skill (`src/install.ts`, `src/install-skill.ts`)

| Feature | Disposition |
|---|---|
| `installSkillToHosts` / `install` / `registerMcp*` | KEPT (MCP/skill installation); skill content updated with the registry-first workflow |

### H. Cross-cutting

| Feature | Disposition |
|---|---|
| Outcome envelope (`IOutcomeEnvelope`) | KEPT (the single response contract) |
| IR-cache (FEAT-002) | KEPT (extract-stage cache) |
| serve singleton lock | KEPT |
| `statusEvidence` transition shape (DEBT-010) | KEPT (transition evidence bundling) |

**Net:** the rebuild keeps the read/query/write shape, the envelope, the audit
discipline, claiming, backup, and the projection surfaces — and **deletes** the
humanId/allocator/ids machinery (BUG-039), repo-string identity + dual-write,
`dimensionGraph`, repo-migration, migration-phase, `SAME_AS` merge, and the
`import` action. The registry (§3a of SPEC-v2.md) is the new home for the
project/component/location navigation that `repo-nodes.ts` half-served.
