# triage — STATE_NAME

**Phase:** triage · **Kind:** audit · **Depends on:** none · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [triage.1] EXEC-001 landed: the tool-call skipped-stub warn is gone from orchestrator

- [triage.2] PUBLISH-001 landed: duplicate short alias @adhd/dispatch-spec removed from tsconfig
---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_triage.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
