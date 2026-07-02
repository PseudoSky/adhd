# dispatch-cli

The human dispatcher CLI for `docs/plan/dispatch-production` (and any other
plan-state-machine `dag.json`). This package holds **no hand-written CLI
code** — `src/api.ts` is a plain, JSDoc'd TypeScript functions surface;
[`@adhd/apigen`](../../apigen) generates the actual Commander CLI from it (see
`generate-cli` in `project.json`). `src/api.ts` is the contract; the
generated CLI is a disposable projection of it.

## Commands

| Command | Reads/writes | What it does |
|---|---|---|
| `validate --dag-path <p>` | read-only | `@adhd/dispatch-spec`'s structural validator over the dag file. |
| `snapshot --dag-path <p>` | read-only | Real `DagClient` + `@adhd/dispatch-optimizer`'s `snapshot()`, cold-start B/context-window defaults. |
| `optimize --dag-path <p>` | read-only | Snapshot + the greedy `optimize()` — the next batch of `DispatchUnit`s that would be packed. |
| `eligible --dag-path <p>` | read-only | `DagClient.getEligibleMilestones()` — milestone slugs whose deps are complete per `dispatch_log`. |
| `status --dag-path <p>` | read-only | Per-milestone `{ status, loggedOperationIds, tokensEstimated, tokensActual }`. |
| `run --dag-path <p> [--dry-run]` | **writes** the dag | Runs exactly one `@adhd/dispatch-orchestrator` scheduling cycle. |
| `calibrate --model-tier <Haiku\|Sonnet\|Opus>` | **writes** `~/.adhd/dispatch-calibration.json` | Fires a null-task dispatch to measure a baseline per-tier token cost ("B"). |

## Generate + run the CLI

```bash
npx nx run dispatch-cli:generate-cli   # → dist/packages/dispatch/dispatch-cli/cli/cli.ts

npx tsx --tsconfig tsconfig.base.json \
  dist/packages/dispatch/dispatch-cli/cli/cli.ts \
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

**CLI caveat:** the apigen `cli-output` plugin emits boolean flags as
presence-only (`--dry-run` sets `true`; there is no `--no-dry-run` negation),
so the *generated* CLI can only ever request the safe default — it cannot
reach `dryRun: false`. Reaching the real path today requires calling `run()`
directly from TypeScript. See the cli milestone completion report
(`docs/plan/dispatch-production`) for the tracked follow-up.

Neither path is exercised by this package's default-running tests, which
call the DI'd `lib/core.ts` functions directly with an injected
`MockAgentRunner` and a calibration path under `tmp/dispatch-cli/`.

## Building

Run `nx build dispatch-cli` to build the library.

## Running unit tests

Run `nx test dispatch-cli` to execute the unit tests via [Vitest](https://vitest.dev/)
— includes a default-running smoke test that generates the real CLI and
spawns it as a child process.
