---
name: "Supersession exclusion — a superseded record must be filtered out BEFORE ranking, not down-weighted"
topic: "cbr-patterns"
tags: ["pattern:recommended", "supersession", "deduplication", "internal-prior-art", "ranking"]
summary: "When a record is superseded (edited/contradicted), the stale row must be excluded from the ranked candidate set entirely — a hard predicate, pushed into the retrieval filter — never merely down-weighted. We already hit and fixed exactly this defect internally: a superseded row stayed rankable and `view:'similar'` returned the same logical issue twice."
importance: 9
type: best-practice
data_quality: verified
---

# content

name: Supersession exclusion (filter stale rows before ranking)
description: A pattern for continuously-growing knowledge bases: superseded records (frozen pre-edit copies, contradicted facts) must be excluded from ranking by a hard filter applied before scoring, because a down-weight can be overwhelmed by other signals and a superseded row's text often most resembles the query that would surface it.

how_it_works:
  - Never physically delete on edit/supersede: mark the old row invalid/superseded and write the successor (or a `supersedes` pointer). Preserves history + auditability.
  - The read path applies `isSuperseded: false` (or equivalent) as a hard predicate pushed into the store filter — the same predicate every other read path uses.
  - CRITICAL: the ranking path must apply the same predicate. A ranked search that filters only on `{kind}` (and not supersession) will rank the stale copy alongside the live one, and the stale copy frequently OUTRANKS the live one because its text is what the anchor query resembles.
  - Where the ranker is a separate package with a different filter contract (no `isSuperseded` member), the caller must narrow candidates by id before ranking (a `dropSupersededResults` step) — the pattern is "exclude, then rank", not "rank, then exclude".
  - Generalization: this is the staleness-gate principle — explicit-validity records that fail the check are FILTERED, not down-weighted, because a down-weighted stale record can still surface above a fresh one.

strengths:
  - Correctness: one logical entity appears exactly once in a result set.
  - Cheap: a predicate, not a scoring term.
  - Robust: immune to the down-weight-overwhelmed problem that a soft penalty suffers.

weaknesses:
  - Requires the supersession predicate to be threaded through EVERY read/rank path; missing one path reintroduces the bug (this is exactly how the internal defect occurred — one rank path used a different filter contract).
  - Under concurrent writers, two successors can be created for the same predecessor if the supersede operation is not serialized — needs a deterministic winner or a content-hash key.
  - Filter pushdown is store-dependent; if the external store cannot express the predicate, candidate-id narrowing is required, which has its own list-size limits.

references:
  - Internal: `entrypoint/backlog/src/query/superseded-ranking.spec.ts` (the defect and the fix); `query/views/semantic.ts` `rankByFusedRelevance` / `dropSupersededResults`; `@adhd/sox-hybrid-search` `StoreSearchBackend` filter contract.
  - Mem0 (arXiv 2504.19413): DELETE semantics = mark old INVALID + write new with a supersedes pointer.
source:
  - Internal repository prior art (verified) + Mem0
data_quality: verified
type: best-practice
tags:
  - pattern:recommended
  - supersession
  - deduplication
  - internal-prior-art
  - ranking
summary: "Exclude superseded rows with a hard predicate BEFORE ranking; never down-weight them. We already hit this exact defect: a superseded row stayed rankable via a rank path using a different filter contract and outranked its live successor. 'Exclude, then rank' — threaded through every read/rank path."
---

## Evidence (verified in-repo)
`entrypoint/backlog/src/query/superseded-ranking.spec.ts` documents that
`rankByFusedRelevance` handed its filter to `@adhd/sox-hybrid-search`'s `StoreSearchBackend`,
which has no `isSuperseded` member, so the rank path filtered on `{kind:'issue'}` alone and a
superseded row stayed rankable forever — `view:'similar'` returned the same logical issue twice.
The fix is `dropSupersededResults` in `query/views/semantic.ts`. **HIGH confidence** (read directly).

## Concurrency note
Supersession under multiple writers is the same read-compare-write hazard as the conflict
resolver (entry 14): needs idempotency/content-hash dedupe or a serialization primitive.
