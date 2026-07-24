# backlog-adoption — plan backlog

Plan-scoped index of backlog items discovered while designing/executing the
`backlog-adoption` migration (`MIGRATION.md`). Each ID here is the authoritative
entry in the repo-root `BACKLOG.md`; this file is the plan cross-reference
mandated by the disclosure standard ("append the IDs to `docs/plan/<plan>/BACKLOG.md`").

## Phase-3 (write-path cut-over) blockers — must all be RESOLVED before cut-over

Source of truth for the gate: `MIGRATION.md` §5 (Prerequisites / blockers).

| ID | Gates | Root-BACKLOG anchor |
|---|---|---|
| `DEBT-BACKLOG-CI-NODE22-001` | Phase 3 | root `BACKLOG.md` (tool needs Node ≥22; CI pinned to Node 20) |
| `DEBT-BACKLOG-CONTENT-HASH-COLLISION-001` | Phase 3 | root `BACKLOG.md` (dedupe merges distinct items with identical normalized title+body) |
| `DEBT-BACKLOG-CONTENT-IMMUTABLE-001` | Phase 3 | root `BACKLOG.md` (`updateItem` can't refresh FTS content after a title/body edit) |
| `DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001` | Phase 3 (at 20+ agent scale) | root `BACKLOG.md` (no bounded retry/backoff on `SQLITE_BUSY`; `busy_timeout` unconfigurable) |

## Phase-4 (nice-to-have / new scope)

| ID | Gates | Note |
|---|---|---|
| `DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001` | Phase 4 | `auditTrail` derives history from durable fields, not a full event log |
| `migration.phase` signal | Phase 4 | new *feature* scope (skill migration-state signal); not yet filed as a separate root item |

## Explicitly NOT a blocker

| ID | Note |
|---|---|
| `FEAT-BACKLOG-RAG-ADOPT-FILTERED-KNN-001` | FTS/symbol dedup is sufficient for cut-over; RAG is an enhancement |

> Do not begin Phase 3 until every Phase-3-gating row above is RESOLVED in the
> repo-root `BACKLOG.md` (and moved to `CHANGELOG.md` per the disclosure standard).

## Discovered executing Phase 1 (seed import) — session 2026-07-24

Not Phase-3 blockers (Phases 1-2 are read-only against markdown, per §5); filed
for tool-robustness/data-hygiene follow-up. Root-BACKLOG.md is authoritative;
rows below are the plan cross-reference.

| ID | Gates | Root-BACKLOG anchor |
|---|---|---|
| `DEBT-BACKLOG-IMPORT-SILENT-DROP-001` | none (tool robustness) | root `BACKLOG.md` (a malformed-ID header is silently dropped on import with zero diagnostic — violates this plan's own Phase-1 negative-control DoD) |
| `DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001` | none (worked around this session via a post-import `attachToPlan` pass) | root `BACKLOG.md` (`ImportMarkdownInput` has no `plan`/`sourcePath` field, though §2.2/§1-step-3 assume both) |
| `DEBT-BACKLOG-DUPLICATE-ID-INSOURCE-001` | Phase 3 (should resolve before markdown files become generated projections) | root `BACKLOG.md` (`FEAT-WORKSPACE-001` and `BUG-APIGEN-031` each reused as two distinct headers within one source file, pre-dating this migration) |
