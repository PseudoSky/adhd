# publish-packages — STATE_NAME

**Phase:** publish · **Kind:** work · **Depends on:** merge-to-main · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase publish`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [publish-packages.1] PUBLISH_RUNBOOK.md contains NO --skip-nx-cache token (never ship stale dist)

- [publish-packages.2] PUBLISH_RUNBOOK reconciles every @adhd/* dep to a real published version (no "*" ships) and names the transitive deps + a verification command (F-P6-13)
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
