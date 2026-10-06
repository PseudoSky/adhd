# AGENTS.md — `@adhd/dispatch-cli`

Factual, code-grounded notes for LLM/agent consumption. This file is not marketing.

## What this package is

`@adhd/dispatch-cli` is the host for the dispatch DAG runtime
(`@adhd/dispatch-orchestrator`): it validates a `dag.json`, optimizes eligible
milestones into dispatch units, and fires them through an `IDispatchAgentRunner`
(default: `AgentMcpRunner` → a spawned `@adhd/agent-mcp`). See `README.md`.

## Native tooling for dispatched agents (NAT-TOOL-5 / ADR-0008)

The dispatch host resolves the standardized native toolset at the **dispatching
cwd** and threads it (and the cwd) to the runner, so a dispatched agent gets
`fs` + `shell` + the `dispatch` self server **plus** `memory-server` + `backlog`.

- `resolveDispatchMcpServers({ cwd })` (in `src/lib/core.ts`) is the ONE
  composition: it reuses `resolveNativeToolingMap` from
  `@adhd/agent-core-native-tooling` — the single fs/shell producer; this package
  authors no fs/shell config of its own — and merges the explicit
  `memory-server`/`backlog` half. Precedence: explicit `mcpServers` >
  `nativeTooling` > the `dispatch` self floor.
- `buildProductionAgentMcpRunner(env, { cwd })` sets the spawned agent-mcp
  child's cwd AND roots the resolved fs/shell configs at the same `cwd`. The
  `run` command roots at `--tools-root` when supplied, else `process.cwd()`.
- `AgentMcpRunner` re-asserts the current resolution on an already-existing
  agent (`agent_update`) so a reused agent is re-scoped to the current cwd.

Proven default-running + hermetic (real spawned agent-mcp, fake `$HOME`, temp
registry DB): `src/test/resolve-dispatch-mcp-servers.spec.ts`,
`src/test/dispatch-native-tooling.e2e.test.ts`.

## Live dispatch e2e — env-gated (paid/external model)

`src/test/integration/live-dispatch-five-acs.e2e.test.ts` drives the REAL system
end to end — real `orchestrateCycle` → real `AgentMcpRunner` → a real spawned
`@adhd/agent-mcp` (stdio JSON-RPC, real stores/engine) → a REAL provider — to prove
five live acceptance criteria (`fa9d3079`, `03145a46`, `5339c2e5`, `daafe2d3`,
`4e829a08`) that no real-model run had ever exercised.

- **Gate:** `DISPATCH_E2E_LIVE=1` (skipped, loudly, otherwise).
- **Provider:** `DISPATCH_E2E_PROVIDER=claudecli` (default; the host's authenticated
  `claude` CLI, no key), `anthropic` (OAuth via `ADHD_AGENT_ANTHROPIC_SECRET`), or
  `deepseek` (`ADHD_AGENT_DEEPSEEK_SECRET`). The function-tool secrets live in
  `~/.adhd/.env`; `set -a; source ~/.adhd/.env; set +a` before running.
- **Negative controls:** add `DISPATCH_E2E_NEGATIVE=1`.
- **Approved by:** pseudosky (repo owner, skywinstonsk@gmail.com).
- **Rationale:** the suite calls a real, paid/external model — the single reason
  AGENTS.md §7 permits an env gate. Everything that does not need the paid call
  (the default-running dispatch/fixture tests) runs by default, unflagged.
- **Fails loudly** when enabled but the required credential is absent (unset
  `ADHD_AGENT_DEEPSEEK_SECRET` for `deepseek`; an unauthenticated `claude` for
  `claudecli`) — it never silently skips.

Run it:

```bash
# prerequisite: build the child agent-mcp the test spawns
npx nx run agent-mcp:dist-manifest

# default: claudecli (subscription; needs `claude auth status` = loggedIn)
cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 npx vitest run --config vite.config.ts \
  src/test/integration/live-dispatch-five-acs.e2e.test.ts

# alternate provider
cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 DISPATCH_E2E_PROVIDER=deepseek \
  npx vitest run --config vite.config.ts src/test/integration/live-dispatch-five-acs.e2e.test.ts
```

(The dispatch-cli `test` target has no `--testFile` option and builds `backlog`
with `cache:false`; invoking the package's Vitest config directly is the
targeted, verified form. `npm`-vs-`npx` aside, the test fails loudly if the
agent-mcp dist is missing.)

**Provider capability note.** `claudecli` drives the `claude` CLI, which only
discovers the CLI's own built-ins and real MCP servers passed via `--mcp-config`.
It does NOT receive agent-mcp's client-side pseudo-tools (`builtin__request_human_input`,
`agent-mcp__agent`/`task`). Therefore AC2 (HITL) and AC5 (delegation) require a
provider that advertises JSON-schema function tools (DeepSeek/OpenAI or Anthropic)
and are skipped under `claudecli` with a visible warning. AC1 (session threading),
AC3 (budget) and AC4 (memory MCP server) run under `claudecli`.

**HITL on AC2 (`03145a46`) — reachable (implemented 2026-10-05).** A sessioned
dispatch unit that calls `builtin__request_human_input` suspends to
`awaiting_input` carrying a `resume_token`. `AgentMcpRunner.fire()` fires a
sessioned unit in the **background** (`background:true`, taking the task id from
the immediate `{ task_id, status: 'pending' }` reply) so `poll()` observes
`awaiting_input` instead of the MCP call blocking to its 60s deadline. The
orchestrator **parks** the unit (records the suspension, runs no guards, injects
no correction) rather than failing it, and `dispatch-cli status` surfaces
`status: "awaiting_input"` plus `awaitingInput: { taskId, resumeToken }`
(`statusCore`). Resume the task with agent-mcp's `task_resume` (that token) to
drive the task to `completed`; the next cycle then reconciles the completed task
back into the DAG — re-runs the milestone guard and marks the milestone complete,
so `status` stops reporting `awaiting_input` (48b14ec1). (A `run --no-dry-run`
naming an *unregistered* agent fails `AGENT_NOT_FOUND` — see the paid-boundary
note in `README.md`.)

The same gate record appears in this package's `README.md` and in the test file's
own header.

## Guarded live runner — `run-live-guarded.ts` (env-gated; paid model)

`src/test/integration/run-live-guarded.ts` is a self-executing, **guarded** live
runner: it drives a real `orchestrateCycle` → real `AgentMcpRunner` → a real
spawned `@adhd/agent-mcp` → a real provider, wrapped in hard guards so a live run
cannot run away. It is NOT collected by Vitest (`vite.config.ts` includes only
`*.{test,spec}.*`) and is skipped by `nx affected -t test`.

- **Gate:** `DISPATCH_E2E_LIVE=1`. When unset it prints a loud notice and exits 0.
- **Provider:** `DISPATCH_E2E_PROVIDER=deepseek` (default; `ADHD_AGENT_DEEPSEEK_SECRET`),
  `anthropic` (`ADHD_AGENT_ANTHROPIC_SECRET`), or `claudecli`.
- **Guards** (all env-overridable): strict turn cap (`DISPATCH_E2E_MAX_TURNS`,
  default 12 → `maxToolLoops` + `ADHD_AGENT_BUDGET_MAX_CALLS`), a continuous cost
  monitor that **hard-kills** the run when cumulative `est_cost_usd` exceeds
  `DISPATCH_E2E_MAX_COST_USD` (default `0.10`), a single-message byte cap
  (`DISPATCH_E2E_MAX_MSG_BYTES`, default 262144), and an optional proxy
  (`DISPATCH_E2E_PROXY`). It also asserts a dispatched agent can really use the
  agent-dispatching tools (`agent-mcp__agent`).
- **Approved by:** pseudosky (skywinstonsk@gmail.com) — real model = paid/external
  service, the single AGENTS.md §7 gate reason.
- **Fails loudly** when enabled without the credential / built agent-mcp / stub.

Run: `DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json
entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts` (see `README.md`
"Guarded live runner" for the full env surface). The same gate record appears in
this package's `README.md` and in the script's own header.

**NAT-TOOL-9 scenarios (ADR-0008 D11).** `DISPATCH_E2E_SCENARIO` selects the
native-tooling end-to-end proof in addition to `dispatch`/`delegation`:
`native-fs-shell` (N1 — the real srt-wrapped `fs` server reads `/P/<file>` and
the srt-wrapped shell runs `pwd` in `/P`, asserted from the child's
`tool_results`), `portability` (N2 — create@/P then reuse@/Q re-asserts fs root
/Q, with a no-re-assert negative control; no model), `hitl` (N3 — a sessioned
`ask` suspends and `task_resume` executes it, proven by a real child session
row), and `retention` (N5 — an `ephemeral` session is reclaimed on terminal
while a retained session survives). Every scenario spawns agent-mcp with an
isolated cwd + fake `$HOME` (D11 #14). Procedure + table:
`docs/playbooks/real-mcp-testing.md` §8. The deterministic half of N9
(resolved-toolset registry connect, permission-gate deny, single producer,
portability) runs default/unflagged in `dispatch-default-mcp-servers.e2e.test.ts`
and agent-mcp's `default-mcp-servers.e2e.test.ts`.
