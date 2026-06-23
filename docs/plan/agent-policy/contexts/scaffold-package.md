# scaffold-package — STATE_NAME

**Phase:** foundation · **Kind:** work · **Depends on:** policy-design · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [scaffold-package.1] project.json exists for agent-policy

- [scaffold-package.2] tsconfig.base.json registers @adhd/agent-policy path
- [scaffold-package.3] project.json tags it platform:node
- [scaffold-package.4] package builds clean
- [scaffold-package.5] no browser globals imported in source
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-policy/project.json", "packages/ai/agent-policy/package.json", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/db/client.ts", "packages/ai/agent-policy/src/db/schema.ts", "tsconfig.base.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
