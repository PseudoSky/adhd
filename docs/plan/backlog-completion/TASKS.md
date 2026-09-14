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
| C5 | S11 — wipe the old layer | todo | Deletes `client.ts`, `ops-v1.ts`, `src/v2/`. Satisfies the hard criterion: 0 references to v1/v2/migration |
| C6 | S12 — vocabulary gate | todo | |
| C7 | S13 — fresh extract + ETL + parity | todo | |
| C8 | S14 — publish + blind test of the public package | todo | |

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

- [ ] 0 references to `v1`, `v2`, or a migration anywhere in the backlog package — it is only "backlog"
- [ ] 0 sqlite dependencies, imports, or references in the backlog package
- [ ] Public package blind-tested after publish
