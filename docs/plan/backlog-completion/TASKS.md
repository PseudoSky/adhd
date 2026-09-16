# Backlog — completion task list

Persistent tracker. Update the Status column in place; never delete a row.
Status: `todo` | `wip` | `blocked` | `done`

## A. User-numbered tasks (this session)

| # | Task | Status | Notes |
|---|---|---|---|
| A1 | Dispatch agent to fix the release-process docs that caused the confusion | done | `release-doc-fixer`: AGENTS.md changesets constraint + PUBLISHING.md (no hand version edits, cascade-plan no-args default, `dist/package.json` is a stale artifact, 2 troubleshooting rows) |
| A2 | Publish the sox release closure | blocked | All gates PASSED; sweep set was exactly the 2 predicted packages. Blocked at the registry on `EOTP` — npm 2FA one-time password. Needs the user: `pnpm exec changeset publish --otp=<code>`. Do NOT re-run `changeset version`. |
| A3 | Remove the owner-gate section from PUBLISHING.md, commit + push | done | Committed `04da5472`. Heading is now "Publish to PUBLIC npm (irreversible …)"; AGENTS.md "owner-gated publish step" also dropped. Push pending with A2. |
| A4 | Finish the backlog work (section B + C) | wip | |

## B. Backlog items to file / resolve

| # | Item | Status | Notes |
|---|---|---|---|
| B1 | File: `@adhd/sox-embedding-provider` unreleased surface drift | todo | `check-changeset-surface` FAIL; local 0.5.0 == npm 0.5.0 → not in sweep set, not a blocker |
| B2 | Resolve sox BUG-031 | todo | Fixed in `turso-adapter.ts` (bounded retry, commit 6f9ec560) + `wal-ownership.ts` docstring correction; ships in store-adapter 0.9.2 |
| B3 | Close adhd BUG-009 as induced | todo | Self-induced by a pin bump, not a real defect |
| B4 | Resolve adhd BUG-010 | todo | `sqlite-vec` import removed from `src/query/views/semantic.spec.ts` |
| B5 | Update DEBT-004 (zero-sqlite) | todo | Imports now zero; textual references remain |
| B6 | File: nx `build` target `inputs` omit `package.json` | todo | Causes stale `dist/package.json`; documented in PUBLISHING.md by A1 |
| B7 | DEBT-005 | filed | Already exists in the graph — no new filing needed. Still to FIX. |
| B8 | sox BUG-030 (turso SIGABRT) | todo | Trigger not yet established |
| B9 | BUG-011 — `filter.humanId` silently ignored | filed | Violates SPEC §7, one of the five load-bearing query contracts. `{filter:{humanId:X}}` returns the full 622-item set with ok:true. Still to FIX. |
| B10 | BUG-012 — `duplicate_candidate` returns empty `details` | filed | Refusal names no candidate; both refusals this session were false positives. Still to FIX. |
| B12 | DEBT-018 — `sox-hybrid-search` re-derives ids it was already handed | filed | `node_modules/@adhd/sox-hybrid-search/dist/index.js:466-468` — when `hasNodeFilter`, it always calls `this.graph.queryNodes(nodeFilter)` to build `matchingIds`, even when the caller already passed a concrete `filters.ids` array (`filter-utils.js` counts `ids` as a node filter). Verified firsthand. Against a different package. |
| B11 | DEBT-006 (repo `adhd`) — vitest workers never call `initTelemetry()` | filed | Landed in the minority `adhd` repo bucket; collides by humanId with a different DEBT-006 under `PseudoSky/adhd`. Covered by the already-CRITICAL `BUG-BACKLOG-REPO-SPLIT-001` (adhd 52 / PseudoSky/adhd 348). |

## C. Project completion — the FEAT-017 hard replacement

**Governing spec: `entrypoint/backlog/SPEC.md`** (FEAT-017, "FULL HARD REPLACEMENT").
**Direction of travel (verified from git history — do not re-derive backwards):**
- NEW layer, built against the spec: `src/query/`, `src/write/`, `src/store/` (created in `d4f3a674`)
- OLD layer, to be WIPED: `src/client.ts`, `src/ops-v1.ts`, `src/v2/` (created in `0cb37400`)
- `src/query/` being unreachable from the live surface is the EXPECTED mid-build state, not a defect.

| # | Task | Status | Notes |
|---|---|---|---|
| C1 | Commit the uncommitted new-layer work | done | 3 commits, all after a full green suite (74 files / 862 passed / 0 failed): `d1c39809` write layer, `3d5ffb55` query views, `d7251f5e` ETL. ~9400 lines that were at risk untracked. |
| C2 | Wave S7 — transports | todo | Wire `src/query/`+`src/write/` to the live entrypoint (CLI / MCP / HTTP). This is what "src/query unwired" actually needs |
| C3 | Wave S8 — ETL (stalled 6/6) | todo | |
| C4 | S10 — acceptance | todo | |
| C5 | S11 — wipe the old layer | todo | Deletes `client.ts`, `ops-v1.ts`, `src/v2/` AND the store-layer identity machinery (`ids.ts` allocator, `structure.ts`, `repo-migration.ts`, humanid-collision/id-uniqueness specs). Satisfies AC-1 + the 0-v1/v2/humanId/migration criterion. **Do this FIRST** — it removes 768 humanId sites before any hand work. |
| C6 | S12 — vocabulary gate | todo | |
| C7 | S13 — fresh extract + ETL + parity | todo | |
| C8 | S14 — publish + blind test of the public package | todo | |

### C-wave 2 (2026-09-16) — new-layer completion before the wipe

| # | Task | Status | Notes |
|---|---|---|---|
| C9  | `queryReady` — apply `limit`, collapse 3N round trips to ~5 | done (uncommitted) | `src/query/query.ts`. Was the ONLY view never calling `assertQueryLimit`. 7 tests + 4 negative controls in `src/query/query.ready.spec.ts`. Commit blocked by the pre-commit hook, see C13. |
| C10 | `openCurve` N+1 — `M*(1+4N)` → `4+M` round trips | done (uncommitted) | `src/query/views/stats.ts`. Status + audit trail hoisted out of the instant loop; they don't vary by `at`. Negative control (cross-issue status contamination) proven RED then green. 12/12. |
| C11 | `resolveStatusesFor` batching + registry `lookup` unbounded scan | done (uncommitted) | `src/query/card.ts` (doc comment had been lying — it was one `getEdges` per issue) and `src/query/views/registry.ts` (bounded at `MAX_QUERY_LIMIT`, truncation surfaced in `CatalogNotFoundError` rather than silently). 35/35. Both negative controls proven. |
| C12 | semantic filter scan | done — no change | Finding did NOT hold: every `queryNodes` in `semantic.ts` is conditional and bounded, and the common path calls none. The real inefficiency is in the `@adhd/sox-hybrid-search` dependency — filed, see B12. |
| C13 | Disconnect the slow suite from commits | wip | `hook-architect`. Measured: 338s per commit attempt, and `nx affected` scopes off the DIRTY WORKTREE, so each agent's commit is gated on every other agent's in-flight edits. Blocked commits 3x today. |
| C14 | 4 registry verbs + `api.ts` mount | wip | `registry-verbs`. `api.surface.spec.ts` currently RED (EXPECTED-length mismatch) — this is what blocks C9-C11 from committing. |
| C15 | AC-19/AC-2 — `create` duplicate gate | wip | `dup-gate`. FEATURE GAP, not a test gap: `ICreateIssueInput` has no `duplicateAction` field and `create-issue.ts` has zero duplicate-detection code. |
| C16 | AC-8/AC-13/AC-20 — keyset paging, `get` defaults, sort+after conflict | wip | `query-acs`. Working production code, literally zero coverage — there is no `query.spec.ts` or `get.spec.ts` at all. |
| C17 | AC-4 + AC-3's embedding clause — on-write embedding observer | todo | FEATURE GAP. `awaitEmbed` "has no effect" and the `embedding_upserted`/`_deleted`/`_failed` audit rows are "NOT implemented here" per the code's own doc comments. Collides with C15 on `create-issue.ts` — dispatch after C15 lands. |
| C18 | AC-12 — registry upsert idempotency under two real OS processes | done | `98405860`. Spawned-process (`spawn`+`tsx`, file barrier, fresh reopen, direct `COUNT(*)===1`) for **all three** upserts: `upsertProject`, `upsertComponent`, `upsertLocation`. **Precise scope:** the `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred` negative control ran for `upsertProject` ONLY — component and location rely on it exercising the shared `executeWriteTransaction` CAS, which is the same code across all three but is NOT separately proven for them. `rmLocation` has no cross-process test: it is invalidate-by-uid, not a contested-identity upsert, so AC-12 does not apply to it. The commit message for `98405860` reads as if the control covered the upserts generally — it did not; this row is the accurate statement. | `catalog-verbs.spec.ts` proves it with `Promise.allSettled` in ONE process, which only demonstrates JS single-threadedness. The AC demands `spawn` + file barriers, as `cross-process-write-safety.spec.ts` already does correctly. |
| C19 | AC-1 mechanically pinned | todo | The zero-`humanId` criterion is a shell command, not a test. Holds today; nothing in CI would catch a regression. Needs a real gate. |
| C20 | Correct the wipe plan's delete list | done | `CUTOVER.md`. `serve-lock.ts` (290 lines) + `signal-cleanup.ts` (114) have ZERO internal imports and are needed by `server.ts`/`cli.ts` — the plan would have deleted working infra. Also closed: the doomed-import inventory (14 files, no dynamic/bare escapes), `immediate-retry.ts` may die, `markdown.ts` is deleted not re-homed. |
| C21 | Stale `v2` vocabulary in `open-test-issue-store.ts` | todo | Doc comment carries `v2` wording and points at `docs/plan/backlog-sox-rebuild/CONSUMERS.md`. Must clear before the vocabulary criterion. |

| D7 | Test processes never call `initTelemetry()` | todo | Every vitest worker prints the BL-404 `[sox-telemetry] WARNING ... emitting with no initTelemetry()` line. The guard is working as designed (`libs/observability/sox-telemetry/src/runtime.ts`, `service==='unlabeled'` sentinel, deliberately not silenced by the `logSink:'none'` short-circuit). Fix in backlog: call `initTelemetry({service:'backlog',role:'test',logSink:'none'})` from a vitest setup file. |
| D8 | Comments describing a sqlite adapter as a supported substrate | todo | 11 sites. Most are accurate historical incident notes and stay. `src/store/graph-backlog-store.ts:3` ("turso substrate by default, sqlite via the test-only `STORE_ADAPTER` env") + `immediate-retry.ts:9` / `busy-retry.spec.ts:41` ("the legacy SQLite adapter's codes") imply a support path we do not offer. Zero sqlite deps/imports is ALREADY met — this is wording only. |

## D. Known defects to fix inside C

| # | Item | Status | Notes |
|---|---|---|---|
| D1 | `assertNonBlank` null-crash | todo | `src/write/claim.ts:62`, `delete.ts:58`, `create-issue.ts:110`, `move.ts:105`, `relate.ts:106` |
| D2 | SPEC gap: `IMoveIssueInput.toComponent` required, no `toProject` | todo | `SPEC.md:1479-1483` |
| D3 | `s5b-semantic-views` frozen-foundation violation on `query.ts` | todo | |
| D4 | 9 pre-existing TS errors in spec files | todo | |
| D5 | Test-lane pattern applied nowhere | todo | `tools/nx-plugins/test/lib/spec-lanes.mjs`; 43 spawn-based specs across 13 projects |
| D6 | `tools/etl/_profile.ts` uncommitted throwaway | todo | Deliberately left untracked (CLAUDE.md: one-shot ETL scripts stay throwaway). Not deleted — it is not mine to delete. Decide with the user. |

## E. Hard acceptance criteria (check at the end)

Full AC-by-AC audit: **[HANDOFF.md](./HANDOFF.md)**.

- [ ] **0 `humanId`** — SPEC §0 anti-antipattern 1 and §9 AC-1. Identity is the
      DB-generated `uid`; no allocator, no dedupe-scan, no `idOverride`, no
      `importedFrom`, **no repo-string identity**. 2124 sites today; 768 die free
      with the §7 wipe, the new layer is already uid-native (5 residual, all prose),
      the store layer's 774 are the real work.
- [ ] 0 references to `v1`, `v2`, or a migration anywhere in the backlog package — it is only "backlog"
- [ ] 0 sqlite dependencies, imports, or references in the backlog package
- [ ] All 23 SPEC §9 acceptance criteria driven. Static audit 2026-09-16
      (**[AC-COVERAGE.md](./AC-COVERAGE.md)**): **7 PROVEN** (5, 7, 9, 10, 14, 16, 17),
      **11 PARTIAL** (1, 2, 3, 6, 11, 12, 15, 18, 21, 22, 23), **5 ABSENT**
      (4, 8, 13, 19, 20). Two of the ABSENT are FEATURE gaps — the code does not
      exist — not test gaps: AC-19's duplicate gate and AC-4's embedding observer.
- [ ] Public package blind-tested after publish

---

## F. Advisor review findings (opus, session resume)

### F1 — BLOCKER: production handle wires neither `search` nor `embedding`
Verified firsthand, not taken on report:
- `api.ts:147` `queryHandle(ctx)` returns `{graph}` only — `search` deliberately
  omitted, with a comment (`api.ts:130-146`) explaining that nothing in the
  package constructs a `StoreSearchBackend` outside `query/views/semantic.spec.ts`.
- `api.ts:123` `writeHandle(ctx)` returns `{adapter, typePolicy}` only — no
  `embedding`, no `search`.

Consequence: `scanForDuplicates` returns `[]` (no backend) and
`scheduleIssueEmbedding` no-ops with no audit row, in production, always.
**AC-4 and AC-19 are proven in unit tests and FALSE at the CLI** — every passing
test builds its own wired handle. This is exactly the pattern AGENTS.md §7 was
written about, and it must be fixed BEFORE the wipe, not debugged inside it.

Fix: `src/write/bootstrap.ts` — the store-bootstrap module that
`test/helpers/open-test-issue-store.ts`'s header already anticipates. Dispatched.

### F2 — the wipe is contained (swept, was never checked)
`rg -l "@adhd/backlog"` outside `entrypoint/backlog/**`: every hit is prose —
docs, RELEASE/CHANGELOG/BACKLOG markdown, and comment text inside
`tools/nx-plugins/**` recounting past publish incidents. **Zero external source
importers.** The wipe cannot break another package.

### F3 — `index.ts` IS the 1.0.0 public API, and nearly all of it dies
`src/index.ts` today re-exports: 37 v1 ops from `./ops-v1.js`, the six v2 verbs
from `./client.js`, `startBacklogServer`/`runBacklogCli`/`runServeCommand`,
`openGraphBacklogStore`, 9 markdown functions, and `export * from './model.js'`
(line 104). `ops-v1.ts`, `client.ts`, `markdown.ts`, `model.ts`, and
`store/graph-backlog-store.ts` are all on the deletion list. Deciding the
surviving surface is an API DECISION to make before deleting, not a
compile-error to fix after.

### F4 — keep the black-box safety net green through the remount
`install.e2e.spec.ts`, `serve.spec.ts`, `serve.singleton.spec.ts`,
`serve.telemetry-role.spec.ts`, `server.published-layout.spec.ts` drive the built
artifact as a black box and are NOT on the doomed list. They catch what
`api.surface.spec.ts` cannot (it proves the mount descriptor, not that a host can
invoke it). Keep them green across the remount.

### F5 — run `nx affected -t verify-dist-load`
Never run this session, and the published surface has changed twice.

### F6 — vocabulary gate scope: DECIDED = shipped code
Gate runs over `src/`. SPEC.md and README get rewritten to describe what backlog
IS (not what it replaced). The frozen ETL corpus JSONL fixtures and
`tools/etl/corpus-types.ts`'s literal `humanId` fixture key are EXEMPT: they are
the ETL parity gate's own reference data, `run-etl.spec.ts` already asserts
`humanId` never leaks past the boundary, and regenerating them would churn the
very fixtures that prove the ETL correct. Asked the user; no response in 60s;
proceeding on this reading and flagging it at the acceptance gate.

### F7 — DROPPED from Phase A
Old item 8 (collapse the three duplicate traversals in `resolve.ts`) is cleanup,
not acceptance, and `resolve.ts` largely dies in the wipe. Not gating 1.0.0.
