---
name: "Voyager — ever-growing skill library of executable code, retrieved by description-embedding similarity"
topic: "experience-library"
tags: ["tool-catalog", "agent:approved", "skill-library", "experience-reuse", "embedding-retrieval", "success-gated-growth"]
summary: "Voyager (Wang et al. 2023, NVIDIA) stores successful behaviours as executable code in an ever-growing skill library, each skill indexed by the embedding of its DESCRIPTION and retrieved by similarity for new tasks. Growth is gated on self-verification (only verified successes are added), so the library is not write-only. It is the canonical 'grow a reusable library from experience' system; its weakness is single-signal (pure-similarity) retrieval and no documented maintenance."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 8
type: production-implementation
data_quality: verified
---

# content

name: Voyager skill library
description: Voyager (Wang et al. 2023, arXiv:2306.00978) is an LLM-powered embodied agent in Minecraft with three modules: an automatic curriculum, an iterative prompting mechanism with execution feedback + self-verification, and a skill library. Successful behaviours are stored as executable JavaScript, indexed by the embedding of their description, and retrieved by similarity to compose into future code generation.

features:
  - "an ever-growing skill library of executable code for storing and retrieving complex behaviors, execution errors, and self-verification".
  - "Each skill is indexed by the embedding of its description, which can be retrieved in similar situations in the future."
  - Growth is gated on self-verification; only verified successful programs enter the library.
  - Transfer: the learned library is reused in a new, empty Minecraft world to solve novel tasks from scratch.
use_cases:
  - A reusable library of verified units indexed by a problem/description embedding — the "Retain" half of a case library.
  - A growth gate: add a unit only after its outcome succeeds.
language: JavaScript (generated skills); Python (agent)
quality_signals:
  arxiv_id: "2306.00978"
  venue: "arXiv preprint (NVIDIA); widely cited (~3,500+ per Google snippet)"
  project_site: "https://voyager.minedojo.org"
  sources_verified: 3
data_quality: verified
metrics_source:
  arxiv_id: "search provider arxiv query 'Generative Agents Interactive Simulacra' / google 'Voyager open-ended embodied agent skill library retrieval embedding' → arXiv:2306.00978"
  quote_skill_library: "search provider google query 'Voyager open-ended embodied agent skill library retrieval embedding' — 'an ever-growing skill library of executable code for storing and retrieving complex behaviors, execution errors, and self-verification'"
  quote_index: "search provider google query 'Voyager skill library embedding retrieval similarity indexing self-verification' — 'Each skill is indexed by the embedding of its description, which can be retrieved in similar situations in the future.'"
tags:
  - tool-catalog
  - agent:approved
  - skill-library
  - experience-reuse
  - embedding-retrieval
  - success-gated-growth
summary: "Voyager (Wang et al. 2023) grows a skill library of executable code, each skill indexed by its description embedding and retrieved by similarity; growth is gated on self-verification. The canonical 'grow a reusable library from experience' system. Weakness: single-signal retrieval and no documented maintenance/forgetting at scale."

## What the source SAID vs what I INFERRED
- SAID (arXiv:2306.00978 abstract via Google snippet): "an ever-growing skill library of executable code for storing and retrieving complex behaviors, execution errors, and self-verification".
- SAID (Voyager project page via Google snippet): "Each skill is indexed by the embedding of its description, which can be retrieved in similar situations in the future."
- SAID (arXiv abstract via Google snippet): "Voyager is able to utilize the learned skill library in a new Minecraft world to solve novel tasks from scratch, while other techniques [do not]".
- INFERRED: self-verification gates growth (the abstract lists self-verification as the third module; the library is described as holding *successful* programs).
- INFERRED: retrieval is single-signal semantic similarity, with no recency/importance/outcome weighting and no documented library-maintenance policy.

## Confidence
- Skill library + embedding-of-description retrieval + reuse in a new world: **HIGH** (arXiv abstract + project page + multiple secondary).
- "Growth gated on verified success": **MEDIUM** (stated across secondary accounts; abstract implies successful programs only).
- Absence of multi-signal ranking / maintenance: **LOW** (absence of evidence in snippets, not proof).

## Verdict: ADOPT (adapt)
Adopt: library of verified reusable units + description-embedding index + success-gated growth.
Add what Voyager lacks: the multi-signal scorer (`11-pattern-multi-signal-retrieval-scoring.md`)
and the maintenance/deletion policy (`15-pattern-case-base-maintenance.md`) from the sibling corpus.
