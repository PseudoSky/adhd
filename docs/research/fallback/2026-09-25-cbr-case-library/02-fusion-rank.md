---
name: "fusion-rank — plain Reciprocal Rank Fusion combiner"
topic: "tool-catalog"
tags: ["agent:blocked", "rrf", "rank-fusion", "typescript"]
summary: "A minimal RRF-only combiner for multiple retriever result lists. 0.5.3, MIT, 9/wk. Blocked: it implements only rank fusion (no recency, no outcome weighting, no confidence/provenance signal), and the internal @adhd/sox-hybrid-search already covers RRF with more (normalization modes, multiplicative weighting, per-channel explainability)."
importance: 5
type: tool
data_quality: verified
---

# content

name: fusion-rank
description: A JavaScript/TypeScript library that computes Reciprocal Rank Fusion across multiple retriever result lists. It is a pure rank-fusion primitive — it takes ranked id lists and returns a fused ranking.
features:
  - Reciprocal Rank Fusion over N retriever result sets (rank-only; no score-magnitude handling)
  - No storage coupling (accepts already-retrieved lists)
use_cases:
  - Fusing the output of two or more independent retrievers when only ranks are available
language: TypeScript
quality_signals:
  version: 0.5.3
  weekly_downloads: 9
  last_update: 2026-09 (npm 0.5.3)
  license: MIT
  repository: — (npm view returned no repository field)
data_quality: verified
metrics_source:
  version: "npm view fusion-rank version  → 0.5.3"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/fusion-rank  → 9 (2026-09-17..23)"
  license: "npm view fusion-rank license  → MIT"
  repository: "npm view fusion-rank repository.url  → (empty)"
tags:
  - agent:blocked
  - rrf
  - rank-fusion
  - typescript
summary: "Plain RRF-only combiner (9/wk). Blocked — it does no multi-signal scoring (no recency/outcome/provenance term) and offers strictly less than the internal @adhd/sox-hybrid-search, which is already a dependency. Integrating it would add a dependency for a subset of a capability we already own."

# Why blocked (finding, not omission)
Rank fusion is only one of the ranking signals the case library needs (RQ2 requires
recency decay + outcome success + confidence/provenance strength in addition to relevance).
`fusion-rank` implements exactly and only RRF. The internal `@adhd/sox-hybrid-search`
already implements RRF (normalized, multiplicative) plus max-score fusion, per-channel
breakdowns, and an optional cross-encoder. Adding `fusion-rank` would be a net-negative
dependency: same capability class, strictly fewer features, negligible adoption (9/wk).
