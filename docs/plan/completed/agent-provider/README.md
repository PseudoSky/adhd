# Agent Registry — Provider Registry (@adhd/agent-provider)

Designs and builds `@adhd/agent-provider`: the database-backed registry of AI
providers, canonical models, model-platform bindings, and per-provider tool
schema formats, plus the thin runtime `ProviderAdapter` implementation and the
compile-time↔runtime tool-emission boundary (RUNTIME_GAPS / FEAT-007). This is
plan **3 of 7** for the Agent Registry initiative. The package answers four
runtime/compile questions for `@adhd/agent-compiler` and `@adhd/agent-mcp`:
which providers exist, what models they expose, how a canonical model id maps to
each platform's provider-specific string, and how each provider expects tools to
be shaped.

> **Plan set & ordering.** Plan 3 of 7 (source spec: `docs/plan/agent-registry/`).
> Ordering: `agent-registry-schema` → `agent-tool-registry`, **`agent-provider`**,
> `agent-policy` (parallel, all depend on schema) → `agent-compiler` (depends on
> all four) → `agent-mcp-refactor` → `agent-registry-migration`. **This plan
> depends on `agent-registry-schema`** for the DB topology decision (one shared
> SQLite file, table-name prefixes). See `docs/plan/plan-index.json`.

## Consumer

A registry/compiler engineer and the agent-mcp runtime. Today
`@adhd/agent-mcp` hardcodes model knowledge: `anthropic.ts` carries a hand-kept
`MODEL_MAX_TOKENS` prefix table, model aliases live only in the `claudecli`
provider, and `toAnthropicTools()` can only emit *custom* tools — it never emits
Anthropic **server-side** type-tagged tools (`{type:"web_search_…"}`), so a
compiled platform tool silently never reaches the model. After this plan the
engineer has a real relational provider/model registry they can resolve a model
hint through (`claude_opus_4_8` → `claude-opus-4-8` on the API, `opus` as the
Claude Code alias), and the runtime can emit a correctly-shaped server-side tool
entry (or fail loudly on a still-unsupported native), proven against a real DB.

## Value delta

- **Before:** model identifiers + capabilities are scattered config/code
  (`MODEL_MAX_TOKENS`, per-provider alias maps); the `ProviderAdapter` contract is
  implicit (`LLMProvider.chat()`); `toAnthropicTools()` drops every server-side
  native tool, so compiled `web_search`/`code_execution` grants are dead config.
- **After:** providers, models, model-platform bindings, and provider tool
  formats are normalized rows in the shared SQLite file under the `provider_*`
  prefix; a canonical model id resolves to the right per-platform string after a
  DB reopen; the `ProviderAdapter` interface is named in `@adhd/agent-mcp-types`
  and implemented by a thin adapter here; and the tool emitter produces a
  type-tagged server-side entry for server-side-bound tools while gating
  currently-unsupported natives behind an explicit, actionable error.

## Execution model

- **Parallel execution:** No — a linear schema build with two audit hold points.
  `db/schema.ts` and the `index.ts` barrel are shared mutable files written by
  every state in sequence, so serialization is required (no merge protocol).
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle in the environment.
- **Review:** the requesting engineer accepts via `audit-final`; the
  `provider-adapter-contract` state touches the shared `@adhd/agent-mcp-types`
  barrel and warrants an `architect-reviewer` glance on the interface shape.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions.

## Non-goals (explicit scope boundary — RUNTIME_GAPS)

- **The full client-side execution loop is OUT OF SCOPE.** Running Anthropic
  client-executed tools (`bash`, `text_editor`, `computer`) locally and returning
  their results to the model is, per `RUNTIME_GAPS.md`, a **large** runtime
  addition with real trust/sandboxing implications and no executor exists today.
  This plan deliberately does **only** the RUNTIME_GAPS "cheap win": emit
  type-tagged **server-side** tools (executed on Anthropic's servers, no local
  loop) and **gate every other native behind an explicit, actionable error**
  rather than a silent no-op. The execution loop is left to a later agent-mcp
  runtime plan (FEAT-007 follow-up).
- **Wiring the emitter into agent-mcp's live `anthropic.ts` provider** is
  `agent-mcp-refactor`'s job (plan 6). This plan delivers the emitter + its
  contract; it does not edit `agent-mcp/src/providers/anthropic.ts`.
- **OpenAI / Bedrock concrete adapter classes** beyond the `ProviderAdapter`
  contract + a thin model-resolving adapter are out of scope; new providers are
  later rows + adapter classes (`REFERENCES.md`).
- **Activation-flag handling** (Claude Code `--chrome` `invocation_note`) is noted
  but not acted on here — it belongs to the claudecli runtime path.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL stores
> / emitter against a REAL on-disk SQLite DB and assert persistence by REOPENING
> the store. Each names a `negative-control:` that must turn the clause red if the
> guarantee regresses. Tests gate on the runner's EXIT CODE, never stdout
> `grep -q passed` (better-sqlite3 can segfault on teardown).

- `[dod.1]` A canonical model id resolves to the correct provider-specific string
  per platform via `model_platform_bindings`, proven after the store is closed and
  reopened. This is the package's core value. (behavioral)
  - entrypoint: `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/binding-store.test.ts`
  - observable: vitest exits 0 and the `binding-store.test.ts` case "canonical id resolves per platform after reopen" passes — after the store is closed and reopened from the same file path, `resolveModelId("claude_opus_4_8", "claude_api")` returns `"claude-opus-4-8"` AND `resolveModelId("claude_opus_4_8", "claude_code")` returns `"opus"`.
  - delivered-by: `model-platform-bindings, seed-and-roundtrip`
  - negative-control: in `model-store.ts` `resolveModelId`, drop the `WHERE platform = ?` filter so it returns the first binding regardless of platform → the two platforms resolve to the same string → `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/binding-store.test.ts` goes red.

- `[dod.2]` The tool-format emitter produces an Anthropic **type-tagged
  server-side** entry (e.g. `{type:"web_search_…"}`, NOT a custom
  `{name, description, input_schema}`) for a tool whose binding marks it
  server-side, and throws an explicit, actionable error for an unsupported native
  tool (OpenAI built-in / Anthropic client-exec `bash`/`computer`). This encodes
  the RUNTIME_GAPS / FEAT-007 compile↔runtime boundary. (behavioral)
  - entrypoint: `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/emit-tools.test.ts`
  - observable: vitest exits 0 and `emit-tools.test.ts` proves BOTH cases — a server-side-bound tool yields an entry whose `type` is `web_search_*` and which has NO `input_schema`, and an unsupported native makes the emitter throw an error whose message names the offending tool and its provider.
  - delivered-by: `provider-tool-formats, runtime-tool-forwarding`
  - negative-control: in `emit-tools.ts`, delete the server-side branch so every tool (including the Anthropic `web_search` binding) is emitted as a custom `{name, description, input_schema}` → the type-tagged assertion fails → `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/emit-tools.test.ts` goes red.

- `[dod.3]` Seeding providers + models + bindings into a fresh DB is idempotent (a
  second run adds no duplicate rows / no version drift) and every seeded row
  round-trips after the store is reopened. (behavioral)
  - entrypoint: `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/roundtrip.test.ts`
  - observable: vitest exits 0 and `roundtrip.test.ts` proves `seed()` run twice yields identical `providers` / `models` / `model_platform_bindings` row counts (no duplicates, no version drift), and a store reopened from the same file path returns the seeded rows deep-equal to what was written.
  - delivered-by: `seed-and-roundtrip`
  - negative-control: in the seeder, make `seed()` use plain `INSERT` instead of upsert / `INSERT OR IGNORE` → the second run duplicates rows → `npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/roundtrip.test.ts` goes red.

- `[dod.4]` `@adhd/agent-provider` is a `platform:node` Nx library, registered in
  `tsconfig.base.json` paths, that builds clean and imports no browser code.
  (structural)
  - Proven by `[scaffold-package.1..5]` in the audit: `project.json` exists and is
    tagged `platform:node`, the tsconfig path is present, `nx build agent-provider`
    exits 0, and no `react`/`document.`/`window.` import appears in `src/`.
  - delivered-by: `scaffold-package`

- `[dod.5]` The `provider_*` DB domain — `providers`, `models`,
  `model_platform_bindings`, and `provider_tool_formats` — exists in the shared
  SQLite file via `db/schema.ts`, with the fields `DATA_MODEL.md` Domain 2b
  requires (provider transport/auth/base-url; model context window, output limit,
  capability flags, pricing tier; binding `(model, platform) → platform_model_id`;
  per-provider tool schema shape). (structural)
  - Proven by the `present` criteria on `db/schema.ts` across the schema states
    (`[provider-and-model-schema.1..2]`, `[model-platform-bindings.1]`,
    `[provider-tool-formats.1]`).
  - delivered-by: `provider-and-model-schema, model-platform-bindings, provider-tool-formats`

- `[dod.6]` The `ProviderAdapter` interface (`stream(messages, tools, model):
  AsyncIterable<StreamChunk>`) is defined in `@adhd/agent-mcp-types` (NOT
  re-declared in `agent-provider`, to avoid the circular dependency), and is
  implemented by a thin adapter in `agent-provider` that resolves a model id
  through the binding table. (structural)
  - Proven by `[provider-adapter-contract.1..3]`: `grep` finds `ProviderAdapter`
    in `agent-mcp-types/src/domain.ts`, `grep` confirms `interface ProviderAdapter`
    is ABSENT from `agent-provider/src`, and `adapter-resolve.test.ts` drives the
    adapter resolving a model id through the binding store.
  - delivered-by: `provider-adapter-contract`

---

## State graph

`scaffold-package` → `provider-and-model-schema` → `model-platform-bindings` →
`provider-tool-formats` → `audit-schema` → `provider-adapter-contract` →
`runtime-tool-forwarding` → `seed-and-roundtrip` → `audit-final` → done.
See `state-machine.md` and `dag.json`.

## Cross-plan dependency note

- **Upstream:** `agent-registry-schema` (plan 1) froze the **DB topology** — one
  shared SQLite file, per-package **table-name prefixes**. This plan's tables use
  the `provider_*` prefix in that same file. Do not introduce a second DB file.
- **Sibling interface:** the `ProviderAdapter` interface lives in
  `@adhd/agent-mcp-types` (shared, dependency-free), per `REFERENCES.md`
  dependency direction `agent-mcp-types ← agent-provider ← agent-mcp`. Editing the
  types barrel is additive.
- **Downstream:** `agent-compiler` (plan 5) reads `model_platform_bindings` +
  `provider_tool_formats` to resolve model ids and shape tool defs;
  `agent-mcp-refactor` (plan 6) wires the FEAT-007 emitter into the live
  `anthropic.ts` provider.
