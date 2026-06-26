# corpus-parser — STATE_NAME

**Phase:** parse · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts`

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
mutates:    ["packages/ai/agent-registry-migration/src/parse/agent-parser.ts", "packages/ai/agent-registry-migration/src/parse/component-mapping.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
