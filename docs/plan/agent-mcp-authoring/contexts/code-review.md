# code-review — architect-reviewer gate over the full authoring diff

**Phase:** audit · **Kind:** review · **Depends on:** live-model-e2e · **Guard:** `python3 docs/plan/agent-mcp-authoring/scripts/review_gate.py`

---

## Goal

The full `authoring-design..live-model-e2e` diff has passed an independent
architect review before the final audit. An **architect-reviewer (opus)** reads
the diff against CLAUDE.md (layer/platform isolation, `@adhd/` imports,
I-prefixed interfaces, JSDoc, the "Proving features actually work" standard),
`decisions.md`, and the SPEC contracts, and verifies the load-bearing guarantees:
the back-out guarantee (every changed agent-mcp src file in the D3 manifest, the
11-tool delegation surface unchanged, no new required args on the hot path); no
`slug` on the wire; the enrichment pipeline is deterministic/idempotent;
`agent_define`/`component_define` are true upserts; and the flat `systemPrompt` is
a computed compat shim, not a competing source of truth. The reviewer writes
`review.md` with an explicit `VERDICT:` line. The default verdict is **NEEDS-WORK**
— a PASS must be explicitly justified; on NEEDS-WORK, fixes go back to the
implementation states and re-review. `review_gate.py` is exit-code gated on an
APPROVED verdict.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-authoring/review.md", "docs/plan/agent-mcp-authoring/scripts/review_gate.py"]
```

---

## Notes for executor

- **Reviewer routing is fixed: architect-reviewer at the opus tier** (see
  README.md §Reviewer routing). This plan adds a new MCP lane AND modifies
  agent-mcp src for the first sanctioned time, so the review is mandatory and
  diff-wide (`authoring-design..live-model-e2e`), not a spot check.
- **Default verdict is NEEDS-WORK.** `review_gate.py` must fail closed: it passes
  ONLY when `review.md` carries an explicit APPROVED/PASS `VERDICT:` line. A
  missing or NEEDS-WORK verdict is a red gate. A PASS must be justified in prose,
  not asserted.
- **On NEEDS-WORK, fixes return to the implementation states, then re-review** —
  do not patch around the reviewer from this state.
- **Mutates only `review.md` + `scripts/review_gate.py`** — no source, no other
  plan files. This is a review gate, not an implementation state.
