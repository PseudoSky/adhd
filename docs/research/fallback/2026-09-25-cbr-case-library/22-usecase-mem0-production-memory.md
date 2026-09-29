---
name: "Use case: Mem0 production long-term memory (3-channel hybrid recall + ADD/UPDATE/DELETE/NOOP resolver)"
topic: "cbr-use-cases"
tags: ["use-case:reference", "mem0", "hybrid-recall", "conflict-resolution", "production-memory"]
summary: "Mem0 (Chhikara et al., ECAI 2025) is the production reference for a scalable long-term memory: three-channel hybrid recall (semantic + BM25 + entity graph) with channel fusion, plus a write-time ADD/UPDATE/DELETE/NOOP conflict resolver. Reported LOCOMO numbers: ~91% lower p95 latency and ~90% less token cost vs full-context, ~26% better than OpenAI's memory baseline."
importance: 8
type: production-implementation
data_quality: estimated
---

# content

name: Mem0 production long-term memory
description: A production-ready agent long-term memory with a three-channel hybrid recall (semantic embeddings + BM25 + entity graph) whose channels are fused, and a write-path conflict resolver (ADD/UPDATE/DELETE/NOOP). It is the strongest published evidence that channel fusion beats single-channel recall.

context: Facts are stored and kept consistent by a per-write LLM classifier that compares the candidate against the top-K nearest existing facts. Retrieval runs three channels and fuses them.

approach:
  - Write path: fetch top-K (≈5-10) nearest existing facts; classify candidate as ADD / UPDATE / DELETE / NOOP; DELETE = mark old INVALID + write new with a `supersedes` pointer (non-destructive).
  - Retrieval path: three channels — semantic (embeddings), lexical (BM25), and an entity graph — fused into one ranking.
  - Consolidation: a periodic background pass runs the resolver over category-level pairs, catching contradictions the per-write top-K retrieval missed (reported 5-10% additional per pass).
  - Reported results (LOCOMO benchmark): ~91% lower p95 latency and ~90% token-cost reduction vs full-context baselines; ~26% improvement over OpenAI's memory baseline on LLM-as-judge. Contradiction-resolver accuracy holds to ~30% contradiction density.

key_takeaway: Hybrid recall (semantic + lexical + graph) with fusion IS the production architecture, and write-time conflict resolution (INVALIDATE+supersedes, never physical delete) is the proven way to keep a growing KB consistent. Both map onto the fixed tool surface: three-channel recall exists; the resolver's DELETE semantics map to supersession links.

source: Chhikara, P. et al. (2025). "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." ECAI 2025. arXiv:2504.19413. (Read via a secondary survey this run; primary arXiv ID recorded.)
data_quality: estimated
type: production-implementation
tags:
  - use-case:reference
  - mem0
  - hybrid-recall
  - conflict-resolution
  - production-memory
summary: "Mem0: 3-channel hybrid recall (semantic+BM25+entity graph) with fusion + write-time ADD/UPDATE/DELETE/NOOP resolver (DELETE=INVALIDATE+supersedes). ~91% lower p95 latency, ~90% less token cost vs full-context. Production evidence that channel fusion + write-time conflict resolution is the proven architecture."
---

## Confidence
- Architecture and benchmark claims: **MEDIUM** — read via a specific secondary survey citing
  Mem0 §3; the primary arXiv abstract was not fetched this run. The arXiv ID (2504.19413) and
  venue (ECAI 2025) are recorded for verification.
