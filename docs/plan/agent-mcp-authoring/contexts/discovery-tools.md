# discovery-tools — STATE_NAME

**Phase:** discovery · **Kind:** work · **Depends on:** name-slug-seam · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/discovery-tools.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [discovery-tools.1] all 11 discovery tools return name-keyed results over the real registry stores

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/discovery.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/__tests__/discovery-tools.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
