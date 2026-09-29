---
name: "gitleaks — secret scanner (MIT, APPROVED — already integrated)"
topic: tool-catalog
tags: [agent:approved, tool, secrets, mit, offline]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "gitleaks (MIT) is the approved offline secret scanner — already the credentials layer in the repo-hygiene-kit. Fast (sub-second on diffs), ~150 rules, custom .gitleaks.toml, and an allowlist/baseline system that is the documented FP-reduction lever. Use `gitleaks git --log-opts=--all` for full history and scan only the git-tracked tree for the working copy."
metrics_source:
  allowlists_docs: "https://deepwiki.com/gitleaks/gitleaks/4.4-allowlists-and-baselines"
  rule_system: "https://deepwiki.com/gitleaks/gitleaks/4-rule-system"
  tuning: "https://devopsaitoolkit.com/blog/gitleaks-tuning-precision/"
---

name: gitleaks
category: secrets (cat. 5, bonus)
description: MIT-licensed Go secret scanner; the credentials layer already wired into repo-hygiene-kit/audit (gitleaks dir over the git-tracked tree + gitleaks git for history).
license: MIT. offline: yes.
precision_features:
  - allowlists by regex, path, commit, and content; baselines to focus on new findings only.
  - Rules specify regex + keywords + entropy thresholds; custom organization rules in .gitleaks.toml.
  - Higher precision than trufflehog for offline use; no network needed.
operational_notes (measured by the kit):
  - `gitleaks dir` CRAWLS THE FILESYSTEM — scope to the git-tracked tree (`git archive HEAD | tar -x`) or it sweeps untracked/generated content (382 FPs observed).
  - 8.30.1 used in the prior PseudoSky audit (`git --log-opts=--all`).
evidence: kit README + prior audit episodes; DDG confirms MIT + allowlist/baseline system across multiple 2026 sources.
