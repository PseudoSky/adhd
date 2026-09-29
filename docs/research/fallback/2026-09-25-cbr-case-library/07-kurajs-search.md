---
name: "@kurajs/search — portable zero-dependency BM25 retrieval engine with hybrid fusion"
topic: "tool-catalog"
tags: ["agent:blocked", "bm25", "hybrid-search", "retrieval-engine"]
summary: "Portable, zero-dependency BM25 keyword search with optional hybrid fusion, pairing with @kurajs/core's vector search. 0.1.0, MIT, 2,785/wk (the highest-adoption fusion-adjacent lib found). Blocked — it is a retrieval engine that owns its own index; the memory service here is external-owned, so only a scoring layer is usable, and the internal ranker already covers that."
importance: 5
type: tool
data_quality: verified
---

# content

name: @kurajs/search
description: Kura retrieval engine — a portable, zero-dependency BM25 keyword search with optional hybrid fusion. Pairs with @kurajs/core's vector search.
features:
  - Zero-dependency BM25 keyword index and search
  - Optional hybrid fusion with a paired vector searcher
use_cases:
  - Adding lexical BM25 retrieval to a JS/TS project without a search backend
language: TypeScript
quality_signals:
  version: 0.1.0
  weekly_downloads: 2785
  last_update: 2026-09 (npm 0.1.0)
  license: MIT
  repository: git+https://github.com/kurajs/kura.git
data_quality: verified
metrics_source:
  version: "npm view @kurajs/search version  → 0.1.0"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@kurajs/search  → 2785 (2026-09-17..23)"
  license: "npm view @kurajs/search license  → MIT"
  repository: "npm view @kurajs/search repository.url  → git+https://github.com/kurajs/kura.git"
tags:
  - agent:blocked
  - bm25
  - hybrid-search
  - retrieval-engine
summary: "Portable zero-dep BM25 engine with hybrid fusion (2,785/wk). Blocked — it builds and owns a lexical index; over a fixed external store its store-side half is unusable, and its fusion half is a subset of the internal ranker. Highest adoption in the scan, but adoption does not overcome the architectural mismatch."

# Note: the memory service already provides BM25/hybrid recall, so a second lexical
# index is redundant even setting ownership aside.
