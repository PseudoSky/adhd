# dataset-build — STATE_NAME

**Phase:** ingest · **Kind:** work · **Depends on:** sonnet-consolidation · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts`

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
mutates:    ["packages/ai/agent-registry-migration/src/ingest/dataset-build.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
