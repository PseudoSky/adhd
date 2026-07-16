# release-ready — STATE_NAME

**Phase:** release · **Kind:** work · **Depends on:** test-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [release-ready.1] all 10 dispatch projects build+test green

---

## Reservations

```text
read_only:  []
mutates:    ["package.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
