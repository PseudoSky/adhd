# compiler-design — STATE_NAME

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compiler-design.1] decisions.md exists

- [compiler-design.2] context-condition precedence consumption recorded (matches agent-registry)
- [compiler-design.3] per-platform header builder contract recorded
- [compiler-design.4] single-DB cross-package join topology cited
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-compiler/decisions.md", "docs/plan/agent-compiler/contexts/compiler-design.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
