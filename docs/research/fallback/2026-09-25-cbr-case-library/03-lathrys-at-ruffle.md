---
name: "@lathrys-at/ruffle — weighted, adaptive, calibration-free multi-channel RRF (Rust/WASM/Python/TS)"
topic: "tool-catalog"
tags: ["agent:blocked", "rrf", "rank-fusion", "adaptive-weighting", "rust", "typescript"]
summary: "The most technically interesting external fusion library found: weighted, adaptive, calibration-free RRF with per-query learned channel weights, no labels, streaming persistent state, and a semantic tag per channel that refuses a model swap. 0.2.0, MIT OR Apache-2.0, 4/wk, 2 GitHub stars. Blocked on adoption + integration cost, not on design."
importance: 6
type: tool
data_quality: verified
---

# content

name: @lathrys-at/ruffle
description: A weighted, adaptive, calibration-free Reciprocal Rank Fusion engine that fuses several retrieval channels into one ranking without per-channel score calibration and without comparing raw scores across channels. It estimates, per query and without labels, how well each channel separates its top results from its bulk, how good those top results are against a declared reference, and how redundant channels are with each other, then weights the fusion from those estimates.
features:
  - Weighted RRF with per-query adaptive weights, no relevance labels and no representative query set needed
  - Accepts channels as score-based (declared Direction) or rank-only (e.g. a recency channel)
  - Redundancy ("coupling") discount between channels, off by default (independence never costs recall)
  - Persistent state is one confidence-weighted summary per channel and per channel-pair; a single merge serves as streaming update, operator prior, and reconciliation
  - Required per-channel semantic+version tag — a model swap under a kept name is REFUSED rather than silently blended
  - Every fuse carries weights used, per-channel non-standard-weight flags, discrimination readings, and two agreement diagnostics
  - Deterministic ranking independent of hash seed; TS surface via WASM (one ESM artifact for Node 20+/browser/edge), plus Rust crate and Python binding
use_cases:
  - Fusing heterogeneous retrieval channels (semantic + lexical + recency) when raw-score calibration is impossible
  - Callers who need explainable, self-tuning channel weights without ground-truth labels
language: Rust (+ TypeScript/WASM, Python bindings)
quality_signals:
  version: 0.2.0
  weekly_downloads: 4
  last_update: 2026-09 (npm 0.2.0)
  license: MIT OR Apache-2.0
  repository: https://github.com/lathrys-at/ruffle
  github_stars: 2
data_quality: verified
metrics_source:
  version: "npm view @lathrys-at/ruffle version  → 0.2.0"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@lathrys-at/ruffle  → 4 (2026-09-17..23)"
  license: "npm view @lathrys-at/ruffle license  → (MIT OR Apache-2.0)"
  repository: "npm view @lathrys-at/ruffle repository.url  → git+https://github.com/lathrys-at/ruffle.git"
  github_stars: "README badge / repo page  → 2 stars, 0 forks (fetched 2026-09-25)"
tags:
  - agent:blocked
  - rrf
  - rank-fusion
  - adaptive-weighting
  - rust
  - typescript
summary: "Weighted, adaptive, calibration-free multi-channel RRF — genuinely strong design (per-query learned weights, no labels, model-swap refusal, full explainability). Blocked: 4/wk adoption and 2 stars make it a bus-factor-1 dependency, it is Rust/WASM (heavier than the TS-native internal equivalent), and it is rank-fusion only — it does not own the recency/outcome/confidence terms the case library needs. Track it as the design reference for adaptive weighting; do not integrate."

# Status
Design is worth reading (`docs/derivation.md` covers discrimination/coupling stats, weighted RRF,
state model, validity boundaries). Blocked for integration on adoption + integration cost, not merit.
