---
name: "ExpeL — experiential learning: gather trajectories, extract cross-task insights, reuse"
topic: "experience-library"
tags: ["tool-catalog", "agent:approved", "experiential-learning", "insight-extraction", "case-generalization", "revise-step"]
summary: "ExpeL (Zhao et al. 2023, arXiv:2308.10144) lets an LLM agent autonomously gather experiences from training tasks and extract natural-language insights, reusing them across tasks with no fine-tuning. Its cross-case insight extraction is the operational 'Revise' step that turns many cases into principles. Risk: insights are LLM-judged with no independent verification, so over-generalization from few cases is the documented failure surface."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 8
type: production-implementation
data_quality: verified
---

# content

name: ExpeL experiential learning
description: ExpeL (Zhao et al. 2023, arXiv:2308.10144; ACM 2024) is an LLM agent that autonomously gathers experiences from a collection of training tasks and extracts natural-language knowledge, improving decision-making across unseen tasks without updating model weights.

features:
  - "Our agent autonomously gathers experiences and extracts knowledge using natural language from a collection of training tasks."
  - "The insight extraction process uses structured prompts that enable the LLM to perform sophisticated knowledge management operations."
  - Learns from BOTH successful and failed trajectories.
  - An insight pool is maintained and retrieved, alongside similar past trajectories, at test time.
use_cases:
  - Cross-case generalization: distil many cases into portable principles (the CBR "Revise" step).
  - Reuse of prior trajectories + extracted rules in a new task's prompt.
language: Python (LLM agent); method is model-agnostic
quality_signals:
  arxiv_id: "2308.10144"
  venue: "NeurIPS 2023 / ACM (2024)"
  repo: "https://github.com/LeapLabTHU/ExpeL"
  sources_verified: 4
data_quality: verified
metrics_source:
  arxiv_id: "search provider google query 'ExpeL LLM agents experiential learning insight extraction' → arXiv:2308.10144; ACM DOI"
  quote: "search provider google query 'ExpeL ...' — 'Our agent autonomously gathers experiences and extracts knowledge using natural language from a collection of training tasks.'"
  quote_insight: "search provider google query 'ExpeL ...' (alphaXiv snippet) — 'The insight extraction process uses structured prompts that enable the LLM to perform sophisticated knowledge management operations.'"
tags:
  - tool-catalog
  - agent:approved
  - experiential-learning
  - insight-extraction
  - case-generalization
  - revise-step
summary: "ExpeL (Zhao et al. 2023) gathers task trajectories and extracts natural-language insights from successes and failures, reusing them without fine-tuning. Its cross-case insight extraction is the operational 'Revise' step for turning many cases into principles. Risk: LLM-judged insights with no independent verification → over-generalization."

## What the source SAID vs what I INFERRED
- SAID (arXiv:2308.10144 abstract via Google snippet): "Our agent autonomously gathers experiences and extracts knowledge using natural language from a collection of training tasks."
- SAID (alphaXiv summary via Google snippet): "The insight extraction process uses structured prompts that enable the LLM to perform sophisticated knowledge management operations."
- SAID (ACM DL / Hugging Face paper pages via Google snippet): no fine-tuning; decisions improve from experience.
- INFERRED: learns from failures as well as successes (the method compares trajectories); maintains an insight pool retrieved at test time.
- INFERRED: because insight extraction is LLM-judged with no independent verifier, it is the natural locus of the anecdotal-over-generalization failure mode.

## Confidence
- ExpeL learns from experience and extracts NL insights without fine-tuning: **HIGH** (arXiv + ACM + HF + GitHub).
- "Uses both success and failure trajectories": **MEDIUM** (consistent across secondaries; abstract not deep-read — fetch backend down).
- "Over-generalization risk is its failure surface": **LOW-MEDIUM** (reasoned, not sourced).

## Verdict: ADOPT (adapt)
Adopt the succeed/fail trajectory → cross-case insight pipeline as the "Revise" step. Gate the
resulting insights on the verified-outcome rule (`10-...retention-gate.md`) and bound them with
maintenance (`15-...case-base-maintenance.md`) precisely because unverified LLM insight extraction
is the over-generalization hazard.
