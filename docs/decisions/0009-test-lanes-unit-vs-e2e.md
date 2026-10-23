# ADR-0009 — Test lanes: unit `test` runs no subprocess; `e2e` owns every subprocess / real-server suite

**Status:** ACCEPTED (2026-10-06) — owner approval relayed by dispatch-2026-10-06-48dc, conditional wording fix applied. The lane model itself is already in force in `docs/PIPELINE.md` §2 and the apigen/backlog `e2e` targets.
**Owner:** devops (pipeline) with the repo owner.
**Supersedes:** nothing.
**Drives:** backlog 5b839b90 (agent packages: separate subprocess-spawning tests into a dedicated e2e lane).
**Grounding:** owner request (verbatim): "I want you to properly set up the e2e spec lanes for agent packages such that subprocess running tests properly separate there should be an adr about this already." A search of `docs/decisions/` (0001–0008) and `docs/` found no ADR on test lanes; the only record was `docs/PIPELINE.md` §2 (stages 4–5) and the per-project comments in `entrypoint/backlog/project.json` / `packages/apigen/apigen-plugin-mcp/project.json`. Incident: `packages/agent/agent-engine-orchestrator/test/unit/native-tooling-caller-cwd.spec.ts` spawns a real `npx` MCP server inside the unit lane and timed out under load, blocking a release.

## TL;DR for the next agent

A test that spawns a process (`child_process`, `StdioClientTransport`/`StdioMcpClient`, a stdio MCP server on `npx`/`uvx`/`srt`/`node`) is an **e2e** test: it is a `*.e2e.ts` file under `<project>/test/e2e/` and it runs in the project's `e2e` target (`nx affected -t e2e --parallel=1`) — its own pipeline stage (docs/PIPELINE.md:30), not `nx test`. The unit `test` target excludes those files. Separately, e2e tests are not env-gated except under the paid-third-party exception in AGENTS.md §7. The trap: renaming a file is not enough — the project needs an `e2e` target and a `vitest.e2e.config.ts`; `check-lane-reachability.mjs` rules 1 and 8 fail the gate if either is missing.

## Context

`docs/PIPELINE.md` §2 already orders the stages `test` then `e2e` (own lane, `--parallel=1`). apigen-* and `entrypoint/backlog` implement it; the agent family (`packages/agent/*`, `entrypoint/agent-mcp`, `entrypoint/dispatch-cli`) did not: 12 subprocess-spawning suites ran inside the unit `test` lane at `--parallel=5`, where load-induced timeouts are nondeterministic. Not established: the exact set of non-agent packages with the same defect (apigen's `flat-content-payload.spec.ts` spawns built dist in its default lane by documented choice).

## Decision

### D1 — Lane contract

Unit `test` = no subprocess, no bound ports to real servers, fast, cacheable at `--parallel=5`. `e2e` = every suite that spawns a process or runs a real server; run with `--parallel=1` as its own pipeline stage (docs/PIPELINE.md:30; in ci.yml after `lint test build verify-dist-load`, docs/PIPELINE.md:36-37), never inside `nx test`; not env-gated (paid-third-party exception only, AGENTS.md §7); cached on content (`cache:true`, `inputs` containing `default`, no declared `outputs`); reached by CI via `tools/gate/lane-gate.mjs` `GATE_TARGETS` and by `publish` / `nx-release-publish`. The local `.githooks/pre-push` runs `test` only (`GATE_TARGETS` minus `PRE_PUSH_EXCLUDED` in `.githooks/lib/pre-push-flags.mjs`); agents run the full lane gate, e2e included, before a push (AGENTS.md "Gates are blocking").

### D2 — File convention and single source

Tests live in `<project>/test/`, one directory per lane: `test/unit/**/*.spec.ts(x)` is the unit lane and `test/e2e/**/*.e2e.ts` is the e2e lane. Both trees mirror `src/`; shared support code is in `test/helpers/`, data in `test/fixtures/` and `test/golden/` (docs/standards/testing.md, "Test file layout"). `tools/vite-plugins/e2e-globs.mjs` is the one definition of the lane globs (`UNIT_FILE_INCLUDES`, `E2E_FILE_INCLUDES`, `E2E_FILE_EXCLUDES`). The unit lane includes `UNIT_FILE_INCLUDES` and excludes `E2E_FILE_EXCLUDES` (the project's `vite.config.ts` `test.include` / `test.exclude`); the e2e lane includes `E2E_FILE_INCLUDES` (`defineE2eConfig` in `tools/vite-plugins/e2e-config.mjs`, via `vitest.e2e.config.ts`). A file is in exactly one lane. A new `*.e2e.ts` file in `test/e2e/` lands in e2e automatically. `check-test-layout.mjs` fails a project whose files are named or placed otherwise.

### D3 — Isolation

An e2e that spawns agent-mcp passes an isolated cwd and a fake `HOME` (adhd ADR-0008 D4/line 32: `loadEnvHierarchy` loads `<cwd>/.env` with `override:true`).

### D4 — Mechanical enforcement

`tools/nx-plugins/test/executors/wiring/check-agent-lane-spawn.mjs` (invoked as rule 8 of `check-lane-reachability.mjs`, run unconditionally by pre-push and both CI workflows (the check runs in pre-push; the `e2e` lane itself runs in CI only — see Amendment)) fails when an agent-family unit-lane file spawns a subprocess, when a project with `*.e2e.ts` files does not exclude them from its unit lane, or when a `pendingMove` baseline entry is stale. Negative controls: `check-agent-lane-spawn.spec.mjs`.

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

## Amendment — e2e is not part of the local push gate (2026-10-07)

Owner decision (verbatim, dispatch-2026-10-06-48dc): "do not run e2e by default, yes remove from push". The `e2e` lane is **CI-only**: `.githooks/pre-push` runs affected `test` only (`GATE_TARGETS` minus `e2e`, resolved by `.githooks/lib/pre-push-flags.mjs`), while both CI workflows keep `test` + `e2e` (`GATE_TARGETS` in `tools/gate/lane-gate.mjs`); lane-reachability rule 5 enforces that pre-push derives its flags from `pre-push-flags.mjs`, runs `test`, and never runs `e2e`. Run e2e locally on demand with `npx nx affected -t e2e --parallel=1`. Env-gated live suites (`NAT_TOOL_LIVE=1`, paid/third-party) stay off by default everywhere, with their gate tables checked by `nat-tool-live-docs.spec.mjs` (backlog 90d07610). Where D1-D4 above describe pre-push running the lanes, read it as CI.

## Amendment — the pre-push `test` lane runs tier S only (2026-10-15)

Owner order (verbatim): "directly stop pre push from running e2e or P tier". The e2e lane is chosen by file NAME, and the tier is declared by the test header (docs/standards/testing.md section 1), so the two are tied mechanically: `check-test-headers.mjs` rule H5 fails any test whose header declares tier P, H or X and whose name is not `*.e2e.*` (`*.e2e.ts`, `*.e2e.test.ts`, `*.e2e.mjs`). It runs in the pre-push hook and both CI workflows (G9). The build-tools `node --test` specs get the same split: tier S in the root `test:build-tools` script (the `test` target of `tools/nx-plugins`, run by pre-push), tier P/H/X renamed `*.e2e.mjs` in `test:build-tools-e2e` (its `e2e` target, CI only via `nx affected -t e2e`). Lane-reachability rule 10 fails when the pre-push script lists an e2e spec, when an e2e spec is in no script (G2), or when the `e2e` target is missing, uncached or hashes other inputs than `test`. H5 shares the G9 baseline `test-headers.baseline.json` (only shrinks); it records no H5 entry. Each vitest suite moved into the e2e lane keeps a paired tier S `*.spec.ts` stub that fails when its sibling leaves the lane or loses its tier header. The build-tools `node --test` lane has no stubs: its scripts list every file by path, and rule 10 already fails an e2e spec that no script reaches. Several of the renamed build-tools files also hold pure tier S cases, which now run only in CI with the rest of their file. Splitting them back into the push lane is tracked in backlog bad79507. Proven by `check-tier-lane.spec.mjs` (tier S) and `check-tier-lane.e2e.mjs` (the CLI exit codes). Backlog f3683008.

## Provenance

- 2026-10-06 — backlog 5b839b90. AC1 and AC2 are proven by tests citing them (`check-lane-reachability.spec.mjs`, `check-agent-lane-spawn.spec.mjs`). AC3 (moved e2e tests still run in the `e2e` lane, un-gated) and AC4 (this ADR, AGENTS.md and PIPELINE.md pointers) have no applicable unit test: AC3 is proven by the `nx affected -t e2e --parallel=1` run, AC4 by the documents themselves.
- 2026-10-07 — dispatch-2026-10-04-b7d4. Local `pre-push` no longer runs `e2e`; CI still does. Proven by `.githooks/pre-push.e2e.mjs` (named `pre-push-e2e.spec.mjs` until 2026-10-15).
- 2026-10-15 — feat/prepush-tier-s-only (backlog f3683008; resolves the socket-file moves of 79624250 and 132547e7). Pre-push runs tier S only: H5 + rule 10. 16 tier P/X files were renamed into the e2e lane (6 vitest suites with paired stubs, 10 build-tools specs) and none is baselined.
