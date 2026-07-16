# live-e2e — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** cli-audit, orch-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [live-e2e.1] default-running structural: real agent-mcp subprocess spawn + MCP stdio handshake (initialize + tools/list), no paid call

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/dispatch-cli/src/test/integration/real-e2e.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
