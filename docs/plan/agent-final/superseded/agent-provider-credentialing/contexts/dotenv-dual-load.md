# dotenv-dual-load — deterministic project-over-home .env loading

**Phase:** env · **Kind:** work · **Depends on:** unified-credential-contract · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/dotenv-load.test.ts`

---

## Goal

Secrets load deterministically regardless of cwd. After this state ([def:dual-env-load]):

- A new `src/utils/load-env.ts` exports a function that runs `dotenv.config()` over
  `<project>/.adhd/agent-mcp/.env` **then** `~/.adhd/agent-mcp/.env`, with **project overriding
  home** (dotenv does not override already-set keys, so load project FIRST).
- `src/index.ts` replaces the bare `import "dotenv/config"` with a call to that loader
  (before any provider/store construction).
- `packages/ai/agent-mcp/.env.example` documents the unified shape: every provider's default
  credential var, `baseURL`, and a **multi-key** example (two Anthropic keys via distinct
  `credentialEnv`) — [inv:multi-key].
- `.gitignore` ignores the project secret destination `.adhd/agent-mcp/.env`
  ([inv:no-tracked-secrets]).
- `DATABASE_PATH` default aligns to the central artifact convention (note it in `.env.example`;
  do not change the real `~/.adhd/agent-mcp/agents.db` that back-compat reads).

## Semantic distillation

This branch is **parallel** to the runtime chain (`provider-credential-runtime`,
`lmstudio-removal`) — it shares no mutable files with them, only `depends_on` the contract for the
shape it documents. dotenv semantics: `config()` keeps the FIRST value seen for a key, so "project
overrides home" means **load project first**, then home. The loader must be a plain function (no
import side-effects) so the unit test can drive it against temp dirs.

## Contract promise

- **Added:** `src/utils/load-env.ts`; `.env.example`; `dotenv-load.test.ts`; a `.adhd/agent-mcp/.env`
  line in `.gitignore`.
- **Modified:** `src/index.ts` (bare dotenv import → deterministic loader call).

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [dotenv-dual-load.1] the env loader targets .adhd/agent-mcp/.env (project + home)

- [dotenv-dual-load.2] .env.example documents the unified credential shape
- [dotenv-dual-load.3] dual .env load resolves project-over-home (unit test)
- [dotenv-dual-load.4] the project .adhd/agent-mcp/.env secret destination is gitignored
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/index.ts", "packages/ai/agent-mcp/src/utils/load-env.ts", "packages/ai/agent-mcp/.env.example", "packages/ai/agent-mcp/src/__tests__/dotenv-load.test.ts", ".gitignore"]
```

---

## Commit points

1. After `dotenv-load.test.ts` proves project-over-home and `.adhd/agent-mcp/.env` is gitignored:
   `git commit -m "feat(agent-mcp): deterministic dual .env load (project over home) + .env.example + gitignore"`.

## Notes for executor

- **`dotenv-load.test.ts` must, with teeth:** write the SAME var to a temp project
  `.adhd/agent-mcp/.env` and a temp home `.adhd/agent-mcp/.env`, run the loader, and assert
  `process.env[var]` equals the **project** value. Swapping the load order MUST turn it red ([dod.4]).
  Use a temp `HOME`/project dir; never touch the real `~/.adhd/agent-mcp/.env`.
- The loader must be import-side-effect-free (export a function `loadAgentMcpEnv(opts?)`), so the
  test can point it at temp dirs. `index.ts` calls it at startup.
- `.gitignore`: add `.adhd/agent-mcp/.env` (the project destination). The package-level
  `packages/ai/agent-mcp/.env` is already ignored by `packages/ai/agent-mcp/.gitignore`.
