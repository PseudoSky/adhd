# ADR-NNNN — <short imperative title>

**Status:** PROPOSED · ACCEPTED (YYYY-MM-DD). · SUPERSEDED BY adhd ADR-NNNN (YYYY-MM-DD) for <scope>.
**Owner:** <owner>.
**Supersedes:** adhd ADR-NNNN (scope) · nothing.
**Drives:** <backlog items / findings / bugs this settles — human-readable ids>.
**Grounding:** <owner directive verbatim if any; specs; incidents; file:line evidence>.

<!-- ADRs are settled decisions, not proposals. Do not write an ACCEPTED ADR without the
     owner's explicit approval. Every cross-repo ADR reference is repo-qualified: `sox ADR-NNNN`
     or `adhd ADR-NNNN` — never a bare `ADR-NNNN` (see README.md). -->

## TL;DR for the next agent

<2–6 sentences. What is decided, what the next agent must do or stop doing, and the one trap to
avoid. This is the highest-value section — include it whenever the decision changes how future
work is done.>

## Context

<The situation, with evidence (file:line, incidents, measured numbers — not adjectives). State
the constraint that forces a decision. State plainly what is NOT established, so no reader assumes
more than is true.>

## Decision

### D1 — <decision>

<One decision per subsection. Each must be falsifiable and implementable. Name files, packages,
symbols.>

### D2 — <decision>

## Consequences

- **<obligation that must survive>** — <why; what breaks if this is dropped. Obligations discovered
  while making the decision are carried here, never discarded.>

## Alternatives considered

- **<alternative>** — <why it was considered, and REJECTED / DEFERRED. A prior review's verdict is
  preserved honestly here, not erased, even when this ADR overrides it.>

## What does NOT change

<Explicit scope fence: which prior decisions, packages, or behaviours this ADR leaves untouched.
Name the adjacent decision this ADR does NOT make, so implementers do not conflate the two.>

## References

- <owner directive — dated, verbatim where possible>
- <specs, ADRs (repo-qualified: `adhd ADR-NNNN` / `sox ADR-NNNN`), file:line>
