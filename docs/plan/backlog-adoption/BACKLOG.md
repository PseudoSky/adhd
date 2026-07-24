# backlog-adoption — plan backlog

Plan-scoped index of backlog items discovered while designing/executing the
`backlog-adoption` migration (`MIGRATION.md`). Each ID here is the authoritative
entry in the repo-root `BACKLOG.md`; this file is the plan cross-reference
mandated by the disclosure standard ("append the IDs to `docs/plan/<plan>/BACKLOG.md`").

## Phase-3 (write-path cut-over) blockers — ALL RESOLVED 2026-07-24 (gate clear)

Source of truth for the gate: `MIGRATION.md` §5 (Prerequisites / blockers). All four rows
below are now RESOLVED in the repo-root `BACKLOG.md` and moved to `CHANGELOG.md` per the
disclosure standard — see CHANGELOG.md's "`@adhd/backlog` Phase-3 migration gate" entry
(2026-07-24) for the fix + verification detail on each.

| ID | Gates | Resolution |
|---|---|---|
| `DEBT-BACKLOG-CI-NODE22-001` | Phase 3 | RESOLVED — `ci.yml`/`pull-request.yml` `test` job pin Node 22; regression-guarded by `ci-node-version.spec.ts`. |
| `DEBT-BACKLOG-CONTENT-HASH-COLLISION-001` | Phase 3 | RESOLVED — verified the shipped uniqueness-marker mitigation fully closes the collision; existing regression test's teeth confirmed via negative control. |
| `DEBT-BACKLOG-CONTENT-IMMUTABLE-001` | Phase 3 | RESOLVED — `updateItemNode` re-syncs `node.content`/`content_hash` via raw SQL on title/body edit; FTS `grep` now finds post-edit terms. |
| `DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001` | Phase 3 (at 20+ agent scale) | RESOLVED — bounded jittered-backoff retry (`withImmediateRetry`) on every `.immediate()` write + configurable `busy_timeout` (`db.busyTimeoutMs`/`ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS`); proven via real `worker_threads` `SQLITE_BUSY` contention test. |

## Phase-4 (nice-to-have / new scope)

| ID | Gates | Note |
|---|---|---|
| `DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001` | Phase 4 | `auditTrail` derives history from durable fields, not a full event log |
| `migration.phase` signal | Phase 4 | new *feature* scope (skill migration-state signal); not yet filed as a separate root item |

## Explicitly NOT a blocker

| ID | Note |
|---|---|
| `FEAT-BACKLOG-RAG-ADOPT-FILTERED-KNN-001` | FTS/symbol dedup is sufficient for cut-over; RAG is an enhancement |

> **Gate clear (2026-07-24):** all four Phase-3-gating rows above are RESOLVED in the
> repo-root `BACKLOG.md` (moved to `CHANGELOG.md` per the disclosure standard) — Phase 3
> may proceed as far as this gate is concerned.

## Discovered executing Phase 1 (seed import) — session 2026-07-24

Not Phase-3 blockers (Phases 1-2 are read-only against markdown, per §5); filed
for tool-robustness/data-hygiene follow-up. Root-BACKLOG.md is authoritative;
rows below are the plan cross-reference.

| ID | Gates | Root-BACKLOG anchor |
|---|---|---|
| `DEBT-BACKLOG-IMPORT-SILENT-DROP-001` | none (tool robustness) | RESOLVED 2026-07-24 — root `BACKLOG.md` → `CHANGELOG.md`. `parseBacklogMarkdownWithDiagnostics` surfaces a malformed-id header via `ImportResult.malformedHeaders`; never a silent drop. |
| `DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001` | none (previously worked around via a post-import `attachToPlan` pass — workaround no longer needed) | RESOLVED 2026-07-24 — root `BACKLOG.md` → `CHANGELOG.md`. `ImportMarkdownInput` gains `plan`/`sourcePath`; `importFromMarkdown` attaches the plan and records provenance directly. |
| `DEBT-BACKLOG-DUPLICATE-ID-INSOURCE-001` | Phase 3 (should resolve before markdown files become generated projections) | OPEN — root `BACKLOG.md` (`FEAT-WORKSPACE-001` and `BUG-APIGEN-031` each reused as two distinct headers within one source file, pre-dating this migration). Markdown-hygiene defect needing HUMAN triage, deliberately not tool-fixed. |
