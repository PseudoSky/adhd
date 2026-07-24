# mcp-adapter — STATE_NAME

**Phase:** phase-2 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test`

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
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-mcp/src/lib/run.ts", "packages/apigen/apigen-plugin-mcp/src/lib/generate.ts", "packages/apigen/apigen-plugin-mcp/src/lib/tool-naming.ts", "packages/apigen/apigen-plugin-mcp/src/lib/stream.ts", "packages/apigen/apigen-plugin-mcp/src/test/run.spec.ts", "packages/apigen/apigen-plugin-mcp/src/test/golden/mcp.snapshot.json"]
```

---

## Notes for executor

Fixes BUG-APIGEN-SERVE-CORE-001 (first-time validate-layer) + wires projectStreamMcp. malformed->invalid_argument is a flagged behavior change. Real @modelcontextprotocol/sdk client only.
