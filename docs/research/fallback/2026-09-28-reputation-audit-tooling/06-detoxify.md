---
name: "Detoxify — offline multi-label toxicity classifier (Apache-2.0)"
topic: tool-catalog
tags: [agent:approved, tool, toxicity, bad-language, classifier, offline]
project_path: /Users/nix/dev/ai/scratch
importance: 7
source: tool_output
data_quality: verified
summary: "Detoxify (Apache-2.0, 0.5.2, ~67k/mo) is an offline PyTorch multi-label toxicity classifier (toxic/hate/threat/insult/obscene). Approved as the SECOND-STAGE toxicity gate over candidates only — its per-chunk transformer cost is the same class as NER, but its binary-per-text FP profile is far more tunable than NER's entity explosion. Perspective API is BLOCKED (network-only)."
metrics_source:
  version_summary: "https://pypi.org/pypi/detoxify/json"
  license: "https://raw.githubusercontent.com/unitaryai/detoxify/master/LICENSE"
  downloads: "https://pypistats.org/api/packages/detoxify/recent"
---

name: Detoxify (unitaryai)
category: toxicity classifier (cat. 4, semantic)
description: A collection of pre-trained PyTorch models for detecting toxic comments (Jigsaw Toxic Comment challenges). Outputs MULTIPLE labels — toxic, severe_toxic, obscene, threat, insult, identity_hate — so it distinguishes profanity from abuse/threats, which a lexicon cannot.
license: Apache-2.0 (verified from LICENSE file + PyPI classifier "Apache Software License").
offline: yes — a local model (transformers + PyTorch); no API. NOT Perspective API (that requires Google network calls and is disqualified by the offline constraint).
cost_profile: per-chunk inference like any transformer — the same shape of cost that made Presidio/spaCy ~92s/repo on the measured repo; must be a CANDIDATE-ONLY second stage, never the all-repo gate. Binary-ish per text, so FP profile is a THRESHOLD-tuning problem, not an entity explosion — materially better precision behaviour than NER.
use_cases:
  - Second-stage toxicity check over prose/docs/commit messages that a lexicon pass flagged or that a sampled pass selected.
  - Distinguishing "unprofessional but not abusive" from genuinely toxic content.
evidence: pypi detoxify → 0.5.2, Apache Software License classifier; LICENSE fetched (Apache 2.0); pypistats month 66,735 / week 13,906.
