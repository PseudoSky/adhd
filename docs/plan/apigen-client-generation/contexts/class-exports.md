# class-exports — STATE_NAME

**Phase:** v2-core · **Kind:** work · **Depends on:** canonical-descriptor, ts-extractor-by-symbol · **Guard:** `npx --yes nx test apigen-core`

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
mutates:    ["packages/apigen/core/src/lib/extract-classes.ts", "packages/apigen/runtime/src/lib/instance-registry.ts"]
```

---

## Notes for executor

SPEC §10 (H2=now): static methods -> ops at path=[file,class,method] now; instances OPT-IN now: kind:constructor (POST .../class -> {instanceId}) + kind:instance-method dispatch via instanceId + registry with TTL/dispose lifecycle. Stateful caveat documented (no horizontal scale without sticky/external store).
