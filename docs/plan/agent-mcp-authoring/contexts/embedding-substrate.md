# embedding-substrate — STATE_NAME

**Phase:** enrichment · **Kind:** work · **Depends on:** authoring-design · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts`

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
mutates:    ["packages/ai/agent-registry/src/enrich/embedding.ts", "packages/ai/agent-registry/src/enrich/usecase-anchors.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
