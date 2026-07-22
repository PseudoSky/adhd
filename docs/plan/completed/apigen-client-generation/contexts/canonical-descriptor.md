# canonical-descriptor — STATE_NAME

**Phase:** v2-core · **Kind:** work · **Depends on:** core-types · **Guard:** `npx --yes nx build apigen-core`

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
mutates:    ["packages/apigen/core/src/lib/descriptor.ts", "packages/apigen/core/src/lib/descriptor.schema.json"]
```

---

## Notes for executor

SPEC §4: Operation{id,host,namespace,path,kind,async,streaming,input,output,envelope,typeText} + Segment{raw,words}; JSON Schema 2020-12 IR. The neutral contract every extractor emits and every plugin consumes.
