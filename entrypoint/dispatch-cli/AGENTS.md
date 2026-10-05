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
  `claude` CLI, no key) or `deepseek` (`DISPATCH_E2E_PROVIDER=deepseek`, requires
  `ADHD_AGENT_DEEPSEEK_SECRET`).
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
# default: claudecli (subscription; needs `claude auth status` = loggedIn)
DISPATCH_E2E_LIVE=1 npx nx test dispatch-cli \
  --testFile=src/test/integration/live-dispatch-five-acs.e2e.test.ts

# alternate provider
DISPATCH_E2E_LIVE=1 DISPATCH_E2E_PROVIDER=deepseek npx nx test dispatch-cli \
  --testFile=src/test/integration/live-dispatch-five-acs.e2e.test.ts
```

**Provider capability note.** `claudecli` drives the `claude` CLI, which only
discovers the CLI's own built-ins and real MCP servers passed via `--mcp-config`.
It does NOT receive agent-mcp's client-side pseudo-tools (`builtin__request_human_input`,
`agent-mcp__agent`/`task`). Therefore AC2 (HITL) and AC5 (delegation) require a
provider that advertises JSON-schema function tools (DeepSeek/OpenAI or Anthropic)
and are skipped under `claudecli` with a visible warning. AC1 (session threading),
AC3 (budget) and AC4 (memory MCP server) run under `claudecli`.

The same gate record appears in this package's `README.md` and in the test file's
own header.
