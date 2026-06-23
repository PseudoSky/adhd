# migration-design — RESOLVE THE PARSE/EQUIVALENCE/ZERO-LOSS/BOUNDARY DECISIONS + CHECK IN FIXTURES

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase architecture`

---

## Goal

Before any migration code, the four design questions are RESOLVED and recorded in
`decisions.md`, and the representative FIXTURE files are checked into the package.
After this state, every later state has a binding answer for: the parse strategy
(YAML frontmatter + markdown section splitter), the equivalence definition (byte
vs. behavioral; what normalization), the zero-loss gate contract (report shape +
the all-PASS forcing function), and the cross-repo removal boundary.

This state exists FIRST because the headline DoD (`[dod.1]` byte/behavioral
equivalence) is meaningless until "equivalent" is defined, and the removal phase
is unsafe until the gate contract + cross-repo boundary are written down.

---

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` + COPY IN the fixtures. No tool code yet.
- **Reference Pattern:** `[fix:frontmatter-mapping]`, `[fix:body-mapping]`,
  `[inv:cross-repo]`, `[inv:zero-loss-before-removal]`. SEED_DATA §0 is the
  authoritative method; this state pins the decisions it leaves open.
- **Delta Spec — `decisions.md` must answer, each with a rationale:**
  1. **Equivalence definition** — byte-equivalent vs. behaviorally-equivalent.
     Name the normalization applied before the diff (trailing whitespace, blank-
     line run collapse, frontmatter key order, `tools:` list order) and justify
     why each is sound — i.e. it cannot hide a real content loss. SEED_DATA §0
     step 7 calls the round-trip diff "the migration's correctness gate."
  2. **Parse strategy** — YAML frontmatter parser + markdown body section
     splitter; the `## heading → prompt_type` table (`[fix:body-mapping]`); how the
     un-headed opening `You are a…` paragraph maps to `role`; how `position` is
     assigned (order of appearance, 1-indexed).
  3. **Zero-loss gate contract** — the equivalence report shape (per-agent
     `PASS`/`FAIL`) and the forcing function: `retire()` MUST require an all-PASS
     report (`[inv:zero-loss-before-removal]`).
  4. **Cross-repo removal boundary** — `[inv:cross-repo]`: the in-repo
     fixtures vs. the external `~/dev/ai/claude-agents` corpus; what the guards may
     touch (fixtures only) and what is a documented operator runbook step.
- **Fixtures (`[def:fixture]`):** copy `code-reviewer.md` (canonical example) and
  one `ticket-creation.SKILL.md` into `src/__fixtures__/` and check them in.

---

## Acceptance criteria

- [migration-design.1] decisions.md exists
- [migration-design.2] equivalence definition (byte/behavioral) recorded
- [migration-design.3] zero-loss gate + cross-repo boundary recorded
- [migration-design.4] fixture agent .md checked in
- [migration-design.5] fixture SKILL.md checked in

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-migration/decisions.md", "packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md", "packages/ai/agent-registry-migration/src/__fixtures__/ticket-creation.SKILL.md"]
```

---

## Commit points

- After writing `decisions.md` + fixtures: `docs(agent-registry-migration): record migration design decisions + check in fixtures`.
- Post-guard mandatory commit recorded by `state-transition.js --complete`.

## Notes for executor

- This is a judgment state. Read SEED_DATA §0 in full, plus SCOPE.md "Systems
  Replaced" and REFERENCES.md "Superseded Systems — Removal Targets".
- Have `architect-reviewer` sign off on `decisions.md` before advancing (README
  Execution model assigns it here) — especially the equivalence normalization
  list, which is the load-bearing decision for `[dod.1]`.
- Do NOT assume you can read/delete files in `~/dev/ai/claude-agents` from this
  plan's guards (`[inv:cross-repo]`). The fixtures are the in-repo proxy.
