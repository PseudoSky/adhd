# compiler-integration — resolve systemPrompt via compileAgent with cache lookup

**Phase:** integration · **Kind:** work · **Depends on:** runtime-sink-schema · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/compiler-resolve.test.ts`

See `contexts/_shared.md` for definitions, invariants, and the caller map.

---

## Goal

On session start, agent-mcp resolves the system prompt from `compileAgent`
(`[def:compileAgent]`) with a cache lookup, instead of reading a stored flat blob.
After this state: a `prompt-resolver` looks up the `composed_prompts` cache for the
agent + context hash; on miss it calls `compileAgent`, upserts the row, and returns
`content`; the session's resolved system prompt (and the compat-shim
`AgentDefinition.systemPrompt`, if retained) is populated from that `content`, and
`sessions.composed_prompt_id` is set. agent-mcp `package.json` + `tsconfig.base.json`
declare `@adhd/agent-compiler`.

## Semantic Distillation

- **Primitive:** ADD `engine/prompt-resolver.ts` (`resolveComposedPrompt`); WIRE
  it into the `agent` session-start tool (`tools/session.ts`) and the session
  snapshot (`store/session-store.ts`); ADD the `@adhd/agent-compiler` dep.
- **Delta spec** (`USAGE.md` §"Runtime Integration via agent-mcp"; `decisions.md`):
  - `resolveComposedPrompt({ agentSlug, platform, context })`:
    1. compute `context_hash`; `ComposedPromptStore.findByAgentContext(...)`;
    2. on HIT (`[def:cache-hit]`) return the cached `{ content, id }` WITHOUT
       calling `compileAgent`;
    3. on MISS call `compileAgent(...)`, `upsert` the row, return `{ content, id }`.
  - Session start: write `sessions.composed_prompt_id = id`; the
    `AgentDefinition` snapshot's `systemPrompt` is `content` (`[def:compat-shim]`).
  - Wire `@adhd/agent-compiler`: add to `package.json` deps + a `tsconfig.base.json`
    path (criteria `.4`/`.5`).
  - Test (`compiler-resolve.test.ts`): with a STUBBED `compileAgent` returning a
    known content, a session start resolves that exact content and writes a
    non-null `composed_prompt_id`. (The LLM provider is irrelevant here — this
    tests the resolver seam, not a model call.)

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compiler-integration.1] prompt-resolver imports compileAgent from @adhd/agent-compiler

- [compiler-integration.2] resolver caches/looks up the composed prompt and writes composed_prompt_id
- [compiler-integration.3] compiler-resolve test passes: systemPrompt comes from compileAgent output
- [compiler-integration.4] agent-mcp package.json declares @adhd/agent-compiler dependency
- [compiler-integration.5] tsconfig.base.json resolves @adhd/agent-compiler path
---

## Reservations

```text
read_only:  ["docs/plan/agent-mcp-refactor/decisions.md", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/prompt-resolver.ts", "packages/ai/agent-mcp/src/tools/session.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/src/__tests__/compiler-resolve.test.ts"]
```

---

## Changes (brownfield)

- RESIGN `AgentDefinition.systemPrompt` (agent-mcp-types `domain.ts`): user-authored
  source-of-truth → computed value populated from `compileAgent(...).content`.
  (Field declared in dag.json `changes.resigns`.)
- RESIGN `SessionStore.getAgentDefinition` / `create` snapshot semantics: the
  snapshot now carries the resolved prompt + `composed_prompt_id`.
- ADD `resolveComposedPrompt` (`engine/prompt-resolver.ts`).

## Commit points

- `feat(agent-mcp): resolve systemPrompt via @adhd/agent-compiler with composed_prompt cache lookup`

## Notes for executor

- `[inv:compiler-is-baseline]` — `compileAgent` is plan-5 baseline; if the package
  is not yet in the workspace, this state's guard cannot go green. Do NOT stub
  `compileAgent` in production code — only in the test.
- The three `tools/task.ts` reads of `agentDefinition.systemPrompt` keep working
  BECAUSE the snapshot's `systemPrompt` is now the resolved `content` — do not
  rip out those reads here (that is `[dod.3]` non-regression).
- Keep the `context_hash` derivation identical to `runtime-sink-schema`'s lookup
  key so the cache actually hits (this is what `session-e2e`'s `[dod.2]` proves).
- Gate on EXIT CODE (`[inv:exit-code-gate]`).
