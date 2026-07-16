# provider-adapter-contract — DEFINE ProviderAdapter IN TYPES + THIN IMPL HERE

**Phase:** adapter · **Kind:** work · **Depends on:** audit-schema · **Guard:** `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/adapter-resolve.test.ts`

---

## Goal

The `ProviderAdapter` interface is named in `@adhd/agent-mcp-types` (NOT in
agent-provider), and a thin adapter in agent-provider implements it by resolving a
model id through the binding table — proven by a test that drives the adapter
turning a canonical model id into a per-platform string via `ModelStore`.

---

## Semantic Distillation

- **Primitive:** ADD the `ProviderAdapter` interface to `@adhd/agent-mcp-types`
  and a thin implementation here. See `[def:provider-adapter]`,
  `[inv:adapter-in-types]`, `[ref:provider-config]`.
- **Delta Spec** (`DATA_MODEL.md` Domain 2b "ProviderAdapter Interface";
  `REFERENCES.md` dependency direction):
  - In `packages/ai/agent-mcp-types/src/domain.ts`: declare a minimal
    `StreamChunk` type (a discriminated union covering at least `text` and
    `tool_call` deltas — keep it small and additive) and:
    ```typescript
    export interface ProviderAdapter {
      stream(
        messages: Message[],
        tools: ToolDefinition[] | undefined,
        model: string
      ): AsyncIterable<StreamChunk>;
    }
    ```
    Re-export both from `packages/ai/agent-mcp-types/src/index.ts`. These are
    ADDITIVE — do not touch the existing `ProviderConfig` / `ToolDefinition` /
    `LLMProvider` shapes.
  - In `agent-provider/src/adapter/provider-adapter.ts`: a thin class implementing
    `ProviderAdapter` (imported from `@adhd/agent-mcp-types`) whose constructor
    takes a `ModelStore` + a platform; it resolves the incoming canonical `model`
    arg through `ModelStore.resolveModelId(model, platform)` before it would call
    the provider. The full streaming body MAY be a stub that yields a single chunk
    — the contract under test here is **model resolution through the binding
    table**, not live streaming.
  - Tests (`adapter-resolve.test.ts`): construct the adapter with a `ModelStore`
    over a real DB seeded with a `claude_opus_4_8`/`claude_api` binding, drive the
    adapter, and assert it resolved the canonical id to `claude-opus-4-8` (expose
    the resolved id via a method or the first stream chunk so the test can
    observe it).

---

## Acceptance criteria

- [provider-adapter-contract.1] ProviderAdapter interface defined in agent-mcp-types
- [provider-adapter-contract.2] ProviderAdapter interface NOT re-declared inside agent-provider source
- [provider-adapter-contract.3] adapter resolves a model id through the binding table

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/model-store.ts"]
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-mcp-types/src/index.ts", "packages/ai/agent-provider/src/adapter/provider-adapter.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/adapter-resolve.test.ts"]
```

---

## Commit points

- `feat(agent-mcp-types): add ProviderAdapter interface`
- `feat(agent-provider): thin ProviderAdapter impl resolving model bindings`

## Notes for executor

- `[inv:adapter-in-types]` is load-bearing: the criterion `[…2]` greps for
  `interface ProviderAdapter` being ABSENT under `agent-provider/src`. Importing
  the type is fine; re-declaring the `interface` here fails the audit and would
  invert the dependency graph.
- This is a `plan_kind: greenfield` edit to the shared `agent-mcp-types` barrel —
  purely additive, no existing symbol renamed/removed, so no external-caller
  resign is needed. An `architect-reviewer` glance on the `StreamChunk` shape is
  worthwhile (Execution model).
- Proves `[dod.6]`.
- **Live lmstudio round-trip (gated, optional proof for `[lmstudio_adapter_roundtrip]`):**
  the HARD guard for this state stays the offline `adapter-resolve.test.ts`. In
  addition, wire the `lmstudio` adapter's live proof to the ready-made artifact
  `scripts/live-lmstudio-roundtrip.sh` — it env-pins the absolute `lms` bin, brings
  up the LM Studio server + the `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8`
  model itself (so an ejected model is not a precondition), drives a REAL completion
  against `http://localhost:1234/v1/chat/completions`, and asserts a
  MODEL-INDEPENDENT invariant (non-empty assistant content). It runs only under
  `AGENT_MCP_LIVE=1` and skips (exit 0) offline / when the bin or model is absent,
  so CI stays offline. Implement the adapter's live test to shell out to this script
  (or port it 1:1 into a `*.live.test.ts` gated on the same flag); do NOT make it a
  default guard — a live-model dependency must never gate the offline build.
