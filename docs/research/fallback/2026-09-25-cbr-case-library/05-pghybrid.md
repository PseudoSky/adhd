---
name: "pghybrid — vector + full-text + RRF on Postgres/pgvector"
topic: "tool-catalog"
tags: ["agent:blocked", "rrf", "postgres", "pgvector", "hybrid-search"]
summary: "Hybrid search (vector + full-text + RRF) over plain pgvector Postgres with no extensions to install. 0.1.4, MIT, 3/wk. Blocked: it is a Postgres store integration, not a client-side ranker, and the memory service is external-owned and fixed."
importance: 4
type: tool
data_quality: verified
---

# content

name: pghybrid
description: Hybrid search on a Postgres database you already run. Combines vector similarity (pgvector), full-text search, and Reciprocal Rank Fusion, with no extra extensions to install.
features:
  - Vector + full-text retrievers fused by RRF
  - Runs on plain pgvector Postgres
use_cases:
  - Adding hybrid retrieval to an application already persisting data in Postgres
language: TypeScript/JavaScript
quality_signals:
  version: 0.1.4
  weekly_downloads: 3
  last_update: 2026-09 (npm 0.1.4)
  license: MIT
  repository: git+https://github.com/pavangupta352/pghybrid.git
data_quality: verified
metrics_source:
  version: "npm view pghybrid version  → 0.1.4"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/pghybrid  → 3 (2026-09-17..23)"
  license: "npm view pghybrid license  → MIT"
  repository: "npm view pghybrid repository.url  → git+https://github.com/pavangupta352/pghybrid.git"
tags:
  - agent:blocked
  - rrf
  - postgres
  - pgvector
  - hybrid-search
summary: "Vector + full-text + RRF on pgvector Postgres. Blocked — it couples ranking to a Postgres/pgvector store, and the memory service is external-owned with a fixed surface; adopting it would require migrating the store. Solves 'add hybrid search to my Postgres' — a different problem from 'rank cases over a fixed external memory service'."

# Why blocked (finding, not omission)
The value in pghybrid is the *store-side* query plan (one SQL query, no extra extensions).
The store here is fixed and external-owned, so the store-side half is unusable and the
remaining fusion half is a strict subset of the internal `@adhd/sox-hybrid-search`.
