---
name: "trufflehog — secret scanner (AGPL-3.0, BLOCKED: license + network)"
topic: tool-catalog
tags: [agent:blocked, tool, secrets, license-flag, agpl]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "trufflehog is a capable secret scanner whose differentiator is LIVE credential verification (it calls provider APIs to confirm a secret is active). Blocked on two independent grounds: it is AGPL-3.0 (copyleft-incompatible with shipping inside a product) and its verification path makes NETWORK calls, violating the offline constraint. gitleaks (MIT, offline) is the approved substitute."
metrics_source:
  license_and_behaviour: "multiple 2026 comparison sources (rafter.so, agenticaisecured.com, appsecsanta.com) — AGPL-3.0, live verification via provider APIs"
---

name: trufflehog
category: secrets (cat. 5, bonus)
description: Open-source secret scanner (Go) that scans git history, S3, Docker images, etc., and uniquely VERIFIES whether a found credential is live by calling the provider's API.
license: AGPL-3.0 (FLAG — copyleft-restrictive; not license-safe to ship inside a product).
offline: NO for the verification feature (network calls to providers). The scan itself can run locally but the differentiator can't.
why_blocked: (1) AGPL-3.0 is outside the MIT/Apache/BSD preference and is explicitly a FLAG; (2) live verification requires network, violating the local/offline constraint. Its one advantage over gitleaks — confirming a secret is active — is exactly the part that can't run offline.
note: for a PUBLIC-repo reputation audit the value of "is this key still live" is low (public repos should be assumed scraped); gitleaks reports candidates, which is sufficient.
evidence: DDG results across 5 independent 2026 comparisons consistently report AGPL-3.0 + live verification calls.
