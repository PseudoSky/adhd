---
name: "Use case: vstash — local-first hybrid retrieval with adaptive RRF (and a negative result on extra ranking terms)"
topic: "cbr-use-cases"
tags: ["use-case:reference", "vstash", "adaptive-rrf", "idf-weighting", "negative-result", "scale"]
summary: "vstash (arXiv 2604.15484) is a single-SQLite-file hybrid retrieval system (sqlite-vec ANN + FTS5) using RRF with adaptive per-query IDF weighting. Two findings matter: (1) adaptive RRF beat fixed weights on all 5 BEIR datasets, and (2) post-RRF extra scoring terms (frequency+decay, history-augmented recall, cross-encoder rerank) did NOT improve NDCG. Search latency 20.9 ms median at 50K chunks with stable NDCG."
importance: 8
type: production-implementation
data_quality: verified
---

# content

name: vstash local-first adaptive RRF
description: A local-first document memory system for LLM agents that combines vector similarity (sqlite-vec ANN) with full-text keyword matching (FTS5) via RRF, with adaptive per-query IDF weighting of the fusion. It reports a rare measured negative result on adding post-RRF ranking terms.

context: All data lives in a single SQLite file (sqlite-vec for ANN + FTS5 for keyword). Evaluated across 5 BEIR datasets and 50,425 relevance-judged queries.

approach:
  - Two channels: vector ANN (sqlite-vec) + lexical (FTS5 BM25), fused with RRF.
  - Adaptive RRF with per-query IDF weighting of the lexical channel — improved NDCG@10 on ALL 5 BEIR datasets vs fixed weights (up to +21.4% on ArguAna), 0.7263 on SciFact with BGE-small.
  - Self-supervised embedding refinement from vector-vs-lexical top-10 disagreement (74.5% of queries disagree at top-10 across 3 datasets) — a label-free training signal.
  - NEGATIVE RESULT: post-RRF scoring with frequency+decay, history-augmented recall, and cross-encoder reranking all FAILED to improve NDCG.
  - Production substrate: integrity checking, schema versioning, ranking diagnostics, distance-based relevance signal.
  - Scale: 20.9 ms median search latency at 50K chunks with stable NDCG.

key_takeaway: (a) At 50K chunks, hybrid RRF with adaptive weighting holds NDCG and keeps latency in the tens of ms — evidence recall does not have to degrade with corpus growth when the ranking stage stays bounded. (b) Adaptive per-query weighting outperforms fixed weights. (c) The measured negative result is the single best argument for the "no ranking signal without a consumer/measurement" rule — even plausible extra terms can be worthless.

source: Steffens, J. (2026). "vstash: Local-First Hybrid Retrieval with Adaptive Fusion for LLM Agents." arXiv:2604.15484 (submitted 16 Apr 2026). https://arxiv.org/abs/2604.15484
data_quality: verified
type: production-implementation
tags:
  - use-case:reference
  - vstash
  - adaptive-rrf
  - idf-weighting
  - negative-result
  - scale
summary: "vstash: sqlite-vec + FTS5 fused by RRF with adaptive per-query IDF weighting — beat fixed weights on all 5 BEIR datasets; 20.9 ms median at 50K chunks. Key negative result: post-RRF frequency+decay, history-augmented recall, and cross-encoder rerank all FAILED to improve NDCG. Validates both adaptive weighting and 'measure every ranking term'."
---

## Confidence
**HIGH** — read directly from the primary abstract (arXiv 2604.15484, fetched 2026-09-25); the
adaptive-RRF gain, the negative result, and the 20.9 ms @ 50K figure are stated explicitly.
