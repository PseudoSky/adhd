# name-slug-seam — STATE_NAME

**Phase:** seam · **Kind:** work · **Depends on:** enrichment-pipeline · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/name-slug-seam.test.ts`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [name-slug-seam.1] bridge translates name->slug inbound, strips slug outbound; no slug field in any MCP response (recursive scan)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/registry/name-slug.ts", "packages/ai/agent-mcp/src/registry/registry-bridge.ts", "packages/ai/agent-mcp/src/__tests__/name-slug-seam.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
