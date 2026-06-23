# removal-runbook — STATE_NAME

**Phase:** removal · **Kind:** work · **Depends on:** roundtrip-equivalence-gate, audit-migration · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

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
mutates:    ["packages/ai/agent-registry-migration/src/removal/retire.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts", "docs/plan/agent-registry-migration/RUNBOOK.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
