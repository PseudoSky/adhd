---
name: "retriv — hybrid TS/JS code search with AST-aware chunking"
topic: "tool-catalog"
tags: ["agent:blocked", "hybrid-search", "ast-chunking", "code-search"]
summary: "Hybrid search for TS/JS projects with AST-aware chunking. 0.15.0, MIT, 427/wk. Blocked — it is a code-chunking + indexing pipeline, not a storage-decoupled ranker; it solves 'search my source tree', not 'rank cases over a fixed memory store'."
importance: 4
type: tool
data_quality: verified
---

# content

name: retriv
description: Hybrid search for TypeScript/JavaScript projects, with AST-aware chunking of source code.
features:
  - AST-aware code chunking
  - Hybrid (lexical + semantic) retrieval over the chunk index
use_cases:
  - Semantic/code search over a TypeScript or JavaScript repository
language: TypeScript
quality_signals:
  version: 0.15.0
  weekly_downloads: 427
  last_update: 2026-09 (npm 0.15.0)
  license: MIT
  repository: git+https://github.com/skilld-dev/retriv.git
data_quality: verified
metrics_source:
  version: "npm view retriv version  → 0.15.0"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/retriv  → 427 (2026-09-17..23)"
  license: "npm view retriv license  → MIT"
  repository: "npm view retriv repository.url  → git+https://github.com/skilld-dev/retriv.git"
tags:
  - agent:blocked
  - hybrid-search
  - ast-chunking
  - code-search
summary: "Hybrid TS/JS search with AST-aware chunking (427/wk). Blocked — it owns a chunking + indexing pipeline aimed at source trees; the case library stores prose episodes in a fixed external store and needs ranking, not a code index. Wrong problem."
