# body-section-splitter — STATE_NAME

**Phase:** parse · **Kind:** work · **Depends on:** frontmatter-parser · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [body-section-splitter.1] body section typing test passes

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md", "packages/ai/agent-registry-migration/src/parse/frontmatter.ts"]
mutates:    ["packages/ai/agent-registry-migration/src/parse/body-sections.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/body-sections.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
