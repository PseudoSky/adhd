# scaffold-package — STATE_NAME

**Phase:** foundation · **Kind:** work · **Depends on:** migration-design · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [scaffold-package.1] project.json exists

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/project.json", "packages/ai/agent-registry-migration/package.json", "packages/ai/agent-registry-migration/src/index.ts", "tsconfig.base.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
