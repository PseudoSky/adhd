# Shared context — Agent Registry — Migration & Removal (@adhd/agent-registry-migration)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Source of truth

- The migration method is `docs/plan/agent-registry/SEED_DATA.md` §0 ("How This
  Seed Data Was Extracted") — the frontmatter→table mapping, the body→component
  heading table, and the 8-step "What a migration script must do".
- The removal scope + the zero-loss rule are `docs/plan/agent-registry/SCOPE.md`
  "Systems Replaced" and `REFERENCES.md` "Superseded Systems — Removal Targets"
  ("Nothing is removed until migration tooling verifies zero data loss").
- The registry tables + stores this tool writes are owned by
  `@adhd/agent-registry` (plan 1, published). The compiler this tool round-trips
  through is `@adhd/agent-compiler` (plan 5). Treat both as published, importable
  dependencies — do NOT re-implement them here.

## Glossary

- **[def:fixture]** — a representative `.md` agent or `SKILL.md` file copied into
  `packages/ai/agent-registry-migration/src/__fixtures__/` and checked in. The
  tool is built + verified against fixtures because the real corpus lives in a
  separate repo (`[inv:cross-repo]`). `code-reviewer.md` is the canonical
  worked example (SEED_DATA §0).
- **[def:import]** — parsing one fixture file's frontmatter + body and writing the
  resulting `AGENT`, `PROMPT_COMPONENT` (+ `AGENT_COMPONENT` junction), and
  `AGENT_TOOL` rows through the real `@adhd/agent-registry` stores.
- **[def:round-trip]** — import an agent, then `agent-registry compile <slug>
  --platform claude_code`, then normalized-diff the emitted markdown against the
  original fixture. An empty diff means the registry is a lossless replacement for
  the file (SEED_DATA §0 step 7: "the migration's correctness gate").
- **[def:equivalence-report]** — the artifact the round-trip gate produces: a
  per-agent `PASS`/`FAIL` list. `retire()` requires it to be **all-PASS**.
- **[def:retire]** — the removal action: delete a migrated file (a fixture in this
  plan; the real corpus via the operator runbook) AND assert the compiler still
  produces the agent. Gated on `[def:equivalence-report]` being all-PASS.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-registry-migration` is `platform:node`.
  It MUST NOT import browser code (`react`, `window`, `document`, CSS). Pure
  Node + SQLite + the registry/compiler packages.
- **[inv:real-deps-not-mocks]** — the import + round-trip tests drive the REAL
  `@adhd/agent-registry` stores and the REAL `@adhd/agent-compiler` against a real
  on-disk SQLite DB. The only thing ever mocked is the absent external repo — and
  even that is replaced by in-repo fixtures, not a stub. Never mock the thing
  under test (project CLAUDE.md verification standard #1).
- **[inv:reopen-proves-persistence]** — import tests prove persistence by CLOSING
  the better-sqlite3 handle and REOPENING from the same file path, then asserting
  the read-back rows — never by reading in-memory state (standard #3).
- **[inv:zero-loss-before-removal]** — no file is deleted until the round-trip is
  verified for EVERY agent in the report. `retire()` refuses on any `FAIL`. This
  is the forcing function for `[dod.4]`.
- **[inv:cross-repo]** — the actual 346 `.md` files + `.claude/skills/` live
  in `~/dev/ai/claude-agents`, NOT in this repo. Guards touch ONLY in-repo
  fixtures + the report. The cross-repo removal is a documented operator runbook
  step (`RUNBOOK.md`), never an automated guard.

## Reference patterns

- **[fix:store-usage]** — write rows via the published `@adhd/agent-registry`
  store classes (`AgentStore`, `ComponentStore`, `CompositionStore`,
  `AgentToolStore` / the tool-registry binding store), mirroring how
  `packages/ai/agent-mcp/src/store/*.ts` wrap Drizzle. Do not hand-write SQL.
- **[fix:frontmatter-mapping]** — SEED_DATA §0 "Frontmatter → registry table
  mapping": `name:`→`AGENT.slug`; `description:`→`AGENT.description`; `tools:`
  comma list→one `AGENT_TOOL` row per token, canonical name via
  `TOOL_PLATFORM_BINDING` where `platform = claude_code`, unknowns flagged;
  `model:`→`AGENT.model_hint` via `MODEL_PLATFORM_BINDING[claude_code]`.
- **[fix:body-mapping]** — SEED_DATA §0 "Body → prompt components" heading table:
  un-headed opening `You are a…`→`role`; `## Identity`/`## Mission`→`identity`;
  `## Process`/`## Workflow`/`## Steps`→`process`;
  `## Invocation`/`## When to use`→`invocation`;
  `## Success Criteria`/`## Done When`→`success_criteria`; etc. Position = order
  of appearance (1-indexed); `context_condition = null`; `version = 1`.

## Notes for every executor

- `@adhd/agent-registry` + `@adhd/agent-compiler` must be on the Nx workspace path
  (`tsconfig.base.json`) before this package builds — they are plan 1 + plan 5
  outputs. `scaffold-package` adds this package's own path line only.
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`, CLAUDE.md verification standard #4).
- Keep `src/index.ts` the single public barrel; export each module as added
  (every work state mutates `index.ts` — append-only).
