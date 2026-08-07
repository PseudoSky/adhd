# runtime-tool-forwarding — FEAT-007 EMITTER (type-tagged server-side + gated error)

**Phase:** runtime · **Kind:** work · **Depends on:** provider-adapter-contract · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/emit-tools.test.ts`

---

## Goal

The RUNTIME_GAPS / FEAT-007 **cheap win**: a tool emitter that, given a tool whose
`provider_tool_formats` binding marks it **server-side**, produces an Anthropic
**type-tagged** entry (`{type:"web_search_…"}`, NOT a custom
`{name, description, input_schema}`); and given a currently-**unsupported native**
(OpenAI built-in, Anthropic client-exec `bash`/`computer`), throws an explicit,
actionable error rather than silently dropping it.

---

## Semantic Distillation

- **Primitive:** ADD `runtime/emit-tools.ts` — the strategic replacement for
  `agent-mcp`'s `toAnthropicTools()`. See `[def:server-side-tool]`,
  `[def:unsupported-native]`, `[inv:server-side-shape]`, `[inv:gate-not-noop]`,
  `[ref:runtime-gap]`.
- **Delta Spec** (`RUNTIME_GAPS.md` Gap 1 + Gap 2 + Recommended Handoff #2):
  - `emitToolsForProvider(tools, formats)` — for each tool, look up its
    `provider_tool_formats` row (via the `ToolFormatStore` / a passed-in lookup)
    and branch on `emit_shape`:
    - `custom` → `{ name, description, input_schema }` (the existing
      `ToolDefinition`-derived shape).
    - `server_side` → a type-tagged entry `{ type: <type_tag>, name }` with **NO
      `input_schema`** (executed on Anthropic's servers; no local loop).
    - `unsupported` → `throw new UnsupportedNativeToolError(...)` whose message
      names the tool + provider and points at the `note` (e.g. "Anthropic `bash`
      is client-executed and requires a local execution loop, which
      @adhd/agent-provider does not yet implement"). Export the error class
      (typed `ToolError`-style code `UNSUPPORTED_NATIVE_TOOL`).
  - Tests (`emit-tools.test.ts`), TWO cases, both asserting the consumer outcome:
    1. server-side: feed a tool bound as Anthropic `web_search` server-side →
       assert the emitted entry has `type` matching `web_search_*` and has NO
       `input_schema` key, and is NOT a `{name, description, input_schema}` custom
       def.
    2. unsupported: feed an Anthropic `bash` (client-exec) tool → assert the
       emitter THROWS, and the thrown message contains the tool name + provider.

---

## Acceptance criteria

- [runtime-tool-forwarding.1] emitter branches on server-side type-tagged shape
- [runtime-tool-forwarding.2] emitter throws explicit actionable error for unsupported native
- [runtime-tool-forwarding.3] emit-tools test: server-side -> type-tagged; unsupported -> throw
- [runtime-tool-forwarding.4] negative-control: FEAT-007 emitter has teeth

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/tool-format-store.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["packages/ai/agent-provider/src/runtime/emit-tools.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/emit-tools.test.ts"]
```

---

## Commit points

- `feat(agent-provider): FEAT-007 tool emitter (type-tagged server-side + gated unsupported)`

## Notes for executor

- **Scope boundary (RUNTIME_GAPS, README non-goals):** this state does ONLY the
  cheap win — emit type-tagged server-side tools + gate the rest behind an
  explicit error. The full client-side execution loop (running `bash`/`computer`
  locally and returning results) is explicitly OUT OF SCOPE and large; do NOT
  build it here. Do NOT edit `agent-mcp/src/providers/anthropic.ts` — wiring this
  emitter into the live provider is `agent-mcp-refactor`'s job (plan 6).
- Proves `[dod.2]`. The negative-control in README dod.2 deletes the server-side
  branch so the `web_search` tool falls through to the custom shape — keep the
  server-side branch the single place the type-tagged entry is produced so the
  control bites and the test goes red.
- The unsupported case must THROW, never return `undefined`/skip
  (`[inv:gate-not-noop]`) — a silent no-op is exactly the regression FEAT-007
  exists to prevent.
