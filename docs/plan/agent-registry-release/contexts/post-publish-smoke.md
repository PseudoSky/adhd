# post-publish-smoke — STATE_NAME

**Phase:** post-publish · **Kind:** work · **Depends on:** publish-packages · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase smoke`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [post-publish-smoke.1] smoke_test.sh imports each published package + runs the USAGE.md install->compose->compile journey

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-release/scripts/smoke_test.sh", "docs/plan/agent-registry-release/POST_PUBLISH.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
