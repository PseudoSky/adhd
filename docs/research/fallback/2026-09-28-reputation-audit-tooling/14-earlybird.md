---
name: "EarlyBird — repo PII/secrets/weak-crypto scanner (Apache-2.0, Go)"
topic: tool-catalog
tags: [agent:approved, tool, pii, secrets, go, offline]
project_path: /Users/nix/dev/ai/scratch
importance: 5
source: tool_output
data_quality: verified
summary: "EarlyBird (American Express, Apache-2.0, Go) is an offline repo scanner for PII, secrets, and weak-crypto patterns driven by YAML rules. It is an optional complementary layer in the repo-hygiene-kit; its YAML-rule model is configurable/allowlistable and it needs no Python ML stack."
metrics_source:
  github_api: "https://api.github.com/repos/americanexpress/earlybird"
---

name: earlybird
category: PII + secrets + weak-crypto repo scanner (cat. 1/2/5)
description: Go CLI from American Express that scans a repository/codebase for PII, secrets, and weak-cryptography signatures using YAML rule definitions.
license: Apache-2.0. offline: yes (no network, no ML runtime). stars: 772. last push: 2026-05-26 (maintained).
role: optional complementary layer in repo-hygiene-kit/audit (the kit already lists it as "optional earlybird", toggled by AUDIT_EARLYBIRD_CMD).
why_useful: a second, independently-maintained rule set over the same tree catches things a single tool's rules miss, at negligible cost; YAML rules are easy to extend and allowlist.
evidence: GitHub API americanexpress/earlybird → license Apache-2.0, 772 stars, pushed 2026-05-26; kit README lists it as optional.
