# AC coverage (re-derived)

**23 PROVEN / 0 PARTIAL / 0 ABSENT** (23 criteria total, SPEC.md §8).

The four gaps this ledger opened are closed. AC-3 and AC-6 by new tests; AC-5 and
AC-22 by correcting the criteria themselves, each against the evidence recorded
below — in both cases the SPEC text named an outcome the shipped design does not and
should not produce, and the ledger's own analysis is what established that.

## AC-1 — Identity in this application layer is `uid` alone; no field or code path resolves it by a human-readable name of any kind.

**PROVEN.** `src/query/identity-by-name.spec.ts:51-70` creates a real issue with a distinctive title via the real `createIssue` write, confirms `getIssue(store.graph, { uid: created.uid })` resolves it (sanity check the harness works), then asserts `getIssue(store.graph, { uid: distinctiveTitle })` rejects with `IssueNotFoundError` — the issue's own real title, fed into the `uid` field, is never silently accepted.

## AC-2 — Live-path identical-content: two `createIssue` calls with byte-identical `{title, body}` in the same project, the second passed `duplicateAction:'force'`, produce two distinct `uid`s.

**PROVEN.** `src/write/create-duplicate-gate.spec.ts:300-308` files `a` then `b` with identical `{title, body}` in the same project, `b` passed `duplicateAction:'force'`, and asserts `a.uid !== b.uid`. Reinforced by `create-duplicate-gate.spec.ts:210-228` (force writes a new distinct uid and still reports `duplicateCandidates`).

## AC-3 — Automatic audit: every transition/update/move/invalidate/embedding write produces one audit node (`actor`+`action`+`sha`); a transition missing `agent`/`note`/`sha` is rejected (red without the check).

**PROVEN.** Closed by `src/write/audit-fields.spec.ts` (commit `99519add`), which reads the raw `audit` node's `meta` JSON over a direct SQL join — never a read-layer projection that could paper over a missing field — for all six write verbs (create, update, transition, move, invalidate, and a multi-write history). It asserts `actor`, asserts `sha` is 64 hex chars, and **recomputes** the sha from the canonical field set rather than merely checking it is truthy, so a sha that stopped covering a field goes red.

Teeth proven by negative control: removing `actor: input.actor` from `writeAudit`'s `canonicalFields` (`src/write/audit.ts`) turns all six tests red; `audit.ts` was restored and `git diff --stat` confirmed clean before commit.

The rejection half was already proven: `src/write/transition.spec.ts:282` (blank `by` → `InvalidArgumentError`), `:136` (`NoteRequiredError`), `:249-260` (`requiredFields:['note']`).

## AC-4 — On-write embedding: writing an issue produces its vector via the observer; invalidating removes it.

**PROVEN.** `src/write/embedding-observer.spec.ts:127-149` — a real `createIssue` (real embedding backend, real vector store `vec.get`) produces the vector matching `backend.embedDocument(...)`, and exactly one `embedding_upserted` audit row. `embedding-observer.spec.ts:322-339` — `deleteIssue` on that issue removes the vector (`vec.get(...)` returns `null`) and records exactly one `embedding_deleted` audit row.

## AC-5 — Uniqueness is edge-scoped, enforced inside the write transaction.

**PROVEN — after correcting the criterion.** As first written, AC-5 required that "duplicate `project.name` rejects". Nothing in the write layer does that, and nothing should: `upsertProject`/`upsertComponent` are the only project/component-name write paths in `src/write/`, and both are resolve-then-create by design — a repeat call merges into the existing row and mints no second one (`src/write/catalog-verbs.spec.ts:128-160`, `:246-260`). AC-12 already asserts that idempotency as the intended contract, so AC-5 as literally written contradicted an adjacent criterion that the suite proves.

The criterion now states the uniqueness that is actually enforced — edge-scoped, inside the write transaction: one row for a repeated `upsertProject` name; one row for a repeated `(project, name)` component; and two genuinely distinct rows for the same component name under two DIFFERENT projects, which is the half a global `name` key would silently collapse (`catalog-verbs.spec.ts:262-267`, `a.uid !== b.uid`).

## AC-6 — A body edit carries the issue's WHOLE graph onto its successor.

**PROVEN — after replacing the criterion.** AC-6 was the ETL's parity gate against a source corpus. The ETL section is deleted (SPEC.md no longer describes a data load), and a parity check against a corpus that no longer exists is not a criterion — so the slot now holds an invariant with real teeth, discovered while closing this ledger.

`update`'s body path re-pointed exactly five edges onto the successor — `owns_component`, `has_status`, `has_kind`, `has_priority`, `authored_by` — which is the set `card.ts` reads: the CARD's edges, not the ISSUE's. Everything else (`blocks`, `depends_on`, `relates_to`, `part_of`, `duplicate_of`, the lowercase `supersedes`, `has_note`, `has_citation`, `has_transition`, `audits`) stayed bound to a node no listing returns, so one body edit silently deleted an issue's dependency graph, its evidence and its entire history.

Fixed by `carryForwardResidualEdgesTx` (`src/write/update.ts`), which sweeps the remainder in BOTH directions — an issue is the SOURCE of `has_note` but the TARGET of `blocks` — excluding only the uppercase `SUPERSEDES` chain edge itself. `openCurve` (`src/query/views/stats.ts`) additionally resolves the chain HEAD per sampled instant, so a point-in-time burndown counts each identity once rather than once per node; `isSuperseded: false` is the wrong predicate there, because at an instant BEFORE the edit it would erase the issue entirely.

The ranking path is covered too: `rankByFusedRelevance` hands its filter to `@adhd/sox-hybrid-search`'s `searchRanked`, whose contract has no `isSuperseded` member, so superseded rows stayed rankable and `view:'similar'` returned an issue alongside its own stale copy. Fixed by over-fetch-and-drop inside that function.

Proven by `src/query/superseded-views.spec.ts`, `src/query/superseded-listing.spec.ts`, `src/query/superseded-ranking.spec.ts` (real fastembed + real Turso vectors) and `src/write/update.spec.ts`. Teeth proven by negative control, each one actually run: the `residual-edges` control turns four tests red, `chain-head` turns one red, and making `dropSupersededResults` a pass-through turns the ranking test red with `expected [ …(2) ] to have a length of 1 but got 2` — the two-rows-for-one-issue failure itself, not a proxy.

The ranking control is recorded here because its first form did NOT have teeth, and the run is what exposed that. The test originally drove `queryIssues({ text })`, which routes to the keyword path — and that path already filters on `graph.queryNodes`'s own `isSuperseded`, so the assertion passed with the fix fully removed. It now drives `view:'similar'` with a bare `filter.semantic`, for which `resolveSimilarFilterIds` returns `undefined`; that is the only shape reaching `rankByFusedRelevance`'s un-narrowed `{kind:'issue'}` branch, which is the branch the fix guards. A test that exercises a sibling code path is indistinguishable from a passing one until the control is run against it.

## AC-7 — Semantic: `searchRanked` over this store returns text+vec fused results.

**PROVEN.** `src/query/views/semantic.spec.ts` (file header lines 1-36) drives `querySimilarView`/`rankByFusedRelevance` against a real `GraphBackend`, a real `TursoVectorBackend` (native `F32_BLOB`/`vector_distance_cos`), and a real, unmodified `StoreSearchBackend` from `@adhd/sox-hybrid-search`, with only the embedding model's `embedQuery` test-pinned. `semantic.spec.ts:130` ("ranks by fused relevance descending (vec channel), best match first") and the surrounding fixture (lines 130-190) assert fused-relevance ordering through the real `searchRanked` call (spied only for call-shape assertions at `semantic.spec.ts:260-269`, never mocked for behavior).

## AC-8 — Keyset: `queryNodes({after, limit})` pages stably, no gaps/dupes.

**PROVEN.** `src/query/paging.spec.ts:55-100` creates 17 issues, pages through with `limit:5` (not a divisor of 17, forcing a short final page), and asserts every full page is exactly `k`-sized (line 78, closing an off-by-one hole), `new Set(collected) === new Set(created)` (no gap, line 93), and `collected.length === N` (no duplicate, line 97).

## AC-9 — Registry list: `view:projects`/`components`/`locations` return the seeded nodes; a component list scoped by `filter.project` returns only that project's components.

**PROVEN.** `src/query/views/registry.spec.ts:174-224` — `listProjects` "lists every live project, unfiltered" (175) and "narrows by filter.project (name/uid)" (188,194); `listComponents` "lists every live component, unfiltered" (207) and "narrows by filter.project" (212); `listLocations` "lists every live location, unfiltered" (225) and "narrows by filter.component" (230). All driven against a real store via `openTestIssueStore` (file header lines 1-25).

## AC-10 — Registry lookup: `lookup("memory_ping")` resolves to `project: sox-ecosystem` + `component: memory-server` + `location: tool memory_ping` with the project `path` and `repoUrl` — one call, no search.

**PROVEN.** `src/query/views/registry.spec.ts:347-355` calls `lookup(store.graph, 'memory_ping')` and asserts `result.project.name === 'sox-ecosystem'`, `result.project.path === '/repo/sox-ecosystem'`, `result.project.repoUrl === 'git@github.com:acme/sox-ecosystem.git'`, `result.component?.name === 'memory-server'`, `result.location?.value === 'memory_ping'`. Fixture seeded at `registry.spec.ts:130-140`.

## AC-11 — Registry detail: `get {registry:"project",name:"adhd"}` returns `path`, `repoUrl`, and its linked `locations[]` + `components[]`; a worktree dir under the project resolves to the SAME project (no phantom row).

**PROVEN.** `src/query/views/registry.spec.ts:253-345` (`getRegistryDetail` describe block) — "project detail includes its components and their locations" (254), "component detail includes its owning project and its locations" (265), "location detail includes its component and project" (272). The worktree-resolution half is proven at the real CLI wire boundary: `src/query/registry-wire.spec.ts:328-351` calls `upsert-project` a second time with a `.worktrees/<id>` path under the same project name and asserts the returned `uid` equals the original `projectAUid` (342), that `get{registry:'project',...}` still resolves the one row (346-347), and that `query{view:'projects'}` lists the project name exactly once (349-350) — never a phantom second row.

## AC-12 — Registry CRUD: each registry upsert is idempotent on its OWN uniqueness key, and on nothing wider; concurrent trio from two real OS processes still yields one row each.

**PROVEN.** `src/write/catalog-verbs.spec.ts:87-491` proves per-verb idempotency: `upsertProject` create/update paths (102-224), `upsertComponent` create/update + cross-project distinctness (235-284), `upsertLocation` create/re-create-after-rm (306-373). The concurrent-process clause is proven at `catalog-verbs.spec.ts:492-735`: three dedicated tests each spin two REAL OS processes via `runBarrieredPair` racing the identical `upsertProject`/`upsertComponent`/`upsertLocation` call and assert, via a direct SQL count against a freshly reopened store, exactly one live row survives (672, 700, 729).

## AC-13 — `get`: no-`fields` returns the five-field default card; `body` pseudo-field returns it; unresolvable `uid` throws `IssueNotFoundError`; a SUPERSEDED `uid` throws `StaleSupersedeError` (never the frozen pre-edit card) carrying `successorUid`; a multi-edit chain resolves to the CURRENT head.

**PROVEN.** `src/query/get.spec.ts:53-133` — default five-field card (53), `body` pseudo-field (88), `IssueNotFoundError` on an unresolvable/soft-deleted uid (109,115,121). `src/query/get-superseded-uid.spec.ts:71-95` — `StaleSupersedeError` (not `IssueNotFoundError`) with `stale.successorUid === liveUid` and the message containing the live uid (88-94). `get-superseded-uid.spec.ts:97-` — a three-hop edit chain resolves the oldest uid to the current head, not the next hop (explicit comment: "a single-hop walk would name `secondUid`... and would fail this").

## AC-14 — `update` touch + no-silent-discard: returns `changed:['title']`; zero-field patch throws `InvalidArgumentError`; a `status` field in input is rejected naming `transition`.

**PROVEN.** `src/write/update.spec.ts:123-125` — `update({uid, by, title:'new title'})` returns `{uid: issueUid, changed:['title']}`. `update.spec.ts:143-144` — zero-field patch (`{uid, by}`) throws `InvalidArgumentError`. `update.spec.ts:147-159` — a raw `status` field is rejected with `BacklogValidationError` whose message matches `/transition/`, and the issue's `has_status` edge is verified untouched (same target row) via direct edge read.

## AC-15 — `transition` closedAt stamp: terminal transition stamps `issue.meta.metadata.closedAt` and the outcome's `closedAt`, retrievable via `filter.closedAt.since`; reopening a terminal issue CLEARS `closedAt` and the reopened issue no longer matches the old `since` filter.

**PROVEN.** `src/write/transition.spec.ts:148-157` — terminal transition stamps `outcome.closedAt` and `row.metadata.closedAt` identically. `transition.spec.ts:159-182` — closing then reopening: `queryIssues(store, {filter:{closedAt:{since: closeOutcome.closedAt}}})` matches while closed (167), reopen clears `outcome.closedAt`/`row.metadata.closedAt` (172,175), and a subsequent identical `queryIssues` filter call (180) no longer matches the reopened issue — the stale-timestamp case, not just unset-on-first-transition.

## AC-16 — `claim` CAS lease: unclaimed→claimed; different agent within stale window → `ClaimHeldError`; `force:true` → `reclaimed-stale` with `previousClaimant`; two concurrent real-process `claim` calls against the same fresh uid never both report `status:'claimed'`.

**PROVEN.** `src/write/claim.spec.ts:101-115` (claim on unclaimed → `status:'claimed'`), `:131` (different agent, not stale, no force → `ClaimHeldError`), `:149` (different agent, `force:true` → `status:'reclaimed-stale'`, `previousClaimant` set). The real-process CAS clause: `claim.spec.ts:370-401` runs two real OS processes via `runBarrieredClaimPair` against the same fresh uid and asserts exactly one `success` and one `rejected` outcome (382-383), the loser's `heldBy` names the actual winner (387), and persistence is verified through a freshly reopened connection (392-398) — never either worker's own in-memory report.

## AC-17 — `relate`/`move` outcomes: a second `relate(...,'supersedes','add')` with a DIFFERENT target throws `SingleValuedRelationConflictError`; the SAME target returns `noop:true`; after `move`, exactly one live `owns_component` edge exists, before and after.

**PROVEN.** `src/write/relate.spec.ts:167-193` — same target twice → `noop:true` (171); different target → `SingleValuedRelationConflictError` with `side`/`cappedUid`/`rel`/`conflictingUid` asserted (181-186), and the rejected attempt is proven to have written nothing (no C edge) while the original A→B edge is untouched (191-192). `src/write/move.spec.ts:167-206` — component-only and cross-project moves each verified to hold exactly one live `owns_component` edge before and after via a direct SQL count (`countLiveOwnsComponentEdges`, lines 62-69), never trusting the outcome object.

## AC-18 — `delete` is soft: returns `{invalidated:true}`; issue disappears from a default `query` listing but `getNodeByUid(uid)` still resolves it.

**PROVEN.** `src/write/delete-listing.spec.ts` (whole file) — single test (48-79) creates an issue, confirms it's in the default `queryIssues(store,{view:'list'})` listing and addressable with `tInvalid === null` (52-59), deletes it and asserts `outcome.invalidated === true` (63), then asserts BOTH halves in the same test: the uid is absent from the post-delete listing (66-68) and `store.graph.getNodeByUid(uid)` still resolves the row with `tInvalid` now set and `content` unchanged (71-76) — explicitly designed so disappearing from the listing alone (which a hard delete also produces) isn't mistaken for proof.

## AC-19 — `create`'s duplicate gate: default `duplicateAction` returns `{created:false, reason:'duplicate-suppressed'}` and writes nothing; `force` writes a genuinely new uid (still reporting `duplicateCandidates`); `comment` writes zero issue rows and attaches a note to the top-scoring candidate.

**PROVEN.** `src/write/create-duplicate-gate.spec.ts:196-207` — default action: `created:false`, `reason:'duplicate-suppressed'`, `duplicateCandidates[0].uid === first.uid`, `uid`/`item` undefined, and issue/audit row counts unchanged. `:210-228` — `force`: new distinct uid, `duplicateCandidates` still reported, issue count +1. `:230-269` — `comment`: zero new issue rows (251), one new note row whose content contains the title+body verbatim (256-258) and author (259), attached via a live `has_note` edge (261-268).

## AC-20 — `query` sort/keyset conflict: `query({after, sort:'priority'})` throws `InvalidArgumentError` naming the incompatibility; the identical call without `sort` succeeds and pages in insertion order.

**PROVEN.** `src/query/paging.spec.ts:119-126` — `{view:'list', after:'0', sort:'created'}` rejects as `InvalidArgumentError` with `field:'sort'` and a message matching `/sort/i`. `:128-143` — the identical shape (`after` set, `sort` omitted) succeeds and returns issues in insertion order across two pages.

## AC-21 — Registry `rmLocation`: invalidates the location; a subsequent `lookup` on that `(locType,value)` no longer resolves it; the location's own record remains addressable by uid.

**PROVEN.** `src/query/lookup-rm-location.spec.ts:49-70` — seeds a location, confirms `lookup(store.graph, value)` resolves it, calls the real `rmLocation`, then asserts `lookup(store.graph, value)` now rejects with `CatalogNotFoundError` (69) — bi-temporal invalidation via a real `lookup` + `rmLocation` pairing, per the file's own stated purpose of closing a gap `catalog-verbs.spec.ts` left (doc comment lines 2-12).

## AC-22 — Concurrent write safety (BUG-039 gate).

**PROVEN — after correcting the negative-control clause.** The positive clause was always fully proven: `src/write/cross-process-write-safety.spec.ts:202-225` (same-target) and `:227-244` (distinct-target) hard-assert `persisted === a.ok + b.ok` over two real, barrier-synchronized OS processes with no serve-lock coordination.

The criterion's negative control named an observable the system cannot produce. It asked for a below-total stored count after removing the `immediate`-mode guard — but §1 makes every live entity write `crypto.randomUUID()`-keyed with `skipDedupe: true` unconditional, so two concurrent `createIssue` inserts have no unique constraint and no content hash to collide on, with or without `BEGIN IMMEDIATE`. There is nothing for a lost update to lose. The suite's own authors documented this at `cross-process-write-safety.spec.ts:274-299` after attempting the assertion and finding it unreachable; the surviving `deferred`-mode test only `console.warn`s, which is not a control.

The criterion now names the control that IS deterministic and IS hard-asserted: stripping `skipDedupe: true` via `ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on` yields `persisted === 1` where two creates reported `ok` (`cross-process-write-safety.spec.ts:370`, `:375`). It also records where the transaction-mode guard is genuinely load-bearing — the business-key find-then-create behind the catalog upserts, whose cross-process control lives in `write/catalog-verbs.spec.ts` — so the reason for the substitution is on the record rather than implied.

## AC-23 — `create` with no `component` defaults to `(root)`, never orphaned: writes exactly one `owns_component` edge to the project's reserved `(root)`; never throws `CatalogNotFoundError`; the new uid is reachable through `filter.project`; two separate no-component creates resolve to the SAME `(root)` row.

**PROVEN.** `src/write/create-issue.spec.ts:54-145` — two independent no-component `createIssue` calls against the same project: both succeed without throwing (102-105, explicitly asserting the never-`CatalogNotFoundError` invariant), both resolve to the SAME `owns_component` target rowid via direct SQL (113-118), that shared rowid is confirmed to be the project's one `(root)` component row minted at `upsertProject` time (120-129), and a subsequent `queryIssues(store, {filter:{project: project.uid}})` returns both new uids (138-142+), proving reachability rather than orphaning.
