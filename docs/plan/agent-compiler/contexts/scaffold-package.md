# scaffold-package — STATE_NAME

**Phase:** foundation · **Kind:** work · **Depends on:** compiler-design · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [scaffold-package.1] project.json exists

- [scaffold-package.2] tsconfig path registered
- [scaffold-package.3] tagged platform:node
---

## Reservations

```text
read_only:  ["docs/plan/agent-compiler/decisions.md"]
mutates:    ["packages/ai/agent-compiler/project.json", "packages/ai/agent-compiler/package.json", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/db/client.ts", "tsconfig.base.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
