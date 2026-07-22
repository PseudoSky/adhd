# conformance-vectors — STATE_NAME

**Phase:** v2-packaging · **Kind:** work · **Depends on:** central-validation, layer-harness, canonical-descriptor, scaffold-v2-common · **Guard:** `npx --yes nx test apigen-conformance`

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
mutates:    ["packages/apigen/conformance/src/lib/vectors.ts", "packages/apigen/conformance/project.json"]
```

---

## Notes for executor

SPEC §12/§14: @adhd/apigen-conformance — cross-language conformance vectors every host runtime must pass (descriptor round-trip, naming projection, validation, error mapping); codifies the host-SDK/extractor contract.
