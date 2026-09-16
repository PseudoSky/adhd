# SPEC.md §9 Acceptance Criteria — Coverage Matrix

Audit date: 2026-09-16. Scope: `entrypoint/backlog`, worktree `backlog-v2`. This
audit is **static** (no test run) and covers only the surviving layer per the
task brief: `src/query/`, `src/write/`, `src/api.ts`, `src/api.surface.spec.ts`,
`src/test/helpers/`, `tools/etl/`, `src/store/type-policy.ts`. Everything under
`src/v2/`, `src/store/` (except `type-policy.ts`), `src/client.ts`,
`src/ops-v1.ts`, `src/model.ts`, `src/cli.ts`, `src/migration-phase.ts`,
`src/migration-admin.ts`, and any spec named `*v1*`/`*v2*`/`*migration*`/
`*humanid*`/`*repo-migration*` is treated as DEAD and never cited as proof,
even where its own tests are green.

One file relevant to this audit — `src/write/catalog-verbs.spec.ts` — is a
new, **untracked** file (not yet committed by whichever concurrent agent wrote
it) discovered mid-audit via `git status`. It is real, on-disk, and read in
full; cited normally.

## Verdict summary

| Verdict | Count | ACs |
|---|---|---|
| PROVEN | 7 | 5, 7, 9, 10, 14, 16, 17 |
| PARTIAL | 11 | 1, 2, 3, 6, 11, 12, 15, 18, 21, 22, 23 |
| ABSENT | 5 | 4, 8, 13, 19, 20 |
| DEAD | 0 | — (no AC's only evidence lives in a to-be-deleted file) |

7 + 11 + 5 + 0 = 23.

---

## AC-1 — `rg 'humanId'` over the v2 layer is empty; identity is `uid`

**Verdict: PARTIAL**

Ran the check myself: `rg -n "humanId" src/write src/query src/api.ts tools/etl src/store/type-policy.ts` returns hits only in `tools/etl/` — and every one is the documented, single-accessor ETL boundary:
- `tools/etl/corpus-types.ts:32,38,72` — `IRawItemMeta.humanId` is the literal key name in the frozen v1 JSONL fixtures; `sourceRefOf()` (line 72) is "the ONE accessor that touches the raw `.humanId` fixture key" per its own doc comment, translating it to `sourceRef` immediately.
- `tools/etl/identity.ts:21-22,83` — same boundary, reading `renamedFrom[].humanId` off the raw corpus.
- `tools/etl/run-etl.spec.ts:136-148` — actively **asserts** `humanId` never leaks past that boundary: `expect(note.includes('humanId')).toBe(false)` on the persisted provenance blob.
- `src/query/types.ts:16` and `src/query/query.ts:515` — comments only ("identity is `uid`... never `humanId`"), no code.

So `src/write/`, `src/query/`, and `src/api.ts` are genuinely clean (zero occurrences), and the one remaining occurrence is a justified, tested ETL-ingest boundary rather than a residual identity field. Downgraded from PROVEN to PARTIAL for one reason: **AC-1 as written is a shell command, not a test** — nothing in the committed suite runs this `rg` check as part of CI, so a future regression (e.g. someone threading `humanId` back into `write/create-issue.ts`) would not be caught by `nx test`; it would only be caught by a human re-running this exact grep. The invariant holds today; it is not mechanically pinned.

---

## AC-2 — Live-path identical-content: two `createIssue` calls, second with `duplicateAction:'force'`, produce two distinct `uid`s

**Verdict: PARTIAL**

The literal claim in the AC — a caller passes `duplicateAction:'force'` to `createIssue` — cannot be tested because `ICreateIssueInput` (`src/write/create-issue.ts:47-84`) **has no `duplicateAction` field at all**. There is no dedupe-detection code path in `createIssue` to force past (confirmed: `grep -n "duplicate" src/write/create-issue.ts` — zero hits). The verb's actual behavior is simpler than the AC assumes: every entity write passes `skipDedupe: true` unconditionally (doc comment, `create-issue.ts:200-201`), so **every** call — force or not — mints a fresh row regardless of content.

That said, the underlying guarantee the AC cares about — "identical `{title, body}` in the same project still produces two distinct `uid`s" — **is** proven, and proven hard, just not via a `duplicateAction` parameter:
- `src/write/cross-process-write-safety.spec.ts:203-226` (CONTROL test) and `src/test/fixtures/cross-process-issue-writer.ts:73-91` — every one of `2*N=400` `createIssue` calls across two real OS processes writes the **exact same** `body` ("cross-process-write-safety probe"), and the test asserts `persisted === a.ok + b.ok` (i.e., 400 distinct rows), never a collapse. The dedupe NEGATIVE CONTROL (`cross-process-write-safety.spec.ts:269-333`, `ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on`) then flips this off and confirms the SAME identical-content input collapses to exactly 1 row when `skipDedupe` is not unconditional — proving the assertion has teeth (AGENTS.md §7 rule 2).

Verdict is PARTIAL rather than PROVEN because the AC's specific mechanism (`duplicateAction:'force'` as the thing that "guarantees" the distinct-uid outcome) does not exist on the live path; the outcome it describes is proven via an unconditional `skipDedupe`, a different design than the AC assumes.

---

## AC-3 — Automatic audit: every transition/update/move/invalidate/embedding write produces one audit node (`actor`+`action`+`sha`); a transition missing `agent`/`note`/`sha` is rejected

**Verdict: PARTIAL**

The `transition`/`update`/`move`/`delete` (invalidate)/`claim` halves are solidly proven:
- `src/write/transition.spec.ts:210-222` — `transition.sha` is **recomputed independently** (`sha256Hex(canonicalJSONStringify(...))`) and compared byte-for-byte against the persisted `metadata.sha`: `expect(transitionRow?.metadata?.['sha']).toBe(recomputed)`. This is the load-bearing assertion for "automatic sha, cannot be forgotten."
- `src/write/transition.spec.ts:291-300` and `:134-139` — `NoteRequiredError` when no note is given (policy default requires one); one audit row per real transition (`expect(trail).toHaveLength(2)`).
- `src/write/transition.spec.ts:265-272` — `InvalidArgumentError` on missing/blank `by` (agent).
- `src/write/claim.spec.ts:251-262`, `src/write/relate.spec.ts:94-105,129-141`, `src/write/move.spec.ts:270-277`, `src/write/delete.spec.ts:111-116`, `src/write/update.spec.ts:353-364` — each independently proves exactly one new audit row per real write, with `action` correctly named.

The gap: **the embedding-write audit clause is not implemented, at all** — `src/write/audit.ts:19-27` states this explicitly in its own doc comment: "The ONE structural exception — the embedding audit row (`embedding_upserted`/`embedding_deleted`/`embedding_failed`, §4a/§4b) — is NOT implemented here... out of scope for this slice." There is no code to test and no test exists. So AC-3's "every ... embedding write produces one audit node" clause is currently false of the shipped code, not merely untested.

Also: `writeAudit` (`src/write/audit.ts:65-99`) computes `sha` unconditionally itself — there is no code path where a caller can omit it, so "a transition missing ... sha is rejected" doesn't apply as a caller-facing rejection (sha can't be missing by construction); this is a structural guarantee, not a validated rejection, and is fine as coverage for that specific sub-clause.

---

## AC-4 — On-write embedding: writing an issue produces its vector via the observer; invalidating removes it

**Verdict: ABSENT**

Not implemented in the surviving write layer, confirmed by the code's own doc comments:
- `src/write/create-issue.ts:69-82` (`awaitEmbed` field doc): "**Not implemented in this slice.** the spec's own embedding observer (`createEmbeddingObserver`, FEAT-021) fires from `GraphWriteObserver.onNodeWritten`, which only fires from INSIDE `GraphBackend.writeNode`/`writeNodeInTx`... a hook this write layer structurally never calls... `awaitEmbed` is accepted for input-shape parity... but has no effect."
- `src/write/update.ts:139-146` — same disclosure, same field, same non-effect.
- `src/write/audit.ts:19-27` — the embedding audit row is explicitly out of scope too (see AC-3).

The only place a vector is ever attached to an issue in the surviving test suite is `src/query/views/semantic.spec.ts`'s `indexIssue()` test helper (lines 60, 90-94), whose own doc comment says it "mirrors what a (not-yet-built) embedding observer would do post-commit, done directly here since this slice is read-path only" — i.e. the test explicitly bypasses the missing feature rather than exercising it. A test would have to: call `createIssue`, then (without any manual `indexIssue`/`vec.upsert` call) query the vector store directly and find a real embedding present; and separately, call `deleteIssue`/`invalidate` and confirm the vector store's row for that node is gone. No such test exists because the production code path it would exercise does not exist.

---

## AC-5 — Uniqueness: duplicate `project.name` rejects; duplicate `component.name` in different projects accepts (edge-scoped), same project rejects

**Verdict: PROVEN**

Proven via idempotent-upsert convergence (the mechanism this package actually implements — collapsing to one row under a race, rather than a raw insert-time throw) in `src/write/catalog-verbs.spec.ts`:
- `catalog-verbs.spec.ts:152-169` — `upsertProject`: two racing calls against the SAME new `name` ⇒ `expect(await countLiveNodes(store, 'project', 'race-project')).toBe(1)`, and exactly one `(root)` component for the survivor.
- `catalog-verbs.spec.ts:245-250` — `upsertComponent`: the SAME component name under a DIFFERENT project is a genuinely distinct row: `expect(a.uid).not.toBe(b.uid)`.
- `catalog-verbs.spec.ts:252-265` — `upsertComponent`: two racing calls against the SAME `(project, name)` ⇒ exactly one live row.
- `catalog-verbs.spec.ts:356-368` — `upsertLocation`: two racing calls against the SAME `(component, locType, value)` ⇒ exactly one live row.

Caveat (not a downgrade, since AC-5 itself does not demand cross-process proof — that is AC-12's job): these are **in-process** `Promise.allSettled` races, not real OS processes. The underlying `BEGIN IMMEDIATE` CAS this rests on is separately proven cross-process by `claim.spec.ts`'s and `cross-process-write-safety.spec.ts`'s real-OS-process harnesses, which exercise the identical transaction-mode guarantee `upsertProject`/`upsertComponent`/`upsertLocation` depend on (per `catalog-verbs.spec.ts:171-202`'s own negative-control commentary, which explicitly leans on this).

---

## AC-6 — Parity (ETL): issue count, terminal-closed count, per-issue citation sets (100 sampled), `getSubgraph(project)` counts all match v1; every transition has `agent`+`note`+`sha`

**Verdict: PARTIAL**

Strongly proven against an independently-computed **oracle**, but scoped to a 400-item fixture, not the full corpus, and missing two of the AC's named checks:
- `tools/etl/run-etl.spec.ts:60-73` — total/live/invalidated issue counts match `oracle.json`, cross-checked by a live query, never a remembered count.
- `tools/etl/run-etl.spec.ts:75-81` — Pass-2 edge counts match the oracle, split by rel.
- `tools/etl/run-etl.spec.ts:92-102` — **every** migrated `transition` node has non-empty `agent`, `note`, `sha` — directly proves the AC's own "every transition has agent+note+sha" clause: `expect(row.agent, ...).toBeTruthy()` etc. over every transition row.
- `tools/etl/run-etl.spec.ts:104-125` — citation sha correctness re-derived independently from real file hashes.

Not proven:
- **"per-issue citation sets (100 sampled)"** — no test compares a v1 issue's citation set against its v2 counterpart, sampled or otherwise. `run-etl.spec.ts` checks citation *counts* and *sha correctness*, never a v1-vs-v2 per-issue citation-set diff.
- **"`getSubgraph(project)` counts all match v1"** — `rg getSubgraph` across `src/query`/`src/write`/`tools/etl` finds only `src/query/views/stats.ts` (production code, `partOfRollup`'s own use of `getSubgraph`) and zero test usages against a v1 comparison. No such parity test exists.
- The proof runs against `fixtures/subset-400` (400 real items) with its own from-scratch oracle, not the full "603 open / 1476 total" corpus SPEC.md §10 names as the actual migration target. A subset proof is real evidence of mechanism correctness, but is not the acceptance run itself.

---

## AC-7 — Semantic: `searchRanked` over the v2 store returns text+vec fused results

**Verdict: PROVEN**

`src/query/views/semantic.spec.ts` is comprehensive and uses real components throughout (real `GraphBackend`, real `TursoVectorBackend`, real `StoreSearchBackend`; only `embedQuery` is test-pinned, which is the correct external-boundary mock per AGENTS.md §7):
- `semantic.spec.ts:119-131` — ranks by fused relevance descending (vec channel).
- `semantic.spec.ts:147-182` — a title/body TEXT match surfaces even when its vector is the worst match, with an explicit `limit:3` cutoff engineered so the test actually discriminates fused-vs-vec-only ranking (the file documents that a looser, prior version of this test "stayed green even with the text channel fully disabled" — flagged and replaced).
- `semantic.spec.ts:307-387` — filter-pushdown-purity: metadata/project/component filters correctly exclude a strictly-closer wrong-scope candidate, and an empty-candidate-set short-circuits to `[]` rather than an unfiltered fallthrough (tested at two independent layers: `querySimilarView` and `rankByFusedRelevance` directly).

---

## AC-8 — Keyset: `queryNodes({after, limit})` pages stably, no gaps/dupes

**Verdict: ABSENT**

The mechanism exists in production code — `src/query/query.ts:64-76` implements the `after`/keyset paging contract and its `sort`-vs-`after` incompatibility rule (rule 5) — but there is **zero test coverage** for it anywhere in the surviving suite. Confirmed by exhaustive search: `rg -n "after:" src/query/*.spec.ts src/query/views/*.spec.ts src/write/*.spec.ts` returns no hits. `query.ready.spec.ts` tests `limit` validation and application for `view:'ready'` only (not `after`/keyset at all — that view doesn't page by `after`). No test in the surviving layer calls `queryIssues`/`query()` with `after` set, checks that consecutive pages don't overlap or skip a row, or exercises the "insertion order" default ordering claim.

A test proving this would have to: create N issues, page through `queryIssues({view:'list', limit:k})` using each response's continuation cursor as the next call's `after`, collect all returned `uid`s across pages, and assert the union is exactly the N created uids with no duplicate and no gap — ideally also proving stability under a concurrent write landing between two page fetches.

---

## AC-9 — Registry list: `view:projects`/`components`/`locations` return the seeded nodes; a component list scoped by `filter.project` returns only that project's components

**Verdict: PROVEN**

`src/query/views/registry.spec.ts`:
- `:172-183` — `listProjects` returns every live project, unfiltered, with full field matching.
- `:203-219` — `listComponents`: unfiltered lists all 4 seeded components; `filter.project` narrows to exactly that project's 2 components (`(root)` + `backlog`), and `expect(components.every((c) => c.projectUid === fx.projectA)).toBe(true)` — the load-bearing scoping assertion.
- `:221-248` — `listLocations`: unfiltered, `filter.component` (by name), combined `filter.project`+`filter.component`, and the negative case (wrong-project scope returns `[]`).

---

## AC-10 — Registry lookup: `lookup("memory_ping")` resolves to `project: sox-ecosystem` + `component: memory-server` + `location: tool memory_ping`, one call, no search

**Verdict: PROVEN**

`src/query/views/registry.spec.ts:344-351` drives the exact scenario named in the AC verbatim: `lookup(store.graph, 'memory_ping')` against a fixture that seeds `sox-ecosystem`/`memory-server`/`tool:memory_ping` (lines 130-138), and asserts `result.project.name === 'sox-ecosystem'`, `result.component?.name === 'memory-server'`, `result.location?.locType === 'tool'`, `result.location?.value === 'memory_ping'`, `result.hint === undefined` — a single `lookup()` call, no separate search step.

---

## AC-11 — Registry detail: `get {registry:"project",name:"adhd"}` returns `path`, `repoUrl`, linked `locations[]`+`components[]`; a worktree dir under the project resolves to the SAME project

**Verdict: PARTIAL**

The first half is fully proven: `registry.spec.ts:251-260` — `getRegistryDetail(..., {registry:'project', name:'adhd'})` returns `name`, and its `components`/`locations` arrays match the seeded fixture exactly (`['(root)','backlog']` and the 3 seeded location values).

The second clause — "a worktree dir under the project resolves to the SAME project (no phantom row)" — is **not implemented**, and therefore not tested. `getRegistryDetail`'s project branch resolves by `name` only (`tryResolveRef`'s name-based lookup, confirmed by reading `registry.ts`); there is no path-based / path-prefix project resolution anywhere in `views/registry.ts` that a worktree subdirectory could hit. `lookup()`'s own path-suffix fallback (`registry.spec.ts:368-374`, "resolves a repo-relative path via suffix fallback, WITH a hint") is a *location* lookup, not a *project* lookup by worktree path, and does not satisfy this clause. A test proving this clause would first need the feature to exist.

---

## AC-12 — Registry CRUD: each upsert is idempotent on its OWN uniqueness key and nothing wider; `upsertComponent` scoped `(project, name)`; all three resolve through the edge-scoped policy inside the `immediate` transaction; re-running concurrently from two real OS processes still yields one row each

**Verdict: PARTIAL**

The idempotency-on-own-key and scoping halves are thoroughly proven in `src/write/catalog-verbs.spec.ts`:
- `:111-125` — `upsertProject` twice with the same `name` is one row, fields merge (not replace).
- `:229-243` — `upsertComponent` twice with the same `(project, name)` is one row.
- `:245-250` — the SAME component `name` under a DIFFERENT `project` is a genuinely distinct row.
- `:301-306` — `upsertLocation` by component-uid and by component-name+project resolve to the SAME row.
- `:309-324` — exact-triple re-`upsertLocation` is a stated no-op with teeth (node count AND audit trail both asserted unchanged).

**The explicit, load-bearing clause the task brief calls out — "re-running the trio concurrently from two real OS processes still yields one row each" — is NOT met.** Every "genuine concurrency" test in this file (`:152-169`, `:252-265`, `:356-368`) uses `Promise.allSettled([...])` over two calls in the **same Node process** against the same in-memory `store` handle — never `child_process.spawn`, never two real OS-level connections. This is exactly the distinction the task brief warned about: "a single-process simulation with promises does not satisfy" the two-real-OS-process requirement. The file's own doc comment on the deferred-mode negative control (`:171-202`) acknowledges leaning on the *general* `BEGIN IMMEDIATE` guarantee proven elsewhere (`claim.spec.ts`, `cross-process-write-safety.spec.ts`) rather than proving it again here cross-process for these three verbs specifically — but that is an inference from a different verb's cross-process proof, not a direct one for `upsertProject`/`upsertComponent`/`upsertLocation`.

A test satisfying this clause would need to mirror `claim.spec.ts`'s `spawnClaimWorker`/file-barrier pattern (`claim.spec.ts:269-343`), but drive `upsertProject`/`upsertComponent`/`upsertLocation` from two real `tsx`-spawned child processes against the same on-disk db, then assert (via a fresh-reopen connection) exactly one live row for the contested key.

---

## AC-13 — `get`: no-`fields` default is the five-field card; `body` pseudo-field returns it; unresolved `uid` throws `IssueNotFoundError`

**Verdict: ABSENT**

There is no `get.spec.ts` (or any spec) dedicated to `src/query/get.ts`'s `getIssue()` in the surviving layer. Every call site that exercises `getIssue` explicitly passes `fields` (never omits it): `src/write/update.spec.ts:172,179,191,255,311,338` all pass an explicit `fields: [...]` array. None of the following are tested anywhere in the surviving suite:
- Calling `getIssue` with no `fields` at all and asserting the result is exactly `{uid, kind, title, status, priority}` (the `DEFAULT_ISSUE_CARD_FIELDS` constant, `src/query/types.ts:76`).
- Requesting the pseudo field `'body'` and getting `card.body === issue.content` (the code path exists, `src/query/card.ts:228`, `if (want('body')) card.body = issue.content;` — just untested).
- Calling `getIssue` on a `uid` that resolves to no live node and asserting `IssueNotFoundError`.

The production code for all three exists (`get.ts`, `card.ts`, `resolve.ts`); none of it is exercised by a dedicated test.

---

## AC-14 — `update` touch + no-silent-discard

**Verdict: PROVEN**

`src/write/update.spec.ts` proves both named clauses with teeth:
- `:123-131` — `update({uid, by, title:'x'})` returns `changed:['title']` exactly.
- `:143-145` — a zero-field patch throws `InvalidArgumentError`.
- `:147-159` — **the load-bearing assertion**: a raw (untyped) input carrying `status` is rejected, `rejects.toThrow(BacklogValidationError)` AND `rejects.toThrow(/transition/)` (naming the correct verb), with an explicit check that the `has_status` edge target is untouched (`expect(after[0].dst).toBe(before[0].dst)`) — proving DEBT-010 cannot recur through `update`.

---

## AC-15 — `transition` closedAt stamp: stamps on terminal transition + `filter.closedAt.since` retrieves it via a subsequent `query`; reopen CLEARS it and a subsequent `query({filter:{closedAt:{since:...}}})` no longer matches

**Verdict: PARTIAL**

The stamp-and-clear half, directly on the node, is proven with teeth:
- `src/write/transition.spec.ts:147-156` — terminal transition stamps `outcome.closedAt` and `issue.meta.metadata.closedAt` (read back via raw node fetch).
- `src/write/transition.spec.ts:158-168` — **explicitly named "the stale-timestamp case, not just never-set"**: reopening a terminal issue clears `closedAt` on both the outcome and the persisted node (`expect(row?.metadata?.['closedAt']).toBeUndefined()`).

The AC's second half — proving this via **the query filter itself** (`query({filter:{closedAt:{since: <the old closedAt>}}})` no longer matching the reopened issue) — is not tested. `src/query/query.ts:162-174` implements `filter.closedAt.{since,until}` (confirmed by reading the source), but no spec file in the surviving suite ever calls `queryIssues` with a `closedAt` filter (there is no `query.spec.ts` in the surviving tree at all — the only `src/query/*.spec.ts` files are `card.spec.ts`, `query.ready.spec.ts`, and the `views/*.spec.ts` files, none of which exercise generic `filter.closedAt`). This is precisely the "stale filter no longer matches after reopen" scenario the AC calls out by name as the harder half, and it is unproven.

---

## AC-16 — `claim` CAS lease: claim/held/reclaim-with-force/reclaim-stale outcomes; two concurrent `claim` calls against the SAME fresh uid, as real barrier-synchronized OS processes, never both report `claimed`

**Verdict: PROVEN**

This is the single best-evidenced AC in the package. `src/write/claim.spec.ts`:
- `:101-260` — every rule-table branch against a real single-connection store: unclaimed→claimed, same-claimant re-claim→held, different-agent-no-force→`ClaimHeldError` (with `heldBy`/`heldSince` asserted, and the row proven untouched by the rejected attempt), different-agent-with-`force`→`reclaimed-stale` with `previousClaimant` set, genuinely-stale lease→auto-reclaim without force, release/release-noop, renew/renew-rejection, `IssueNotFoundError` for missing/soft-deleted/superseded uids, `InvalidArgumentError` on blank inputs, and a full audit-trail assertion.
- `:345-401` — **the CAS proof, literally two real OS processes**: `spawnClaimWorker` (`:281-305`) spawns `tsx cross-process-claim-worker.ts` as a genuine child process (not `worker_threads`, not a promise simulation); `runBarrieredClaimPair` (`:308-343`) synchronizes both via a file-based `ready-<tag>`/`GO` handshake so both begin from identical committed state; the CONTROL test asserts `winners.length === 1` and `losers.length === 1` (never both, never neither), the loser's `ClaimHeldError.heldBy` names the actual winner via a fresh read, and persistence is re-verified through a brand-new store connection (never either worker's own view).
- `:403-459` — the NEGATIVE CONTROL (`ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`) strips the `BEGIN IMMEDIATE` guarantee and documents/observes the CAS breaking under the downgrade (double-win or driver-level chaos), proving the CONTROL case has teeth per AGENTS.md §7 rule 2.

---

## AC-17 — `relate`/`move`: conflicting `supersedes` target throws; same target is `noop:true`; exactly one live `owns_component` edge before/after `move`

**Verdict: PROVEN**

Both halves proven with direct SQL-level teeth (never trusting the outcome object alone):
- `src/write/relate.spec.ts:167-193` — a second `relate(...,'supersedes','add')` naming a DIFFERENT target throws `SingleValuedRelationConflictError` (with `side`/`cappedUid`/`rel`/`conflictingUid` all asserted), and the original edge is proven untouched by a raw edge read; the SAME target returns `noop:true` (`:170-171`).
- `src/write/relate.spec.ts:195-205` — the same generic multiplicity gate also covers `duplicate_of`/`part_of` (not a rel-specific code path).
- `src/write/move.spec.ts:167-187,189-205` — a direct SQL count of live `owns_component` edges (`countLiveOwnsComponentEdges`, never the outcome object) is asserted `=== 1` both before and after a component-only move AND a cross-project move; `:180-186` further confirms exactly 2 rows exist total (1 invalidated + 1 live), never a lingering third.
- `move.spec.ts:235-255` — same-placement is a stated no-op with teeth: the audit trail and the live edge's own `rowid` are asserted byte-identical across the no-op call.

---

## AC-18 — `delete` is soft: returns `{invalidated:true}`; disappears from a default `query` listing; `getNodeByUid(uid)` still resolves it

**Verdict: PARTIAL**

The bi-temporal soft-delete mechanics are thoroughly proven in `src/write/delete.spec.ts`:
- `:81-94` — `deleteIssue` returns `{uid, invalidated:true}`; the node survives with `content`/`name`/`kind` verbatim and `tInvalid` stamped; **the row is still fetchable by uid afterward** (`const after = await readNode(store, issueUid); expect(after).not.toBeNull();`) — this satisfies "getNodeByUid still resolves it" at the tx-level primitive (`getNodeByUidTx`), which is what `graph.getNodeByUid` itself wraps.
- `:118-130` — a second delete against the same uid throws `IssueNotFoundError`, never re-stamping.
- `:111-116` — exactly one `deleted` audit row, alongside the original `created` row.

Not directly tested: **"disappears from a default `query` listing."** No spec in the surviving suite calls `queryIssues({view:'list', ...})` (or any `query()` view) on a project containing a just-deleted issue and asserts the deleted issue is excluded from the results. The closest evidence is `src/query/views/stats.spec.ts:188-221`, which proves a **different** code path — `priorityMatrix` (a stats view) — excludes a soft-deleted issue from its counts; that is not the `query` verb's default `list` view, and the task brief explicitly warns against letting an adjacent green test mask a gap in the actual claimed surface.

---

## AC-19 — `create`'s duplicate gate: default suppresses with `{created:false, reason:'duplicate-suppressed'}` and writes nothing; `force` writes a new distinct uid + still reports `duplicateCandidates`; `comment` writes zero issue rows and attaches a note instead

**Verdict: ABSENT**

The live `createIssue` verb (`src/write/create-issue.ts`) has **no duplicate-detection mechanism whatsoever**. Confirmed: `ICreateIssueInput` (lines 47-84) has no `duplicateAction` field; `grep -n "duplicate" src/write/create-issue.ts` returns zero hits; `src/write/errors.ts` has no duplicate-suppression error/result shape for the live path. Every occurrence of `duplicateAction`/`duplicateCandidates`/`'duplicate-suppressed'` in the repository is in the DEAD v1 layer (`src/client.ts:239-306`, `src/model.ts:2459-2523`) — explicitly out of scope per the task brief's dead-set list. This is not a testing gap; it is a feature gap. A test cannot prove behavior the production code does not implement. Building this would require adding duplicate detection to `createIssue` (or a wrapping verb) before any test of it could be written.

---

## AC-20 — `query` sort/keyset conflict: `query({after, sort:'priority'})` throws `InvalidArgumentError('sort', ...)` naming the incompatibility; the identical call without `sort` succeeds, insertion order

**Verdict: ABSENT**

The production code implements exactly this rule — `src/query/query.ts:64-76` ("SPEC.md §6.5 rule 5: `after` is incompatible with `sort` and with `grep`/`semantic`"), throwing `InvalidArgumentError('sort', 'sort is incompatible with keyset pagination (after)...')`. But there is no test anywhere in the surviving suite that calls `queryIssues`/`query()` with both `after` and `sort` set and asserts the throw, nor one that confirms the identical call without `sort` succeeds and pages in insertion order. (Same underlying gap as AC-8: no generic `query.spec.ts` exists in the surviving `src/query/` tree at all.)

---

## AC-21 — Registry `rmLocation`: invalidates the location; subsequent `lookup` on `(locType,value)` no longer resolves it; the record remains addressable by uid

**Verdict: PARTIAL**

`src/write/catalog-verbs.spec.ts`'s `rmLocation` describe block (`:402-473`) proves:
- `:418-432` — invalidates the node AND its owning `has_location` edge; audits `'deleted'`.
- `:447-450` — a second `rmLocation` against the same uid throws `CatalogNotFoundError` (never re-stamps).
- `:456-467` — no issue-facing fallout (an issue owned by the same component survives untouched).
- (Implicit in `:418-432`'s own `readNode` call after invalidation) the record remains addressable by uid.

**Not tested: the AC's own middle clause** — "a subsequent `lookup` on that `(locType,value)` no longer resolves it." No test in either `catalog-verbs.spec.ts` (which never imports/calls `lookup`) or `registry.spec.ts` (whose location-invalidation tests, e.g. `:288-294`, flip `t_invalid` via raw SQL directly rather than going through the real `rmLocation` verb, and target `getRegistryDetail`, not `lookup`) actually chains a real `rmLocation()` call into a subsequent `lookup()` call on the same `(locType, value)` and asserts it no longer resolves. This is exactly the kind of "adjacent-but-not-identical" gap the task brief warns about: the ingredients are separately tested, the composition is not.

---

## AC-22 — Concurrent write safety (BUG-039 gate): fresh-reopen stored count equals ok-reporting creates, same-target and distinct-target cases, two real OS processes, no serve-lock; negative control (guard removed) goes red

**Verdict: PARTIAL**

`src/write/cross-process-write-safety.spec.ts` is a rigorous, real two-OS-process harness (`:203-226` CONTROL, `:228-267` tx-mode NEGATIVE CONTROL, `:269-333` dedupe NEGATIVE CONTROL):
- CONTROL: two real `tsx`-spawned child processes (`spawnWriter`, real `child_process.spawn`, never threads), file-barrier synchronized, each call `createIssue` 200 times into the same project; `storedCount` reopens the store **fresh** and asserts `persisted === a.ok + b.ok` exactly (`:217-223`) — the literal BUG-039 assertion.
- The tx-mode NEGATIVE CONTROL strips `BEGIN IMMEDIATE` (`ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`) and asserts the deterministic invariant that must always hold (`persisted <= a.ok + b.ok`), documenting per-run flakiness honestly rather than asserting a false-precision hard number.
- The dedupe NEGATIVE CONTROL (`ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on`) is a genuinely separate, second criterion (`skipDedupe:true`'s load-bearing role) and does go hard-red-by-design green-here: `expect(persisted).toBe(1)` when dedupe is force-enabled against 400 colliding identical-content calls, vs. exactly 400 under the production default.

The gap is the AC's explicit **"for both the same-target and distinct-target cases"** clause. `§10.4`'s original harness (the now-dead `src/store/concurrency-scale.spec.ts`) had a literal same-family-vs-distinct-family writer split, inherited from the old `humanId`/`family` identity model. The new harness's writer (`src/test/fixtures/cross-process-issue-writer.ts:55-97`) always writes the SAME body across every one of the 2×N calls (by design, to exercise the dedupe control) but always a DISTINCT title, and `createIssue` always mints a fresh uid per call (there is no concept of "the same target uid" for a *create* verb — that scenario is what AC-16's `claim` CAS and AC-12's upsert-idempotency tests cover instead, for different verbs). So under the new uid-based identity model, this file proves the core BUG-039 property (no silent loss, negative control goes red) convincingly, but does not literally split into two writer-pair "same-target"/"distinct-target" *createIssue* scenarios the way the AC's inherited wording describes — that split's meaning did not survive the identity-model change intact, and no test explicitly re-derives what it should mean for `createIssue` and proves both halves separately.

---

## AC-23 — `create` with no `component` defaults to `(root)`, never orphaned; reachable via `query({filter:{project}})`; two separate no-component creates resolve to the SAME `(root)` row

**Verdict: PARTIAL**

Two of the three clauses are solidly proven, via evidence assembled across files (never a single dedicated `create-issue.spec.ts`, which does not exist):
- **"writes exactly one `owns_component` edge to the reserved `(root)` component, never throws"** — `src/write/move.spec.ts:225-233,257-268` creates an issue with `component` omitted and confirms (via `move`'s own resolution) `outcome.fromComponent === projectARootUid`, i.e. the component-omitted issue really did land on `(root)`, not orphaned. `src/write/catalog-verbs.spec.ts:105-109` also creates an issue with `component` omitted against a fresh project and confirms the create succeeds (`created.uid` truthy) — weaker evidence (doesn't check the edge target), but corroborating.
- **"reachable through the project filter, never orphaned"** — `src/write/cross-process-write-safety.spec.ts`'s `storedCount` helper (`:169-179`) queries `queryIssues({filter:{project}, limit:1000})` after 400 real `createIssue` calls that all omit `component`, and the CONTROL test asserts the exact count matches — i.e. every component-omitted-created issue really is reachable via `filter.project`, at real scale, through the real `query` verb.

**Not tested: "two separate no-`component` `createIssue` calls against the same project resolve to the SAME `(root)` component row"** — the specific negative-control-shaped assertion the AC calls for (`get({registry:'component', name:'(root)', filter:{project}})` returning exactly one row after two separate omitted-component creates) does not exist as a test. No spec creates two issues without `component` in the same project and then explicitly counts the live `(root)` component rows for that project (the way, e.g., `catalog-verbs.spec.ts:162-167` counts `(root)` rows for `upsertProject`'s own race, or `move.spec.ts:215-222` counts them for `move`'s destination-project default) to prove the fallback is a *resolve*, never a *mint*.

---
