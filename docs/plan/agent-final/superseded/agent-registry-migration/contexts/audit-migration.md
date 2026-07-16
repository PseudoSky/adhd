# audit-migration — HOLD POINT: PROVE THE MIGRATION TOOL IS CORRECT BEFORE REMOVAL

**Phase:** audit · **Kind:** audit · **Depends on:** roundtrip-equivalence-gate · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase migration`

---

## Goal

The migration tool is proven correct — parse → import (persisted after reopen) →
round-trip equivalence (with teeth) — BEFORE the removal phase is allowed to touch
anything. `removal-runbook` depends on this audit, so removal cannot start until
the tool is verified. This is the zero-data-loss firewall.

---

## Semantic Distillation

- **Primitive:** RUN `audit_migration.py --phase migration`. It runs the
  architecture checks plus every parse/import/verify work-state criterion,
  including the round-trip negative control (`[roundtrip-equivalence-gate.4]`).
- No `[dod.N]` checks here (those are the final phase). This audit confirms the
  TOOL is sound; the final audit confirms the OUTCOMES.

---

## Acceptance criteria

- [audit-migration.1] migration-phase audit self-consistent

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-migration/scripts/audit_migration.py"]
```

---

## Commit points

- `chore(agent-registry-migration): migration-phase audit green — tool verified`

## Notes for executor

- This audit is the forcing function for `[inv:zero-loss-before-removal]` at the
  PLAN level: `removal-runbook` depends on it in the DAG, so a red migration audit
  blocks the entire removal phase.
- The round-trip negative control must BITE here — if `[roundtrip-equivalence-gate.4]`
  passes while the round-trip test is broken, the gate proves nothing.
