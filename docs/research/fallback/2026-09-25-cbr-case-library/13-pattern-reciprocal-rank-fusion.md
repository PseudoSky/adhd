---
name: "Reciprocal Rank Fusion (RRF) — rank-based, scale-free channel fusion"
topic: "cbr-patterns"
tags: ["pattern:recommended", "rrf", "rank-fusion", "hybrid-retrieval"]
summary: "RRF (Cormack, Clarke & Buettcher, SIGIR 2009) fuses multiple ranked result lists by summing reciprocal ranks: score(d) = Σ_q 1/(k + rank_q(d)), with k a ranking constant defaulting to 60. It needs no score calibration and no tuning, which is why it is the default fusion primitive when channels' raw scores live on different scales. Variants: weighted RRF (per-channel weight), adaptive RRF with per-query IDF weighting (vstash)."
importance: 9
type: best-practice
data_quality: verified
---

# content

name: Reciprocal Rank Fusion (RRF)
description: A rank-fusion method for combining multiple result sets that have different (uncalibrated) relevance indicators into one ranking. Because it uses ranks, not raw scores, it is invariant to per-channel score scale.

how_it_works:
  - score(d) = Σ over queries/q of 1 / (k + rank(result(q), d)), where rank starts at 1 and k is a ranking constant.
  - k defaults to 60 in Cormack et al. and in Elasticsearch's `rrf` retriever's `rank_constant`. A higher k gives lower-ranked documents more influence; k must be ≥ 1.
  - `rank_window_size` bounds how many documents per channel participate (defaults to the result `size`); it is the fusion-stage analogue of K_recall and it must stay fixed for stable pagination.
  - RRF requires ≥ 2 child retrievers; it needs no score normalization and no weight tuning to beat either channel alone.
  - Weighted variant: score(d) = Σ_c w_c · 1/(k + rank_c(d)). Adaptive variant (vstash): per-query IDF weighting of the lexical channel improved NDCG@10 on all 5 BEIR datasets vs fixed weights (up to +21.4% on ArguAna).

strengths:
  - Scale-free: combines BM25 (unbounded) and cosine ([0,1]) with no calibration — the exact situation for a vector+BM25 memory store.
  - No tuning required; robust default (k=60); deterministic; cheap.
  - Trivially extensible to more channels (a recency channel or an outcome channel can be a "retriever").
  - Has a real production implementation in Elasticsearch and a known-good academic provenance.

weaknesses:
  - Ignore score magnitudes entirely: a channel that is confidently right and a channel that is barely-guessing contribute the same weight when both rank something #1. Weighted RRF mitigates; plain RRF does not.
  - The one free parameter (k) still changes results; setting k too low over-weights top ranks and can be brittle.
  - Ranks alone cannot express "this channel is untrustworthy for this query" — hence adaptive weighting (Ruffle, vstash) exists, at the cost of state and complexity.
  - Careful: vstash found that adding POST-RRF terms (frequency+decay, rerank) did NOT improve NDCG — so RRF plus a tuned additive blend is not automatically better than RRF alone; validate.

references:
  - Cormack, G.V., Clarke, C.L.A., Buettcher, S. (2009). "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods." SIGIR 2009. PDF: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf (retrieved 2026-09-25; PDF body not machine-parsed — formula and k=60 confirmed via Elasticsearch docs).
  - Elasticsearch RRF reference: https://www.elastic.co/guide/en/elasticsearch/reference/current/rrf.html (formula, rank_constant default 60, rank_window_size, worked example — fetched 2026-09-25).
  - vstash (2026), arXiv:2604.15484 (adaptive RRF + per-query IDF).
source:
  - Elasticsearch RRF docs (verified formula) + Cormack et al. 2009 (primary origin)
data_quality: verified
type: best-practice
tags:
  - pattern:recommended
  - rrf
  - rank-fusion
  - hybrid-retrieval
summary: "RRF: score(d) = Σ 1/(k + rank(d)), k=60 default. Scale-free, no calibration, no tuning; the default fusion for a vector+BM25 store. Variants: weighted RRF, adaptive per-query IDF (vstash). Weakness: magnitudes are ignored; and vstash's negative result warns that post-RRF additive terms may not help."
---

## Confidence
- Formula and k=60 default: **HIGH** — Elasticsearch's official reference states the algorithm in
  code, supplies a worked numeric example, and links the primary Cormack et al. 2009 paper.
- Primary paper itself: **MEDIUM** — the PDF was retrieved (URL live) but not parsed; the
  formula is attributed to it by a second, independent, authoritative source (Elastic).
