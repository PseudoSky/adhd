---
name: "Reflexion — verbal reflection stored in an episodic buffer keyed on outcome feedback"
topic: "experience-library"
tags: ["tool-catalog", "agent:approved", "episodic-memory", "outcome-signal", "retention-gate", "reflection"]
summary: "Reflexion (Shinn et al. 2023, arXiv:2303.11366) has agents verbally reflect on task feedback (the outcome signal) and keep reflective text in an episodic memory buffer to improve later trials. It is the cleanest prior-art case of OUTCOME driving retention — the empirical basis for gating a library on verified success. Weakness: the buffer is per-task and self-generated, with no cross-task library, ranking, or maintenance."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 7
type: production-implementation
data_quality: verified
---

# content

name: Reflexion episodic memory
description: Reflexion (Shinn et al. 2023, arXiv:2303.11366) reinforces language agents verbally: instead of weight updates, the agent reflects on task feedback signals and stores reflective text in an episodic memory buffer that conditions subsequent attempts.

features:
  - "Reflexion agents verbally reflect on task feedback signals, then maintain their own reflective text in an episodic memory buffer to induce better decision-making in subsequent trials."
  - The outcome/failure signal ("task feedback") determines what is reflected and kept.
  - No model-weight updates; learning is entirely in the stored text.
use_cases:
  - Outcome-keyed retention: keep a lesson only relative to a success/failure signal.
  - Self-improvement loop where the retained artefact is inspectable natural language.
language: Python (LLM agent)
quality_signals:
  arxiv_id: "2303.11366"
  venue: "NeurIPS 2023; openreview, ACM DL"
  sources_verified: 4
data_quality: verified
metrics_source:
  arxiv_id: "search provider arxiv query 'Reflexion language agents verbal reinforcement learning' → arXiv:2303.11366; google → arXiv abs"
  quote: "search provider google query 'Reflexion language agents verbal reinforcement episodic memory' — 'Reflexion agents verbally reflect on task feedback signals, then maintain their own reflective text in an episodic memory buffer to induce better decision-making in subsequent trials.'"
tags:
  - tool-catalog
  - agent:approved
  - episodic-memory
  - outcome-signal
  - retention-gate
  - reflection
summary: "Reflexion (Shinn et al. 2023) reflects verbally on task feedback and keeps reflective text in an episodic buffer to improve later trials. The cleanest prior-art case of outcome driving retention — basis for a verified-success gate. But it is per-task, self-generated, and lacks a cross-task library, ranking, or maintenance."

## What the source SAID vs what I INFERRED
- SAID (arXiv:2303.11366 / OpenReview PDF via Google snippet): "Reflexion agents verbally reflect on task feedback signals, then maintain their own reflective text in an episodic memory buffer to induce better decision-making in subsequent trials."
- INFERRED: "task feedback signals" is the outcome/success-failure signal and thus the retention driver.
- INFERRED: the buffer is episodic (per-task retry scope), not a long-term cross-task ranked library with maintenance — so it does not by itself solve library growth.

## Confidence
- Reflection on feedback → episodic buffer → better subsequent trials: **HIGH** (arXiv + OpenReview + ACM + Princeton page).
- "Outcome drives retention": **HIGH** by direct reading of the quoted sentence.
- "No cross-task library / ranking / maintenance": **MEDIUM** (scope of the paper as described; absence of evidence).

## Verdict: ADOPT (adapt)
Take the outcome-driven retention principle (it is what justifies the caller's verified-outcome
gate — sibling `10-...retention-gate.md`) but EXTEND beyond Reflexion's per-task buffer into a
cross-task, ranked, maintained library. Do not adopt the buffer scope as sufficient.
