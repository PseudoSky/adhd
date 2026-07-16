# agent-store-retire — remove the flat-systemPrompt source-of-truth authoring path

**Phase:** retire · **Kind:** work · **Depends on:** compiler-integration · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/agent-cache-store.test.ts`

See `contexts/_shared.md` for definitions, invariants, and the caller map.

---

## Goal

The flat-`systemPrompt` authoring / source-of-truth path is GONE. After this
state: `AgentDefinition` no longer requires a user-authored `systemPrompt` string
(`grep_absent` of `systemPrompt: z.string()`); if retained it is a documented
computed compat shim (`[def:compat-shim]`); `AgentStore` is a thin compiled-agent
cache (`[def:thin-cache]`) per `decisions.md`, and agent CRUD delegates definition
resolution to the registry/compiler rather than persisting an authored blob.

## Semantic Distillation

- **Primitive:** RESIGN `AgentStore` (source-of-truth → thin cache) and RESIGN
  `agentDefinitionSchema.systemPrompt` (required `z.string()` → optional/computed
  compat shim). Declared in dag.json `changes.resigns`.
- **Delta spec** (`SCOPE.md` "agent-mcp Internal Agent Registry" + "Flat
  systemPrompt in AgentDefinition"; `decisions.md` questions 1 + 3):
  - `validation/agent.ts`: remove the REQUIRED `systemPrompt: z.string()` authoring
    field. Per `decisions.md`: either drop it (replace with `composedPromptId`) or
    make it `.optional()` with a JSDoc/comment stating it is computed/populated
    from compiler output (criterion `.2` greps for that compat note). The patch
    schema's `systemPrompt` follows the same fate.
  - `store/agent-store.ts` + `tools/agent-crud.ts`: `AgentStore` becomes the
    `[def:thin-cache]`; `agent_create`/`update` no longer require an authored
    prompt — the row is a compiled-agent cache populated from compiler output.
  - Test (`agent-cache-store.test.ts`): creating an agent WITHOUT authoring a flat
    systemPrompt succeeds, and the persisted row behaves as a cache (re-resolution
    comes from the compiler/registry, not a stored authored blob).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [agent-store-retire.1] user-authored flat systemPrompt is no longer a required authoring field (source-of-truth path gone)

- [agent-store-retire.2] systemPrompt retained only as a documented computed compat shim
- [agent-store-retire.3] agent CRUD delegates / agent row is a compiled cache (test passes)
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/store/agent-store.ts", "packages/ai/agent-mcp/src/tools/agent-crud.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/store/index.ts", "packages/ai/agent-mcp/src/__tests__/agent-cache-store.test.ts", "packages/ai/agent-mcp-types/src/domain.ts"]
```

---

## Changes (brownfield)

- RESIGN `AgentStore` (`store/agent-store.ts`): flat-systemPrompt source-of-truth →
  thin compiled-agent cache.
- RESIGN `agentDefinitionSchema.systemPrompt` (`validation/agent.ts`): required
  authoring field → optional computed compat shim (removes the authoring path).
  (Both declared in dag.json `changes.resigns`.)

## Commit points

- `refactor(agent-mcp): retire flat-systemPrompt authoring path; AgentStore becomes a thin compiled-agent cache`

## Notes for executor

- `[dod.4]` is STRUCTURAL: the audit `grep_absent`s `systemPrompt: z.string()` in
  `validation/agent.ts` — the literal required-string declaration must be gone.
  Do NOT leave it as `z.string()` "for compat"; make it `.optional()` + a compat
  note, or replace with `composedPromptId`.
- Non-regression risk (`[dod.3]`): `tools/task.ts` and `session-store.ts` read
  `systemPrompt` — they keep working ONLY because `compiler-integration` populates
  it from compiler output. Run the full suite before declaring green.
- The `agent-mcp__agent_create` USAGE_GUIDE examples in `server.ts` mention
  `systemPrompt` — `server.ts` is NOT in your mutate set; if its doc string needs
  a compat note, that is an additive doc edit owned here only if reserved. Do not
  exceed the reservation; record any needed `server.ts` doc change in BACKLOG.md.
- Gate on EXIT CODE (`[inv:exit-code-gate]`).
