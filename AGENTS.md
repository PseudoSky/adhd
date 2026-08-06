# 🤖 Agent Instructions: Universal Monorepo Architecture

You are an expert full-stack engineer operating within a high-scale **Nx Monorepo**. You must strictly adhere to the architectural hierarchy, platform isolation, and testing protocols defined below.

> **`CLAUDE.md` is a symlink to this file.** There is exactly one agent-instruction
> document. Edit `AGENTS.md`; never create a divergent `CLAUDE.md`. (They previously
> diverged, and the stale copy — which was the injected one — is what stranded the
> `agent-*` plan corpus on dead `packages/ai/*` paths. See BUG-WORKSPACE-GEN-001.)

## Rules

- You must not push without human approval
- You always plan before acting
- You never run destructive bash commands without evaluating failure cases
- You always write tests for the real user use cases (the way in which a 3rd party consumes a package)
- You do not run git stash commands ever
- **You never run `git reset --hard` (or `git checkout -- .` / `git restore` over a whole tree).** It silently and irrecoverably destroys uncommitted work — including work belonging to other agents running concurrently in this repo. It has already cost this project real work. To discard one file: `git restore <path>`. To move HEAD without touching files: `git reset --soft`. To inspect a clean tree: use a worktree under `.worktrees/`. If you believe a hard reset is genuinely required, **stop and ask a human.**
- You never run `git clean -fd` (or any `git clean` with `-f`) without human approval — it deletes untracked files, which is where new, unsaved work lives
- You always reuse packages within the repository instead of rewriting code
- You always evaluate best of class 3rd party tools before authoring
- You always get human approval before installing external tools
- You never create folders in the repo root without human approval
- You never chain file removals in bash commands
- You never write fs removals within scripts relying on variables without human approval
- You file, claim, transition, and resolve backlog items via the `backlog` CLI / `mcp__backlog__*` tools — never by hand-editing a `BACKLOG.md`. Every `BACKLOG.md` is now a generated projection of the global backlog graph (`@adhd/backlog`, migration phase-3); a hand edit is overwritten on the next render and rejected by the parity gate. Check `backlog migration-status` for the authoritative phase. (For this repo, this supersedes the global "store deferrals/bugs to BACKLOG.md" disclosure rule.)
- You never declare bugs as "pre-existing"
- After merging branches or worktrees, you always clean up the branch and write to the apropriate changelogs
- You always update relevant docs to include surface features added (add to backlog if the docs do not exist)

---

## 📦 1. Package Scaffolding — ALWAYS use `@adhd/workspace-codegen-nx`

**ALWAYS use `@adhd/workspace-codegen-nx` generators to scaffold new packages.** Never use `@nx/js:library`, `@nx/vite:lib`, or any other generic Nx generator — they produce incorrect `project.json`, tags, and Nx configuration for this monorepo. Never hand-create a package directory.

> `scripts/generate-lib.sh` is **DEPRECATED and disabled** (exits 1). It scaffolded into
> `packages/{shared,features,design-system,ai,testing,node-tools,other}/` — **all seven of
> those directories are gone**. Its `ai` branch is the upstream source of the dead
> `packages/ai/*` paths in the plan corpus. If you find a doc or plan citing it, that
> artifact is stale — fix it and log it.

### The invocation

```bash
npx nx g @adhd/workspace-codegen-nx:<tier> \
  --name=<bare-name> --group=<domain> \
  --nxLayer=<layer> --platform=<node|browser|shared> \
  [--access public] [--publish true] --dry-run
```

**Always `--dry-run` first**, read the CREATE list, then re-run without it.

### ⚠️ Pass the BARE name — the generator composes the full name itself

The generator builds `<group>-<tier>-<name>` for you:

```
--name=migration --group=agent  + tier `engine`  →  packages/agent/agent-engine-migration
--name=agent-engine-migration   + tier `engine`  →  agent-engine-agent-engine-migration  ❌
```

### Tiers (the generator collection)

| Tier | Command | Usage |
|-------|---------|-------|
| **types** | `nx g @adhd/workspace-codegen-nx:types --group <domain> --name <name>` | Pure type/contract packages (zero deps, `access:public`) |
| **base** | `nx g @adhd/workspace-codegen-nx:base --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Zero internal deps, roots of dep graph |
| **core** | `nx g @adhd/workspace-codegen-nx:core --group <domain> --name <name> --nxLayer <layer> --platform <platform> [--access public] [--publish true]` | Depends only on base packages |
| **engine** | `nx g @adhd/workspace-codegen-nx:engine --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Orchestration/wiring (depends on base + core) |
| **store** | `nx g @adhd/workspace-codegen-nx:store --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Persistence/storage (depends on base + core) |
| **plugin** | `nx g @adhd/workspace-codegen-nx:plugin --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Optional extension |
| **generator** | `nx g @adhd/workspace-codegen-nx:generator --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Code generator |
| **query** | `nx g @adhd/workspace-codegen-nx:query --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Query engine |
| **entrypoint** | `nx g @adhd/workspace-codegen-nx:entrypoint --name <name> --nxLayer entrypoints --platform node [--access public] [--publish true]` | CLI/server/runner (lives under `entrypoint/`, **not** `packages/`) |

### Domains (`--group`)

The authoritative list is **`.adhd/workspace.json`** — the generator validates against it and rejects unknown groups. Current: `apigen`, `agent`, `data`, `dispatch`, `environment`, `ui-react`, `workspace`. Adding a domain means adding it there first.

### Naming convention

Packages follow `<domain>-<tier>-<name>` and live at `packages/<domain>/<domain>-<tier>-<name>/`. Entrypoints live at `entrypoint/<name>/`.

**Full convention, tier vocabulary, and the "should this be a package at all?" checklist: [`docs/contributing/conventions/package-naming.md`](docs/contributing/conventions/package-naming.md).**

**Why a project builds with `@nx/js:tsc` instead of `@nx/vite:build`:** [`docs/contributing/conventions/build-executor-choice.md`](docs/contributing/conventions/build-executor-choice.md).

### Before you scaffold: should this be a package at all?

A `packages/` entry is a **library with importers**. If nothing will `import` it, it is not a package:

- **One-shot migrations / ETL** → a temporary, uncommitted throwaway script. Reusable tooling is *not* one-shot: build/publish gates belong in a `tools/nx-plugins/*` plugin (e.g. the `@adhd/nx-build` executors), and a reusable CLI belongs in the owning `entrypoint/` package (e.g. DAG validation is `dispatch-cli`'s `validate` command).
- **A CLI / server / runner** → `entrypoint/`, via the `entrypoint` generator.
- **A library that must never publish** → `--publish` already defaults to `false`; leave it.

### Non-JS packages (Python, Rust)

The `@adhd/workspace-codegen-nx` generators emit TypeScript packages. Python and Rust packages use their own Nx plugins (`@nxlv/python`, `@monodon/rust`, both registered in `nx.json`) but **must still conform to the `<domain>-<tier>-<name>` layout and the `domain:`/`platform:` tags**.

#### Python-specific

Use `@nxlv/python`. Keep the package under `packages/<domain>/<domain>-<tier>-<name>/`, and set tags in `project.json` by hand to match what the TS generator would emit.

#### Rust-specific

Use `@monodon/rust`. Same layout and tagging rule as Python.

---

## 🏗️ 2. Architectural Hierarchy & Dependency Flow

Dependencies flow **strictly downward**. Higher layers orchestrate; lower layers provide primitives. Never allow upward or circular dependencies.

### ⚠️ `domain` is the DIRECTORY. `layer` is a TAG. They are orthogonal

This is the single most misread rule in the repo. A package's **directory** is its
`domain` (`packages/agent/`, `packages/dispatch/`). Its **`layer:` tag** is an
independent Nx boundary attribute. Layers do **not** map to directories — an earlier
version of this doc said they did (`layer:data → packages/shared/`), which is how
`packages/ai/` and `packages/shared/` got scaffolded and then stranded.

**Directory** = `packages/<domain>/<domain>-<tier>-<name>/`

**Tier** (`pkg-kind:` tag) — position in the dep graph:

| Tier | Meaning | Depends on |
|---|---|---|
| `base` / `types` | zero-dep types & spec | nothing |
| `core` | pure logic | base |
| `store` | persistence | base + core |
| `engine` | orchestration | base + core + store |
| `serializer` / `plugin` / `generator` / `query` | adapters & extensions | base + core |

**Layer** (`layer:` tag) — the Nx module-boundary attribute, set via `--nxLayer`.
Valid values: `shared`, `logic`, `data`, `entrypoints`, `ui-primitives`, `ui-composites`, `components`, `workflows`, `ai`, `mcp`.

**Tags the generator emits** (verified): `domain:<group>`, `pkg-kind:<tier>`, `pkg-class:<class>`, `layer:<nxLayer>`, `platform:<platform>`, `access:<access>`.

Use `npx nx graph` to verify dependency flow.

## 🛑 3. Platform Isolation (Environment Rules)

We use a "Two-Way Mirror" to prevent environment crashes and security leaks:

- **`platform:node`**: Used for **CLI tools** (e.g., `decompile`).
  - _Constraint:_ **NEVER** import Browser code (`react-hooks`, `window`, `document`, CSS).
- **`platform:browser`**: Used for **UI** (React Apps, Storybook).
  - _Constraint:_ **NEVER** import Node internals (`fs`, `path`, server-side resolvers).
- **`platform:shared`**: Used for **Universal Tools**.
  - _Constraint:_ Must be **Pure TypeScript**. It must be safe to run in both a Node CLI and a Browser window.

## 🧭 4. Existing Package Context

Refer to these established packages when building new features. **Verify with `CI=true npx nx list` before relying on any name here** — this section has gone stale before.

- **`@adhd/decompile`** (`packages/decompile`): Node CLI entrypoint. **platform:node.**
- **`@adhd/data-query-engine`** (`packages/data/data-query-engine`): In-browser/Node DB engine. **platform:shared.**
- **`@adhd/data-*`** (`packages/data`): Generic data analysis utilities. **platform:shared.**
- **`@adhd/data-base-transforms`** (`packages/data/data-base-transforms`): Basic type transforms (camelCase, deepCopy). **platform:shared.**
- **`@adhd/ui-react-base-storybook`** (`packages/ui-react/ui-react-base-storybook`): UI testing config. **platform:browser.** (The sole `private: true` package.)
- **Agent Registry Family** (`packages/agent/*`): 12-package ecosystem for modular agent execution. NO longer opens DBs at import; use `@adhd/agent-core-env` for shared registry DB resolution.
  - **Core/Types**: `agent-base-types` (no deps), `agent-core-env` (lazy registry DB resolver via Environment DI, **NEW v0.0.1**), `agent-core-policy`, `agent-core-provider`
  - **Stores**: `agent-store-prompts` (component/composition/usecase/composed-prompt stores), `agent-store-tools` (tool registry), `agent-store-runtime` (runtime state)
  - **Orchestration**: `agent-engine-compiler`, `agent-engine-orchestrator`
  - **Extensions**: `agent-generator-plugin`, `agent-plugin-budget`, `agent-plugin-sanitize`
  - Host: `entrypoint/agent-mcp`
- **Dispatch Family** (`packages/dispatch/*`): task DAG execution. Contains: `dispatch-base-spec`, `dispatch-core-client`, `dispatch-core-optimizer`, `dispatch-orchestrator`, `dispatch-serializer-json`. Host: `entrypoint/dispatch-cli`.
- **Apigen Family** (`packages/apigen/*`): Code-first API generation from TypeScript types. Extract types → compose schemas → live-mount to any transport (HTTP, CLI, MCP, OpenAPI, Python) with zero code generation. **NEW 0.0.1 (2026-07-28):** Batch/bulk fan-out operations (`_batch/<kind>` synthetic mounts, portable across all hosts). Core: `apigen-core-client` (schema derivation, batch logic), `apigen-engine-runtime` (TS runtime execution, concurrency modes), `apigen-base-logical` (logical-type transcoding contracts; also ships `synthesizeExample`/`renderExampleNote` — schema-driven worked-example synthesis, consumed by `apigen-engine-runtime`'s tool descriptions and validate-Layer error messages, **NEW 2026-07-31**). Plugins: `apigen-plugin-api-fastify`, `apigen-plugin-api-express`, `apigen-plugin-batch`, `apigen-plugin-mcp`, `apigen-plugin-openapi`, `apigen-plugin-cli-output`, `apigen-plugin-py-flask`, `apigen-plugin-py-grpc`. **Critical fix (2026-07-28):** `BUG-APIGEN-CORE-CLIENT-001` — schema extraction for nested interfaces now correctly computes `required` array; this is a validation-tightening fix affecting all apigen-based operations repo-wide. See CHANGELOG for details. Host: `entrypoint/apigen-cli`. Spec: `docs/apigen/SPEC.md`, `docs/spec/apigen/BATCH_0.0.1.md`.
- **Environment Cascade** (`packages/environment/*`, **NEW v0.0.1**): Zero-config configuration (code defaults → system → global → project → env vars). Consumers: agent-mcp (config, logging, plugins, queue, server, SSE, transport, DB paths), apigen-plugin-mcp (multi-instance port binding). Tier: core/base. Platform: node. Layers: base-spec, builder, core-node.
- **Workspace Codegen** (`packages/workspace/workspace-codegen-nx`): **MANDATORY** generator for package scaffolding. Tier: core. Platform: shared. Usage: `npx nx g @adhd/workspace-codegen-nx:<tier> --name <name> --group <domain> --nxLayer <layer> --platform <platform>`.

## 💻 5. Development & Nx Commands

- **List Projects:** `npx nx list`
- **Build Project:** `npx nx build <project-name>`
- **Run Tests:** `npx nx affected -t test` when the package has dependents — targeted `npx nx test <project>` exercises only that project and silently misses downstream consumers (`DEBT-PROCESS-AFFECTED-TEST-001`). `nx test <project>` is safe only for a leaf with zero dependents.
- **Linting:** `npx nx lint <project-name>` — includes `@nx/dependency-checks` (check-only, never mutates). Repair dependency drift with `npx nx run <project>:sync-deps` (or `npx nx affected -t sync-deps`) — the explicit, standalone replacement for the removed pre-commit `--fix`/auto-restage. **Never run dependency-checks in a workspace root without an installed `node_modules`** (e.g. a fresh `git worktree`): it misreports used deps as unused and strips them (`BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001`) — run `corepack yarn install` there first.
- **Verify a build actually loads:** `npx nx run <project>:verify-dist-load` (`npx nx affected -t verify-dist-load`) builds then `require()`/`import()`s the real `dist/` entry the way a consumer does. A green `nx test` resolves to source and never loads the production bundle, so it can pass while the shipped artifact throws on load.
- **Graph Visualization:** `npx nx graph` (Use this to verify dependency flow).

### Build & Type-Checking — NEVER run `tsc` directly

Never invoke `tsc` by hand. Type-checking goes through the project's Nx target (`npx nx build <project>` / the project's `tsc` target) so that inputs, path aliases, and the cache are all honored. A hand-rolled `tsc` invocation reads a different tsconfig resolution than the build does and will report phantom errors — or miss real ones.

### 🚫 NEVER use `--skip-nx-cache`

Do not pass `--skip-nx-cache` (or set `NX_SKIP_NX_CACHE`) to any `nx` command. The nx cache is **correct** — its inputs (`production` = `{projectRoot}/**/*` minus tests) already hash `package.json` (version), `README.md`, and all source, so a version bump, a README edit, or a source change **does** invalidate the cache and reach `dist/`. Trust it.

`--skip-nx-cache` is actively harmful: it runs the task **without reading or writing the cache**, so it builds fresh output to `dist/` but leaves the cache holding an **older entry**. A later normal build then sees matching inputs, **restores that stale cached output over your fresh `dist/`**, and a publish ships the wrong artifact (e.g. an old version → `cannot publish over previously published versions`). The "stale dist" symptom is _caused by_ `--skip-nx-cache`, not cured by it.

- Need a clean rebuild? Change an input (you already did, if you bumped a version) and run the normal cached build, or `npx nx reset` to clear the whole cache deliberately — never `--skip-nx-cache`.
- Prove a cache hit/miss by running the build twice and reading nx's output; don't reach for the flag.
- Releases go through `nx release publish` (clean build + test, normal cache) — it ships the right artifact when the cache is left alone.

## 🧹 6. Lint Responsibility

You are responsible for the lint status of every file you touch. Run `npx nx lint <project>` on the affected project before considering work complete, and fix what you introduced. Do not disable a rule to make a warning go away without stating why in the code and logging it to BACKLOG.md.

## 🧪 7. Testing Protocol

- **Logic/Math:** Use `layer:test-logic` (Vitest/Node). Focus on edge cases and pure functions.
- **UI/Hooks:** Use `layer:test-ui` (JSDOM/Storybook). Focus on component states and user interactions.
- **Verification:** Before marking a task as complete, you must run the relevant test suite and ensure 0 failures.

### Proving features actually work (verification standard)

Green unit tests and passing `grep` audits are **not** proof a feature works. On a recent agent-mcp roadmap every plan was "green," yet driving the features through their real components surfaced four real bugs (an off-by-one cap, a lost cancellation reason, an unreachable HITL trigger, and a broken OAuth path). Hold every feature — and every plan's Definition of Done — to this bar:

1. **Verify the consumer outcome through REAL components, not mocks.** Add at least one integration test that wires the actual stores / engine / server / tools (real DB, real queue, real HTTP) and drives the feature the way a consumer does. Mock only the external boundary (the LLM/provider, a third-party API) — never the thing under test.
2. **Assertions must have teeth.** A behavioral test must FAIL if the bug is reintroduced. Prove it: revert the fix (or run a deliberately-wrong negative-control variant) and confirm the test goes red. A test that stays green when the code is broken proves nothing.
3. **Be deterministic without timing.** Prove concurrency with latches/barriers, await events with bounded deadlines, prove persistence by reopening the store — never `sleep`/wall-clock. A flaky proof is not a proof.
4. **Trust exit codes, not stdout.** Never gate on `… | grep -q passed` — it ignores the process exit code and hides crashes/failures (a ~50% teardown segfault once "passed" this way). Key on the runner's exit status.
5. **For LLM features, verify with a real model end-to-end.** A scripted/mock provider can fake a tool call the real model can't actually make — that exact gap left HITL unreachable until a live run exposed it. Add a live test that runs a real model through the real loop and asserts model-independent invariants. Gating it behind an env flag (e.g. `AGENT_MCP_LIVE=1`) is legitimate **only because a real model is a paid third-party service** — the one qualifying exception in _Live testing is mandatory_ below — and only if you document the approval (named owner, in README + AGENTS.md + the test header) as that section requires.
6. **Assert the consumer-visible outcome, not the implementation shape.** "`Promise.all` is present" is a proxy; "an agent gets N results back, faster" is the outcome. An implementation-shaped check can stay green while the guarantee regresses.

When authoring a plan with the `plan-state-machine` skill, each behavioral DoD clause must name the real entrypoint + observable and be proven by an audit check that drives it. **Never mark a task complete on proxy evidence.**

### Live testing is mandatory — no silent gating

**Start from the principle.** A feature is proven only by exercising it the way a consumer does — through the real entrypoint or built artifact. A test that doesn't run is not a safety net; it's a comment. We learned this the expensive way: env-gated "live" suites stayed green for months while the real `apigen run`/`serve` path was broken, and they hid several real bugs (BUG-009..013) that a single default-running test would have caught on the first commit.

**So the default is simple: every behavioural test runs by default, unflagged, in CI.** Spawning a local server, building the artifact first, taking a few seconds, needing `python3`/`grpcurl` on the box — none of these are reasons to gate. They are _setup_, and setup is the test's job (wire `dependsOn:["build"]`, provision the tool in CI). A feature is not "done" until a default-running test drives its real path, and the project's `demo`/`verify` target must do the same.

**There is exactly one exception, and it is narrow.** You may put a test behind an env flag _only_ when it calls a **paid or external third-party service** — something this system does not control, or that costs money per run (a real LLM, a billed API). That is the _only_ qualifying reason. Ask yourself: _"Does skipping this test save money or avoid an outside system I can't run myself?"_ If the honest answer is no, it runs by default — full stop.

**If — and only if — a test qualifies, the gate must be documented in the open:** the approval, with a named owner, surfaced in **all three** of the project's `README.md`, its `AGENTS.md`, and the gated test file's own header. An undocumented gate is a broken gate.

**Watch for the trap.** "It spawns child processes," "it needs a built CLI," "it's slow," "it's inconvenient in CI" — every one of these _feels_ like a reason and is _not_ one. They are the exact rationalizations that produce the blind spot. When a test has a hard local prerequisite, make it **fail loudly** if the prerequisite is missing (a missing `python3` should turn the suite red, never make it quietly skip). The single acceptable softening is an **optional external binary** (e.g. `grpcurl`): that one assertion may self-skip _with a visible warning_, and only so long as it never masks a failure in the code under test.

### Proving an MCP server works — drive the real tools, never a bypass

An MCP server's consumer seam is its **tools as loaded by a host** (`.mcp.json` → `mcp__<server>__*`). So the proof it works is to **call those loaded tools the way a host does** — against real state and real dependencies — and trust the returned **payload + exit code**, not a report. This applies to every MCP server in the repo, not just agent-mcp.

The trap to avoid: **if the tool isn't available, make it available — don't go around it.** When an `mcp__<server>__*` tool is missing or stale, the fix is to load it (build the server, point `.mcp.json` at the built artifact, `/mcp` reload) and call it. It is **not** license to run a shell script that spawns or — worse — _imports_ the build and calls its functions directly. That is our code calling our code; it skips the exact layer that fails in real use (host wiring, dist dependency resolution, tool registration, output-size limits), so it can pass while the shipped server is broken. A standalone script is acceptable **only** when it acts as a real MCP client (real JSON-RPC over stdio/http to the unmodified built server) — never when it reaches inside the server. Ask: _am I calling it like a host, or reaching inside it?_ Only the former proves anything.

## 🔄 8. Refactoring & Purity Protocol (CRITICAL)

You are responsible for maintaining the health of the shared ecosystem. **Follow these rules for every code change:**

1. **Prefer Imports over Creation:** Before writing a utility (e.g., deep copy, camelCase, data filter), check the existing `@adhd/data-*` packages (`data-base-transforms`, `data-query-engine`). **Always** use existing exports.
2. **The "Two-Use" Refactor Rule:** If you are writing logic in an `entrypoint` or feature that is generic and likely reusable, **STOP**.
    - Extract the logic.
    - Place it in the appropriate `packages/<domain>/` package at the right tier.
    - Import it back into the original file using the `@adhd/` scoped path.
3. **Dependency Purity:** `base`/`core` tier packages must **never** depend on higher tiers or UI. They are the bedrock.
4. **Hyphenated NPM Naming:** All new libraries must use hyphenated names (e.g., `network-helpers`, not `networkHelpers`) for NPM compatibility.

## 📝 9. Code Style & Standards

- **Naming:** Use PascalCase for Components, camelCase for functions/variables.
- **Interfaces:** Prefix all Shared/Data interfaces with `I` (e.g., `IUserRecord`).
- **Imports:** Always use Nx workspace paths (e.g., `@adhd/data-base-transforms`) instead of relative paths (`../../`). The import specifier must **exactly** equal the `package.json` name — a divergence builds in-repo via tsconfig paths and is broken on publish (BUG-DISPATCH-PUBLISH-001, BUG-AGENTMCP-001).
- **Docs:** New public functions must include JSDoc comments.

## 📁 10. Workspace Context

- **Ignore:** Always ignore `dist/`, `.nx/`, and `tmp/` folders.
- **Entry:** Start by reading `project.json` in the target library to confirm tags.

### Test/ephemeral artifacts — one central, always-cleaned location

Generated output, scratch DBs, logs, and test fixtures are **ephemeral and must never be tracked or scattered**. There is exactly **one canonical root: `tmp/`** (gitignored). Everything ephemeral writes under `tmp/<package>/…` (e.g. `tmp/apigen/generate-out`, `tmp/agent-mcp/test.db`) and is removable with `nx reset` or a project `clean` target.

- **Never invent ad-hoc artifact dirs** — no per-package `data/`, `dist-temp/`, `out-dir/`, or stray repo-root scratch. If code needs a scratch path, derive it under `tmp/`.
- **Never write a runtime/test DB to the repo root or a tracked path.** SQLite stores (`*.db`/`*.sqlite` + `-wal`/`-shm`) are gitignored globally; persistent app stores belong in the user home (e.g. agent-mcp → `~/.adhd/agent-mcp/`), never in the tree.
- **A test must clean up after itself** — write under `tmp/`, remove on teardown (bounded, deterministic; see §7). A test that leaves artifacts behind is a defect.
- The repo-root `data/` (created by agent-mcp's legacy `./data/agents.db` default) is gitignored; moving that default out of the tree is tracked in BACKLOG.

## 📦 11. Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the full version-bump, build, and publish workflow, including the post-publish checklist and per-package smoke test references.

## 💾 12. Commit Convention

- Use **Conventional Commits**: `feat(scope):`, `fix(scope):`, `refactor(scope):`.
- Always include the library name as the scope (e.g., `feat(ui-primitives): add segmented-control`).

## 🧵 13. Task Decomposition — when to fan out instead of looping in one context

adhd's token spend is dominated by a single structural anti-pattern, not by expensive models or bad prompts: a subagent given a naturally decomposable job (fix N files, migrate N backlog entries, orchestrate N independent steps) looping internally over all N items in **one continuous dispatch** instead of forking. Four real examples from one session alone: `backlog-tool-fixer` (399 sequential tool calls → 155M tokens), `typescript-pro` (341 calls → 122M tokens), `backlog-migrator-2` (360 calls → 112M tokens), `apigen-orch` (304 calls → 104M tokens) — combined tool *output* for each was under 1MB, and turn-by-turn inspection shows `cache_read` tokens climbing every turn while each turn's actual new output stays flat: every turn re-pays to re-read the entire accumulated conversation history, so cumulative cost over N turns grows faster than linearly with N. A controlled A/B test (8 files, same task, same model, only the dispatch structure varied) measured this directly: one continuous 9-turn dispatch cost 1.13x what the same work cost split into 8 independent one-turn dispatches via `pipeline()` — the effect is negligible at ~10 turns and dominant at the 300-400 turn scale these production dispatches ran at. Full detail: BACKLOG DEBT items for monolithic-dispatch (token-cost driver) and parked-teammate idle gaps (wall-clock driver).

**The rule:** before dispatching a Task/Agent for work that spans a list of independently-fixable items (files, tickets, migration targets, config entries, etc.), count the items first.

- **≤5 items, or the item count genuinely can't be known upfront:** a single `Agent()`/Task dispatch is fine.
- **>5 items, or you can already see the work is "the same fix repeated across a list":** use the `Workflow` tool's `pipeline()`/`parallel()` — one bounded `agent()` call per item — instead of a single dispatch that iterates internally. See the `Workflow` tool's own docstring for the pipeline-vs-barrier decision rule; default to `pipeline()`.
- **If a dispatch you're running is already past ~100 sequential tool calls and you can see more of the same-shaped work ahead:** stop, report back the remaining item list to your orchestrator, and let it re-dispatch the rest as parallel work rather than continuing serially.
- **Reserve Opus for judgment/architecture calls, not high-volume sweeps.** Running a 100+ call sweep on Opus stacks a 5x model-cost multiplier on top of the structural problem — decompose first, then pick the cheapest model that's sufficient per item.
- **Don't park teammates.** An `in_process_teammate`/`SendMessage`-based agent that has finished its assigned work should be closed out (`TaskStop`) — not left idle waiting for the next assignment. A parked teammate that sits for hours between jobs inflates session wall-clock and forces a cache-cold re-prime on its next resume.
- **Self-check periodically:** `scratch-claude-metadata flags <project>` (in `~/dev/ai/scratch/claude-metadata`) flags `MONOLITHIC_DISPATCH`, `IDLE_GAP`, `RETRY_LOOP`, `HIGH_ERROR_RATE`, and `HIGH_CHURN` against real session history — run it after a big orchestration to catch this before it compounds.

---

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **adhd** (23271 symbols, 35246 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- You may use the gitnexus cli or the mcp if available.
- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

### Never discard changes you did not author — surface them

If you encounter uncommitted changes in the working tree that you did not make, **do not revert, stash, or overwrite them**. Another agent or a human may be working concurrently. Surface them to the user and ask. See the `git reset --hard` rule in §Rules.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/adhd/context` | Codebase overview, check index freshness |
| `gitnexus://repo/adhd/clusters` | All functional areas |
| `gitnexus://repo/adhd/processes` | All execution flows |
| `gitnexus://repo/adhd/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **adhd** (29372 symbols, 43586 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/adhd/context` | Codebase overview, check index freshness |
| `gitnexus://repo/adhd/clusters` | All functional areas |
| `gitnexus://repo/adhd/processes` | All execution flows |
| `gitnexus://repo/adhd/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
