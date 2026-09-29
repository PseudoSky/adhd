---
name: "@myceliumhq/index — local-first sqlite-vec semantic index with incremental content-hash sync + RRF"
topic: "tool-catalog"
tags: ["agent:blocked", "rrf", "sqlite-vec", "local-first", "semantic-index"]
summary: "Local-first semantic index: sqlite-vec vector store, incremental content-hash sync, and hybrid lexical/semantic search fused by RRF. 1.1.1, MIT, 31/wk. Blocked — it owns its own sqlite index/ingest path, which conflicts with the external-owned fixed store."
importance: 4
type: tool
data_quality: verified
---

# content

name: @myceliumhq/index
description: A local-first semantic index combining a sqlite-vec vector store, incremental content-hash-based sync, and hybrid lexical/semantic search fused via Reciprocal Rank Fusion.
features:
  - sqlite-vec vector store
  - Incremental content-hash sync (re-index only changed content)
  - Hybrid lexical + semantic search fused by RRF
use_cases:
  - Local-first document/code semantic search with incremental reindexing
language: TypeScript
quality_signals:
  version: 1.1.1
  weekly_downloads: 31
  last_update: 2026-09 (npm 1.1.1)
  license: MIT
  repository: git+https://github.com/myceliumhq/toolkit.git
data_quality: verified
metrics_source:
  version: "npm view @myceliumhq/index version  → 1.1.1"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@myceliumhq/index  → 31 (2026-09-17..23)"
  license: "npm view @myceliumhq/index license  → MIT"
  repository: "npm view @myceliumhq/index repository.url  → git+https://github.com/myceliumhq/toolkit.git"
tags:
  - agent:blocked
  - rrf
  - sqlite-vec
  - local-first
  - semantic-index
summary: "Local-first sqlite-vec index with content-hash sync + RRF hybrid search. Blocked — its value is in owning the index, ingest, and sync path; the memory service here is external-owned with its own ingest and store, so adopting it would duplicate/replace the store. Its content-hash incremental sync is a useful reference for the dedup/near-dup maintenance question (RQ4)."

# Subsequent in the same registry scan: @myceliumhq/index has a look-alike fork
# `@transmitt0r/mycelium-index` (0.0.0) — noted, not catalogued.
