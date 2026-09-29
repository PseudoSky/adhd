---
name: "neo4j-agent-memory — Neo4j-backed agent memory with case-based reasoning"
topic: "tool-catalog"
tags: ["agent:blocked", "case-based-reasoning", "neo4j", "agent-memory", "graph-store"]
summary: "The only npm package found that actually advertises case-based reasoning (symptoms → similar cases → fixes) plus negative memories and hybrid retrieval. 0.5.0, 0/wk, no license field. Blocked by the hard constraint: it IS a store (Neo4j), and the memory service here is external-owned and cannot be modified or replaced."
importance: 6
type: tool
data_quality: verified
---

# content

name: neo4j-agent-memory
description: A Neo4j-backed memory system for AI agents, exposing semantic / procedural / episodic memory kinds, case-based reasoning (symptoms → similar cases → fixes), "negative memories" ("do not do"), environment fingerprints for precision, and hybrid retrieval. It is the closest published package to the target use case in shape.
features:
  - Case-based reasoning over a graph store (symptoms → similar cases → fixes)
  - Negative memories ("do not do") — a first-class record for failures
  - Semantic / procedural / episodic memory kinds
  - Environment fingerprints for retrieval precision
  - Hybrid retrieval returning a combined result set
use_cases:
  - A CBR case library where cases are stored as graph nodes and retrieved by symptom similarity
language: TypeScript
quality_signals:
  version: 0.5.0
  weekly_downloads: 0
  last_update: 2026-09 (npm 0.5.0)
  license: — (npm view returned no license field)
  repository: git+https://github.com/emmett08/neo4j-agent-memory-demo.git
data_quality: verified
metrics_source:
  version: "npm view neo4j-agent-memory version  → 0.5.0"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/neo4j-agent-memory  → 0 (2026-09-17..23)"
  license: "npm view neo4j-agent-memory license  → (empty)"
  repository: "npm view neo4j-agent-memory repository.url  → git+https://github.com/emmett08/neo4j-agent-memory-demo.git"
tags:
  - agent:blocked
  - case-based-reasoning
  - neo4j
  - agent-memory
  - graph-store
summary: "The only package that advertises CBR (symptoms → similar cases → fixes) + negative memories + hybrid retrieval. Blocked on the external-owned-store constraint: it requires Neo4j and owns the persistence/retrieval stack — adopting it would replace the memory service, which is out of scope. Blocked, but its record shape (case kinds + negative memories + fingerprint) is a useful design reference."

# Why blocked (finding, not omission)
The one hard constraint is that the memory service is EXTERNAL-OWNED and the store cannot be
modified or swapped. `neo4j-agent-memory` is not a client-side ranking layer: it is a
Neo4j-backed store whose retrieval and persistence are its own. Integrating it would mean
standing up a second store and abandoning the fixed surface — explicitly out of scope.
Dowloads are 0/wk; the repo is a "demo". Track the *record model* (kinds + negative memories
+ environment fingerprint), not the package.
