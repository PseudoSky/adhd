---
name: "Two-stage retrieve-then-rerank (coarse recall → fine, signal-rich rerank)"
topic: "cbr-patterns"
tags: ["pattern:recommended", "two-stage-retrieval", "reranking", "scalability"]
summary: "Separate recall from ranking: a cheap, high-recall coarse stage (vector KNN + BM25) returns K_recall ≈ 20-50 candidates, then an inexpensive signal-rich reranker scores them and keeps N_final ≈ 3-10. This is what keeps ranking cost independent of corpus size and recall stable as the corpus grows."
importance: 8
type: best-practice
data_quality: estimated
---

# content

name: Two-stage retrieve-then-rerank
description: A retrieval architecture with a recall-focused coarse stage followed by a precision-focused rerank stage. The coarse stage must be wide enough that the right case is in the candidate set; the rerank uses extra signals to surface it even when it is not the top vector hit.

how_it_works:
  - Stage 1 (recall): the store's hybrid (vector + BM25) search returns K_recall candidates. Recall must be maximized here — a case missing from the candidate set can never be recovered downstream.
  - Stage 2 (rerank): apply the multi-signal score (recency/importance/outcome/confidence) — or RRF across channels — to the K_recall candidates and keep the top N_final.
  - Standard fan-out ratio is ~4:1 (e.g. recall 20-50 → final 3-10). The ratio is the key knob: too narrow a recall silently loses answers; too wide wastes rerank budget.
  - ANN index reality: approximate-nearest-neighbour indexes (IVF, HNSW) trade recall for latency; IVF with nprobe tuning typically lands at 60-80% recall at scale, which is exactly why a two-stage design pairs an approximate coarse stage with an exact rerank and, when needed, query expansion to recover recall.
  - At >100k items the coarse stage is an ANN index (IVF/HNSW) and the rerank stays bounded — this is the mechanism that prevents recall degradation from growing with corpus size.

strengths:
  - Ranking cost is O(K_recall), not O(corpus) — the property that keeps recall stable as the corpus grows past 100k.
  - Decouples recall tuning (index, nprobe, query expansion) from precision tuning (signals, weights).
  - The rerank stage is where a fixed external store's limitation is worked around: the store gives candidates, the client ranks them.

weaknesses:
  - Recall ceiling is set by stage 1; no rerank can recover a candidate that was never recalled (the "false-negative cascade").
  - Two round-trips and a normalization/candidate-assembly step add latency and code.
  - If the store exposes only a fixed recall surface (no control over nprobe/K), the recall ceiling is out of the caller's hands — a real risk for an external-owned service.

references:
  - Google/industry two-stage retrieval descriptions (fetched 2026-09-25): coarse candidate generation (recall-focused) then fine-grained rerank.
  - IVF/HNSW index behaviour — Faiss; IVF recall drops to 60-80% at scale without fallback (query expansion / two-stage).
  - Chhikara et al. (2025). "Mem0" arXiv:2504.19413 — three-channel hybrid recall + channel fusion is a production instance.
source:
  - Industry retrieval architecture docs + Mem0
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - two-stage-retrieval
  - reranking
  - scalability
summary: "Coarse high-recall stage (hybrid KNN+BM25, K_recall 20-50) → bounded signal-rich rerank (N_final 3-10). Ranking cost stays O(K_recall), so recall does not degrade as the corpus grows. Stage-1 recall is the ceiling — a candidate never recalled cannot be reranked."

## Confidence
**MEDIUM** — the architecture is standard and appears across multiple industry sources and Mem0,
but the only sources read this run were secondary/blog-level plus the Mem0 citation. The
"recall cannot exceed stage-1 recall" property is **HIGH** by construction.
