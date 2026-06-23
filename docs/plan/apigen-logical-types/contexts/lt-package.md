# lt-package — STATE_NAME

**Phase:** contracts · **Kind:** work · **Depends on:** none · **Guard:** `npx nx build apigen-logical`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lt-package.1] guard green: npx nx build apigen-logical

---

## Reservations

```text
read_only:  []
mutates:    ["packages/apigen/logical/project.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
