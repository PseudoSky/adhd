# Shared context — Agent Registry — Composition & Compile Engine (@adhd/agent-compiler)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- Behavioral target (the intended end-state CLI + engine): `docs/plan/agent-registry/USAGE.md`
  — "Compiling to Markdown (Claude Code)", "Context-Conditional Composition",
  "Applying Policies", "Runtime Integration via agent-mcp". This is the consumer
  outcome every behavioral DoD drives toward.
- Composed-prompt model: `DATA_MODEL.md` Domain 1 "Composed Prompts" + Domain 5
  "Runtime Sink". Platforms + `header_format`: `SEED_DATA.md` §5. Example agent
  compositions (junction + context-conditioned `success_criteria`): `SEED_DATA.md`
  §14. Tool bindings: `SEED_DATA.md` §6. Model bindings: `SEED_DATA.md` §7.
- Package boundary: `SCOPE.md` row `@adhd/agent-compiler`.
- These are **requirements, not a frozen contract** — `compiler-design` resolves
  the open consumption/header/topology questions and writes `decisions.md`, which
  every later state treats as binding.

## Upstream packages this plan reads (cross-plan)

- **[up:registry]** `@adhd/agent-registry` (plan 1) — `resolveComposition(agentSlug,
  context)` returns the ordered, version-pinned, context-filtered component list;
  the `composed_prompts` table is WRITTEN here by the cache layer.
- **[up:tools]** `@adhd/agent-tool-registry` (plan 2) — `tool_platform_bindings`
  maps a canonical tool (`shell_exec`) to its platform alias (`Bash` on
  `claude_code`); `agent_tools` holds the agent's grants.
- **[up:provider]** `@adhd/agent-provider` (plan 3) — `model_platform_bindings`
  resolves a canonical model id to its per-platform string; `provider_tool_formats`
  shapes the JSON tools array for API platforms.
- **[up:policy]** `@adhd/agent-policy` (plan 4) — `agent_policy` rows (direct +
  inherited) carry the permission/constraint the compiler folds into the header.

## Glossary

- **[def:compile-input]** — the argument to `compileAgent({agentSlug, platform,
  context})`: an agent slug, a target platform (`claude_code` | `claude_api` |
  `openai`), and a runtime `context` object (e.g. `{ticket_type:"security"}`).
- **[def:composed-output]** — the return of `compileAgent`: `{ id, content, tools,
  componentVersions }` — `content` is the flat platform artifact (markdown for
  `claude_code`, JSON string for `claude_api`); `id` is the `composed_prompts` row
  id (the audit/cache handle). Mirrors `USAGE.md` "Runtime Integration".
- **[def:header-format]** — a platform's `header_format` from `SEED_DATA.md` §5:
  `yaml_frontmatter` (claude_code), `json_object` (claude_api / openai / bedrock),
  or `none` (cursor / vscode — system prompt only).
- **[def:tools-header]** — the platform `tools:` declaration built by joining the
  agent's `agent_tools` grants to `tool_platform_bindings` for the target platform.
  On `claude_code` it is a YAML `tools: Read, Grep, Glob, WebSearch` line; on
  `claude_api` it is a structured tool-definition array.
- **[def:junction-order]** — the body's component sections emitted in ascending
  `agent_components.position` order, exactly as `resolveComposition` returns them.
- **[def:context-hash]** — the canonical hash over `(context, resolved
  component-version set)` that keys a `composed_prompts` cache row; a context
  change or a version-pin change must miss the cache.
- **[def:policy-constraint]** — the rule text the compiler renders from an attached
  `agent_policy` row (e.g. `no-credentials` → "Never write API keys or secrets…")
  into the compiled header/body. (`USAGE.md` "Applying Policies".)

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-compiler` is `platform:node`. It MUST NOT
  import browser code (`react`, `window`, `document`, CSS). Pure Node + SQLite.
- **[inv:one-db-handle]** — per `agent-registry-schema`'s topology decision, all
  four registry packages share ONE SQLite file with table-name prefixes
  (`registry_*` / `tool_*` / `provider_*` / `policy_*`). The compiler opens ONE
  handle and queries all four prefixes — NO `ATTACH DATABASE`, NO second DB file,
  NO cross-package SQLite FK. Cite plan 1's `decisions.md`; do not re-decide.
- **[inv:real-rows-not-mocks]** — every behavioral test seeds REAL rows into all
  four prefixes (via the upstream packages' seed/store APIs or direct inserts) and
  drives the REAL `compileAgent` / CLI bin. Mock nothing under test; the only thing
  that may be faked is an external boundary, and there is none here. (CLAUDE.md
  verification standard #1.)
- **[inv:reopen-proves-cache]** — the caching test proves persistence by CLOSING
  the better-sqlite3 handle and REOPENING from the same file path, then asserting
  the second compile hits the persisted `composed_prompts` row — never by reading
  in-memory state. (CLAUDE.md verification standard #3.)
- **[inv:platform-shaped-observable]** — behavioral assertions key on a
  consumer-visible, platform-shaped property (frontmatter `tools:` line equals the
  resolved aliases; body sections in junction order; conditioned component
  included/excluded; policy constraint present; CLI stdout begins with `---`), NOT
  on an implementation shape ("a join exists"). (CLAUDE.md verification standard
  #6.)
- **[inv:context-precedence-consumed]** — the compiler CONSUMES the
  context-condition precedence rule frozen in `agent-registry-schema`'s
  `decisions.md`; it does not invent its own. If that rule is under-specified,
  escalate (planner-class amendment), don't guess.

## Reference patterns

- **[ref:store-read]** — read upstream rows through the published store classes
  (`CompositionStore.resolveComposition`, `BindingStore.resolve`,
  `ModelStore.resolveModelId`, `AgentPolicyStore.listForAgent`) where they exist;
  fall back to thin Drizzle reads against the prefixed tables in the shared DB.
- **[ref:compile-agent]** — the public surface is `compileAgent({agentSlug,
  platform, context, db})` returning `[def:composed-output]`, mirroring the
  `USAGE.md` "Runtime Integration via agent-mcp" snippet
  (`composed.content` / `composed.tools` / `composed.id` /
  `composed.componentVersions`).
- **[ref:cli-bin]** — the `compile` CLI bin mirrors `agent-mcp`'s `bin` entry in
  `package.json`; it parses `compile <slug> --platform <p> [--context '{...}']
  [--format json] [--out-dir <d>] [--all --category <c>] [--db <path>]` and writes
  markdown to stdout (or files under `--out-dir`).

## Notes for every executor

- Build the four upstream packages first (`npx --yes nx build agent-registry
  agent-tool-registry agent-provider agent-policy`) so their barrels resolve.
- Keep `src/index.ts` the single public barrel; export `compileAgent`, the emit
  helpers, and the cache as they are added (several states mutate `index.ts`).
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`; CLAUDE.md verification standard #4).
- The CLI behavioral test spawns the real bin as a child process and keys on its
  EXIT CODE + stdout — it does not import the CLI module and call it in-process
  (that would not prove the bin works).
