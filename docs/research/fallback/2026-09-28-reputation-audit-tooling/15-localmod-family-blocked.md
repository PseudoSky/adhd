---
name: "LocalMod / LPTE / ToxiScan — self-hosted moderation tools (BLOCKED: unvetted)"
topic: tool-catalog
tags: [agent:blocked, tool, moderation, toxicity, unvetted]
project_path: /Users/nix/dev/ai/scratch
importance: 4
source: tool_output
data_quality: unknown
summary: "LocalMod (KOKOSde/syntax-syndicate), LPTE (Local Profanity & Toxicity Engine), and ToxiScan are recent self-hosted/offline content-moderation projects. Blocked as a first choice: no verifiable registry metrics, no license confirmation, single-author blogs/LinkedIn posts as the only evidence — LOW confidence, do not adopt without an independent audit."
metrics_source:
  evidence: "DDG surface only — dev.to, LinkedIn, personal blogs. No npm/PyPI registry entry or confirmed license."
---

name: LocalMod / LPTE / ToxiScan (self-hosted moderation family)
category: content-moderation suites (cat. 4, and partly cat. 1)
description: A cluster of recent 2025–2026 "fully offline / self-hosted content moderation" projects found via search. LocalMod is a text+image moderation API; LPTE is a "Local Profanity & Toxicity Engine"; ToxiScan is a compact multi-label toxicity classifier.
why_blocked: evidence is single-source (blog posts, LinkedIn) with no registry metrics, no pinned version, and no confirmed license. Confidence is LOW — these are not safe to depend on without an independent source review. The underlying capability (multi-label toxicity) is already covered by Detoxify (Apache-2.0, verified) and the lexicon layer.
note: revisit only if one surfaces on a registry (npm/PyPI) with a real license and usage; the space is active.
evidence: DDG search "offline open source content moderation toxicity classifier self-hosted" returned dev.to/knowlab/LinkedIn only; no registry presence found.
