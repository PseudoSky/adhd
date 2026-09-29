---
name: "alt-profanity-check — sklearn offensive-language classifier (MIT, 266k/mo)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, classifier, sklearn]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "alt-profanity-check (MIT, 1.9.1, ~266k/mo) is a sklearn-based offensive-language classifier — the maintained successor to profanity-check. Cheap enough to run broadly (near-lexicon speed, no transformer). Approved as the mid-tier probabilistic layer between lexicons and Detoxify; threshold-tunable."
metrics_source:
  version: "https://pypi.org/pypi/alt-profanity-check/json"
  license: "https://raw.githubusercontent.com/dimitrismistriotis/alt-profanity-check/master/LICENSE"
  downloads: "https://pypistats.org/api/packages/alt-profanity-check/recent"
---

name: alt-profanity-check
category: profanity / offensive-language classifier (cat. 4)
description: A fast, robust ML library (scikit-learn based) to classify strings as offensive/profane. The MAINTAINED drop-in replacement for the original `profanity-check` (which is stale, ~12.5k/mo). No GPU or deep-learning runtime — a lightweight sklearn model, much cheaper per text than a transformer and far cheaper than NER.
license: MIT (verified: PyPI classifier "MIT License" + LICENSE file reads "MIT License").
offline: yes. install: pip only.
cost_profile: sklearn linear model — near-regex speed; could plausibly run over ALL prose, not just candidates, unlike Detoxify. Tradeoff: lower accuracy than Detoxify; tuning the threshold trades precision/recall.
use_cases:
  - A cheap probabilistic layer between the lexicon pass and the transformer/LLM pass.
  - Flagging offensive language a wordlist misses (context-dependent insults).
evidence: pypi alt-profanity-check → 1.9.1, MIT classifier; LICENSE fetched (MIT); pypistats month 265,948 / week 71,561.
