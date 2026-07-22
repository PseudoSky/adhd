# gateway — STATE_NAME

**Phase:** v2-packaging · **Kind:** work · **Depends on:** unified-cli, scaffold-v2-common · **Guard:** `npx --yes nx test apigen-gateway`

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
mutates:    ["packages/apigen/gateway/src/lib/gateway.ts"]
```

---

## Notes for executor

SPEC §13: @adhd/apigen-gateway — sidecar topology for mixed-host run (spawn per-language runtime, route each op to its owning runtime over local IPC, present one transport); single in-process fast path when all one host.
