# ADR-0002 — Correct the source, never work around a functional gap (adhd ↔ sox)

**Status:** ACCEPTED (2026-09-24). **Owner directive** — recorded as accepted, not proposed; do not re-open.
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** the general (cross-repo) form of the `AGENTS.md` §8 "Two-Use Refactor Rule"; the resolution of the `FEATURE_COMPARISON_SOX.md` **S5** class ("the loop does not close in code"); the standing answer to the finding that `agent-*` and `backlog` share no code.
**Grounding:** owner directive 2026-09-24 ("and the same for sox to adhd"); `AGENTS.md` §8 ("Two-Use Refactor Rule"); `docs/product/dispatcher-platform/ROADMAP.md` rulings **D-B** (sox's own plans/backlog are authoritative for sox's design) and **D-F** ("fix things, don't file debt"); `docs/dispatcher/FEATURE_COMPARISON_SOX.md` S5.

## TL;DR for the next agent

**When you find a functional gap across the adhd ↔ sox boundary, correct it at its source — never shim, duplicate, or work around it at the consumer.** The rule is **symmetric**: a gap in a sox package found while building adhd is fixed in the **sox** package; a gap in an adhd package found while building/depending from sox is fixed in the **adhd** package.

**But authority is not symmetric.** You may **not** unilaterally redesign sox (`ROADMAP.md` ruling **D-B**). The reconciliation (D4): you may not change the other repo's **design** unilaterally, but you **must** fix the other repo's **code** rather than work around it. Bug → fix the source's code. Design question → raise a decision request in the source repo and **fail loud** until it is ruled; do not shim in the meantime.

The trap to avoid: reading "fix things, don't file debt" (**D-F**) as licence to edit the other repo's design. It is not — D-B still governs design, D-F governs the default of fixing code rather than deferring.

## Context

**The boundary makes workarounds tempting.** adhd consumes published sox packages (the sox store adapter, graph store, embedding provider, telemetry, service proxy, and more). When a sox package falls short of what an adhd consumer needs — or vice versa — the cheap move is to shim, duplicate, or special-case at the consumer. It is fast, it lives in one repo, and it looks local. It is also how two implementations of one concern begin to drift.

**Two in-repo norms already point the other way.**
- `AGENTS.md` §8 — the **"Two-Use Refactor Rule"**: when generic, reusable logic is being written in a consumer, stop, extract it to the package that owns the concern, and import it back. The same instinct applies across the repo boundary.
- `ROADMAP.md` ruling **D-F** — **"fix things, don't file debt"**: the default is to fix, not to file and defer.

**The counter-norm that constrains them.** `ROADMAP.md` ruling **D-B** — **sox's own plans and backlog are authoritative for sox's design**; adhd docs *guessing* at sox internals have been "wrong 3-for-4." So "fix it at the source" cannot mean "edit sox's design from adhd."

**The class this ADR answers.** `FEATURE_COMPARISON_SOX.md` **S5**: `@adhd/backlog` is imported by nothing outside `entrypoint/backlog`; the work-order → dispatch → agent → verify loop closes only at `dag.json`, and the "→ backlog update" leg is 100% convention. So is `ROADMAP.md` §5.4, "the loop does not close in code." The prior finding that `agent-*` and `backlog` share no code is the same class: two halves of one loop, each implemented independently. This ADR is the **standing answer** to that class.

## Decision

### D1 — The principle

**When a functional gap is found across the adhd ↔ sox boundary, correct it AT ITS SOURCE.** Do not shim it, duplicate it, or work around it at the consumer.

### D2 — Symmetry

The rule is symmetric (owner's phrasing: *"and the same for sox to adhd"*):

- **A gap in a sox package found while building adhd → fix the sox package** (contribute upstream). Do **not** paper over it in adhd.
- **A gap in an adhd package found while building or depending from sox → fix the adhd package.** Do **not** paper over it in sox.

### D3 — Genuine gap vs. legitimate design difference

The rule must not be misused to force one repo's preference onto the other. Apply these tests **in order**:

1. **Does the source's own contract support the expectation?** If the source's spec, type, or documented contract promises the capability and it is missing or wrong → **genuine gap**: fix the source.
2. **Is the need expressible by the source's documented extension point?** If the source deliberately supports extension (e.g. `sox ADR-0010`'s open `kind`/`rel` vocabulary, a typed config field, a capability slot) → **use the extension point**; do not fork.
3. **Is the difference a recorded decision?** If the source's choice is documented (an ADR, a spec citation in the code) → it is a **legitimate design difference**, and the answer is a *decision request*, not a "fix."

**Precedent for the trap.** `renewClaimNode` was classified by the comparison as `FAILURE-MODE+INVARIANT-VIOLATION`, but the function carries its own spec citation — *"SPEC.md §5.3 — always succeeds (bumps claimedAt), no contention check, ever"* — and the code's own spec outranks the label (`ROADMAP.md` §5.6). That was a **design question**, not a bug. Reading it as a gap to "fix" would have been the rule misused.

### D4 — Designing authority vs. code-fix obligation (resolves **D-B** vs. **D-F**)

**You may not change the other repo's DESIGN unilaterally. You MUST fix the other repo's CODE rather than work around it.** These are not in tension once separated by *what kind of change* is needed:

- **The fix is a bug** — the source's code contradicts the source's *own* spec/contract. → **Fix the source's code**, citing the spec. No design authority is needed; the design already says so. (This is what D-F governs.)
- **The fix would change the source's design** — no spec supports the desired behavior; it is new behavior. → **Do not invent it.** Raise a **decision request** in the source repo (an ADR proposal, or a backlog item in the source repo's authoritative backlog per D-B), and **fail loud** at the consumer until it is ruled.
- **In neither case** do you shim at the consumer.

**D-B is not weakened:** you still do not guess at sox internals and you still do not unilaterally redesign sox. **D-F is not weakened:** the default is to fix, and filing is permitted **only** for the genuine design-question case above — and even then the item is filed in the **source** repo's backlog, never used to justify a workaround.

### D5 — Escalation path when the two repos' owners disagree

Named parties: the **adhd owner** and the **sox owner** (both pseudosky today; the path must survive a split).

1. **File the gap with evidence in the source repo's authoritative backlog.** A sox gap → sox's backlog (per D-B); an adhd gap → adhd's backlog. Include a reproduction and the source's own contract as evidence.
2. **If it is a design question, propose an ADR in the source repo's catalog** — sox gaps → the sox catalog; adhd gaps → this catalog (see [README](./README.md)).
3. **The two owners resolve it.** The source repo's owner holds the veto on the source repo's own design (D-B).
4. **Until it is resolved, the consumer MAY NOT ship a workaround.** It degrades or errors **loudly**, naming the open item — never silently shims, never silently falls back.

### D6 — Relationship to "file debt"

**D-F ("fix things, don't file debt") is the default.** Filing is permitted **only** for the cross-repo design-question case in D4, and then only in the **source** repo's backlog. Filing is never a substitute for fixing code that contradicts the source's own spec.

## Consequences

- **Standing answer to the S5 class.** "The loop does not close in code" (`FEATURE_COMPARISON_SOX.md` S5; `ROADMAP.md` §5.4) is **not** resolved by convention-glue, nor by a shim, nor by duplicating backlog's readiness logic inside dispatch/agent. Closing the loop means correcting the **source** side (e.g. backlog's programmatic read API) and **consuming** it — `ROADMAP.md` §6 **A2** ("Close the loop — dispatch reads work from F1 and writes status back"). The prior finding that `agent-*` and `backlog` share no code is the same class and takes the same remedy.
- **`AGENTS.md` §8 gains a cross-repo form.** The "Two-Use Refactor Rule" trigger fires across the repo boundary: a second consumer needing the same logic is a signal to fix/extract at the source, not to copy.
- **Cost, accepted.** You may have to work in the other repo, coordinate publishing and versions, and wait on a ruling. That cost is smaller than the divergence debt the alternative creates.
- **No silent divergence.** The failure mode this prevents — two drifting implementations of one concern, one per repo — is exactly the failure S5 names.

## Alternatives considered

- **Shim / duplicate at the consumer.** **Rejected.** Produces two implementations that drift; violates `AGENTS.md` §8 and D-F; it is the pattern S5 documents.
- **"Fix it in whichever repo is faster to edit."** **Rejected.** Erases design authority — it lets adhd edit sox's design (D-B) or vice versa.
- **File-and-defer without fixing.** **Rejected as the default.** Retained **only** for the genuine design-question case (D4/D6), and only in the source repo's backlog.
- **Edit the source's design directly from the consumer repo.** **Rejected.** D-B: the source repo's owner is authoritative over the source's design.

## What does NOT change

- **D-B stands** — you still do not guess at sox internals or unilaterally redesign sox.
- **D-A stands** — sox owns all RAG/embedding/vector work; this ADR does not move that boundary.
- **The authoritative-backlog split stands** — sox's plans/backlog remain authoritative for sox; adhd's for adhd (`sox ADR-0011` governs `@adhd/backlog`'s write destination).
- **`ROADMAP.md`'s evidence standard stands** — absence claims require proof that no call site can exist; a severity label is an opinion about code, and the code's own spec outranks it (§5.6).
- **`sox ADR-0013` and `adhd ADR-0001`** are untouched by this ADR.

## References

- Owner directive, 2026-09-24 — "correct the source … and the same for sox to adhd."
- `AGENTS.md` §8 — "Two-Use Refactor Rule."
- `docs/product/dispatcher-platform/ROADMAP.md` — rulings **D-B** and **D-F**; §5.4 ("the loop does not close in code"); §5.6 (`renewClaimNode` spec-vs-label); §6 **A2**.
- `docs/dispatcher/FEATURE_COMPARISON_SOX.md` — finding **S5** ("Backlog is a data island; the integration loop does not close in code").
- `sox ADR-0010` (open node/edge typing — the extension-point precedent) — `sox-ecosystem/docs/decisions/0010-open-node-and-edge-typing.md`.
- `sox ADR-0011` (backlog tool write destination) — `sox-ecosystem/docs/decisions/0011-backlog-tool-write-destination.md`.
