# Agent Registry — Composition & Compile Engine (@adhd/agent-compiler)

Designs and builds `@adhd/agent-compiler`: the composition engine that reads the
registry + tool + provider + policy stores and emits a platform-specific header +
body — markdown (YAML frontmatter) for `claude_code`, JSON (`json_object`) for
`claude_api` / `openai`. It is the **convergence package** of the Agent Registry
initiative: it JOINS across all four sibling registry packages, assembles an
agent's components in junction order, resolves the platform `tools:` header from
`tool_platform_bindings`, resolves the model hint from `model_platform_bindings`,
folds attached `agent_policy` constraints into the output, and WRITES a
`composed_prompts` cache row so re-compiling the same agent+context is a lookup,
not a re-assembly. It ships a real `compile` CLI bin so the headline behavioral
DoD can drive `node .../cli/compile.js compile <slug> --platform claude_code` and
assert platform-shaped stdout.

> **Plan set & ordering.** This is plan **5 of 7** for the Agent Registry
> initiative (source spec: `docs/plan/agent-registry/`). Ordering:
> `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (parallel — all depend on schema) → **`agent-compiler`** (depends
> on all four) → `agent-mcp-refactor` (depends on compiler) →
> `agent-registry-migration`. See `docs/plan/plan-index.json`.

## Cross-plan dependency note (depends on plans 1–4)

This plan **depends on all four upstream registry packages** and is the first to
read them together:

- **`agent-registry-schema` (plan 1)** — the foundation. This plan reads its
  `resolveComposition(agentSlug, context)` to get the ordered, version-pinned,
  context-filtered component list, and WRITES its `composed_prompts` table
  (`(agent_slug, context_hash, content, component_versions)`). The **DB topology
  decision** taken in plan 1's `decisions.md` — **one shared SQLite file with
  per-package table-name prefixes** (`registry_*` / `tool_*` / `provider_*` /
  `policy_*`), **no cross-package SQLite FKs** — is the central assumption this
  plan builds on: the compiler opens ONE DB handle and queries all four prefixes.
  Cited, not re-decided, in `compiler-design`.
- **`agent-tool-registry` (plan 2)** — the compiler joins `tool_platform_bindings`
  to turn an agent's `agent_tools` grants into the platform `tools:` header
  (`shell_exec` → `Bash` on `claude_code`, `bash` on `claude_api`).
- **`agent-provider` (plan 3)** — the compiler resolves `AGENT.model_hint` through
  `model_platform_bindings` (`claude_opus_4_8` → `opus` / `claude-opus-4-8`) and
  reads `provider_tool_formats` to shape the JSON tool array for API platforms.
- **`agent-policy` (plan 4)** — the compiler reads `agent_policy` rows (direct +
  inherited) and folds each policy's permission/constraint into the compiled
  header/body. The eager-vs-lazy inheritance decision from plan 4 constrains this
  join.

The four packages were authored standalone; this plan is where their outputs are
proven to compose into a single platform-shaped artifact from real rows.

## Consumer

A registry/compiler engineer, and — transitively — `@adhd/agent-mcp` (which calls
`compileAgent({agentSlug, platform, context})` to populate `systemPrompt` at
session start, per `agent-mcp-refactor`, plan 6) and every team that runs
`agent-registry compile`. Today an agent's system prompt is a hand-authored
markdown file with a hand-kept `tools: Read, Write, Bash` frontmatter line and no
record of which component versions composed it. After this plan the engineer
compiles any registered agent to any platform from rows — `agent-registry compile
api-design-reviewer --platform claude_code` prints ready-to-use markdown to stdout
— and every compile leaves a reproducible `composed_prompts` audit row.

## Value delta

- **Before:** there is no compiler. The four registry packages hold rows but
  nothing turns them into a platform artifact; an agent's prompt + `tools:` header
  + model alias are still hand-maintained per `.md` file, and the
  `composed_prompts` table (defined by plan 1) is never written.
- **After:** `compileAgent({agentSlug, platform, context})` produces a real
  platform-shaped artifact from real component/tool/model/policy rows —
  `claude_code` markdown with a YAML frontmatter `tools:` line resolved from
  `tool_platform_bindings` and a body whose sections follow junction `position`
  order; `claude_api` JSON with a structured tools array; the same agent under a
  different `--context` includes a different `success_criteria` component;
  attached policy constraints appear in the header; and the second compile of the
  same agent+context is served from a persisted `composed_prompts` row (a cache
  hit proven by reopening the DB). Adding a platform is seeding binding rows, not
  editing agent definitions (`GOAL.md` "Platform Portability"); every compile is
  an audit-trail row (`GOAL.md` "Audit Trail").

## Execution model

- **Parallel execution:** No — the engine is a serialized build: each `resolve/*`
  layer builds on the previous, `compile.ts` and the `index.ts` barrel are shared
  mutable files written by several states in sequence, and the two emit/cache
  layers both feed `compile.ts`. `compile-cli` and `composed-prompt-caching` both
  depend on `platform-markdown-emit` but mutate disjoint files; they are
  serialized through the shared `index.ts`/`compile.ts` so no merge protocol is
  needed.
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle in the environment, and the four upstream packages
  built locally.
- **Review:** `architect-reviewer` reviews `compiler-design` output (the
  context-precedence consumption, the per-platform header builder contract, the
  single-DB join strategy) before `scaffold-package`; the final audit is the
  acceptance gate, accepted by the requesting engineer.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions. Hand off with the Dispatch line.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL compile
> engine / CLI bin against a REAL on-disk SQLite DB seeded with rows from all four
> registry packages, and assert a platform-shaped observable (frontmatter
> `tools:`, junction order, context-conditional inclusion, policy constraint,
> cache hit proven by REOPENING the DB). Each names a `negative-control:` that must
> turn the clause red if the guarantee regresses. Tests gate on the runner's EXIT
> CODE, never stdout `grep -q passed` (better-sqlite3 can segfault on teardown).

- `[dod.1]` **HEADLINE — the compiler emits REAL platform output from REAL
  component rows.** Compiling a seeded agent for `claude_code` emits markdown whose
  YAML frontmatter `tools:` is the platform-resolved set (joined from
  `tool_platform_bindings`) and whose body contains the agent's components in
  junction `position` order. (behavioral)
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: vitest exits 0 and the `compile-e2e.test.ts` case "claude_code compile emits frontmatter tools + ordered body from real rows" passes — it seeds an agent (registry components + `agent_tools` grants + bindings), calls `compileAgent({agentSlug, platform:'claude_code', context})`, and asserts the emitted markdown opens with a `---` frontmatter block whose `tools:` line equals the platform aliases resolved from `tool_platform_bindings` (e.g. `tools: Read, Grep, Glob, WebSearch`) AND that the body's component sections appear in ascending junction `position` order.
  - delivered-by: `composition-resolve, tool-header-emit, platform-markdown-emit, compile-fixtures-e2e`
  - negative-control: in `compile-e2e.test.ts` (or the resolver it drives), drop the `ORDER BY position` so the body emits components out of order, OR have the tools resolver ignore the platform and emit canonical names (`shell_exec` instead of `Bash`) → the frontmatter / ordering assertion fails → `npx --yes nx test agent-compiler --testFile=...compile-e2e.test.ts` goes red.

- `[dod.2]` **Context-conditional emit.** The SAME agent compiled with `--context
  '{"ticket_type":"security"}'` includes the security `success_criteria` component
  and excludes the general one; under the default context the inclusion flips
  (`USAGE.md` "Context-Conditional Composition"). (behavioral)
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: vitest exits 0 and the `compile-e2e.test.ts` case "context selects the conditioned success_criteria component" passes — compiling the seeded agent with context `ticket_type security` yields a body containing the `api-security-criteria` component text and NOT the `api-review-criteria` text; compiling with the default empty context yields the inverse.
  - delivered-by: `composition-resolve, platform-markdown-emit, compile-fixtures-e2e`
  - negative-control: in the composition resolver, stop passing `context` to `resolveComposition` (so the context filter is bypassed) → both criteria components leak into both compiles → `npx --yes nx test agent-compiler --testFile=...compile-e2e.test.ts` goes red.

- `[dod.3]` **Policy-derived constraints incorporated.** An attached policy's
  constraint appears in the compiled header/body of the emitted output (`USAGE.md`
  "Applying Policies"). (behavioral)
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-e2e.test.ts`
  - observable: vitest exits 0 and the `compile-e2e.test.ts` case "attached policy constraint appears in compiled output" passes — after attaching the `no-credentials` policy to the seeded agent and compiling, the emitted output contains the policy's constraint text (the rule rendered from the `agent_policy` row); removing the attachment removes the text.
  - delivered-by: `model-and-policy-emit, platform-markdown-emit, compile-fixtures-e2e`
  - negative-control: in the policy resolver, return an empty constraint list regardless of attached `agent_policy` rows → the `no-credentials` constraint text is absent from the compiled output → `npx --yes nx test agent-compiler --testFile=...compile-e2e.test.ts` goes red.

- `[dod.4]` **Round-trip / caching.** Re-compiling the same agent+context returns
  the cached `composed_prompts` row; persistence is proven by REOPENING the DB
  (`GOAL.md` "Audit Trail", `DATA_MODEL.md` Domain 1 "Composed Prompts").
  (behavioral)
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-cache.test.ts`
  - observable: vitest exits 0 and the `compile-cache.test.ts` case "recompile hits the persisted composed_prompts cache after reopen" passes — the first `compileAgent` writes a `composed_prompts` row keyed by `agent_slug context_hash`; the better-sqlite3 handle is CLOSED and REOPENED from the same file path; the second `compileAgent` of the same agent and context returns the SAME `composed_prompts.id` and does NOT re-run assembly (proven by a resolver spy counter, or by the row count staying at 1).
  - delivered-by: `composed-prompt-caching`
  - negative-control: in the cache layer, skip the `SELECT` lookup (always re-assemble + `INSERT`) → after reopen the second compile creates a second row / a new id → `npx --yes nx test agent-compiler --testFile=...compile-cache.test.ts` goes red.

- `[dod.5]` **Real CLI bin drives the engine end-to-end.** `agent-registry compile
  <slug> --platform claude_code` prints platform-shaped markdown to stdout from
  seeded rows (`USAGE.md` "Compiling to Markdown"). (behavioral)
  - entrypoint: `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-cli.test.ts`
  - observable: vitest exits 0 and the `compile-cli.test.ts` case "compile CLI prints YAML-frontmatter markdown to stdout" passes — it spawns the built CLI bin (`node ...cli compile.js compile <slug> --platform claude_code --db <tmp>`) against a seeded DB, asserts the child exits 0, and asserts its stdout begins with a `---` frontmatter block and contains the resolved `tools:` line; the `format json` flag with `--platform claude_api` yields a parseable JSON object instead.
  - delivered-by: `compile-cli, compile-fixtures-e2e`
  - negative-control: break the CLI's argument plumbing so `--platform` is ignored and it always emits the `none`/no-header format → stdout no longer begins with `---` frontmatter → `npx --yes nx test agent-compiler --testFile=...compile-cli.test.ts` goes red.

- `[dod.6]` `@adhd/agent-compiler` is a `platform:node` Nx library, registered in
  `tsconfig.base.json` paths, that builds clean, imports no browser code, and
  declares npm dependencies on the four registry packages
  (`@adhd/agent-registry`, `@adhd/agent-tool-registry`, `@adhd/agent-provider`,
  `@adhd/agent-policy`). (structural)
  - Proven by `[scaffold-package.1..6]` and the `[dod.6]` grep checks in the audit:
    `project.json` exists and is tagged `platform:node`, the tsconfig path is
    present, `nx build agent-compiler` exits 0, no `react`/`document.`/`window.`
    import appears in `src/`, and `package.json` lists all four registry deps.
  - delivered-by: `compiler-design, scaffold-package`

- `[dod.7]` (structural) The compiler WRITES `composed_prompts` rows and EMITS
  both `yaml_frontmatter` (claude_code) and `json_object` (claude_api/openai)
  header formats from `db/schema` `header_format` per platform.
  - Proven by the `[dod.7]` grep checks: `composed_prompts` written in the cache
    layer, a `frontmatter`/`---` emitter in `emit/markdown.ts`, and a
    `json_object`/structured emitter in `emit/json.ts`.
  - delivered-by: `platform-markdown-emit, composed-prompt-caching`

---

## State graph

`compiler-design` → `scaffold-package` → `composition-resolve` →
`tool-header-emit` → `model-and-policy-emit` → `platform-markdown-emit` →
(`compile-cli` ∥ `composed-prompt-caching`) → `audit-engine` →
`compile-fixtures-e2e` → `audit-final` → done. See `state-machine.md` and
`dag.json`.

## Source spec

- Behavioral target (intended end-state CLI/engine): `docs/plan/agent-registry/USAGE.md`
  ("Compiling to Markdown", "Context-Conditional Composition", "Applying Policies",
  "Runtime Integration via agent-mcp").
- Composed-prompt model: `DATA_MODEL.md` Domain 1 "Composed Prompts" + Domain 5
  "Runtime Sink".
- Package boundary: `SCOPE.md` row `@adhd/agent-compiler` ("Composition engine:
  reads registry + tool + provider + policy, emits header + body").
- Platforms (`header_format`): `SEED_DATA.md` §5; example agent compositions:
  `SEED_DATA.md` §14 (`code-reviewer`, junction with context-conditioned
  `success_criteria`); platform portability + audit trail: `GOAL.md`.

## Open design questions handed to `compiler-design`

Recorded in `decisions.md` before any code is frozen:

1. **Context-condition evaluation consumption** — the compiler CONSUMES (does not
   re-decide) the precedence rule frozen in `agent-registry-schema`'s
   `decisions.md` (which component wins when two rows target the same `position`
   with different conditions). Cite it verbatim; the e2e context test asserts it.
2. **Per-platform header builder contract** — the exact shape of the
   `yaml_frontmatter` header (which fields: `name`, `description`, `tools`,
   `model`) vs. the `json_object` body (`systemPrompt` + structured `tools` array)
   vs. `none`. Pin the field set per platform `header_format`.
3. **Cross-package join strategy** — confirm the single-DB / table-name-prefix
   topology from plan 1 and record that the compiler opens ONE handle and queries
   `registry_*` / `tool_*` / `provider_*` / `policy_*` (no `ATTACH DATABASE`, no
   cross-package SQLite FK).
4. **Composed-prompt cache key** — how the `context_hash` is computed (canonical
   JSON of the context + the resolved component-version set) so a pinned-version
   change or a context change correctly misses the cache.
