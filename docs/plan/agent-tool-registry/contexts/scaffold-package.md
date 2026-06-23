# scaffold-package — STATE_NAME

**Phase:** foundation · **Kind:** work · **Depends on:** none · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-tool-registry/project.json", "packages/ai/agent-tool-registry/package.json", "packages/ai/agent-tool-registry/src/index.ts", "packages/ai/agent-tool-registry/src/db/client.ts", "packages/ai/agent-tool-registry/src/db/schema.ts", "packages/ai/agent-tool-registry/src/db/migrate.ts", "tsconfig.base.json"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
