# layer-harness — STATE_NAME

**Phase:** v2-harness · **Kind:** work · **Depends on:** canonical-descriptor · **Guard:** `npx --yes nx test apigen-runtime`

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
mutates:    ["packages/apigen/runtime/src/lib/invoke.ts"]
```

---

## Notes for executor

SPEC §8: createInvoker(plugins)->invoke(op,call) composes the Layer stack around dispatch; typed-extension ctx (type-keyed, insert/read); generalizes v1 dispatch->invoke. Transports become thin adapters.
