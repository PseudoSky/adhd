# skills-migration — STATE_NAME

**Phase:** import · **Kind:** work · **Depends on:** import-pipeline · **Guard:** `true`

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
read_only:  ["packages/ai/agent-registry-migration/src/parse/frontmatter.ts", "packages/ai/agent-registry-migration/src/parse/body-sections.ts", "packages/ai/agent-registry-migration/src/__fixtures__/ticket-creation.SKILL.md"]
mutates:    ["packages/ai/agent-registry-migration/src/import/import-skill.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/skills-migration.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
