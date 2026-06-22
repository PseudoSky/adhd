# ts-extractor-by-symbol — STATE_NAME

**Phase:** v2-core · **Kind:** work · **Depends on:** canonical-descriptor, naming-helpers · **Guard:** `npx --yes nx test apigen-core`

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
mutates:    ["packages/apigen/core/src/lib/extract.ts"]
```

---

## Notes for executor

SPEC §4/§14, fixes F28/F29: name operations by EXPORTED SYMBOL (honor 'as' aliases; handle default/anonymous/renamed/CJS shapes); emit canonical descriptor incl typeText; ctx-first-param excluded; data-wrapper dissolved.
