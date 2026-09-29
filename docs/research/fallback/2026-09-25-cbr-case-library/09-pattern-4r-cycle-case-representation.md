---
name: "CBR 4R cycle + canonical case representation (problem / solution / outcome / provenance)"
topic: "cbr-patterns"
tags: ["pattern:recommended", "case-based-reasoning", "case-representation", "4r-cycle", "primary-literature"]
summary: "The canonical CBR position (Aamodt & Plaza 1994): a case is a contextualized piece of knowledge representing an experience — minimally a PROBLEM description + a SOLUTION description, cycled through Retrieve → Reuse → Revise → Retain. For a verified-retention case library the representation must add an explicit OUTCOME and PROVENANCE; classic CBR retains optimistically, so outcome verification is our deliberate strengthening."
importance: 9
type: best-practice
data_quality: estimated
---

# content

name: Canonical CBR case representation and the 4R cycle
description: The Aamodt & Plaza (1994) framework defines a case as a contextualized piece of knowledge representing an experience, and the reasoning cycle as four R's — Retrieve, Reuse, Revise, Retain. The minimum case is a problem description plus a solution description; the full record adds the outcome of applying the solution and the provenance of both.

how_it_works:
  - Retrieve: given a target problem, fetch the most similar prior cases from the case base.
  - Reuse: map the retrieved case's solution onto the new problem (adapt if needed).
  - Revise: test/repair the proposed solution in the real world — this is where an OUTCOME is produced.
  - Retain: incorporate the (now tested) case into the case base. Classic CBR retains after revision; a verified-retention policy gates Retain on a verified, successful outcome.
  - Case fields a case MUST carry for a recallable, auditable library: (1) problem/context, (2) solution, (3) outcome, (4) provenance (source episodes / links), (5) optional principle/generalization, (6) applicability/validity window.

strengths:
  - Primary, extremely well-cited framework (Aamodt & Plaza 1994, >10,000 citations) — a stable vocabulary that maps cleanly onto write-episode + link + recall.
  - Problem/solution/outcome maps to concrete fields; no custom schema is required to carry them (they fit in topic/tags/metadata/importance/summary).
  - The Revise step gives a principled place to attach the outcome-verification gate.

weaknesses:
  - Classic CBR retains cases optimistically (no verification) — the 4R cycle as published does NOT require a verified outcome; the "retained only once outcome VERIFIED" invariant is a deliberate departure from the primary literature, not something it prescribes.
  - Aamodt & Plaza is a 1994 position/methodology paper, not an implementation spec: it does not fix wire formats, and different CBR systems use different case representations (Richter's knowledge-container model, Kolodner's case-memory model).
  - Schema-on-write pressure: forcing every case to populate all fields conflicts with a schemaless store and with heterogeneous case types (see antipattern entry 19).

references:
  - Aamodt, A. & Plaza, E. (1994). "Case-Based Reasoning: Foundational Issues, Methodological Variations, and System Approaches." AI Communications 7(1):39-59. PDF: https://research.idi.ntnu.no/aiml/research/cbr/tdt55/papers/... (NTNU copy fetched 2026-09-25; >10,000 citations per Google Scholar)
  - Kolodner, J. (1993). "Case-Based Reasoning." Morgan Kaufmann.
  - Richter, M. (various). Knowledge-container model of cases.
  - Leake, D. (1996). "CBR in Context: The Present and Future."
source:
  - Aamodt & Plaza 1994 (primary)
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - case-based-reasoning
  - case-representation
  - 4r-cycle
  - primary-literature
summary: "Canonical CBR (Aamodt & Plaza 1994): case = problem + solution (+ outcome + provenance), cycled Retrieve→Reuse→Revise→Retain. Maps cleanly to write-episode + link + recall. The verified-outcome retention invariant is our deliberate strengthening — the primary literature retains optimistically."
---

## Confidence notes
- 4R cycle and "case = problem + solution": **HIGH** (Aamodt & Plaza 1994, verified citation via
  Google search 2026-09-25; canonical, >10k citations).
- Additional mandatory fields (outcome, provenance, principle): **MEDIUM** — these are standard
  CBR case components (Kolodner, Richter, Leake) but were not read from a single primary source
  this run; they are the conventional superset used by outcome-aware CBR systems.
- "Verified outcome before retention" is NOT prescribed by Aamodt & Plaza — it is the caller's
  invariant. **HIGH** that it is a departure from classic CBR (classic CBR retains after revise,
  not after verified success).

## Anti-pattern guard
Do not turn this into a schema-on-write requirement (see 19-antipattern-schema-on-write.md).
The fields are a *contract at read time*; cases may carry them in topic/tags/metadata and
heterogeneous case types need not all populate every field.
