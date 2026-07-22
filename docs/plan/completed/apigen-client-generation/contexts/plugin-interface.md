# plugin-interface — STATE_NAME

**Phase:** v2-projection · **Kind:** work · **Depends on:** canonical-descriptor · **Guard:** `npx --yes nx build apigen-core`

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
mutates:    ["packages/apigen/core/src/lib/plugin.ts"]
```

---

## Notes for executor

SPEC §7.1: Plugin{id,capabilities:{target,layer,mount,envelope}}; Call/Next/MountedOperation/EnvelopeCapability types; hook sugar compiles to a LayerCapability. The contract all plugins implement.
