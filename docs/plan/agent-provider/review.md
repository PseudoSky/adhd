# Code Review — @adhd/agent-provider (runtime-tool-forwarding / FEAT-007)

**Reviewer:** code-reviewer (opus)
**Ref:** runtime-tool-forwarding state, branch `agent-registry-execution`
**Scope:** `packages/ai/agent-provider/src/runtime/emit-tools.ts`, `src/index.ts`,
`src/__tests__/emit-tools.test.ts`

---

## Summary

FEAT-007 delivers the tool emitter as specified: a pure TypeScript module with no
DB dependency that branches on `emit_shape` from a caller-supplied lookup, produces
the correct type-tagged server-side shape, and throws an actionable typed error for
unsupported native tools. The implementation is surgically scoped — it does not wire
into `agent-mcp` or alter any existing stores, schemas, or the provider adapter.

---

## Findings

### Design intent

- **[inv:server-side-shape]** — `EmittedServerSideTool` carries only `{ type, name }`
  with no `input_schema` key. The `satisfies` operator ensures structural conformance
  at compile time. The test asserts `"input_schema" in emitted === false` explicitly.

- **[inv:gate-not-noop]** — `UnsupportedNativeToolError` is always thrown for the
  `unsupported` case; there is no code path that silently returns `undefined` or
  skips a tool. The test asserts `didThrow === true` for the bash fixture.

- **[inv:adapter-in-types]** — `ProviderAdapter` is NOT re-declared in
  `agent-provider`; the emitter imports `ToolDefinition` from `@adhd/agent-mcp-types`
  read-only. Dependency direction preserved.

- **[inv:platform-node]** — No browser imports; pure Node + TypeScript.

- **[ref:runtime-gap]** — The emitter is a standalone replacement for
  `agent-mcp/src/providers/anthropic.ts` `toAnthropicTools()`. Wiring is deferred
  to plan 6 (agent-mcp-refactor) as specified.

### Test quality

Twelve tests cover:
1. Type-tagged server-side path (type present, input_schema absent, keys exhaustively checked).
2. Unsupported gated-error path (UnsupportedNativeToolError thrown, message contains tool + provider, note surfaced).
3. Custom / unregistered path (standard def shape).
4. Batch emitter (`emitToolsForProvider`) with mixed tools and empty list.
5. Negative-control (lookup returning null for web_search produces custom shape — proves the server-side branch is the single place type-tagged entries are produced).

All twelve pass. The negative-control mutation script (`nc_break_emitter.mjs`) confirms
3 tests go red when the server-side branch is removed.

### Cross-cutting checks

- `index.ts` barrel re-exports `emitTool`, `emitToolsForProvider`,
  `UnsupportedNativeToolError`, and all types cleanly.
- No imports from `agent-mcp`, `agent-policy`, or any tsconfig/drizzle path.
- TypeScript strict mode; no `any` in emitter or test file.
- `ToolFormatLookup` type is ergonomically decoupled from the store class so callers
  and tests can supply in-memory fixtures without a real DB.

### No blocking findings

The implementation matches the context spec, the invariants, and the DoD clauses.

---

VERDICT: APPROVED
