# AGENTS.md — `@adhd/dispatch-cli`

Factual, code-grounded notes for LLM/agent consumption. This file is not marketing.

## What this package is

`@adhd/dispatch-cli` is the host for the dispatch DAG runtime
(`@adhd/dispatch-orchestrator`): it validates a `dag.json`, optimizes eligible
milestones into dispatch units, and fires them through an `IDispatchAgentRunner`
(default: `AgentMcpRunner` → a spawned `@adhd/agent-mcp`). See `README.md`.

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
