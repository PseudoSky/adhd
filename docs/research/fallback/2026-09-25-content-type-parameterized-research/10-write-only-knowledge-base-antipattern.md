---
name: "Write-only knowledge base / documentation rot (ANTIPATTERN — UNRESOLVED, LOW confidence)"
topic: "failure-modes"
tags: ["pattern:antipattern", "write-only", "documentation-rot", "knowledge-decay", "unresolved", "low-confidence"]
summary: "The claim that knowledge bases decay into a 'write-only' state — contributions accumulate but are never retrieved/reused, and stale entries are never corrected — is widely asserted in KM/blog literature but was NOT verifiable from a reliable source this run (Google returned empty/timeouts; the browser fetch backend was down). FLAGGED UNRESOLVED / LOW confidence. Do not treat as established."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 5
type: best-practice
data_quality: unknown
---

# content

name: Write-only knowledge base / documentation rot (UNRESOLVED)
description: STATUS: UNRESOLVED. The hypothesis that knowledge bases drift into a write-only state (many writes, few reads; stale/contradictory entries never corrected) is a common assertion in knowledge-management and blog writing, but I could not capture a primary or peer-reviewed source this run. Google returned `empty`/`timeout` on the targeted queries and the `fetch` (browser) provider failed on every call (`CDP timeout: Page.enable`), so no page could be deep-read.

claimed_mechanism:
  - Contributors add entries; nothing consumes them at read time (no retrieval-driven reuse).
  - No maintenance/expiry; stale or contradictory entries persist.
  - Search precision falls as volume grows (a C-grade blogger labels this "Retrieval Degradation").
why_it_matters:
  - Matches the caller's OBSERVED skew (1,509 tool episodes vs 62 technique episodes ≈ 24:1) — but the skew is the caller's own measurement, not an external source.
  - Conceptually adjacent to the UTILITY PROBLEM (file 08: cost without benefit) and to CBR swamping (sibling file 15: volume slows retrieval) — both of which ARE well-sourced.
weaknesses:
  - No primary/peer-reviewed source captured; surviving leads are C-grade blogs (Medium/ideabosque/shopclawmart) that assert failure modes without citations.
  - The stronger, verifiable neighbours (utility problem, swamping, lost-in-the-middle) already make the same design point; this entry adds no verified evidence beyond them.
references:
  - UNVERIFIED leads only (do NOT cite as evidence): Google snippet "Failure Mode 3: Retrieval Degradation" (shopclawmart.com blog); "The Consolidation Problem in Agent Memory" (hindsight.vectorize.io); "Agent Memory Design: Three Failure Modes and the ..." (ideabosque.com).
source:
  - Unverified blog/search snippets (Google), 2026-09-25
data_quality: unknown
tags:
  - pattern:antipattern
  - write-only
  - documentation-rot
  - knowledge-decay
  - unresolved
  - low-confidence
summary: "UNRESOLVED/LOW: the 'write-only KB / documentation rot' claim could not be verified from a reliable source this run (fetch backend down; Google empty/timeout). Only C-grade blogs surfaced. The verifiable neighbours — EBL utility problem (file 08), CBR swamping (sibling 15), lost-in-the-middle (file 09) — already carry the design point. Re-research before relying on it."

## What the source SAID vs what I INFERRED
- SAID (C-grade blog snippets, Google, 2026-09-25): "Failure Mode 3: Retrieval Degradation"; "This article maps the three failure modes that make agent memory a governance problem"; "The Consolidation Problem in Agent Memory". These are unverified blog claims.
- INFERRED: the general shape of the write-only failure and its relevance to the caller's observed 24:1 skew.
- EXPLICIT: I state plainly — *I believe the write-only-KB phenomenon is real, but I cannot verify it from my research this run.* Treat as a hypothesis.

## Confidence: LOW — UNRESOLVED
Does NOT pass the Phase 6 stopping criterion. Flagged for a follow-up run with a working fetch
backend (e.g. search ACM/IEEE/`sciencedirect` on "knowledge management system success/failure",
"IT documentation rot", "knowledge decay").

## Verdict: FLAG — REJECT for now (do not adopt on this evidence)
Do not build on this claim until sourced. Use the verified neighbours (files 08 and 09, sibling 15)
to justify the same design decisions.
