---
name: "Anti-pattern: eagerly materialized ranking (scoring at write time)"
topic: "cbr-antipatterns"
tags: ["pattern:antipattern", "ranking", "retrieval-time", "eager-materialization"]
summary: "Computing and storing a composite ranking score at write time is an anti-pattern for a growing corpus: the score is stale the moment any contributing signal changes (a retrieval, a supersession, a decay), and it cannot incorporate query-time signals at all. Ranking quality is a RETRIEVE-time property."
importance: 7
type: best-practice
data_quality: estimated
---

# content

name: Anti-pattern — eagerly materialized ranking (score-at-write)
description: Persisting a composite relevance/quality score as a stored field (baked ranking) instead of computing rank at retrieval time. The caller's second invariant explicitly forbids this: ranking quality is computed at RETRIEVE time, never eagerly at write time.

how_it_works (the anti-pattern):
  - On write, compute score = f(importance, recency-so-far, ...) and store it as a field.
  - On read, sort by the stored score.

why_it_fails:
  - Recency is a function of NOW and of LAST-RETRIEVED; a stored value goes stale with every passing hour and is not updated by reads (LRU refresh becomes impossible or requires rewriting every row).
  - A supersession, a merge, or an outcome-verification event invalidates the stored score for the changed record and, in MMR/diversity schemes, for its neighbours.
  - Query-time signals (query embedding similarity, temporal-intent) are unknowable at write time, so the stored score cannot represent them.
  - It front-loads cost and couples write latency to ranking complexity; every weight change requires a full backfill over the corpus — the O(N) operation the two-stage design exists to avoid.
  - At scale the backfill becomes the dominant cost and the stored score is guaranteed to be at least one backfill behind reality.

what_to_do_instead:
  - Store raw signals (importance, last_read, retrieval_count, outcome status, provenance links) as facts.
  - Compute the composite score at retrieval time over a bounded recalled candidate set (see entries 11, 12).
  - If per-record read-state (last_read/retrieval_count) must persist, update the minimal state on the top-N retrieved records only — bounded, not a full-corpus rewrite.

strengths: (none — this is an anti-pattern entry)
weaknesses:
  - Note the nuance: it is legitimate to store SIGNALS eagerly (importance is set at write time by design in Park et al.). The anti-pattern is storing the COMBINED ranking, not the raw inputs.

references:
  - Park et al. (2023) arXiv:2304.03442 — importance is a write-time signal, but the combined retrieval score is computed at read time.
  - vstash (2026) arXiv:2604.15484 — retrieval computed at query time; only the substrate (index) is materialized.
source:
  - Caller's stated invariant (rank at retrieve time) + scoring pattern (entry 11)
data_quality: estimated
type: best-practice
tags:
  - pattern:antipattern
  - ranking
  - retrieval-time
  - eager-materialization
summary: "Storing a combined ranking score at write time goes stale (recency/LRU/supersession/query-time signals cannot be captured), forces O(N) weight-change backfills, and couples write latency to ranking. Store RAW signals; compute the composite at retrieve time over a bounded candidate set."
