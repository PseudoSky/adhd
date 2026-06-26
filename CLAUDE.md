# 🤖 Claude Instructions: Universal Monorepo Architecture

You are an expert full-stack engineer operating within a high-scale **Nx Monorepo**. You must strictly adhere to the architectural hierarchy, platform isolation, and testing protocols defined below.

## 🏗️ 1. Architectural Hierarchy & Dependency Flow

Dependencies flow **strictly downward**. Higher layers orchestrate; lower layers provide primitives. Never allow upward or circular dependencies.

| Layer             | Tag                   | Directory                 | Purpose                                            |
| :---------------- | :-------------------- | :------------------------ | :------------------------------------------------- |
| **Entrypoints**   | `layer:entrypoints`   | `apps/`                   | CLI Tools (Node) or Apps (Browser).                |
| **Workflows**     | `layer:workflows`     | `packages/features/`      | Stateful user journeys & sub-routing.              |
| **Components**    | `layer:components`    | `packages/features/`      | **Merge Point.** UI meets Data (GQL/DB).           |
| **UI-Composites** | `layer:ui-composites` | `packages/design-system/` | Complex **Pure Visual** units (Cards).             |
| **UI-Primitives** | `layer:ui-primitives` | `packages/design-system/` | Atomic visual units (Buttons, Hooks).              |
| **Data**          | `layer:data`          | `packages/shared/`        | Data Engines (e.g., `query` package).              |
| **Logic**         | `layer:logic`         | `packages/shared/`        | Domain-specific Business Rules.                    |
| **Shared**        | `layer:shared`        | `packages/shared/`        | **Foundation Tools** (e.g., `data`, `transform`).  |

## 🛑 2. Platform Isolation (Environment Rules)

We use a "Two-Way Mirror" to prevent environment crashes and security leaks:

- **`platform:node`**: Used for **CLI tools** (e.g., `decompile`).
  - _Constraint:_ **NEVER** import Browser code (`react-hooks`, `window`, `document`, CSS).
- **`platform:browser`**: Used for **UI** (React Apps, Storybook).
  - _Constraint:_ **NEVER** import Node internals (`fs`, `path`, server-side resolvers).
- **`platform:shared`**: Used for **Universal Tools** (e.g., `query`, `data`, `transform`).
  - _Constraint:_ Must be **Pure TypeScript**. It must be safe to run in both a Node CLI and a Browser window.

## 🛠️ 3. Existing Package Context

Refer to these established packages when building new features:

- **`decompile`** (`packages/decompile`): A Node CLI entrypoint. **Platform: node.**
- **`query`** (`packages/query`): In-browser/Node DB engine. **Platform: shared.**
- **`data`** (`packages/data`): Generic data analysis utilities. **Platform: shared.**
- **`transform`** (`packages/transform`): Basic type transforms (camelCase, deepCopy). **Platform: shared.**
- **`react-hooks`** (`packages/react-hooks`): UI-only logic. **Platform: browser.**
- **`storybook`** (`packages/storybook`): UI testing config. **Platform: browser.**

## 🚀 4. Scaffolding Cheat Sheet

When generating new modules, use the syntax:
`./generate-lib.sh <app|lib> <name> <layer> <platform>`

- **New Logic/Util:** `./generate-lib.sh lib my-tool logic shared`
- **New UI Component:** `./generate-lib.sh lib user-card ui-composites browser`
- **New CLI Entrypoint:** `./generate-lib.sh app my-cli entrypoints node`
- **New React Entrypoint:** `./generate-lib.sh app web-dashboard entrypoints browser`

_Always verify the `project.json` after generation to ensure tags were applied correctly._

## 💻 5. Development & Nx Commands

- **List Projects:** `npx nx list`
- **Build Project:** `npx nx build <project-name>`
- **Run Tests:** `npx nx test <project-name>`
- **Linting:** `npx nx lint <project-name>`
- **Graph Visualization:** `npx nx graph` (Use this to verify dependency flow).

### 🚫 NEVER use `--skip-nx-cache`

Do not pass `--skip-nx-cache` (or set `NX_SKIP_NX_CACHE`) to any `nx` command. The nx cache is **correct** — its inputs (`production` = `{projectRoot}/**/*` minus tests) already hash `package.json` (version), `README.md`, and all source, so a version bump, a README edit, or a source change **does** invalidate the cache and reach `dist/`. Trust it.

`--skip-nx-cache` is actively harmful: it runs the task **without reading or writing the cache**, so it builds fresh output to `dist/` but leaves the cache holding an **older entry**. A later normal build then sees matching inputs, **restores that stale cached output over your fresh `dist/`**, and a publish ships the wrong artifact (e.g. an old version → `cannot publish over previously published versions`). The "stale dist" symptom is *caused by* `--skip-nx-cache`, not cured by it.

- Need a clean rebuild? Change an input (you already did, if you bumped a version) and run the normal cached build, or `npx nx reset` to clear the whole cache deliberately — never `--skip-nx-cache`.
- Prove a cache hit/miss by running the build twice and reading nx's output; don't reach for the flag.
- Releases go through `nx release publish` (clean build + test, normal cache) — it ships the right artifact when the cache is left alone.

## 🧪 6. Testing Protocol

- **Logic/Math:** Use `layer:test-logic` (Vitest/Node). Focus on edge cases and pure functions.
- **UI/Hooks:** Use `layer:test-ui` (JSDOM/Storybook). Focus on component states and user interactions.
- **Verification:** Before marking a task as complete, you must run the relevant test suite and ensure 0 failures.

### Proving features actually work (verification standard)

Green unit tests and passing `grep` audits are **not** proof a feature works. On a recent agent-mcp roadmap every plan was "green," yet driving the features through their real components surfaced four real bugs (an off-by-one cap, a lost cancellation reason, an unreachable HITL trigger, and a broken OAuth path). Hold every feature — and every plan's Definition of Done — to this bar:

1. **Verify the consumer outcome through REAL components, not mocks.** Add at least one integration test that wires the actual stores / engine / server / tools (real DB, real queue, real HTTP) and drives the feature the way a consumer does. Mock only the external boundary (the LLM/provider, a third-party API) — never the thing under test.
2. **Assertions must have teeth.** A behavioral test must FAIL if the bug is reintroduced. Prove it: revert the fix (or run a deliberately-wrong negative-control variant) and confirm the test goes red. A test that stays green when the code is broken proves nothing.
3. **Be deterministic without timing.** Prove concurrency with latches/barriers, await events with bounded deadlines, prove persistence by reopening the store — never `sleep`/wall-clock. A flaky proof is not a proof.
4. **Trust exit codes, not stdout.** Never gate on `… | grep -q passed` — it ignores the process exit code and hides crashes/failures (a ~50% teardown segfault once "passed" this way). Key on the runner's exit status.
5. **For LLM features, verify with a real model end-to-end.** A scripted/mock provider can fake a tool call the real model can't actually make — that exact gap left HITL unreachable until a live run exposed it. Add a live test that runs a real model through the real loop and asserts model-independent invariants. Gating it behind an env flag (e.g. `AGENT_MCP_LIVE=1`) is legitimate **only because a real model is a paid third-party service** — the one qualifying exception in *Live testing is mandatory* below — and only if you document the approval (named owner, in README + CLAUDE.md + the test header) as that section requires.
6. **Assert the consumer-visible outcome, not the implementation shape.** "`Promise.all` is present" is a proxy; "an agent gets N results back, faster" is the outcome. An implementation-shaped check can stay green while the guarantee regresses.

When authoring a plan with the `plan-state-machine` skill, each behavioral DoD clause must name the real entrypoint + observable and be proven by an audit check that drives it. **Never mark a task complete on proxy evidence.**

### Live testing is mandatory — no silent gating

**Start from the principle.** A feature is proven only by exercising it the way a consumer does — through the real entrypoint or built artifact. A test that doesn't run is not a safety net; it's a comment. We learned this the expensive way: env-gated "live" suites stayed green for months while the real `apigen run`/`serve` path was broken, and they hid several real bugs (BUG-009..013) that a single default-running test would have caught on the first commit.

**So the default is simple: every behavioural test runs by default, unflagged, in CI.** Spawning a local server, building the artifact first, taking a few seconds, needing `python3`/`grpcurl` on the box — none of these are reasons to gate. They are *setup*, and setup is the test's job (wire `dependsOn:["build"]`, provision the tool in CI). A feature is not "done" until a default-running test drives its real path, and the project's `demo`/`verify` target must do the same.

**There is exactly one exception, and it is narrow.** You may put a test behind an env flag *only* when it calls a **paid or external third-party service** — something this system does not control, or that costs money per run (a real LLM, a billed API). That is the *only* qualifying reason. Ask yourself: *"Does skipping this test save money or avoid an outside system I can't run myself?"* If the honest answer is no, it runs by default — full stop.

**If — and only if — a test qualifies, the gate must be documented in the open:** the approval, with a named owner, surfaced in **all three** of the project's `README.md`, its `CLAUDE.md`, and the gated test file's own header. An undocumented gate is a broken gate.

**Watch for the trap.** "It spawns child processes," "it needs a built CLI," "it's slow," "it's inconvenient in CI" — every one of these *feels* like a reason and is *not* one. They are the exact rationalizations that produce the blind spot. When a test has a hard local prerequisite, make it **fail loudly** if the prerequisite is missing (a missing `python3` should turn the suite red, never make it quietly skip). The single acceptable softening is an **optional external binary** (e.g. `grpcurl`): that one assertion may self-skip *with a visible warning*, and only so long as it never masks a failure in the code under test.

### Proving an MCP server works — drive the real tools, never a bypass

An MCP server's consumer seam is its **tools as loaded by a host** (`.mcp.json` → `mcp__<server>__*`). So the proof it works is to **call those loaded tools the way a host does** — against real state and real dependencies — and trust the returned **payload + exit code**, not a report. This applies to every MCP server in the repo, not just agent-mcp.

The trap to avoid: **if the tool isn't available, make it available — don't go around it.** When an `mcp__<server>__*` tool is missing or stale, the fix is to load it (build the server, point `.mcp.json` at the built artifact, `/mcp` reload) and call it. It is **not** license to run a shell script that spawns or — worse — *imports* the build and calls its functions directly. That is our code calling our code; it skips the exact layer that fails in real use (host wiring, dist dependency resolution, tool registration, output-size limits), so it can pass while the shipped server is broken. A standalone script is acceptable **only** when it acts as a real MCP client (real JSON-RPC over stdio/http to the unmodified built server) — never when it reaches inside the server. Ask: *am I calling it like a host, or reaching inside it?* Only the former proves anything.

## 🔄 8. Refactoring & Purity Protocol (CRITICAL)

You are responsible for maintaining the health of the shared ecosystem. **Follow these rules for every code change:**

1.  **Prefer Imports over Creation:** Before writing a utility (e.g., deep copy, camelCase, data filter), check `@adhd/data`, `@adhd/transform`, and `@adhd/query`. **Always** use existing exports.
2.  **The "Two-Use" Refactor Rule:** If you are writing logic in an `app` or `feature` that is generic and likely reusable, **STOP**.
    - Extract the logic.
    - Place it in the appropriate `packages/` shared package (e.g., `transform`).
    - Import it back into the original file using the `@adhd/` scoped path.
3.  **Dependency Purity:** Shared packages (`data`, `transform`) must **never** depend on high-level logic or UI. They are the bedrock.
4.  **Hyphenated NPM Naming:** All new libraries must use hyphenated names (e.g., `network-helpers`, not `networkHelpers`) for NPM compatibility.

## 📝 7. Code Style & Standards

- **Naming:** Use PascalCase for Components, camelCase for functions/variables.
- **Interfaces:** Prefix all Shared/Data interfaces with `I` (e.g., `IUserRecord`).
- **Imports:** Always use Nx workspace paths (e.g., `@adhd/transform`) instead of relative paths (`../../`).
- **Docs:** New public functions in `packages/shared` must include JSDoc comments.

## 📁 Workspace Context

- **Ignore:** Always ignore `dist/`, `.nx/`, and `tmp/` folders.
- **Entry:** Start by reading `project.json` in the target library to confirm tags.

### Test/ephemeral artifacts — one central, always-cleaned location

Generated output, scratch DBs, logs, and test fixtures are **ephemeral and must never be tracked or scattered**. There is exactly **one canonical root: `tmp/`** (gitignored). Everything ephemeral writes under `tmp/<package>/…` (e.g. `tmp/apigen/generate-out`, `tmp/agent-mcp/test.db`) and is removable with `nx reset` or a project `clean` target.

- **Never invent ad-hoc artifact dirs** — no per-package `data/`, `dist-temp/`, `out-dir/`, or stray repo-root scratch. If code needs a scratch path, derive it under `tmp/`.
- **Never write a runtime/test DB to the repo root or a tracked path.** SQLite stores (`*.db`/`*.sqlite` + `-wal`/`-shm`) are gitignored globally; persistent app stores belong in the user home (e.g. agent-mcp → `~/.adhd/agent-mcp/`), never in the tree.
- **A test must clean up after itself** — write under `tmp/`, remove on teardown (bounded, deterministic; see §6). A test that leaves artifacts behind is a defect.
- The repo-root `data/` (created by agent-mcp's legacy `./data/agents.db` default) is gitignored; moving that default out of the tree is tracked in BACKLOG.

## 📦 Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the full version-bump, build, and publish workflow, including the post-publish checklist and per-package smoke test references.

## 💾 Commit Convention

- Use **Conventional Commits**: `feat(scope):`, `fix(scope):`, `refactor(scope):`.
- Always include the library name as the scope (e.g., `feat(ui-primitives): add segmented-control`).
