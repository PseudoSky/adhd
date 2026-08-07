# serializer-sqlite — STATE_NAME

**Phase:** storage · **Kind:** work · **Depends on:** orch-audit · **Guard:** `npx --yes nx run-many -t test,build -p dispatch-serializer-sqlite`

---

## Goal

`@adhd/dispatch-serializer-sqlite` persists+reloads a dag identically to the JSON serializer (adapter parity), and confirms BL-107 back-compat load lives in `normalizeDag`.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [serializer-sqlite.1] dispatch-serializer-sqlite builds+tests green (incl. json-parity test)

- [serializer-sqlite.2] sqlite serializer entry exists
---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-serializer-sqlite/src/index.ts"]
```

---

## Notes for executor

New package satisfying the identical `IDagSerializer` contract ([inv:adapter-pattern]). Closes DEBT-005/BL-107. Teeth (dod.6): sqlite reload equals json reload on the normalized form; corrupt the read mapping → parity red. SQLite store under `tmp/` in tests ([inv:ephemeral-tmp]).
