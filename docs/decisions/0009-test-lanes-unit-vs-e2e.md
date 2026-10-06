# ADR-0009 — Test lanes: unit `test` runs no subprocess; `e2e` owns every subprocess / real-server suite

**Status:** ACCEPTED (2026-10-06) — owner approval relayed by dispatch-2026-10-06-48dc, conditional wording fix applied. The lane model itself is already in force in `docs/PIPELINE.md` §2 and the apigen/backlog `e2e` targets.
**Owner:** devops (pipeline) with the repo owner.
**Supersedes:** nothing.
**Drives:** backlog 5b839b90 (agent packages: separate subprocess-spawning tests into a dedicated e2e lane).
**Grounding:** owner request (verbatim): "I want you to properly set up the e2e spec lanes for agent packages such that subprocess running tests properly separate there should be an adr about this already." A search of `docs/decisions/` (0001–0008) and `docs/` found no ADR on test lanes; the only record was `docs/PIPELINE.md` §2 (stages 4–5) and the per-project comments in `entrypoint/backlog/project.json` / `packages/apigen/apigen-plugin-mcp/project.json`. Incident: `packages/agent/agent-engine-orchestrator/src/__tests__/native-tooling-caller-cwd.test.ts` spawns a real `npx` MCP server inside the unit lane and timed out under load, blocking a release.

## TL;DR for the next agent

A test that spawns a process (`child_process`, `StdioClientTransport`/`StdioMcpClient`, a stdio MCP server on `npx`/`uvx`/`srt`/`node`) is an **e2e** test: name it `*.e2e.test.ts` (agent family) or `*.e2e.ts` (apigen/backlog convention) and it runs in the project's `e2e` target (`nx affected -t e2e --parallel=1`) — its own pipeline stage (docs/PIPELINE.md:30), not `nx test`. The unit `test` target excludes those files. Separately, e2e tests are not env-gated except under the paid-third-party exception in AGENTS.md §7. The trap: renaming a file is not enough — the project needs an `e2e` target and a `vitest.e2e.config.ts`; `check-lane-reachability.mjs` rules 1 and 8 fail the gate if either is missing.

## Context

`docs/PIPELINE.md` §2 already orders the stages `test` then `e2e` (own lane, `--parallel=1`). apigen-* and `entrypoint/backlog` implement it; the agent family (`packages/agent/*`, `entrypoint/agent-mcp`, `entrypoint/dispatch-cli`) did not: 12 subprocess-spawning suites ran inside the unit `test` lane at `--parallel=5`, where load-induced timeouts are nondeterministic. Not established: the exact set of non-agent packages with the same defect (apigen's `flat-content-payload.spec.ts` spawns built dist in its default lane by documented choice).

## Decision

### D1 — Lane contract

Unit `test` = no subprocess, no bound ports to real servers, fast, cacheable at `--parallel=5`. `e2e` = every suite that spawns a process or runs a real server; run with `--parallel=1` as its own pipeline stage (docs/PIPELINE.md:30; in ci.yml after `lint test build verify-dist-load`, docs/PIPELINE.md:36-37), never inside `nx test`; not env-gated (paid-third-party exception only, AGENTS.md §7); cached on content (`cache:true`, `inputs` containing `default`, no declared `outputs`); reached by the gate via `tools/gate/lane-gate.mjs` `GATE_TARGETS` and by `publish` / `nx-release-publish`.

### D2 — File convention and single source

An e2e file matches `*.e2e.ts` or `*.e2e.test.ts` (`tools/vite-plugins/e2e-globs.mjs` is the one definition). The unit lane excludes them (`E2E_FILE_EXCLUDES` in the project's `vite.config.ts` `test.exclude`); the e2e lane includes them (`defineE2eConfig` in `tools/vite-plugins/e2e-config.mjs`, via `vitest.e2e.config.ts`). A file is in exactly one lane. New `*.e2e.test.ts` files in an agent project land in e2e automatically.

### D3 — Isolation

An e2e that spawns agent-mcp passes an isolated cwd and a fake `HOME` (adhd ADR-0008 D4/line 32: `loadEnvHierarchy` loads `<cwd>/.env` with `override:true`).

### D4 — Mechanical enforcement

`tools/nx-plugins/test/executors/wiring/check-agent-lane-spawn.mjs` (invoked as rule 8 of `check-lane-reachability.mjs`, run unconditionally by pre-push and both CI workflows) fails when an agent-family unit-lane file spawns a subprocess, when a project with `*.e2e.test.ts` does not exclude them from its unit lane, or when a `pendingMove` baseline entry is stale. Negative controls: `check-agent-lane-spawn.spec.mjs`.

## Consequences

- **Every agent project with spawning tests owns an `e2e` target** and its `publish`/`nx-release-publish` reaches it — a broken heavy suite cannot publish green.
- **`pendingMove` baseline** (`agent-lane-spawn.baseline.json`) lists suites that spawn through the real engine path and cannot be proven statically; it can only shrink.
- **Detection is heuristic** (import / identifier / real-executable stdio config); a spawn hidden behind a new helper is not caught until the heuristic is extended.

## Alternatives considered

- **Raise unit-lane timeouts** — REJECTED: hides the load sensitivity and keeps `--parallel=5` contention.
- **Env-gate the spawning suites** — REJECTED: AGENTS.md §7 (silent gating).
- **Global `targetDefaults.e2e` in nx.json** — REJECTED: name-keyed, collides with `@nx/cypress`; project-scoped targets are the convention.

## What does NOT change

apigen-* and `entrypoint/backlog` lanes and their `*.e2e.ts` convention; paid-service gating rules; ADR-0008's native-tooling design.

## References

- `docs/PIPELINE.md` §2; `tools/gate/lane-gate.mjs`; `tools/vite-plugins/e2e-globs.mjs`
- adhd ADR-0008 (`docs/decisions/0008-agent-mcp-native-tooling.md`:32)
- backlog 5b839b90

## Provenance

- 2026-10-06 — backlog 5b839b90. AC1 and AC2 are proven by tests citing them (`check-lane-reachability.spec.mjs`, `check-agent-lane-spawn.spec.mjs`). AC3 (moved e2e tests still run in the `e2e` lane, un-gated) and AC4 (this ADR, AGENTS.md and PIPELINE.md pointers) have no applicable unit test: AC3 is proven by the `nx affected -t e2e --parallel=1` run, AC4 by the documents themselves.
