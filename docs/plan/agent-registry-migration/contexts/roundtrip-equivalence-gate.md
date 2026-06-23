# roundtrip-equivalence-gate — STATE_NAME

**Phase:** verify · **Kind:** work · **Depends on:** import-pipeline, skills-migration · **Guard:** `true`

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
mutates:    ["packages/ai/agent-registry-migration/src/verify/equivalence-gate.ts", "packages/ai/agent-registry-migration/src/verify/normalize.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
