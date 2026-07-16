# Shared context — agent-mcp Refactor (consume @adhd/agent-compiler + @adhd/agent-registry)

> Single source of truth for definitions. Reference entries here from any context
> file instead of restating them. This is plan 6 of 7 (`docs/plan/agent-registry/`).

## Source of truth

- Intent + boundary: `docs/plan/agent-registry/SCOPE.md` ("Systems Replaced" →
  "agent-mcp Internal Agent Registry", "Flat systemPrompt in AgentDefinition",
  "Ad-hoc Policy in Agent Frontmatter").
- Integration contract: `docs/plan/agent-registry/REFERENCES.md` ("Collaborator:
  agent-mcp" → "What Changes in agent-mcp", "PolicyEngine", "@adhd/agent-mcp-types").
- Runtime sink data model: `docs/plan/agent-registry/DATA_MODEL.md` Domain 5
  (composed-prompt cache, experiment_assignments, sessions.composed_prompt_id).
- Already-shipped tactical features on the removal path:
  `docs/plan/agent-registry/RUNTIME_GAPS.md` "Relationship to Already-Shipped
  agent-mcp Features".
- Compiler contract (delivered by plan 5): `docs/plan/agent-registry/USAGE.md`
  §"Runtime Integration via agent-mcp".
- Binding decisions for THIS plan: `docs/plan/agent-mcp-refactor/decisions.md`
  (written by `refactor-design`; every later state treats it as binding).

## Glossary

- **[def:compileAgent]** — the `@adhd/agent-compiler` entrypoint
  `compileAgent({ agentSlug, platform, context }) → { content, tools, id,
  componentVersions }`. `content` is the flat system-prompt string; `id` is the
  `composed_prompts` row id written to `sessions.composed_prompt_id`. Delivered by
  plan 5; consumed (not built) here.
- **[def:composed-prompt]** — a cached compiler-output row keyed by
  `(agent_slug, context_hash)` carrying `content` + `component_versions`. Lives in
  the runtime sink (`composed_prompts` table). The session-start cache key.
- **[def:cache-hit]** — a session start finds an existing `composed_prompts` row
  for the same agent + context hash whose component versions are not superseded,
  and reuses it WITHOUT calling `compileAgent`.
- **[def:compat-shim]** — `AgentDefinition.systemPrompt`, if retained, is a
  computed value POPULATED from `compileAgent(...).content` — never user-authored.
  (SCOPE.md "Flat systemPrompt in AgentDefinition".)
- **[def:thin-cache]** — the post-refactor `agents` table / `AgentStore` role:
  a compiled-agent cache, not the source of truth. Source of truth is the
  registry. (DATA_MODEL.md Domain 5: the `agents` table transitions from
  source-of-truth to a compiled-agent cache.)

## Cross-cutting invariants

- **[inv:real-session-start]** — behavioral DoD tests DRIVE the REAL agent-mcp
  session-start path (real SessionStore + prompt-resolver + composed-prompt-store
  + the `agent` tool) against a REAL on-disk SQLite file with migrations applied.
  Mock ONLY the LLM provider boundary — never the resolver/stores/DB under test.
  (Project CLAUDE.md "Proving features actually work" #1, #5.)
- **[inv:reopen-proves-cache]** — cache/persistence claims are proven by CLOSING
  the better-sqlite3 handle and REOPENING from the same file path, then asserting
  rows — never by reading in-memory state. (CLAUDE.md verification #3.)
- **[inv:exit-code-gate]** — every gate keys on the runner's EXIT CODE, never a
  stdout `grep -q passed`. better-sqlite3 under vitest can segfault on teardown;
  a teardown segfault must fail the gate. (CLAUDE.md verification #4; project
  memory `feedback_plan_execution_pitfalls`.)
- **[inv:no-third-tool-model]** — `claudecli`'s `allowedBuiltinTools` /
  `systemPromptIsAgentSpec` must be reconciled with the registry's `AGENT_TOOL` /
  compiled-tools model, not left as a competing third tool-permission model.
  (RUNTIME_GAPS.md.)
- **[inv:compiler-is-baseline]** — `@adhd/agent-compiler`'s `compileAgent` is an
  `assumed_baseline` from plan 5; it must be present (built + tsconfig path) before
  `compiler-integration` goes green. Do NOT re-implement composition here.

## Caller map (brownfield — every caller is owned by a state)

`AgentStore` / flat `systemPrompt` callers found in `packages/ai/agent-mcp/src`
(non-test), and the state that owns each:

| Caller site | What it does today | Owned by state |
|---|---|---|
| `store/agent-store.ts` | flat-systemPrompt source-of-truth CRUD | `agent-store-retire` (resign → thin cache) |
| `store/index.ts` (barrel) | exports AgentStore | `agent-store-retire` |
| `tools/agent-crud.ts` | agent_create/read/update/delete/list → AgentStore | `agent-store-retire` (delegate) |
| `validation/agent.ts` `systemPrompt: z.string()` (+ patch) | authoring schema | `agent-store-retire` (compat shim) + `policy-engine-bridge` (claudecli fields) |
| `tools/task.ts` (×3) reads `agentDefinition.systemPrompt` for the system message | runtime prompt source | `compiler-integration` (resolve via compiler; task.ts reads resolved value) |
| `store/session-store.ts` `getAgentDefinition` + `create` snapshot `agentData` | session AgentDefinition snapshot | `compiler-integration` (snapshot includes resolved prompt + composed_prompt_id) |
| `index.ts` `new AgentStore(...)` wiring | server bootstrap | `agent-store-retire` (rewire) / `compiler-integration` (resolver wiring) |
| `server.ts` USAGE_GUIDE text mentions `systemPrompt` in agent_create examples | docs string | `agent-store-retire` (doc compat-shim note) |
| `providers/claudecli.ts` `systemPromptIsAgentSpec` / `allowedBuiltinTools` | tactical tool-permission path | `policy-engine-bridge` (reconcile) |
| `providers/anthropic.ts` `systemPrompt` local var | assembles system msg from messages | unchanged (consumes already-resolved system messages, not the authoring blob) |
| `engine/policy.ts` `PolicyConfig` hardcoded limits | recursion/loop/allowedAgents | `policy-engine-bridge` (read from agent-policy templates) |

Every caller above is in exactly one state's `mutates` or `read_only` set.

## Reference patterns

- **[ref:drizzle-schema]** — new tables/columns mirror
  `packages/ai/agent-mcp/src/db/schema.ts` style: `sqliteTable(...)`,
  `text().primaryKey()`, `integer().notNull().default(...)`, `index(...)`,
  `.references(...)`. Generate migrations with drizzle-kit into
  `packages/ai/agent-mcp/drizzle/`; run them via `db/migrate.ts`.
- **[ref:store-class]** — `composed-prompt-store.ts` mirrors the existing
  `agent-store.ts` / `session-store.ts` constructor-takes-`BetterSQLite3Database`,
  thin-Drizzle-query, typed-`ToolError` pattern.
- **[ref:agent-mcp-types]** — new shared types (`ComposedPrompt`) extend
  `@adhd/agent-mcp-types` (`packages/ai/agent-mcp-types/src/domain.ts`) — no new
  types package, no circular dep on the orchestrator. (REFERENCES.md
  "@adhd/agent-mcp-types".)

## Notes for every executor

- This is LIVE code. Run `git diff` + `npx --yes nx test agent-mcp` to trace any
  failure to its true origin; never label a failure "pre-existing".
- Keep `src/index.ts` and `src/db/schema.ts` append-only across states (shared
  mutable files) — coordinate, don't clobber.
- Discovered deferrals/bugs → `packages/ai/agent-mcp/BACKLOG.md` at discovery time.
