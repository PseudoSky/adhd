---
name: "Verified-outcome retention gate (retain only after the outcome is confirmed)"
topic: "cbr-patterns"
tags: ["pattern:recommended", "case-based-reasoning", "outcome-verification", "retention"]
summary: "Gate the RETAIN step on a verified outcome: a case enters the recallable library only once its solution's result has been confirmed. This is the caller's stated invariant and it is a deliberate strengthening of classic CBR, where retention is optimistic. Implemented as a metadata status field plus a supersession/eligibility rule, never as a write-time schema."
importance: 8
type: best-practice
data_quality: estimated
---

# content

name: Verified-outcome retention gate
description: A retention policy in which a candidate case is written to the store immediately (append-only) but is only marked RETRIEVED_ELIGIBLE once its outcome has been independently verified. Until verification, the case is retained but not rankable. Verification is a separate, auditable event.

how_it_works:
  - Write the case as an episode with an outcome-status field in metadata (e.g. `outcome: pending | verified_success | verified_failure | abandoned`).
  - A separate verification step updates the outcome status (via supersession or an explicit status mutation) when the result is confirmed by a real signal (a passing test, a downstream success, a human confirmation).
  - The read path hard-filters on eligibility: only `verified_success` (and optionally `verified_failure`, as negative cases) participate in ranking. `pending` cases are retained but excluded — this is a filter, not a down-weight (see the staleness-gate reasoning in the scoring pattern).
  - Provenance: verified cases carry a link (`DERIVED_FROM`/`SUPPORTS`) back to the verifying evidence, so the verification is auditable.

strengths:
  - Prevents unverified speculation from polluting recall — the single largest source of false-precision in a growing case base.
  - Append-only + status update preserves the full history (a later-disproven case can be superseded without deletion) — matches bitemporal/immutable-store norms.
  - Keeps ranking quality a RETRIEVE-time property: eligibility is a predicate, not an eagerly baked score.

weaknesses:
  - Requires a verification signal to exist. For many agent outcomes there is no ground truth; naive "self-reported success" verification is worthless and simply launders noise into the case base.
  - Verification latency: a case is un-retrievable until verified, so the library grows slower than the raw episode stream.
  - Status mutation under concurrent multi-process writers must be idempotent and last-writer-wins-safe; a status field can be lost-updated if two verifiers race (prefer supersession via a new episode + link over in-place mutation where the store permits).

references:
  - Aamodt & Plaza (1994) Revise/Retain (the outcome is produced in Revise; classic CBR retains after revise).
  - Leake & Wilson, "Categorizing Case-Base Maintenance" — distinguishes maintenance that improves competence from churn.
source:
  - Caller's stated invariant (retention-on-verified-outcome) + CBR revise/retain literature
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - case-based-reasoning
  - outcome-verification
  - retention
summary: "Retain immediately, but mark a case RETRIEVABLE only after its outcome is independently verified; exclude pending cases from ranking via a hard filter, not a down-weight. Strengthens classic CBR (which retains optimistically). Requires a real verification signal — self-reported success is not verification."

## Confidence
**MEDIUM** — the invariant is the caller's; the mechanism (append + status + hard read-filter)
follows from the fixed tool surface (write episode with metadata; no schema enforcement enables
a status field). The warning about self-reported success is **HIGH** by reasoning (a signal with
no independent verifier carries no information), but not read from a single primary source this run.
