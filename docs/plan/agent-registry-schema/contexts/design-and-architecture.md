# design-and-architecture — STATE_NAME

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [design-and-architecture.1] decisions.md records the resolved topology + context-eval semantics

- [design-and-architecture.2] DB topology decision recorded
- [design-and-architecture.3] context-condition evaluation precedence recorded
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-schema/decisions.md", "docs/plan/agent-registry-schema/contexts/design-and-architecture.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
