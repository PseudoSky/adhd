# frontmatter-parser — STATE_NAME

**Phase:** parse · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [frontmatter-parser.1] frontmatter parse test passes (name/desc/tools/model -> rows)

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md"]
mutates:    ["packages/ai/agent-registry-migration/src/parse/frontmatter.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/frontmatter.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
