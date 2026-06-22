# error-taxonomy — STATE_NAME

**Phase:** v2-harness · **Kind:** work · **Depends on:** canonical-descriptor · **Guard:** `npx --yes nx test apigen-errors`

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
mutates:    ["packages/apigen/errors/src/lib/errors.ts", "packages/apigen/errors/project.json"]
```

---

## Notes for executor

SPEC §9: @adhd/apigen-errors — ApiError{code,message,details} on gRPC canonical code set + per-transport status maps (HTTP/gRPC/MCP/CLI).
