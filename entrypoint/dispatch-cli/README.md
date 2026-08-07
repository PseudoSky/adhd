# dispatch-cli

The human dispatcher CLI for `docs/plan/dispatch-production` (and any other
plan-state-machine `dag.json`). This is a published, **npx-invocable command-line tool** — `package.json` declares `bin: { "dispatch-cli": "./dist/bin/cli.js" }`, and `npm run build` compiles the hand-written `bin/cli.ts` fallback into the `dist/bin/cli.js` executable that ships with the package.

The CLI wraps `src/api.ts`, a plain, JSDoc'd TypeScript functions surface where all commands are defined. The published binary (`dist/bin/cli.js`) is the compiled-to-JavaScript version of `bin/cli.ts`, which is a hand-written Commander wrapper over the same `api.ts` contract.

## Commands

| Command | Reads/writes | What it does |
|---|---|---|
| `validate --dag-path <p>` | read-only | `@adhd/dispatch-base-spec`'s structural validator over the dag file. |
| `snapshot --dag-path <p>` | read-only | Real `DagClient` + `@adhd/dispatch-core-optimizer`'s `snapshot()`, cold-start B/context-window defaults. |
| `optimize --dag-path <p>` | read-only | Snapshot + the greedy `optimize()` — the next batch of `DispatchUnit`s that would be packed. |
| `eligible --dag-path <p>` | read-only | `DagClient.getEligibleMilestones()` — milestone slugs whose deps are complete per `dispatch_log`. |
| `status --dag-path <p>` | read-only | Per-milestone `{ status, loggedOperationIds, tokensEstimated, tokensActual }`. |
| `run --dag-path <p> [--dry-run]` | **writes** the dag | Runs exactly one `@adhd/dispatch-orchestrator` scheduling cycle. |
| `calibrate --model-tier <Haiku\|Sonnet\|Opus>` | **writes** `~/.adhd/dispatch-calibration.json` | Fires a null-task dispatch to measure a baseline per-tier token cost ("B"). |

## Run the CLI

After installation and build, invoke the compiled binary directly:

```bash
npx dispatch-cli eligible --dag-path docs/plan/dispatch-production/dag.json
```

In development (in-repo), build the compiled binary first:

```bash
npx nx run dispatch-cli:build-bin
npx dispatch-cli eligible --dag-path docs/plan/dispatch-production/dag.json
```

Or use `tsx` directly against the hand-written `bin/cli.ts` fallback:

```bash
npx tsx --tsconfig tsconfig.base.json \
  bin/cli.ts \
  eligible --dag-path docs/plan/dispatch-production/dag.json
```

(No root `tsconfig.json` exists in this repo — `--tsconfig tsconfig.base.json`
is required so `tsx` resolves `@adhd/*` workspace imports.)

## The paid boundary — `run` and `calibrate`

`run`'s `dryRun` defaults to `true` (and anything other than the literal
`false` is treated as `true`): the safe default wires `MockAgentRunner` — no
network, no cost, fully deterministic. `dryRun: false` wires a real
`AgentMcpRunner` that spawns `npx -y @adhd/agent-mcp` and fires real, billed
model calls. `calibrate` *always* fires one real model call.

**CLI implementation:** `bin/cli.ts` (the hand-written fallback) uses Commander's native `--no-dry-run` negation, so it *does* reach the real paid path from the command line — proved by `cli-smoke.spec.ts`'s `run --no-dry-run` test. This is the CLI that ships (compiled to `dist/bin/cli.js` and executed via `npx dispatch-cli`).

Neither path is exercised by this package's default-running tests, which
call the DI'd `lib/core.ts` functions directly with an injected
`MockAgentRunner` and a calibration path under `tmp/dispatch-cli/`.

## Building

Run `nx build dispatch-cli` to build the main library code. This does NOT compile the CLI binary — you must also run `nx run dispatch-cli:build-bin` to compile `bin/cli.ts` to JavaScript (`dist/bin/cli.js`), which is what gets published.

For a complete build (library + CLI binary):
```bash
npx nx run dispatch-cli:build-bin
```

The `build-bin` target depends on `build`, so it runs both automatically. This produces `dist/bin/cli.js`, which is declared as the `bin` entry in `package.json` and becomes the npx-invocable command when the package is published.

## Running unit tests

Run `nx test dispatch-cli` to execute the unit tests via [Vitest](https://vitest.dev/).
This automatically builds and tests:
- The generated CLI (via `generate-cli` target)
- The compiled binary (via `build-bin` target) — the actual `dist/bin/cli.js` that ships with the package
- Smoke tests that spawn both CLI paths as child processes

## Real end-to-end lifecycle test

`src/test/integration/real-e2e.ts` is a self-executing `tsx` script (NOT a
Vitest spec — it lives outside `src/**/*.{spec,test}.ts` on purpose, so `nx
test dispatch-cli` never picks it up) that drives the FULL
`docs/plan/dispatch-production` product lifecycle through real components:
a real `DagClient` + `createJsonFileSerializer` writing an actual `dag.json`
under `tmp/dispatch-cli/e2e/`, `@adhd/dispatch-core-optimizer`'s real
`snapshot()`/`optimize()`, `@adhd/dispatch-orchestrator`'s real
`orchestrateCycle()`, and this package's own `bin/cli.ts` spawned as a real
child process for every CLI-facing assertion. Eight required scenarios run
by default (cold start, author, snapshot+optimize, dispatch, a second cycle,
a guard failure, its correction, and a simulated process-resume) —
deterministic and free, using `MockAgentRunner` as the sole test double (the
agent-mcp task-runner boundary). Run it with:

```bash
npx nx build dispatch-cli && npx tsx --tsconfig tsconfig.base.json \
  entrypoint/dispatch-cli/src/test/integration/real-e2e.ts
```

It prints a per-scenario result table and exits 0 iff every required
scenario passes.

### Live e2e gate

One additional, fully independent scenario is gated behind
`DISPATCH_E2E_LIVE=1` and is **skipped by default** with a loud console
notice. When enabled, it fires **one real, billed agent-mcp dispatch** (a
`claudecli`-provider agent — i.e. whatever model the local `claude` CLI
resolves to) through the real `AgentMcpRunner` (`npx -y @adhd/agent-mcp`),
asks it to write a real file to disk, and verifies via a real shell guard
(`test -f <file>`) that it did.

This is the repo's single legitimate env-gate exception (CLAUDE.md §6,
"Live testing is mandatory" — a real model is a paid third-party service).
The gate is disclosed here, in the test file's own header, and in the
repo-root `CLAUDE.md`:

- **Gate:** `DISPATCH_E2E_LIVE=1`
- **Approved by (named owner):** the repo owner/maintainer, git user
  `pseudosky` (skywinstonsk@gmail.com)
- **Cost/requirement:** real money/quota per run; requires local
  `claude auth status` to already be configured (no API key needed —
  `claudecli` drives the local Claude Code CLI directly, it is not gated on
  an Anthropic API key)

Run it explicitly with:

```bash
DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json \
  entrypoint/dispatch-cli/src/test/integration/real-e2e.ts
```
