# BACKLOG_BACKLOG.md — hygiene audit of the backlog package's own PR

> **This is not a tracked backlog.** The repo's real backlog is a graph, and any
> `BACKLOG.md` on disk is a dead artifact. This file is a plain-markdown audit
> record about the code hygiene of the `entrypoint/backlog` package on branch
> `feat/backlog-hard-replacement`, produced by a multi-pass review (module graph,
> magic-variable sweep, jscpd duplication scan, raw-SQL sweep, external-package
> claim audit, four package code reviews, forgotten-file sweep, and definitive
> answers to all 74 PR comments). Items here are candidates for filing through
> `adhd-backlog`; nothing here is authoritative state.

## Read-this-first caveat on two of the evidence streams

Two schemas used to collect this evidence are missing a field, and that limits
what can be concluded from them:

- **`CODE_REVIEW_SCHEMA` has no `coverage` field.** The four package reviews
  (backlog, apigen-base-logical, apigen-core-client, apigen-engine-runtime)
  returned eight findings in total, but nothing in the data records *how much of
  the diff each reviewer actually read*. A reviewer that read 10% of the changed
  lines and a reviewer that read all of it produce indistinguishable artifacts.
  Treat the eight findings as a **lower bound on real defects**, never as
  "the diff is clean apart from these eight".
- **`JSCPD_SCHEMA` has no field explaining a `toolUnavailable` result.** Here
  `toolUnavailable` is `false` — jscpd genuinely ran on 2026-09-21 and the
  **6.54% duplicated / 15 blocks** figures are real measurement, not estimates.
  The gap is that the schema offers no way to record what the scan *covered* or
  what it excluded, so the same coverage-unknown caveat applies: the 15 blocks
  are real, but the scan's completeness is not verifiable from the data.

Both gaps argue for adding the missing fields to those schemas before the next
audit round (see **T-01**).

---

## 1. Needs triage

*Genuinely unclear whether these are problems worth fixing: conflicting signals,
insufficient evidence, or a judgment call only a human can make.*

### T-01 — Reviewer/scan coverage is unverifiable from the audit schemas
**Evidence:** `CODE_REVIEW_SCHEMA` (no `coverage` field, 4 reviews / 8 findings);
`JSCPD_SCHEMA` (no field to explain a `toolUnavailable` verdict; here
`toolUnavailable: false`, `percentDuplicated: 6.54`, 15 blocks).
**Why triage:** whether to re-run the reviews with a coverage contract, or accept
the eight findings as-is, is a process judgment about how much assurance this PR
needs — not a code defect with a determinable fix.

### T-02 — The architecture-placement analysis for the external-package work was never run
**Evidence:** `pass2.architectReviewOfRemovalScope` is a **dispatch-failure
diagnosis**, not the placement analysis it was commissioned to produce. It
correctly identified that the last element of the 35-item assessment array had
serialized as a bare `null` (the `@adhd/sox-store-adapter` / Turso BL-512 claim
at `src/cli.spec.ts:926`). **That gap is now closed** — index 34 of the delivered
array is a complete assessment of exactly that claim. What was **never produced**
is the actual "stay in backlog / extract to a shared package / push upstream"
verdict per workaround.
**Why triage:** S-14 cannot be sequenced without it, so someone has to decide
whether to re-commission that analysis or make the placement calls inline.

### T-03 — The 35 external-package assessments are fragmented under near-duplicate names with conflicting estimates
**Evidence:** the same logical package appears repeatedly under free-text
variants — `@adhd/sox-store-adapter` (#23, 20 lines), `@adhd/sox-store-adapter
(Turso error discrimination)` (#30, 45 lines), `turso adapter (store-open)` (#24,
24 lines), `@adhd/sox-store-adapter (Turso)` (#34, 20 lines), `turso (via store
adapter capabilities)` (#2, 45 lines), `@adhd/sox-store-adapter /
@adhd/sox-graph-store` (#9, 120 lines). The optional-embedding surface is split
three ways over **the same file** `src/store/semantic-search.ts` with
**different totals**: #0 says ~140 lines, #21 says ~110 lines, #1 says ~9 lines.
`filesAffected` for #0 is an absolute worktree path while every other entry is
repo-relative.
**Why triage:** the totals cannot simply be summed, and nobody can tell from the
data whether #0 and #21 are two estimates of one thing or two disjoint things —
reconciliation needs a human pass over the source claims, not more analysis.

### T-04 — `computeCitationSha` duplication: extract, or is the per-file convention deliberate?
**Evidence:** `src/write/create-issue.ts:307` and `src/write/transition.ts:224`
are byte-identical. The module-graph pass calls it a "candidate for extraction to
a shared write helper"; the jscpd scan (block 1, `create-issue.ts:282-346` vs
`transition.ts:216-254`, 65 lines) reports that **`transition.ts`'s own doc
comment says the duplication is deliberate, per an established per-file
convention**.
**Why triage:** two evidence streams disagree about intent. Someone has to decide
whether that per-file convention is still the rule before anyone refactors.

### T-05 — `carryForwardResidualEdgesTx` intentionally bypasses the multiplicity gate
**Evidence:** code review (backlog, **low**), `src/write/update.ts:638`
(hand-composed edge carry-forward at lines 616-634). It copies
`weight`/`confidence`/`origin`/`meta` verbatim from a residual edge **without
re-running `checkMultiplicityTx`** — the only write path in the package where
that gate is skipped. Documented as deliberate in the file's own comment;
reviewer's verdict is "likely correct".
**Why triage:** the risk is conditional on a prior bug having already produced two
live edges for a single-valued rel. Whether that is an acceptable residual risk
or a latent silent-propagation bug is a design call, not a determinable fix.

### T-06 — `SemanticHealthState` literal-union duplication inside a file already slated for deletion
**Evidence:** PR comment `4064583270` — `src/store/semantic-search.ts:66` and
`:278` both re-type `'uninitialized' | 'warming' | 'real' | 'error'` verbatim.
**Why triage:** the fix is trivial, but the whole module is on the deletion list
(see **S-01**). Deduping a type inside a doomed file may be wasted work — the
call depends on when that deletion actually lands. *(Contrast: **C-09**, the
false single-writer claim in the same file, is a clear fix regardless, because
the repo's hard rule requires correcting single-writer commentary on sight.)*

### T-07 — Commenter asserts `isSuperseded` filtering is now supported upstream; verification says otherwise
**Evidence:** PR comment `4064101204` on `src/query/views/semantic.ts:434` —
"This was changed in the underlying library and is supported now…". Verification
against both the installed `@adhd/sox-hybrid-search@0.4.3` **and** the latest
published `0.4.5` found `isSuperseded` is still **not** an accepted key in
`SearchQuery.filters` (`buildFilterClause()` is a hardcoded switch), so
`dropSupersededResults` must stay.
**Why triage:** the PR author's recollection directly contradicts the verified
package contents. Needs a confirmation from whoever owns sox-hybrid-search before
the post-filter is either kept or removed.

### T-08 — Commenter disputes the write-lock framing in the embed queue
**Evidence:** PR comment `4064412481` on `src/store/embed-queue.ts:14` — "False,
there are not locks. this mechanism is queueing because its ensuring we don't
simultaneously launch onyx runtimes." Verification found the write-lock the doc
block describes **is** real (`mutate-metadata.ts`'s `BEGIN IMMEDIATE`
transaction) and found **no ONNX-launch-serialization queue** anywhere in
`embed-queue.ts` or `semantic-search.ts`.
**Why triage:** author intent vs. verified code disagree, and this file is also
half-dead (see **S-01**) — the resolution may be "delete the argument" rather
than "settle it".

### T-09 — Should audit records carry a git-commit-SHA provenance field?
**Evidence:** three separate comments on the same line, `src/write/audit.ts:92` —
`4064702431` ("Pretty sure the original meaning of the sha field was the git sha
ref — so I'm guessing that is missing now?"), `4064704780` ("Git related data
should be considered metadata anyway"), `4064708473` ("signing the actions is
actually a ref-able feature from the readme"). Verification: `sha` is
deliberately a SHA256 content-integrity hash over the audit's canonical fields
(`actor`/`action`/`target_uid`/`from`/`to`/`note`/`at`), per SPEC.md §4a and
DATA_MODEL.md §4, unchanged since commit `d4f3a674`; no git-SHA field exists and
none is specified.
**Why triage:** the code matches the spec, so there is no bug — but the author
clearly expected git provenance to be recorded somewhere. Whether to add it as a
new field is a product decision, not a fix.

### T-10 — Anticipatory request to centralize sorting/prioritization
**Evidence:** PR comment `4064235018` on `src/query/query.ts:804` — "I'm assuming
this is going to be copy and pasted somewhere else in this pr". Verification:
`sortByPriorityRank` (lines 333-368) has exactly one caller (`queryList`, line
569) and `queryOrder`'s Kahn's-algorithm block (805-860) has no copies.
**Why triage:** valid as a forward-looking concern, with zero duplication today.
Needs a judgment on whether to pre-emptively abstract or revisit at the third use.

### T-11 — Should `fetchCatalogNames` be cached?
**Evidence:** PR comment `4064317705` on `src/query/resolve.ts:354-362`.
Verification calls the concern "technically correct but not worth fixing" —
the underlying `graph.queryNodes({kind, liveOnly:true})` is index-backed, and a
cache would risk serving stale catalog names under concurrent writers.
**Why triage:** "correct but not worth it" is exactly a cost/risk judgment, and
the staleness argument depends on how hot this path actually is — unmeasured.

### T-12 — Is a hardcoded 30s embed timeout in a spec file acceptable?
**Evidence:** PR comment `4064717061` on `src/write/bootstrap.spec.ts:55` —
`const EMBED_TIMEOUT = 30_000;`, documented at line 54 as accommodating a real
Turso vector-store round trip.
**Why triage:** verification calls making it configurable "a stylistic
preference, not a correctness fix". Whether test tunables belong in the env spec
alongside **S-08**/**S-09** is the same open question, unresolved.

### T-13 — Is 6.54% duplication over this package acceptable?
**Evidence:** jscpd, 2026-09-21: 6.54% duplicated across 15 blocks; the largest
runtime blocks are `create-issue.ts`/`transition.ts` (65 lines),
`create-issue.ts`/`update.ts` (55), `query.ts`/`views/stats.ts` (44),
`semantic-search.ts`/`bootstrap.ts` (36), `create-issue.ts`/`relate.ts` (36),
`create-issue.ts`/`transition.ts` again (32).
**Why triage:** there is no recorded threshold for this package, and several of
the blocks are individually justified elsewhere in this document. Setting (or
declining to set) a gate threshold is a policy call.

---

## 2. Needs scoping

*Real and worth doing, but the fix spans multiple files, needs a design decision,
or needs coordination with an external package.*

### S-01 — Free-text search silently degrades to grep-only for the life of the process
**Consumer symptom first:** on a store whose vector space is empty at process
startup — a fresh store, or one created by the cutover — **every `text:` search
(the CLI `search` command and the MCP free-text query, the primary user-facing
search path) is downgraded to grep-only for the entire process lifetime**, even
after real vectors exist. Only a restart clears it.

**Mechanism and evidence, consolidated from six streams:**
- Code review (backlog, **high**), `src/query/query.ts:1015`: `resolveTextInput`
  routes semantic-vs-grep off the process-wide singleton
  `isSemanticSearchReadable()` (`src/store/semantic-search.ts`), which
  `enableSemanticSearchFromConfig` latches to `false` once at boot.
- Forgotten-file sweep (**high confidence**), `src/store/embed-queue.ts`:
  `scheduleEmbed()` (line 151) is exported and documented but has **zero call
  sites** anywhere in the tree; its own header says it is called from
  `createItemNode`/`updateItemNode` in `crud.ts`, and **`crud.ts` does not exist
  anywhere in the repo**. That dead path was the *only* caller of
  `markSemanticVectorSpacePopulated()` — so the live write layer never flips the
  readiness flag the read path consults.
- Code review (backlog, **medium**), `src/cli.ts:658` and `src/server.ts:818`:
  both hosts still call the legacy `enableSemanticSearchFromConfig` at startup
  *in addition to* `api.ts`'s per-adapter `bootstrapSemanticStoreMembers`
  (`src/write/bootstrap.ts`) — **two embedding-provider instances and two vector
  store connections** against the same store, for the process lifetime.
- Forgotten-file sweep (**medium-high**): SPEC.md §5b
  (`DEBT-BACKLOG-CLI-EAGER-EMBEDDING-001`) fully specifies the replacement
  (`ensureSemanticReady`/`needsSemantic` in `api.ts`, after which cli/server
  "stop calling `enableSemanticSearchFromConfig` entirely"). Verified **not
  implemented**: no `ensureSemanticReady|needsSemantic|queryNeedsSemanticBackend`
  symbol exists in `api.ts` or `query/query.ts`. `STATE.md` marks task `A11` as
  done — the design was written, the code never applied.
- Module graph finding #8 + jscpd block 9 (`semantic-search.ts:319-354` vs
  `bootstrap.ts:118-155`, 36 lines): `bootstrap.ts` re-homes
  `loadOptional`/`checkDim`/`errText`/`PermanentEmbeddingDimensionError` rather
  than importing the dying module — deliberate, and self-resolving **only if**
  the deletion actually happens.
- PR comments folded in here: `4064619989` (`semantic-search.ts:342`, "should
  this exist & if so, it should definitely not be in this file"), `4064627603`
  (`:442`), `4064606888` (`:285`, also flags that the replacement layer has **no
  equivalent of `resolveVecFilter`'s NodeFilter→ids resolution** before calling
  the ids-only vector filter), `4064723442` (`bootstrap.ts:19` — the "imminent"
  deletion claim is stale), `4064731457` (`bootstrap.ts:143`), `4064737543`
  (`bootstrap.ts:352`).

**Why scoping:** this is one defect with five interlocking parts — delete the
dead half of `embed-queue.ts`, re-home the readiness responsibility onto the
live write layer, implement the already-specified `ensureSemanticReady` seam,
remove the duplicate host bootstrap, delete `semantic-search.ts`, and carry the
`resolveVecFilter` ids-resolution across. Doing any one in isolation either
breaks search or leaves the bug live.

### S-02 — Query filters are built ad hoc in five places, and several filter fields are silently ignored
**Evidence:** PR comment `4064185618` on `src/query/query.ts:563` ("Do we not have
a centralized parser for queries?"). Verification found only partial
centralization: `resolveEdgeScopedFilterIds` (line 147) covers the edge-scoped
dimensions, but `queryList`'s `baseFilter`, `queryReady`, `queryStale`,
`queryGraph` and `queryOrder` each compose their own ad hoc `NodeFilter` literal
— **and `filter.assignee`, `filter.claimedBy`, `filter.closedAt`,
`filter.createdAt`, `filter.updatedAt` are silently dropped on some of those
paths.** That is a real correctness bug, not a style nit.
**Why scoping:** a shared `buildIssueNodeFilter()` changes observable behaviour on
four query views at once and needs regression tests per view before it lands.
**Overlaps C-01** — do C-01's date-range helper as part of this, or expect a
collision in `query.ts`.

### S-03 — Open/closed resolution is triplicated verbatim across three query modules
**Evidence:** module-graph finding #1 and magic-variable finding #9 describe the
same defect. `resolveOpenClosedCandidates` / `resolveOpenClosedIds` /
`unionOpenClosed` at `src/query/query.ts:130-142`,
`src/query/views/semantic.ts:169-181`, `src/query/views/stats.ts:141-152` have
**byte-identical bodies**, and each site's JSDoc explicitly says it "mirrors" the
other two. `stats.ts`'s own comment records that a BUG-023-class fix had to be
applied there **specifically** — i.e. the triplication has already cost a
three-place fix once.
**Why scoping:** extraction needs a home module that all three query files can
import without creating a cycle, and the shared type (`query/types.ts:189`'s
canonical `'open' | 'closed' | 'all'` union) should be threaded at the same time.

### S-04 — `assertNonBlank` (×8) and `enforceRequiredFields` (×3) reimplemented across the write layer
**Evidence:** module-graph findings #2 and #3. `assertNonBlank` appears verbatim
in `src/write/catalog.ts:561`, `claim.ts:83`, `create-issue.ts:275`,
`delete.ts:77`, `move.ts:110`, `relate.ts:122` — while `transition.ts:144` and
`update.ts:198` carry a **widened variant** that also catches an explicit `null`
via `typeof value !== 'string'`. `enforceRequiredFields` at `update.ts:302` and
`transition.ts:269` is byte-identical; `create-issue.ts:375` is a near-identical
variant **missing** the `if (!(field in resolvedValues)) continue` guard the
other two have. jscpd block 3 (`create-issue.ts:380-434` vs `update.ts:308-333`,
55 lines) is the same duplication seen from the scanner's side.
**Why scoping:** consolidation is not mechanical — it decides that the widened
null-safe check and the `in`-guard become the behaviour everywhere, which changes
what `createIssue` rejects. Needs a deliberate call plus tests on the newly-strict
paths.

### S-05 — `grep` is the wrong name for a full-text-search field
**Evidence:** PR comment `4064355904` on `src/query/types.ts:196`. The field named
`grep` drives FTS, not grep: it calls `graph.searchNodes()` (`query.ts:453`) and
`graph.countNodesFts()` (`:518`), and `query.ts:481` already documents
"searchNodes already returns FTS-ranked results".
**Why scoping:** it is a public query-input field — renaming is a breaking change
requiring a major version bump, a deprecation path, and edits across the query
layer, SPEC.md and the tests.

### S-06 — `'order'` is a poor name for the execution-sequence view
**Evidence:** PR comment `4064226369` on `src/query/query.ts:804`. The literal is
live across `query.ts` (`queryOrder`, and `case 'order':` at line 1074),
`query/types.ts` (`IIssueView` union line 236, `IIssueQueryResult` discriminant
line 352), **SPEC.md §6.2 line 189**, and two test files
(`markdown-format.spec.ts`, `superseded-views.spec.ts`).
**Why scoping:** same shape as S-05 — a public-surface rename touching the spec
and tests, or an explicit recorded won't-fix.

### S-07 — User-defined, store-persisted named views and relationships
**Evidence:** PR comment `4064200865` on `src/query/query.ts:732`. Today
`GRAPH_RELS = ['blocks','relates_to','part_of'] as const` is a fixed tuple and
`queryGraph` (line 743) is built strictly around it; a repo-wide search found no
`viewDefinition`-style schema or store support anywhere in `src/`.
**Why scoping:** this is a feature with a data-model component (persisted view
definitions) — it needs a spec before any code.

### S-08 — Query limits are hardcoded rather than configured
**Evidence:** PR comment `4064373548` on `src/query/types.ts:284-285` —
`MAX_QUERY_LIMIT = 1000` and `DEFAULT_QUERY_LIMIT = 50` are plain module consts.
**Why scoping:** the fix is not just adding two fields to
`backlogEnvironmentSpec` (`src/env.ts`) — **none** of the three consuming call
sites (`query.ts`, `views/semantic.ts`, `views/registry.ts`) currently receive
config at all, so this needs a plumbing design mirroring `db.busyTimeoutMs`.

### S-09 — Retry tuning constants have no override path
**Evidence:** PR comment `4064516706` on `src/store/immediate-retry.ts:24-26` —
`DEFAULT_MAX_ATTEMPTS=5`, `BASE_DELAY_MS=20`, `MAX_DELAY_MS=500`. Only
`maxAttempts` has a pass-through override; the two delay constants have **no
override path at all**, and both call sites (`mutate-metadata.ts`,
`graph-backlog-store.ts`) invoke `withImmediateRetry()` with no opts.
**Why scoping:** same plumbing design as S-08 — env spec fields plus an
`ImmediateRetryOpts` widening plus threading through two call sites. Worth doing
together with S-08 as one config pass.

### S-10 — `catalog.ts` introduces four novel SQL shapes, against `tx.ts`'s stated rule
**Evidence:** PR comment `4064766637` on `src/write/catalog.ts:274` (and the same
concern at `:228`, comment `4064761911`, which verification found *is* spec-backed
and therefore lands in the no-action roster). `catalog.ts` composes SQL at lines
160-161, 197-200, 224-228 and 274 that mirrors **no** library function, while
`tx.ts`'s own header states "Every function below mirrors the library's own SQL
shape byte-for-byte — never a NEW SQL shape". Estimated 2-3 hours.
**Why scoping:** the fix is to promote those four shapes into named `tx.ts`
helpers, which touches the package's documented SQL-provenance discipline and
needs the citations updated alongside.

### S-11 — `tryResolveComponentRef` duplicates `tryResolveRef`'s name-resolution path
**Evidence:** PR comment `4064282581` on `src/query/resolve.ts:184`. Lines
178-187 structurally duplicate lines 144-152 — same
`queryNodes`→extract→validate→return shape, differing only by an optional
`metadata` filter. The uid-shaped paths already share code, so this is a
half-finished refactor.
**Why scoping:** the unified helper has to take query options as a parameter and
preserve both callers' validation semantics; it also intersects **S-23**'s
determinism question on the very same lookup.

### S-12 — UUID v4 shape validation belongs in `@adhd/data-base-transforms`
**Evidence:** PR comment `4064752198` on `src/write/catalog.ts:79-80` — a
hand-rolled UUID v4 regex (third field `4`, fourth field `[89ab]`).
`@adhd/apigen-base-logical` has a generic RFC 4122 validator but does **not**
enforce the v4 constraints.
**Why scoping:** it is a cross-package change — add a public export to a shared
data package, publish it, then consume it here. That is coordination, not a local
edit.

### S-13 — The vector store cannot distinguish "no filter" from "filtered to zero"
**Evidence:** PR comment `4064641971` on `src/store/semantic-search.ts:561`, plus
removal-scope assessments #0 and #1. `resolveVecFilter` (lines 349-378) must
already return three states (`undefined` = no filter, `{ids}` = resolved
candidates, and the empty case) and the call site at 553-562 works around the
ambiguity; #0 estimates ~54 lines removable if the vector store honoured
`NodeFilter` properly.
**Why scoping:** the two viable routes — fix upstream in `@adhd/sox-vector-store`,
or add compile-time guards locally — are mutually exclusive and the decision
should be recorded (an ADR, per the verification's own recommendation).

### S-14 — The external-package workaround-removal program (~1,400+ lines, blocked on T-02)
**Evidence:** 64 in-code claims about external packages (`t1_externalClaims`),
assessed across 35 write-ups. Merging the near-duplicate package identities, the
material clusters are:

| Cluster | Estimated removable | Key sites |
|---|---|---|
| `@adhd/sox-graph-store` transaction-scoping defect — `GraphBackend.writeNode/writeEdge/invalidateEdge/touch/getNodeByUid` all run against the bare un-transacted adapter, and `transaction(fn)` never swaps `this.adapter` | **~650-700** of `src/write/tx.ts`'s 876 lines, plus `claim.ts`'s `touchMetadataTx` (~30-40) and most of `delete.ts`'s hand-composed invalidate (~50-80) | `write/tx.ts`, `write/claim.ts`, `write/delete.ts`, `write/embedding-observer.ts` |
| `@adhd/sox-telemetry` — three upstream bugs (role persistence, init lock ordering, `logDir` ignored on re-init) | ~250-270 incl. an entire 140-line spec file | `src/serve.ts`, `src/serve.telemetry-role.spec.ts` |
| Telemetry-init contract on the adapter/graph store (records silently dropped without `initTelemetry`) | ~120 | `src/index.ts`, `src/serve.ts` |
| `@adhd/apigen-plugin-batch` top-level mount namespaces | ~125-130 (`resolveMountNamespaces`, the `prefixCommand` reserved guard, ~40 lines of tests) | `src/cli.ts`, `src/cli.spec.ts` |
| Optional embedding/vector deps — local type mirrors + `loadOptional` + dimension checks | **~110-145 (estimates conflict — see T-03)** | `src/store/semantic-search.ts`, `src/write/bootstrap.ts` |
| Turso error discrimination (`err.code` non-discriminating) | ~40-50 | `src/write/errors.ts:366-402`, `src/store/immediate-retry.ts:34-36` |
| `SortField` has no joined-edge column → in-memory `sortByPriorityRank` | ~40-50 | `src/query/query.ts:317` |
| `@adhd/apigen-plugin-cli-output` — no "see also"/field-requirement surface on per-verb `--help` | ~35-40 | `src/cli.ts:726-766` |
| Turso concurrent store-open WAL corruption (BUG-008) diagnostics | ~24-26 | `src/write/cross-process-write-safety.spec.ts:127-132, 176-200` |
| pnpm/npm bin symlink vs `process.argv[1]` | ~17-50 | `src/index.ts:129-131` |
| `@adhd/sox-hybrid-search` — no native anchor exclusion, forces over-fetch-by-one | ~13 | `src/query/views/semantic.ts:591, 599-600` |
| `@adhd/environment` — no explicit `defaultNamespace` | ~13 | `src/env.ts` |
| `@nx/vite:test` runs with workspace root as cwd | ~3-4 | `src/install-skill.spec.ts:17-26` |

Assessed as **informational only, nothing removable**: `npx` arg convention,
`vitest` collection-before-`beforeAll`, `fastify` teardown, `@adhd/apigen-base-errors`
exit codes, `@adhd/environment-builder`'s `project`-scope bug (backlog never takes
that path), `@adhd/apigen-plugin-openapi` request-time document derivation,
`liveOnly` defaults in `views/registry.ts:190` and `views/stats.ts:755` (both
already pass explicit values), and the closed-default-vocabulary note in
`store/graph-backlog-store.ts:42`.
**Why scoping:** every line of this is contingent on an upstream change that does
not exist yet, the estimates are not additive (T-03), and the stay/extract/push
decision was never made (T-02). This is a program to plan, not a task to start.

### S-15 — `closeStoreOnce` independently defined in both hosts
**Evidence:** module-graph finding #6 — `src/cli.ts:670-673` and
`src/server.ts:798-803` each define an identical memoize-the-close-promise
closure over `closeGraphBacklogStoreSafe`, wired into `installSignalCleanup` the
same way. Not a pure copy (`server.ts` closes over `store`, `cli.ts` over
`opened?.store`).
**Why scoping:** a shared `makeCloseStoreOnce(getStore)` needs a host-bootstrap
module that does not yet exist, and the two memoization semantics must be proven
equivalent before they are unified — shutdown paths are exactly where a wrong
assumption hangs a process.

### S-16 — Test-harness boilerplate copy-pasted across six spec files
**Evidence:** jscpd blocks 4, 5, 8, 11, 12, 15 — `query/meta-wire.spec.ts:31-77`
vs `query/registry-wire.spec.ts:50-96` vs `search-shortcut-wire.spec.ts:39-85`
(47 lines); `meta-wire.spec.ts:34-77` vs `query/paging-wire.spec.ts:52-98` (44);
`serve.spec.ts:138-175` vs `server.mcp.spec.ts:160-191` (38);
`batch-adoption.spec.ts:144-178` vs `server.spec.ts:173-194` (35);
`write/claim.spec.ts:71-103` vs `write/transition.spec.ts:79-110` (33);
`batch-adoption.spec.ts:67-96` vs `server.spec.ts:42-71` (30, the densest at 218
tokens).
**Why scoping:** a shared wire-test harness has to live somewhere
(`src/test/helpers/` already exists) and must not weaken the isolation each spec
currently gets from its own bootstrap — that is a test-architecture decision.

### S-17 — `write/CONTRACT.md` embeds code samples that mirror the implementation
**Evidence:** jscpd blocks 2, 7, 14 — `CONTRACT.md:688-744` vs `write/audit.ts:43-81`
(57 lines); `CONTRACT.md:146-184` vs `write/tx.ts:496-528` (39);
`CONTRACT.md:474-504` vs `write/errors.ts:40-77` (31).
**Why scoping:** three options (generate the samples from source, trim them to
signatures, or accept the drift with a gate) with different costs; the doc's
teaching value is a real argument against the cheapest one.

### S-18 — `findImplicitDiscriminatorBranch` can select the wrong union branch on a missing tag
**Evidence:** code review (apigen-base-logical, **high**),
`packages/apigen/apigen-base-logical/src/lib/runmode.ts:516` — the `matchIndex`
lookup can match a value's **undefined/missing** discriminator tag against a
branch that simply does not declare that property (also `undefined` in
`literalsByBranch`), silently selecting the wrong branch instead of falling
through to structural scoring. The reviewer notes this is *the same class of
silent-data-loss bug this PR set out to fix*, triggered by a missing tag rather
than a tie.
**Why scoping:** the fix changes branch-selection semantics in a decoder — it
needs a negative-control test proving the wrong branch is selected today, plus a
decision on the fallback ordering.

### S-19 — Unbounded recursion in `describeParams` for a union-of-unions
**Evidence:** code review (apigen-engine-runtime, **medium**),
`packages/apigen/apigen-engine-runtime/src/lib/describe-params.ts:96` — when a
`oneOf`/`anyOf` member is itself directly a union with no intervening object,
`typeName(member, expand)` passes `expand=true` through to `unionValues`, which
recurses with `expand=true` again, indefinitely. This contradicts the function's
own doc comment at line 92 ("never runaway into an unbounded recursive dump") and
lines 70-73. **No test covers it** — the new tests only exercise unions nested
inside object fields.
**Why scoping:** the one-level bound needs an explicit depth budget threaded
through `typeName`/`unionValues`/`objectShape`; picking that contract is a design
decision, not a one-line guard.

### S-20 — The startup-cost fix in `extraction-session.ts` shipped with no test
**Evidence:** code review (apigen-core-client, **medium**),
`packages/apigen/apigen-core-client/src/lib/extraction-session.ts:1`. The diff's
stated purpose is `BUG-APIGEN-CORE-CLIENT-STARTUP-001` (stop pulling in
ts-morph / ts-json-schema-generator for callers like `backlog --help`), but a
search by bug id and by filename found **no test anywhere in the repo** that
exercises or measures it — nothing proves requiring the module no longer eagerly
loads ts-morph, and nothing asserts the lazy getters are hit only on first real
use. This fails the repo's own "assertions must have teeth" standard for a
four-file perf refactor.
**Why scoping:** proving lazy module loading requires a harness that can observe
`require`/`import` side effects in a child process — real work to design, not a
missing `expect()`.

### S-21 — Name lookups return "first match" with no ordering guarantee
**Evidence:** PR comment `4064274271` on `src/query/resolve.ts:134-153`
(`tryResolveRef`): `graph.queryNodes({kind, name: ref, liveOnly: true, limit: 1})`
then `matches[0]`, with no `ORDER BY` and no uniqueness guarantee visible at the
call site.
**Why scoping:** two separable pieces, one of which is a product decision — (a)
add an explicit `ORDER BY` as defence-in-depth so "first" is deterministic rather
than storage-order-dependent, and (b) decide whether the project-agnostic
`tryResolveRef(graph, 'component', ref)` call sites in `query/views/registry.ts`
and `query/views/semantic.ts` should require a project scope.

---

## 3. Clear fix

*Unambiguous, small, and actionable directly — no further discussion needed.*

### C-01 — Extract `buildDateRangeFilter`
`src/query/query.ts` (`queryList`'s `baseFilter`, ~lines 427-438) maps
`createdAt`/`updatedAt` → `tCreatedAfter`/`tCreatedBefore`/`tUpdatedAfter`/
`tUpdatedBefore` via four spread-ternaries; `src/query/views/semantic.ts`
(`buildScalarNodeFilter`, ~lines 267-270) does the identical mapping as an
if-chain. PR comment `4064178417`. Pure refactor, two call sites, one unit test.
**Coordinate with S-02** — this is a strict subset of that surface.

### C-02 — Use `MARKDOWN_CAPABLE_VIEWS` in its own guard
`src/query/query.ts:1152-1158` hand-writes
`view !== 'list' && view !== 'ready' && view !== 'stale' && view !== 'similar'`
while line 1127 already defines `MARKDOWN_CAPABLE_VIEWS` and the error message
renders from it. Replace the chain with
`!(MARKDOWN_CAPABLE_VIEWS as readonly string[]).includes(view)`. PR comment
`4064246532`.

### C-03 — One canonical markdown-capable-view type
`src/query/types.ts:342` declares `IIssueMarkdownResult.view: 'list' | 'ready' |
'stale' | 'similar'` inline while `src/query/query.ts:1127` holds the same four
values as a runtime const. Hoist a single `MARKDOWN_CAPABLE_VIEWS` const plus
derived `MarkdownCapableView` type into `types.ts` and import it. PR comment
`4064378156`. Do together with C-02.

### C-04 — One canonical graph-relation vocabulary
`src/query/types.ts:300` (`IDependencyGraph.edges[].rel`) hand-writes
`'blocks' | 'relates_to' | 'part_of'`, re-declared as `GRAPH_RELS`/`GraphRel` at
`src/query/query.ts:732-736`. Export const+type from `types.ts`, import in
`query.ts`. No behaviour change. PR comment `4064375449`.

### C-05 — Name the catalog-kind union
`src/query/resolve.ts:356` (`fetchCatalogNames`'s `catalogKind`) and `:418`
(`resolveValidatedCatalogFilter`) both inline `'kind' | 'status' | 'priority'`.
Extract one named exported type and reference it at both sites. PR comment
`4064330138`.

### C-06 — Constrain `mutateMetadata`'s generic
`src/store/mutate-metadata.ts:36` declares `M = Record<string, unknown>` with no
constraint, forcing an `as Record<string, unknown>` cast at line 49. Add
`M extends Record<string, unknown>` and drop the cast; the inbound narrowing cast
at line 46 is legitimate and stays. PR comment `4064547109`.

### C-07 — Parallelize the independent ref-resolution loop
`src/query/resolve.ts:421-433` (`resolveValidatedCatalogFilter`) runs a
sequential `for…of` where each iteration awaits `tryResolveRef` then
`graph.getEdges` before the next starts. The iterations are independent — extract
the per-ref work and `Promise.all` it. PR comment `4064339362`.

### C-08 — Export the env-var name instead of re-typing the string
`src/write/bootstrap.spec.ts:57` declares
`const ENV_VAR = 'ADHD_BACKLOG_EMBEDDING_ENABLED'`, the same literal hardcoded at
`src/env.ts:96` inside `backlogEnvironmentSpec`. Export the name from `env.ts`
and import it in the spec. PR comment `4064718767`.

### C-09 — Delete the false single-writer claim (repo hard rule)
`src/store/semantic-search.ts:30` asserts that a worker thread would break "the
'one file, one writer' invariant RAG-SPEC §0 pins". **Verified against the
source:** `RAG-SPEC.md` exists at the package root and **does** contain "one
file, one writer" — but at **line 13**, not §0, and the claim itself contradicts
the repo's authoritative parallel-process invariant (ADR-0012). Fix **both**
sites: correct the misattributed section reference and replace the single-writer
framing at `semantic-search.ts:30` with the real reason (Turso's API contract),
and correct `RAG-SPEC.md:13`'s "one file, one writer" wording. PR comment
`4064580288`. *(Note: the pass-2 answer for this comment claimed `RAG-SPEC.md`
does not exist — that is wrong; it does. The single-writer point stands on its
own.)* This stays a clear fix even though the module is slated for deletion
(S-01), because the hard rule requires correcting single-writer commentary on
sight and `RAG-SPEC.md` is not going anywhere.

### C-10 — Sweep for other single-writer language
Follow-on to C-09 and independently mandated by the same hard rule: grep the
package's `src/` and top-level docs for single-writer / single-process /
one-writer phrasing and correct every hit, since two instances were found by
accident rather than by search.

### C-11 — Remove the static import of an optional dependency
`src/write/bootstrap.ts:50-52` statically imports `openTursoVectorStore` and
`AsyncVectorBackend` from `@adhd/sox-vector-store`, an `optionalDependency` — and
the direct import is **never used**, since the real access is the dynamic load at
line 282 (typed via `typeof`). Drop the static import and declare a local
`OptVectorStoreModule` interface matching the embedding-provider pattern already
in the same file. PR comment `4064725226`.

### C-12 — Export `parseJsonObject` instead of duplicating it
`src/write/tx.ts:130` defines `parseJsonObject` (unexported) for parsing the
`meta` column; `src/write/catalog.ts:61` duplicates it as `parseMetaObject`,
which catalog.ts's own doc comment records as behaviour-identical. Export from
`tx.ts`, delete the copy, update call sites. PR comment `4064748901`.

### C-13 — Share the claim-staleness default instead of re-typing `30`
`src/query/query.ts:715` has `const staleAfterMin = input.staleAfterMin ?? 30;`
with a doc comment stating it stands in for the project policy's own default —
which is `DEFAULT_PROJECT_POLICY.claimStaleAfterMin` at `src/write/catalog.ts:555`,
also `30`. `catalog.ts` is the source of truth and stays as-is; export a
`DEFAULT_CLAIM_STALE_AFTER_MIN` constant from it and import it in `query.ts`.

### C-14 — Share the busy-timeout default instead of re-typing `5000`
`src/store/graph-backlog-store.ts:79` has `busyTimeoutMs = 5000` with a doc
comment (lines 71-75) explicitly stating it is chosen to match `src/env.ts:83`'s
`default: 5000` for `db.busyTimeoutMs`. Two literals, an acknowledged coupling,
and nothing enforcing it. Export one `DEFAULT_BUSY_TIMEOUT_MS` and import it at
both sites.

### C-15 — Name the default HTTP host and port, and derive the help text
`src/server.ts:860-861` has `port: opts.port ?? 3300` and
`host: opts.host ?? '127.0.0.1'` as bare literals; `src/serve.ts:102-108` re-types
`3300`, `127.0.0.1` and `0.0.0.0` as prose in the CLI help with no reference back.
Introduce named constants in `server.ts` and interpolate them into the help text.

### C-16 — Name the retry jitter band
`src/store/immediate-retry.ts:72` has
`await sleepAsync(delay * (0.5 + Math.random() * 0.5));` with unnamed factors,
while the same file names `BASE_DELAY_MS`/`MAX_DELAY_MS`/`DEFAULT_MAX_ATTEMPTS`
at the top. Add a named `JITTER_FACTOR` (or a comment stating "50%-150% of
delay") to match the file's own convention. Independent of S-09.

### C-17 — Name the default edge weight
The literal `1.0` appears as a bare positional argument at `src/write/tx.ts:463`,
again as `input.weight ?? 1.0` at `tx.ts:655`, and a third time **inside a raw SQL
string** at `src/write/update.ts:871`
(`VALUES (?, ?, 'SUPERSEDES', 1.0, 'user_asserted', NULL, ?, ?)`), where it is
neither greppable nor bound. Introduce `DEFAULT_EDGE_WEIGHT` and use it at all
three sites.

### C-18 — Extract `resolveIssueProjectTx`
`src/write/transition.ts:175` and `src/write/update.ts:236` hold a byte-identical
async function running the same transaction-scoped
`SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL` to resolve
an issue's owning project. Move it into a shared write-internal helper (module
graph finding #5).

### C-19 — Export `looksLikeOwnSandboxDir` from one place
`src/cli.ts:417-418` defines the predicate `p.includes(sep + 'backlog-sandbox-')`
as an unexported inline const; `src/test/helpers/spawn-backlog-bin.ts:230-232`
re-types the identical line and exports it. The test helper should import the
production definition so it cannot drift from the check it mirrors (module graph
finding #7).

### C-20 — Hoist `getScopeEnum()` out of the per-method loop
`packages/apigen/apigen-core-client/src/lib/extract-classes.ts:176` and `:265`
call the memoized `getScopeEnum()` inside the loop body; the scope enum never
changes across iterations. Hoist `const Scope = getScopeEnum();` above each loop.
Code review (apigen-core-client, **low**) — described as a hot extraction path.

### C-21 — Fall back for an empty `enum: []`
`packages/apigen/apigen-engine-runtime/src/lib/describe-params.ts:56` —
`enumValues` on a schema with an empty `enum` array produces `''`
(`[].map(...).join('|')`), so `describeParams` renders `mode?: ` with a trailing
colon and nothing after it. Emit a placeholder (`enum`/`unknown`) and add the
missing test. Code review (apigen-engine-runtime, **low**).

### C-22 — Run the vocabulary gates in CI
Neither `scripts/check-vocabulary.mjs` (scans the packed tarball) nor
`tools/gate/vocabulary-gate.mjs` (scans `src/` plus the package's top-level
markdown) is invoked by CI, a git hook, or any Nx target — both only run when a
human remembers. Wire them into an Nx target on the backlog project so they run
on PRs touching the package. PR comment `4064072037`. *(The commenter's second
question — whether the banned-term scan should also sweep the whole PR diff
repo-wide — is a scope decision; note it when filing, but the CI wiring itself is
unambiguous and should not wait on it.)*

### C-23 — Add a data-model diagram and link it from the README
`README.md` has no mention of the data model, no mermaid fence, and no image
reference; `DATA_MODEL.md` (300 lines) describes the graph schema in prose with
**no diagram at all**, and the README does not even cross-link it. Add a mermaid
`graph`/`erDiagram` of the node kinds and edge relations (`has_status`,
`owns_project`, `owns_component`, …) to `DATA_MODEL.md` and link it from
`README.md`. PR comment `4064169633` — an explicit request from the repo owner,
doc-only, decoupled from any code under review.

### C-24 — Retire the now-satisfied TEST-GAP marker
`src/store/graph-backlog-store.spec.ts:73-89` carries a doc comment titled
`TEST-GAP-BACKLOG-BUSY-TIMEOUT-UNPROVEN-001` explaining that the preceding tests
only prove the adapter reads back the value it was given. The test immediately
below it (lines 90-146) **does** prove a contended `BEGIN IMMEDIATE` blocks, via
real two-connection contention with a ratio-based assertion. Rename or remove the
`UNPROVEN` marker so it stops advertising a gap that is closed. PR comment
`4064483026`.

### C-25 — Correct the stale fixture header comment
`src/test/fixtures/cross-process-issue-writer.ts:6-8` implies `createIssue` and
`queryIssuesWithMeta` are absent from the barrel; they are reachable via the
wrapped `create`/`query` barrel exports, just not under their own names. Reword.
PR comment `4064669130`.

### C-26 — Reword the retry header's PRAGMA framing
`src/store/immediate-retry.ts` header refers to a busy PRAGMA, but
`isBusyContention()` (lines 32-35) classifies **thrown errors** via
`isBusyError`/`isConcurrentConflict` and never introspects a PRAGMA; Turso applies
its busy-timeout equivalent separately at connect time (`dbOpts.timeout = 5000`,
BL-512). Cosmetic comment fix. PR comment `4064520082`.

---

## Appendix — PR comments resolved with no action

All 74 PR comments are accounted for in this document. Forty-two are cited
directly in the items above; the remaining thirty-two were verified against
current code and need no change beyond, in some cases, a reply on the thread.

| Comment | Location | Comment | Resolution |
|---|---|---|---|
| `4064241992` | `src/query/query.ts:995` | "Definetly doesn't seem like something that is inherent to an exported functionality" | `resolveTextInput` is a module-local export for unit tests; never re-exported through `api.ts`/`index.ts`, so it is not public API. |
| `4064257968` | `src/query/resolve.ts:98` | "very strange name for the variable of this helper" | `currentUidOf` is correct given its single call site's `isSuperseded` guard (`resolve.ts:71-73`). Reply-only. |
| `4064322527` | `src/query/resolve.ts:365` | "probably already available in @adhd data packages" | Premise false: no edit-distance utility exists in any `@adhd/data-*` package. The ~15-line private implementation stays. |
| `4064343326` | `src/query/resolve.ts:457` | "Definetly a adhd transforms / collections op" | `intersectCandidateSets` is `Set<number>`-based with an undefined-for-empty contract required by SPEC.md §6.5 rule 3; the transforms `intersection` is array-based, throws on empty, and would regress performance. |
| `4064327559` | `src/query/resolve.ts:388` | "Get the feeling sox supports this both better and natively" | sox ships no lightweight did-you-mean primitive — its search is embedding+BM25 over issue content, not tiny-catalog typo matching. |
| `4064368065` | `src/query/types.ts:209` | "first mention i've seen of plan so far" | Observational. The `plan` filter is specified, implemented and tested. |
| `4064387521` | `src/store/audit-log.ts:46` | "This is just blanket dropped feature?" | Not dropped — superseded by `src/write/audit.ts` (`writeAudit`, atomic in-transaction) in commit `9fab4938`; fixes `BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001`. Reply-only. |
| `4064394040` | `src/store/claim.ts:28` | "Confirm claiming still supported" | Relocated, not removed: claim/release/renew live in `write/claim.ts` + `write/claim-lease.ts` + `write/catalog.ts`, with CAS transaction, `ClaimHeldError` and a 30-minute stale default. |
| `4064488976` | `src/store/graph-backlog-store.ts:81` | "We don't trust adhd env?" | `openGraphBacklogStore` is public and has call sites that never run `backlogEnvironmentSpec`; the re-validation is defence-in-depth at a real trust boundary. |
| `4064524465` | `src/store/immediate-retry.ts:47` | "Hmm" | `sleepAsync` is deliberately a pure clamping primitive; jitter is applied at the call site (line 72). See C-16 for the naming nit. |
| `4064531259` | `src/store/lifecycle.ts:1` | "Lifecycles still exist?" | Decomposed into the per-verb write layer (`transition.ts`, `claim.ts`, `update.ts`, `create-issue.ts`, `delete.ts`); the terminal-transition citation gate is at `write/transition.ts:397-405`. |
| `4064512051` | `src/store/graph-backlog-store.ts:155` | "should be correctly caught no?" | Only `closeGraphBacklogStoreSafe` swallows, deliberately, for finally-path teardown, and it is tested (`cli.spec.ts:934`); `closeGraphBacklogStore` propagates. |
| `4064574103` | `src/store/semantic-search.ts:26` | "should be filed against sox ecosystem if this is true" | The claim is accurate but describes an intentional guard-rail directing callers to the shipped async backend — no upstream ticket warranted. |
| `4064593741` | `src/store/semantic-search.ts:233` | "Why arent we reusing the type then?" | `SemanticBootstrapConfig` structurally mirrors an `optionalDependency`'s config by design. Optional one-line comment. |
| `4064601680` | `src/store/semantic-search.ts:270` | "cant tell if its a logical decision" | A type-only import still requires `tsc` to resolve the specifier of a package that is not installed by default — the structural mirror is the correct pattern. |
| `4064613242` | `src/store/semantic-search.ts:298` | "Does this copy every type from the semantic layer?" | The `Opt*` mirrors are deliberate zero-compile-time-coupling, explained at lines 268-271 — not bad upstream exports. |
| `4064587827` | `src/store/semantic-search.ts:83` | "Seems like this whole type exists inside the semantic library" | `SemanticBackend` is a local composition of two libraries' APIs, not a duplicate of either; rationale already at lines 73-79. |
| `4064671593` | `src/test/fixtures/cross-process-issue-writer.ts:10` | "I dont like that variable, concerning" | Fail-closed negative-control switch: read once at `tx.ts:777`, safe default when unset, throws on any unrecognized value, set only in spec files. |
| `4064091467` | `src/query/views/semantic.ts:292` | "first function in this file that actually makes sense to be here" | The five private helpers (lines 141-272) are domain-specific to the semantic view; placement is correct. |
| `4064348071` | `src/query/types.ts:48` | "Pseudo field?" | The term is precisely defined in the doc block at lines 19-32 (extra reads, opt-in, excluded from the default card). |
| `4064419247` | `src/store/embed-queue.ts:46` | "Qualifies for adhd env config?" | `CONTENT_MARKER_PREFIX` is a data-format constant that must be identical across deployments, not a deployable setting. |
| `4064436604` | `src/store/embed-queue.ts:120` | "Sounds like a sketchy data store to me" | The per-store `WeakMap<GraphBacklogStore, Set<Promise<void>>>` is sound: untrack fires on success and failure (line 95), and the flush loop re-snapshots. |
| `4064475307` | `src/store/embed-queue.ts:178` | "should be handled inside the backend" | The `embedModel` provenance stamp lives in graph-store node metadata; `SemanticBackend` is store-agnostic and cannot write it. |
| `4064650662` | `src/store/semantic-search.ts:608` | "this resolves and iterates every vector?" | Single-probe: the lazy async iterator yields one item then breaks. Optional rename of `_first` to `_probeItem`. |
| `4064715217` | `src/write/bootstrap.spec.ts:26` | "This is concerning commentary" | The test already pins `ADHD_BACKLOG_EMBEDDING_ENABLED` explicitly and cleans up, which is exactly the fix for the ambient-state risk raised. |
| `4064756436` | `src/write/catalog.ts:120` | "Sounds redundant with other functions" | `resolveByUidTx` is the shared consolidation helper behind `resolveProjectTx` and `resolveComponentTx`, not a redundant sibling. |
| `4064761911` | `src/write/catalog.ts:228` | "Hard spec violation" | The `owns_project` JOIN in `resolveDefaultComponentTx` is the spec-documented traversal (header at lines 207-214) that prevents cross-project `(root)` mismatches. *(The neighbouring concern at `:274` is real — see S-10.)* |
| `4064773538` | `src/write/claim.ts:127` | "staged for removal question" | Hand-composed SQL against the transaction handle is the mandated pattern in SPEC.md §4c (lines 537-615) for compare-and-swap edge lookups; the file is complete, not staged for removal. |
| `4064877105` | `src/serve.ts:2` | "Backlog should have 1 client that the transports all use" | Already the current shape: `api.ts` is the single client, and CLI / HTTP+MCP / in-process all mount from the same operation descriptors. |
| `4064895789` | `apigen-base-logical/src/lib/codecs/date-time.ts:27` | "adhd transform code has pretty much all of these utilities" | The codec wraps native `Date` with protocol-specific strict-mode, NaN and path-tracking validation that does not belong in a generic transforms package. |
| `4064899079` | `apigen-base-logical/src/lib/contracts.ts:58` | "Strange name" | `ownsValue?()` is deliberately parallel to `matches(node)` and documented in the JSDoc at lines 40-57; renaming is churn. |
| `5719922858` | PR-level (DeepSource bot) | "JavaScript — Failed" in the `cb56c8b…af8eaf6` review | Resolved at HEAD: the ESLint flat-config rewrite (commit `53f4ff3e`) turned linting green for all 62 affected projects. |
