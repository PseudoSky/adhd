# main-merge — STATE_NAME

**Phase:** scaffold · **Kind:** work · **Depends on:** sp-switch · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py main-merge`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [main-merge.1] probe criterion

---

## Reservations

```text
read_only:  []
mutates:    [".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml"]
```

---

## Notes for executor

executor=haiku
