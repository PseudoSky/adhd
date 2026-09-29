---
name: "@adhd/sox-hybrid-search — self-authored hybrid retrieval ranker (decoupled from storage)"
topic: "tool-catalog"
tags: ["agent:approved", "rrf", "hybrid-retrieval", "rank-fusion", "typescript", "internal-prior-art"]
summary: "WE already authored this: a storage-decoupled hybrid ranker fusing vector + BM25 with normalized RRF / max-score multiplicative fusion, per-channel explainability (fuseWithBreakdown), an optional MS-MARCO cross-encoder reranker, and an unconditional degrade signal. 0.4.9, MIT, 129/wk. Approved as the retrieval+ranking layer to build the case library on — it is client-side, so it does not modify the external-owned memory service."
importance: 9
type: tool
data_quality: verified
---

# content

name: @adhd/sox-hybrid-search
description: A self-authored (sox-ecosystem) hybrid retrieval ranker. BM25 text + vector KNN over a `VectorBackend` + `GraphBackend`; normalizes each channel then fuses with RRF / max-score. Crucially the ranking logic is decoupled from storage (mechanism-agnostic `textScore`/`vecScore`), so it can rank results from a fixed external store without modifying that store.

features:
  - SearchBackend / SearchQuery / SearchResult contract — backends report `textScore`/`vecScore`, never `bm25`/`cosine` in the type surface; degrades to text-only or vec-only when a signal is absent, never errors on a missing signal
  - normalize() + fuse() — pure, storage-free; normalize via min_max / L2 / z_score, then combine textScore+vecScore with MULTIPLICATIVE (never additive / scale-blind) weights, normalized BEFORE combining
  - fuseWithBreakdown() + FusionBreakdown — same math, returns per-channel (bm25 / vec / total) contributions per result; a separate exported function (not gated behind a flag)
  - topicBoost() — post-fusion multiplicative boost; exact topic match 2x, substring 1.5x; TOPIC_BOOST_FLOOR (BL-437) floors a literal-zero fused score to 0.1 so the last-place candidate is not structurally unrankable
  - createCrossEncoder() / CrossEncoder — a real ONNX sequence-classification cross-encoder (Xenova/ms-marco-MiniLM-L-6-v2, q8), opt-in, proxies through the single process-wide shared ONNX worker
  - Degrade signal (SearchDegradeInfo) — any unsupported filter is surfaced unconditionally as `result.degraded`, never silently dropped
  - buildFilterClause() / buildNodeFilterClause — filter → NodeFilter pushdown, shared with the store layer

use_cases:
  - A client-side, retrieval-time ranking layer for a CBR case library over a fixed external memory store (vector + BM25 + recency/outcome re-ranking)
  - Per-channel explainability for why a case ranked where it did (fuseWithBreakdown)
  - Filter-parity: scope the vector channel identically to the text channel so unfiltered hits never leak

language: TypeScript
quality_signals:
  version: 0.4.9
  weekly_downloads: 129
  last_update: 2026-09 (npm 0.4.9)
  license: MIT
  repository: git+https://github.com/PseudoSky/adhd.git
  source_repo: "~/dev/ai/sox-ecosystem (changesets-managed — the source of truth; this repo consumes the published package)"
  docs_url: https://github.com/PseudoSky/adhd
data_quality: verified
metrics_source:
  version: "npm view @adhd/sox-hybrid-search version  → 0.4.9"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@adhd/sox-hybrid-search  → 129 (2026-09-17..23)"
  license: "npm view @adhd/sox-hybrid-search license  → MIT"
  repository: "npm view @adhd/sox-hybrid-search repository.url  → git+https://github.com/PseudoSky/adhd.git"
  capability_detail: "docs/sox/CAPABILITY-CATALOG.md §2.5 (lines 231-251), 418; CHANGELOG.md:187; pnpm-lock.yaml:1576"
tags:
  - agent:approved
  - rrf
  - hybrid-retrieval
  - rank-fusion
  - typescript
  - internal-prior-art
summary: "Internal prior art: @adhd/sox-hybrid-search already fuses BM25 + vector with normalized RRF / max-score multiplicative weights, per-channel explainability, an opt-in cross-encoder, and an unconditional degrade signal — and its ranking logic is decoupled from storage, so it can rank a fixed external store without modifying it. 0.4.9, MIT, 129/wk. Approved as the retrieval+ranking layer; this is a REUSE, not a build."

# Governance note
This is a WE-AUTHORED package (`@adhd/sox-hybrid-search`, repo PseudoSky/adhd) that this
repo already depends on (`pnpm-lock.yaml:1576`, pinned 0.4.6). It is client-side: it consumes
a `VectorBackend` + `GraphBackend` and produces a ranking. Using it does **not** modify the
external-owned memory service. See `docs/sox/CAPABILITY-CATALOG.md` §2.5 and the
`FEAT-SOX-VECTOR-STORE-FILTERED-KNN-001` entry in `CHANGELOG.md:187`.
