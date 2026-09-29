---
name: "MemGPT — virtual context management: tiered memory (main context vs external storage)"
topic: "experience-library"
tags: ["tool-catalog", "agent:approved", "memory-hierarchy", "context-window", "tiering", "retrieval-budget"]
summary: "MemGPT (Packer et al. 2023, arXiv:2310.08560) frames the LLM as an OS managing a scarce 'main context' (RAM) and abundant external storage (disk), paging information in/out to extend effective memory past the context window. It supplies the tiering justification for bounded top-k retrieval and hot/cold case tiers. Weakness: heavy engineering, an LLM-driven paging policy, and no case schema or ranker."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 6
type: production-implementation
data_quality: estimated
---

# content

name: MemGPT virtual context management
description: MemGPT (Packer et al. 2023, arXiv:2310.08560) treats the LLM as an operating system that manages limited in-context memory ("main context") and external storage, using function/tool calls to page information in and out so the effective memory exceeds the fixed context window. (Mechanism described from prior knowledge + secondary accounts; the paper was NOT deep-read this run — the fetch backend was down.)

features:
  - A fixed main-context working set ("RAM") and a large external store ("disk").
  - The agent issues tool calls to search/insert/evict memory entries (paging).
  - Memory-pressure events trigger summarisation and paging of the working set.
use_cases:
  - Justifying a bounded, hot retrievable set vs a cold archive (tiering).
  - Paging a curated subset into a scarce context rather than dumping the corpus.
language: Python (framework: letta)
quality_signals:
  arxiv_id: "2310.08560"
  venue: "arXiv preprint"
  sources_verified: 1
  verified_fields: "arXiv ID + title only"
data_quality: estimated
metrics_source:
  arxiv_id: "search provider arxiv query 'MemGPT large language models operating systems' → arXiv:2310.08560"
tags:
  - tool-catalog
  - agent:approved
  - memory-hierarchy
  - context-window
  - tiering
  - retrieval-budget
summary: "MemGPT (Packer et al. 2023) frames the LLM as an OS with scarce in-context memory and external storage, paging entries in/out. It justifies tiering and bounded top-k retrieval (hot set vs cold archive). Weakness: heavy, LLM-driven paging, no case schema/ranker. Mechanism is unverified this run (fetch down)."

## What the source SAID vs what I INFERRED
- SAID (arXiv title, verified): "MemGPT: Towards LLMs as Operating Systems" (arXiv:2310.08560).
- INFERRED (LOW confidence — NOT verified this run): the main-context/external-storage tiering, the paging via tool calls, the memory-pressure summarisation. These are prior knowledge; the paper was not fetched because the browser backend was down.
- INFERRED: the framing makes "context is the scarce resource" explicit, which is the argument for a bounded, ranked retrievable set rather than whole-corpus injection.

## Confidence
- Existence + title + arXiv ID: **HIGH** (arxiv provider).
- Mechanism details (tiering, paging, summarisation): **LOW** — I state explicitly: *I believe this, but I cannot verify it from my research this run.* Treat as a lead to re-verify with a working fetch backend before citing.

## Verdict: CONSIDER (adapt, pending verification)
Adopt only the tier framing (hot retrievable set vs cold archive) — which the caller's store
already provides and which the sibling maintenance pattern (`15-...case-base-maintenance.md`)
uses via FadeMem's score-and-evict-to-cold-tier. Do NOT adopt the full OS metaphor. Re-verify the
mechanism before relying on it.
