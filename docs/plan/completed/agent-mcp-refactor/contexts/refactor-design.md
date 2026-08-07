# refactor-design — caller map + binding decisions before any live code change

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase architecture`

See `contexts/_shared.md` for definitions, invariants, the full caller map, and source-of-truth pointers.

---

## Goal

`decisions.md` exists and resolves the four open questions BEFORE any live
agent-mcp code is touched, so every later state has a binding contract. After
this state: the AgentStore removal-vs-thin-cache call is made and cited; the
session-start composed-prompt cache flow (cache key = agent + context hash;
lookup → reuse-or-`compileAgent`) is specified; the `systemPrompt` compat-shim
policy is fixed (retained-as-computed vs replaced-by-`composedPromptId`); and the
`claudecli` `allowedBuiltinTools` / `systemPromptIsAgentSpec` reconciliation with
`AGENT_TOOL` is decided. The caller map (`_shared.md`) is confirmed against the
real tree — every `AgentStore`/`systemPrompt` caller is assigned to a state.

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` (no code change). This is an
  `architect-reviewer`-reviewed gate (Execution model).
- **Delta spec** — `decisions.md` MUST record, each with a SCOPE/REFERENCES/
  DATA_MODEL/RUNTIME_GAPS citation:
  1. **AgentStore: remove vs thin-cache** — REFERENCES.md "What Changes in
     agent-mcp" allows either; pick one. Recommend thin-cache (`[def:thin-cache]`)
     so `agent_create`/`read`/`list` keep working as a compiled-agent cache while
     the registry is the source of truth.
  2. **composed_prompts ownership** — DATA_MODEL.md Domain 5 places the cache +
     `experiment_assignments` + `sessions.composed_prompt_id` in agent-mcp's
     runtime sink; Domain 1 also defines a `composed_prompts` in the registry.
     Decide: agent-mcp owns its OWN runtime cache table (recommended — the runtime
     sink is agent-mcp's domain) vs references the registry's. Cite.
  3. **systemPrompt compat-shim** — `[def:compat-shim]`. If retained, it is
     populated from `compileAgent(...).content`, never authored. Decide retain vs
     replace-with-`composedPromptId`.
  4. **claudecli reconciliation** — `[inv:no-third-tool-model]`. Specify how
     `allowedBuiltinTools` / `systemPromptIsAgentSpec` map onto the compiled
     `composed.tools` / `AGENT_TOOL` model.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [refactor-design.1] decisions.md exists

- [refactor-design.2] AgentStore removal-vs-thin-cache decision recorded
- [refactor-design.3] session-start composed_prompt cache flow recorded
- [refactor-design.4] systemPrompt compat-shim policy recorded
- [refactor-design.5] claudecli tactical-feature reconciliation recorded
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/store/agent-store.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/tools/task.ts", "packages/ai/agent-mcp/src/providers/claudecli.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["docs/plan/agent-mcp-refactor/decisions.md", "docs/plan/agent-mcp-refactor/contexts/refactor-design.md"]
```

---

## Commit points

- `docs(plan): record agent-mcp-refactor decisions (AgentStore role, cache flow, compat shim, claudecli reconciliation)`

## Notes for executor

- Read the REAL code first: `store/agent-store.ts`, `store/session-store.ts`,
  `db/schema.ts`, `tools/task.ts` (×3 systemPrompt reads), `providers/claudecli.ts`,
  `agent-mcp-types/src/domain.ts`. Confirm the `_shared.md` caller map line-by-line.
- Do NOT change any `.ts` here — all source files are `read_only`. The only
  outputs are `decisions.md` + this context. The forcing function is the audit:
  `[refactor-design.2..5]` grep `decisions.md` for each decision token.
- `compileAgent` is plan-5 baseline (`[inv:compiler-is-baseline]`) — design the
  integration against its `{ content, tools, id, componentVersions }` shape; do not
  assume you will build composition here.
- If a decision is genuinely blocked on a plan-5 detail, record the assumption +
  escalate (planner amendment); do not invent registry internals.
