---
name: "Use case: Generative Agents memory stream (recency + importance + relevance retrieval)"
topic: "cbr-use-cases"
tags: ["use-case:reference", "generative-agents", "memory-stream", "retrieval", "reflection"]
summary: "Park et al. 2023 instantiate an agent memory as an append-only 'memory stream' of natural-language observations, synthesize higher-level REFLECTIONS over time, and retrieve a small subset by a combined recency+importance+relevance score to plan behavior. It is the canonical production-shaped example of retrieve-time multi-signal ranking over a growing episodic store."
importance: 8
type: production-implementation
data_quality: estimated
---

# content

name: Generative Agents memory stream
description: Park et al. (2023) build 25 agents that store a complete record of experience as natural-language observations (a "memory stream"), periodically synthesize those into higher-level reflections, and dynamically retrieve memories to plan behavior. Ablations show observation, planning, and reflection each contribute critically.

context: The memory is an append-only stream of timestamped natural-language records. A retrieval function selects a small subset for the current planning context; reflections are themselves records derived from lower-level observations.

approach:
  - Store a complete record of experiences as natural-language episodes (append-only stream).
  - Synthesize higher-level "reflections" over time from the raw observations — a consolidation/generalization layer above the episodic records.
  - Retrieve dynamically with the §A.1 function: score = α·recency + β·importance + γ·similarity; equal weights; recency = exponential decay (0.995/hr) over time since LAST RETRIEVED; importance = normalized LLM-assigned salience; similarity = query embedding similarity.
  - Read-driven updates: retrieval advances last-retrieved time (LRU) and can boost salience.
  - Ablation: removing observation, planning, or reflection each degrades believability — the memory architecture is load-bearing, not incidental.

key_takeaway: A growing episodic store plus a retrieve-time multi-signal score plus a reflection/consolidation layer is a proven architecture. It maps directly onto the target: write episodes (observations), derive reflections (principle/generalization cases via DERIVED_FROM links), and rank at retrieval with recall + recency + importance (+ our outcome/confidence terms).

source: Park, J.S., O'Brien, J.C., Cai, C.J., Morris, M.R., Liang, P., Bernstein, M.S. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." arXiv:2304.03442 (submitted 7 Apr 2023, revised 6 Aug 2023). https://arxiv.org/abs/2304.03442
data_quality: estimated
type: production-implementation
tags:
  - use-case:reference
  - generative-agents
  - memory-stream
  - retrieval
  - reflection
summary: "Park et al. 2023: append-only natural-language memory stream + periodic reflections + retrieve-time score α·recency+β·importance+γ·similarity (0.995/hr decay over last-retrieved). Proven by ablation. Maps to write-episode + DERIVED_FROM reflections + retrieve-time ranking."
---

## Confidence
- Paper existence, authors, abstract, and the observation/planning/reflection ablation: **HIGH**
  (read from the primary arXiv abstract page 2026-09-25).
- The exact §A.1 formula and 0.995/hr constant: **MEDIUM** (via a specific secondary account
  citing §A.1; the primary abstract does not contain the formula).
