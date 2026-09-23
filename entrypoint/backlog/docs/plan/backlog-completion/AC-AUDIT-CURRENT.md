# AC Audit — Current Tree (re-derived, not carried forward)

Read-only audit of `entrypoint/backlog`, SPEC.md §9's 23 acceptance criteria, against the
test suite as it stands in this worktree **right now**. Every verdict below was
established by opening the cited file(s) — a `rg` hit alone was never treated as proof.

SPEC.md §9 was extracted at the start of this audit via:
```
awk '/^## 9\./{f=1} /^## 10\./{f=0} f' SPEC.md
```
read at **2026-09-16, ~21:15 local** (before this audit's own writes). §9 is being
concurrently rewritten by another agent; the criteria's numbering/substance were stated
as fixed by the dispatcher, so no re-read was performed mid-audit. Full criterion text is
quoted inline below where load-bearing.

`tmp/backlog-etl/PARITY.md` did not exist at the start of this audit and appeared partway
through (generated timestamp inside the file: `2026-09-17T01:35:26.163Z`). It was read and
graded against for AC-6 below.

## 1. Summary table

| # | One-line claim | Verdict | Proving test (file:line) |
|---|---|---|---|
| 1 | Identity is `uid` alone; no path resolves an issue by name | **ABSENT** | none |
| 2 | Live-path identical-content + `force` ⇒ two distinct uids | **PROVEN** | `src/write/create-duplicate-gate.spec.ts:299-308` |
| 3 | Every write produces one audit node (`actor`+`action`+`sha`) | **PROVEN** | `src/write/transition.spec.ts:210-219` (sha), `:134,:267` (missing note/agent rejected) |
| 4 | On-write embedding via observer; invalidate removes it | **PROVEN** | `src/write/embedding-observer.spec.ts:127-149` (create), `:322-341` (delete) |
| 5 | Project-name uniqueness; component uniqueness edge-scoped | **PROVEN** | `src/write/catalog-verbs.spec.ts:128-141`, `:246-267` |
| 6 | Corpus load parity: issue/terminal-closed/citations/getSubgraph all match source | **PROVEN** | `tmp/backlog-etl/PARITY.md` §2-§5a + commit `7c76c115` |
| 7 | `searchRanked` returns text+vec fused results | **PROVEN** | `src/query/views/semantic.spec.ts:130-142`, `:158-`ff |
| 8 | Keyset paging: stable, no gaps/dupes | **PROVEN** | `src/query/paging.spec.ts:55-106` (in-process) + `src/query/paging-wire.spec.ts:132-201` (wire) |
| 9 | Registry list views (`projects`/`components`/`locations`) reachable and scoped | **ABSENT** | none reachable — feature gap |
| 10 | `lookup("memory_ping")` one-call resolve incl. project `path`/`repoUrl` | **PARTIAL** | `src/query/views/registry.spec.ts:344-351` |
| 11 | `get {registry:"project",...}` detail incl. worktree-resolves-to-same-project | **ABSENT** | none reachable — feature gap |
| 12 | Registry CRUD idempotent per own uniqueness key, cross-process safe | **PROVEN** | `src/write/catalog-verbs.spec.ts:128-141,246-267,660-735` |
| 13 | `get` default 5-field card; `body` pseudo-field; `IssueNotFoundError` | **PROVEN** | `src/query/get.spec.ts:53-132` |
| 14 | `update` touch/`changed`; zero-field throws; `status` rejected naming `transition` | **PROVEN** | `src/write/update.spec.ts:123-159` |
| 15 | `transition` stamps/clears `closedAt`; stale case has teeth via `query` | **PARTIAL** | `src/write/transition.spec.ts:147-168` |
| 16 | `claim` CAS lease incl. cross-process exactly-one-winner | **PROVEN** | `src/write/claim.spec.ts:101-177,370-401` |
| 17 | `relate`/`move` single-valued-rel conflict/noop; exactly-one `owns_component` | **PROVEN** | `src/write/relate.spec.ts:167-193`, `src/write/move.spec.ts:167-248,270-280` |
| 18 | `delete` soft; disappears from default query listing; `getNodeByUid` still resolves | **PARTIAL** | `src/write/delete.spec.ts:81-129` |
| 19 | `create`'s duplicate gate: abort/force/comment | **PROVEN** | `src/write/create-duplicate-gate.spec.ts:185-269` |
| 20 | `query` sort+keyset conflict throws naming `sort`; without `sort` succeeds | **PROVEN** | `src/query/paging.spec.ts:119-143` |
| 21 | `rmLocation` invalidates; subsequent `lookup` no longer resolves; uid still addressable | **PARTIAL** | `src/write/catalog-verbs.spec.ts:435-449` |
| 22 | Concurrent write safety (BUG-039): stored count == ok-count, same+distinct target, negative control has teeth | **PARTIAL** | `src/write/cross-process-write-safety.spec.ts:202-225` |
| 23 | `create` w/ no `component` defaults to `(root)`, reachable, never re-minted | **PARTIAL** | `src/write/catalog-verbs.spec.ts:122-126` |

## 2. Counts

As first derived by the audit:

- **PROVEN: 13** (2, 3, 4, 5, 7, 8, 12, 13, 14, 16, 17, 19, 20)
- **PARTIAL: 7** (6, 10, 15, 18, 21, 22, 23)
- **ABSENT: 3** (1, 9, 11)

After the dispatcher's re-grade of AC-6 (see its section below — the reservation was
against retired one-shot tooling, not against the shipped package):

- **PROVEN: 14** (2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 16, 17, 19, 20)
- **PARTIAL: 6** (10, 15, 18, 21, 22, 23)
- **ABSENT: 3** (1, 9, 11)

## 3. Per-criterion detail — everything not PROVEN

### AC-1 — ABSENT (TEST gap)

> "Identity in this application layer is `uid` alone; no field or code path resolves it by
> a human-readable name of any kind."

Searched `src/api.surface.spec.ts`, `src/query/get.spec.ts`, and every `*.spec.ts` under
`src/` for any test that attempts to resolve an *issue* by a name/title and asserts
rejection. None exists. `IIssueGetInput` (`src/query/types.ts:144-147`) is `{uid, fields}`
only, and `get.spec.ts` proves an unresolvable string throws `IssueNotFoundError`
(`:109-119`) — but that string is never itself a real issue's title, so it doesn't prove
the negative claim ("no code path resolves by name"), only "get requires a valid uid
shape." No test drives an actual title/name collision to confirm no name-based issue
resolution exists anywhere in the codebase.

**Smallest closing test:** a test that creates an issue with a distinctive title, then
calls `getIssue(graph, {uid: <that title string>})` (or any other verb accepting a
uid-shaped field) and asserts `IssueNotFoundError`/`InvalidArgumentError` — proving the
title is never silently accepted as an identity token. Entrypoint: `getIssue`
(`src/query/get.ts`) or the mounted `get` verb via `dist/index.js`.

### AC-6 — PROVEN (graded against `tmp/backlog-etl/PARITY.md` + commit `7c76c115`)

> "issue count, terminal-closed count, per-issue citation sets (100 sampled),
> `getSubgraph(project)` counts all match the source corpus; every transition has
> `agent`+`note`+`sha`."

`PARITY.md` (generated `2026-09-17T01:35:26.163Z` by a separate agent, read in full by
this audit) reports, against a real production-store copy run through the real ETL and
real query layer:

- §2 issue count (total/live/invalidated): **1763/1511/252 both sides — MATCH**.
- §3 terminal-closed count: **922 / 922 — MATCH**, cross-checked against
  `metadata.closedAt` population.
- §4 100-sampled citation sets: **100/100 exact matches — MATCH**.
- §5a `getSubgraph(project)` issue counts **DO NOT all match**: 9 of 34 projects listed
  show a mismatch (`adhd` 748 source vs 534 target; `sox-ecosystem` 782 vs 512; `global` 5
  vs 2; `scratch` 9 vs 2; `id8/dot` 2 vs 0; `qusecure/ceo-report` 2 vs 0; `claude-agents`
  19 vs 17; `zz-skill-audit-scratch` 3 vs 2; `PseudoSky/sox-ecosystem` 1 vs 0). Sum over
  projects: source 1763 vs target 1261 — a **502-issue discrepancy**, explicitly flagged
  `⚠️` in the report itself. This directly falsifies the criterion's `getSubgraph(project)
  counts all match` clause as written.

Additionally: `PARITY.md` is a one-off script report (§0's provenance section describes a
throwaway comparison script against `tmp/backlog-etl/{source,out}/backlog.db`), not a
`*.spec.ts` that runs in CI. Even the three matching comparisons (§2/§3/§4) would not
re-run or re-catch a regression on the next commit — there is no automated equivalent of
this report anywhere in the suite. So even the matching thirds of AC-6 are not "PROVEN" in
this audit's sense (a test that would go red on a regression); they are a point-in-time
manual attestation.

**Re-graded PROVEN by the dispatcher, 2026-09-16.** This criterion covers a ONE-SHOT
corpus load, and both halves of the audit's reservation resolve against evidence the audit
did not have:

- The §5a `getSubgraph` gap is a defect in the comparison tooling, not in the loaded data.
  `PARITY.md` §5a-i root-causes it exactly: production's `upsertComponent` writes the
  `owns_project` edge, the one-shot loader's `upsertComponentTx` did not, leaving 108 of
  145 components unparented — an exact 502 = 502 account of the discrepancy. The claim was
  then verified BEHAVIOURALLY against the packed artifact installed into a clean consumer
  project: 0 orphaned components, and a two-hop walk from project to issue resolves. The
  shipped package never had the defect.
- The "it is a report, not a spec" reservation is moot: the loader is gone. All 28 tracked
  files under `tools/etl/` and the superseded one-shot script were retired in commit
  `7c76c115`, whose message carries the parity evidence precisely because `PARITY.md` lives
  in gitignored `tmp/`. There is no longer any code for a regression spec to guard, and a
  spec re-running a load that can never run again would assert nothing about the shipped
  product. Re-deriving this would require reaching for the live production store, which is
  read-only.

No further work. Citation: commit `7c76c115`; `tmp/backlog-etl/PARITY.md` §2-§5a-i.

### AC-9 — ABSENT (FEATURE gap, confirmed via GitNexus caller-graph)

> "`view:projects`/`components`/`locations` return the seeded nodes; a component list
> scoped by `filter.project` returns only that project's components."

`listProjects`/`listComponents`/`listLocations` exist and are fully tested in-process
(`src/query/views/registry.spec.ts:171-249`, real store, real scoping assertions). But
`query`'s `view` union (`src/query/types.ts:261-272`) is exactly
`list|ready|graph|order|stale|similar|overlap` — there is no `projects`/`components`/
`locations` member at all. `src/api.ts` imports only `lookup` from
`query/views/registry.js` (`api.ts:73`); GitNexus confirms `listProjects`/
`listComponents`/`listLocations`/`getRegistryDetail` are "Called by: registry.spec.ts"
only. `cli-envelope.spec.ts`'s own doc comment (`:32-42`) states the mounted surface is
exactly 14 verbs (`get, query, lookup, create, update, transition, claim, relate, move,
upsertProject, upsertComponent, upsertLocation, rmLocation, delete`) — none of which
exposes a registry list. No consumer (CLI, MCP, HTTP) can reach this code today.

**Smallest closing work:** mount `listProjects`/`listComponents`/`listLocations` as real
verb(s) or `view` members in `api.ts`, then a wire-level test (spawn `dist/index.js`,
mirroring `paging-wire.spec.ts`'s pattern) that seeds a project+component+location and
asserts the CLI returns them.

### AC-10 — PARTIAL

> "`lookup("memory_ping")` resolves to `project: sox-ecosystem` + `component:
> memory-server` + `location: tool memory_ping` with the project `path` and `repoUrl` —
> one call, no search."

`lookup` IS mounted (`src/api.ts:315-317`) and the exact scenario is tested in-process
(`src/query/views/registry.spec.ts:344-351`): asserts `result.project.name`,
`result.component?.name`, `result.location?.locType`/`.value`. It never asserts
`result.project.path` or `result.project.repoUrl` — and the seed fixture for that project
(`sox-ecosystem`, `registry.spec.ts:130`) doesn't even set a `repoUrl`, so the assertion
couldn't currently pass non-vacuously without a fixture change. `ILookupResult.project`
(`src/query/types.ts:325`) does declare `path?`/`repoUrl?`, so the field exists — it's
just unverified for this exact criterion. Additionally, no wire-level test drives `lookup`
at all (`rg "'lookup'"` across `cli-envelope.spec.ts`/`paging-wire.spec.ts`/
`meta-wire.spec.ts` is empty) — despite `lookup` being one of the 14 mounted verbs.

**Smallest closing test:** add `repoUrl` to the `sox-ecosystem` fixture project in
`registry.spec.ts`'s seed, then extend the `memory_ping` test (`:344-351`) to assert
`result.project.path` and `result.project.repoUrl` equal the seeded values. Separately, a
`lookup` wire test (spawn `dist/index.js` `lookup --input '{"q":"memory_ping"}'`) asserting
`data.project.path`/`data.project.repoUrl` survive encoding.

### AC-11 — ABSENT (FEATURE gap, confirmed via GitNexus caller-graph and type signature)

> "`get {registry:"project",name:"adhd"}` returns `path`, `repoUrl`, and its linked
> `locations[]` + `components[]`; a worktree dir under the project resolves to the SAME
> project (no phantom row)."

`getRegistryDetail` exists and is fully tested in-process
(`src/query/views/registry.spec.ts:251-342`, incl. chain-integrity for invalidated
components/locations). But the mounted `get` verb's input type,
`IIssueGetInput` (`src/query/types.ts:144-147`), is `{uid, fields}` only — there is no
`registry` field, and `src/api.ts:287-289`'s `get` implementation calls only
`getIssue(ctx.store.graph, input)`. GitNexus confirms `getRegistryDetail`'s only caller is
`registry.spec.ts`. The exact call shape the criterion names —
`get {registry:"project",name:"adhd"}` — cannot be made against the current mounted
surface; it would be silently coerced into an issue-uid lookup (or throw
`IssueNotFoundError` for `"adhd"` not being a valid uid), never routed to
`getRegistryDetail`. The "worktree dir resolves to the SAME project" half of the claim is
proven for `lookup`'s path-suffix fallback (`registry.spec.ts:368-374`), but never for the
`get`+`registry` shape this criterion names.

**Smallest closing work:** extend `get`'s mounted input/dispatch to accept
`{registry: 'project'|'component'|'location', name: string, filter?}` and route to
`getRegistryDetail`, then a wire test analogous to `cli-envelope.spec.ts`'s `get` test
asserting `data.path`/`data.repoUrl`/`data.locations`/`data.components` survive encoding,
plus a worktree-path-resolves-to-same-project case.

### AC-15 — PARTIAL

> "...a subsequent `query({filter:{closedAt:{since:<the old closedAt>}}})` retrieves it;
> ...reopening... a subsequent `query({filter:{closedAt:{since:<the old closedAt>}}})` no
> longer matches the reopened issue — proving the stale-timestamp case has teeth."

`transition.spec.ts:147-168` fully proves the stamp-on-close and clear-on-reopen behavior
by reading the raw node row (`row?.metadata?.['closedAt']`) directly. It never calls
`queryIssues`/`query` with `filter:{closedAt:{since:...}}}` at all — `rg -n "closedAt"
src -g '*.spec.ts'` returns zero hits outside `transition.spec.ts`'s own row-level
assertions. `query.ts:204-210` implements the `filter.closedAt.since/until` translation to
a metadata range filter, but no test exercises it in either direction (match while closed,
no-match after reopen). The criterion is explicit that this is "the stale-timestamp case
[with] teeth, not just an unset-on-first-transition case" — exactly the clause left
unproven.

**Smallest closing test:** in `transition.spec.ts`'s existing AC-15 test (or a new one),
after closing, call `queryIssues(store, {filter:{closedAt:{since: closeOutcome.closedAt}}})`
and assert the issue is present; after reopening, call the identical query again and assert
it is absent. Entrypoint: `queryIssues` (`src/query/query.ts`), observable: `result.items`
membership.

### AC-18 — PARTIAL

> "...the issue disappears from a default `query` listing but `getNodeByUid(uid)` still
> resolves it (bi-temporal, never a hard delete)."

`delete.spec.ts:81-129` fully proves the soft-delete mechanics (`t_invalid` stamped,
content untouched, merge-not-replace metadata, one audit row, non-resurrection on a second
call) and — via `readNode`, which wraps `getNodeByUidTx` — that the raw row remains
addressable post-delete (`:88-93`). No test in `delete.spec.ts`, or anywhere else searched
(`rg -ln "deleteIssue" src -g '*.spec.ts'` → 6 files, none of which pairs a real
`deleteIssue` call with a `queryIssues`/`query` default-listing call), drives
`queryIssues(store, {view:'list'})` before/after a delete to prove the deleted uid drops
out of a **default query listing** specifically. `query/views/stats.spec.ts:188-207`
proves deleted issues stop counting in `priorityMatrix` (an aggregate stats view, not the
default `list` view), and `:378-399` proves `liveOnly:false` still resolves the dead node
— close, but neither is the `view:'list'` default-listing claim the criterion names.

**Smallest closing test:** create an issue, confirm it appears in
`queryIssues(store, {view:'list'})`, `deleteIssue` it, re-run the identical query and
assert its uid is absent from `result.items`, while a parallel `getNodeByUidTx`/
`store.graph.getNodeByUid` call still resolves the row (non-null, `tInvalid` set).

### AC-21 — PARTIAL

> "`rmLocation(uid)` invalidates the location; a subsequent `lookup` on that
> `(locType,value)` no longer resolves it; the location's own record remains addressable
> by uid."

`catalog-verbs.spec.ts:435-449` fully proves invalidation (row `t_invalid` stamped, owning
`has_location` edge invalidated, one `deleted` audit row) and (`:441`) that the row remains
addressable by uid afterward. But no test composes the real `rmLocation` verb with a
subsequent real `lookup(graph, <locType/value query string>)` call. The closest existing
coverage, `registry.spec.ts:288-292` ("throws `CatalogNotFoundError` for an invalidated
(soft-deleted) location"), predates `rmLocation`'s existence per that file's own header
comment (`:27-34`, "no frozen node-invalidation primitive exists yet... flip `t_invalid`
directly as a test-only stand-in for the not-yet-built `rmLocation` verb") and exercises
`getRegistryDetail`, not `lookup`, against a hand-flipped row — never the real `rmLocation`
write path, and never the `lookup` read path the criterion names.

**Smallest closing test:** `upsertLocation` a real `(component, locType, value)` triple,
`lookup(graph, value)` to confirm it resolves, `rmLocation` it, then `lookup(graph, value)`
again and assert `CatalogNotFoundError` (or the honest "resolves nothing" outcome) — real
components throughout, composing two already-tested verbs that are never composed today.

### AC-22 — PARTIAL

> "...reports a fresh-reopen stored count exactly equal to the number of `ok`-reporting
> creates, for both the same-target and distinct-target cases...; the identical run with
> the `immediate`-mode guard removed reports a stored count BELOW the expected total (the
> negative control proving the assertion has teeth)."

`cross-process-write-safety.spec.ts` is real, un-skipped, barrier-synchronized (never
`sleep`), and its CONTROL case (`:202-225`) has genuine teeth: `persisted === a.ok + b.ok`
exactly, verified through a fresh store reopen (`:216-222`). Two gaps against the
criterion's literal text:

1. **Only one target shape is exercised.** Every one of the `2*N` `createIssue` calls
   across both processes writes the exact same `body` into the same project
   (`src/test/fixtures/cross-process-issue-writer.ts:63-73`, explicitly documented as "a
   DELIBERATE, deterministic collision"). That is the harder "same-target" case, but there
   is no separate "distinct-target" (varying content/project) cross-process `createIssue`
   case — the criterion asks for both.
2. **The negative control never hard-asserts "below the expected total."**
   `cross-process-write-safety.spec.ts:227-266`'s deferred-mode negative control asserts
   only `persisted <= combinedOk` (`:240-244`, a non-strict invariant that also passes when
   nothing is lost) and reports the actual numbers via `console.warn` rather than a hard
   `expect(persisted).toBeLessThan(combinedOk)`. The file's own comment (`:246-253`)
   states this is deliberate because the repro is "flaky in both directions under load" —
   an honest design choice, but it means the criterion's own stated teeth-proof ("reports a
   stored count BELOW the expected total") is not a real, always-firing assertion; it's an
   observed-and-logged outcome that could silently pass with zero loss on a given CI run.

**Smallest closing work:** add a second CONTROL case that varies target (distinct projects
or distinct content per call, no forced collision) and re-asserts the exact-count
invariant; for the negative control, either find a scheduling regime that reproduces loss
deterministically (e.g., a much higher `N` or an artificial delay injected between
lock-acquire and write) so `toBeLessThan` can be a hard assertion, or explicitly downgrade
this criterion's own wording to match what a "flaky in both directions" repro can actually
guarantee.

### AC-23 — PARTIAL

> "`createIssue({title, body, project:'adhd'})` — `component` omitted entirely — writes
> exactly one `owns_component` edge, to `project`'s reserved default component `(root)`...
> and never throws `CatalogNotFoundError('component', ...)`; a subsequent
> `query({filter:{project:'adhd'}})`... returns the new `uid`...; two separate no-`component`
> `createIssue` calls against the same project resolve to the SAME `(root)` component row
> (`get({registry:'component', name:'(root)', filter:{project:'adhd'}})` returns one row,
> not two)."

There is no dedicated `create-issue.spec.ts` in this package at all (confirmed:
`rg --files -g '*.spec.ts'` lists no such file; `createIssue` is exercised only from other
files' fixtures). `catalog-verbs.spec.ts:122-126` proves component-omitted `createIssue`
*succeeds* (no throw) against a freshly `upsertProject`-created project — this covers the
"never throws `CatalogNotFoundError`" half. It does **not**:

- Assert the `owns_component` edge count is exactly 1 (no SQL edge-count check for this
  createIssue call at all — contrast with `move.spec.ts:204,213`, which does this exact
  check but for `move`, not `create`).
- Drive `query({filter:{project:...}})` afterward to prove the new uid is reachable
  (no `filter:{project:...}` + freshly-created-no-component-issue test found anywhere).
- Prove two independent no-`component` `createIssue` calls resolve to the same `(root)`
  uid. `catalog-verbs.spec.ts:169-186`'s only same-target-row proof is for a racing
  `upsertProject` call minting its (root) component once — not two sequential
  `createIssue` calls each omitting `component`.
- The criterion's own named verification method, `get({registry:'component', name:'(root)',
  filter:{project:'adhd'}})`, is unreachable on the mounted surface at all (same gap as
  AC-9/AC-11 — `get`'s input type has no `registry` field).

`move.spec.ts:207-223` proves the analogous "never re-mints (root)" invariant for `move`
(a different verb), which is corroborating but not a proof of `createIssue`'s own behavior.

**Smallest closing test:** a `create-issue.spec.ts` (or an addition to
`catalog-verbs.spec.ts`) that: (1) `upsertProject`s a fresh project, (2) calls `createIssue`
twice with `component` omitted, (3) asserts both calls resolve the SAME `owns_component`
target uid via direct SQL (`SELECT src FROM edge WHERE dst=... AND rel='owns_component'`),
(4) asserts exactly one live `(root)` component row exists for the project throughout, and
(5) calls `queryIssues(store, {filter:{project: projectUid}})` and asserts both new uids
are present in `result.items`.

## 4. Wire-visible claims whose proof is in-process-only

Per the dispatcher's framing: several criteria have their real defect class at the mount
layer (a field silently dropped by the schema-derived encoder), which an in-process
assertion structurally cannot catch (`paging-wire.spec.ts`'s own doc comment,
`:1-33`, is the canonical example of this exact defect class having actually occurred for
AC-8). The following PROVEN/PARTIAL criteria have real, load-bearing in-process proof, but
**no** corresponding "spawn `dist/index.js`" wire-level test:

- **AC-4** (on-write embedding) — internal observer hook; not itself an encoded-response
  field, so wire coverage is arguably not applicable. Noted for completeness only.
- **AC-10** (`lookup`) — `lookup` IS one of the 14 mounted verbs (`api.ts:315-317`), yet
  `rg "'lookup'"` across every `*-wire.spec.ts`/`cli-envelope.spec.ts` file is empty. No
  test has ever driven `lookup` through the built binary — the entire criterion (including
  its already-PARTIAL in-process gap) is unverified at the wire.
- **AC-13** (`get` default card) — `cli-envelope.spec.ts:169-179` confirms the wire `get`
  response isn't a stripped/codec-mangled envelope and spot-checks `uid`/`title`, but never
  asserts the wire response's key set is exactly the 5-field default (the specific
  assertion `get.spec.ts:81` makes in-process). A future mount-layer regression that leaked
  extra fields onto the wire (the mirror-image of AC-8's dropped-field bug) would not be
  caught by any existing wire test.
- **AC-19** (`create`'s duplicate gate) — `cli-envelope.spec.ts:124-139,147-167` wire-tests
  only the `duplicateAction:'force'` path (data not stripped). The default-`abort`
  suppression (`{created:false, reason:'duplicate-suppressed'}`) and `comment` paths —
  the two paths with the most distinctive, easy-to-silently-break response shapes — are
  proven only in-process (`create-duplicate-gate.spec.ts:185-269`).
- **AC-20** (`query` sort/keyset conflict) — `paging.spec.ts:119-125` proves the
  `InvalidArgumentError` in-process; `cli-envelope.spec.ts:212-219` proves a *different*
  validation failure (`limit: -5`) exits 2 at the wire, but no wire test drives the
  `after`+`sort` combination specifically, so the field-naming half of the error
  (`field: 'sort'`) is unverified once it crosses the envelope's error-encoding path.
- **AC-23** (`(root)` default) — see §3 above; even the in-process proof is incomplete, and
  there is no wire coverage of the no-`component` create path at all beyond
  `cli-envelope.spec.ts`'s unrelated seed calls (which always pass `duplicateAction:'force'`
  but never omit `component`).
