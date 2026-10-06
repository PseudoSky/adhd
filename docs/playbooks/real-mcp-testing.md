# Real MCP testing playbook

Deterministic, command-first procedure for running **real** dispatch through the
**real MCP boundary** — real `orchestrateCycle` → real `AgentMcpRunner` → a
spawned `@adhd/agent-mcp` (stdio JSON-RPC, real stores/engine) → a real provider
— under hard mechanical guards, and for proving that a dispatched agent can
actually use the agent-dispatching tools.

There is **no separate script to author**: the guarded runner *is* the script.
This playbook is the procedure around it. (No `docs/playbooks/` existed before
this file; nothing here duplicates an earlier playbook.)

## Read, don't restate — sources of truth

| Topic | Path |
|---|---|
| Strategy contract (levels, environments, gates, the one legitimate gate) | [`../TEST-STRATEGY.md`](../TEST-STRATEGY.md) |
| The guarded runner (self-executing; never collected by Vitest) | [`../../entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts`](../../entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts) |
| Guard primitives (side-effect-free; default-running spec) | [`../../entrypoint/dispatch-cli/src/test/integration/live-guard-core.ts`](../../entrypoint/dispatch-cli/src/test/integration/live-guard-core.ts) |
| Live five-AC suite (AC5 = delegation) | [`../../entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts`](../../entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts) |
| Approved gate record + full env surface | [`../../entrypoint/dispatch-cli/README.md`](../../entrypoint/dispatch-cli/README.md) §"Guarded live runner" · [`../../entrypoint/dispatch-cli/AGENTS.md`](../../entrypoint/dispatch-cli/AGENTS.md) §"Guarded live runner" |
| Child spawn / scratch helper | [`../../entrypoint/dispatch-cli/src/test/helpers/agent-mcp-registry.ts`](../../entrypoint/dispatch-cli/src/test/helpers/agent-mcp-registry.ts) |
| `agent_verify_mcp` (no-model-call MCP handshake) | [`../../entrypoint/agent-mcp/src/server.ts`](../../entrypoint/agent-mcp/src/server.ts) (`agent_verify_mcp`) |

A real model is a paid/external third-party service — the **single** reason
`AGENTS.md §7` permits an env gate. The gate owner is recorded in all three
required places (runner header, package `README.md`, package `AGENTS.md`). Every
run costs real money.

## 1. Prerequisites

Run from the repo root. The runner **fails loudly** — never a silent skip — if
any prerequisite is absent.

```bash
corepack pnpm install                     # shared pnpm store
npx nx run agent-mcp:dist-manifest        # builds the child server the runner spawns
set -a; source ~/.adhd/.env; set +a       # ADHD_AGENT_DEEPSEEK_SECRET / ADHD_AGENT_ANTHROPIC_SECRET
```

- `agent-mcp:dist-manifest` must emit **both** `entrypoint/agent-mcp/dist/src/index.js`
  and `entrypoint/agent-mcp/dist/package.json` (the child `require`s the latter).
- The provider secret name is provider-specific:
  `ADHD_AGENT_DEEPSEEK_SECRET` (deepseek) or `ADHD_AGENT_ANTHROPIC_SECRET`
  (anthropic). `claudecli` needs no key but requires `claude auth status` to
  report `loggedIn: true`.
- Zero-cost preflight for an agent's configured `mcpServers`, before spending any
  model budget: call agent-mcp's `agent_verify_mcp` (`{ "name": "<agent>" }`) —
  it connects each server and returns reachable tool names, no model call. A
  self-referential `agent-mcp` server reports `status: "skipped"` (handled
  in-process).

## 2. The guardrails and why

Every knob is env-overridable; the defaults **are** the guardrails
(`run-live-guarded.ts` §"Config surface"; the same table is in the package
`README.md`).

| Guard | Env | Default | Behaviour |
|---|---|---|---|
| Gate | `DISPATCH_E2E_LIVE` | unset | Must be `1` to run; unset ⇒ loud notice + exit `0` (never a silent skip). |
| Provider | `DISPATCH_E2E_PROVIDER` | `deepseek` | `deepseek` \| `anthropic` \| `claudecli`. |
| Model | `DISPATCH_E2E_MODEL` | provider default (`deepseek-v4-flash` / `claude-haiku-4-5`; claudecli picks its own) | Must have a rate-card entry so `est_cost_usd` is computable. |
| Strict turn count | `DISPATCH_E2E_MAX_TURNS` | `12` | Applied twice — per-agent `maxToolLoops` **and** the child's `ADHD_AGENT_BUDGET_MAX_CALLS` (a global model-call cap) — then re-asserted post-run (`Σ model_calls ≤ cap`). |
| Cost kill | `DISPATCH_E2E_MAX_COST_USD` | `0.10` | Polls `Σ task_usage.est_cost_usd`; **hard-kills** the run the moment spend exceeds the cap. |
| Message-size protection | `DISPATCH_E2E_MAX_MSG_BYTES` | `262144` (256 KiB) | Polls the largest single stored message/prompt/result/event-payload byte-length; kills if exceeded. |
| Proxy | `DISPATCH_E2E_PROXY` | unset | Routes the provider `base_url` + the child's `HTTP(S)_PROXY` through a proxy so API calls can be metered/blocked. Unset ⇒ the runner says so and relies on the cost + message-size guards. |
| Poll interval | `DISPATCH_E2E_POLL_MS` | `1000` (floored at `100`) | Monitor cadence. |
| Scenario | `DISPATCH_E2E_SCENARIO` | `all` | `all` \| `dispatch` \| `delegation`. |

Plainly:

- **Hard-killed on exceedance.** When cumulative cost exceeds the cap the monitor
  stops, closes the spawned `agent-mcp`, aborts the orchestration, and the
  process exits non-zero with `[GUARD-KILL:cost-exceeded]` and the observed
  evidence. The run is never allowed to continue past a breach.
- **Unpriceable cost is fatal.** If any task made model calls while its
  `est_cost_usd` is `NULL` (the model has no rate-card entry) **and** no proxy
  meters spend, the run **fails loudly** (`[GUARD-KILL:cost-telemetry-unavailable]`)
  rather than run unmetered.

## 3. The exact command

```bash
DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json \
  entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
```

Without the gate, the runner is a no-op that says so (this output is captured
from the real script; exit `0`, no model call):

```text
[run-live-guarded] NOT RUN — DISPATCH_E2E_LIVE is not "1". This runner fires a real, billed model call; it is env-gated per AGENTS.md §7 (a real model is the single permitted gate reason). Gate owner: pseudosky. Run it with:
  DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
```

When gated, the startup line and the per-poll cost line are:

```text
[run-live-guarded] provider=deepseek model=deepseek-v4-flash | maxTurns=12 maxCostUsd=$0.1 maxMsgBytes=262144 pollMs=1000 | proxy=(none — relying on cost + message-size guards)
[guard] cost=$0.000000 (cap $0.1) | modelCalls=0 (cap 12) | tasks=0 | maxMsgBytes=0 (cap 262144)
```

The PASS result table (the banner is literal from `printTable`; the numbers are
run-dependent — this is the **format**, not a captured run):

```text
================================================================================================
 run-live-guarded — guarded live dispatch (turns + cost-kill + msg-size + delegation)
================================================================================================
 G1  | PASS | guarded smoke dispatch (turns + cost + msg-size)         | task completed; N/12 model calls; cost $0.000XXX/0.1; maxMsgBytes N/262144
 G2  | PASS | guarded delegation (dispatched agent uses agent-mcp__agent) | parent completed; child session(s) for 'guarded-child': 1 (real sub-dispatch)
================================================================================================
```

- **Exit status:** `0` iff no row is `FAIL`; `1` if any row is `FAIL` (including
  a `KILL` row); `2` on a fatal error outside a scenario.
- **Reading the running cost line:** `cost=$X` is the live cumulative
  `SUM(task_usage.est_cost_usd)` read from the child's real store every
  `DISPATCH_E2E_POLL_MS`, printed with the cap beside it. It is the **same
  number** the kill compares against `DISPATCH_E2E_MAX_COST_USD`. `modelCalls`
  is the same `Σ model_calls` the turn cap is asserted against.

## 4. The delegation test

The `delegation` scenario (`G2`) proves a dispatched agent **really used the
agent-dispatching tools**:

- The parent agent is created with the **self-referential `agent-mcp` MCP
  server** (handled in-process) and `permissions.allowedAgents: [<child>]`, then
  asked to call `agent-mcp__agent {"name": "<child>"}`.
- **Success is a real child SESSION row**: the runner calls
  `session_list { agentName: <child> }` and requires `>= 1`. A child session can
  *only* be created by the dispatching tool (`agentTool` → `sessionStore.create`),
  so the row is the proof the tool actually executed and passed policy. The
  parent task must also be `completed`.
- **It needs a function-tool provider** (`deepseek` / `anthropic`), because
  `claudecli` never receives agent-mcp's client-side pseudo-tools
  (`agent-mcp__agent` / `task`). Under `claudecli` the scenario returns a
  **loud `SKIP`** (`status: SKIP`), never a silent pass.

Run only the delegation scenario:

```bash
DISPATCH_E2E_SCENARIO=delegation DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json \
  entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
```

The broader live five-AC suite exercises the same real delegation boundary as
AC5 (`4e829a08`): policy enforcement across a real dispatch-driven delegation
chain, surfacing `DELEGATION_NOT_ALLOWED` — see
[`live-dispatch-five-acs.e2e.test.ts`](../../entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts)
and its header.

## 5. Proving the guards themselves

A cap of `0` is breached on the first priced turn, so this run is hard-killed —
it proves the kill path, not the feature:

```bash
DISPATCH_E2E_LIVE=1 DISPATCH_E2E_MAX_COST_USD=0 DISPATCH_E2E_POLL_MS=100 \
  DISPATCH_E2E_SCENARIO=delegation npx tsx --tsconfig tsconfig.base.json \
  entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
```

Expected:

- **Exit `1`.**
- Result row `KILL | FAIL | cost-exceeded | {…evidence…}`.
- stderr `[run-live-guarded] HARD KILL — [GUARD-KILL:cost-exceeded] {…}` followed
  by `[run-live-guarded] terminated by a guard — exiting non-zero.`

`GUARD-KILL:cost-exceeded` means the continuous monitor observed cumulative
`est_cost_usd` **above** the cap and closed the spawned `agent-mcp` before
reporting. (The runner header shows the same demo with
`DISPATCH_E2E_MAX_COST_USD=0.000001`; either tiny cap breaches on the first
priced turn.)

## 6. Failure playbook

| Symptom (matched string) | Meaning | Next action |
|---|---|---|
| `[GUARD-KILL:cost-exceeded]` / row `cost-exceeded` | Cumulative spend passed `DISPATCH_E2E_MAX_COST_USD`; hard-killed. | This is the guard working, not a feature FAIL. Re-run only after deliberately raising the cap, or confirm the cost is expected. Never disable the guard to get a feature PASS. |
| `[GUARD-KILL:turn-count-exceeded]` | Post-run `Σ model_calls > DISPATCH_E2E_MAX_TURNS`. | Investigate the tool-loop / delegation depth. Raise the cap only deliberately. |
| `[GUARD-KILL:message-size-exceeded]` | A single stored message / prompt / result / event payload exceeded `DISPATCH_E2E_MAX_MSG_BYTES`. | Find the oversized payload; raise the cap only deliberately. |
| `[GUARD-KILL:cost-telemetry-unavailable]` | `est_cost_usd` is `NULL` while model calls occurred, and no proxy meters spend. | Set `DISPATCH_E2E_MODEL` to a priced model (the deepseek default has a rate-card entry), or set `DISPATCH_E2E_PROXY`. Under `claudecli`, switch to `DISPATCH_E2E_PROVIDER=deepseek` (or `anthropic`). |
| `[GUARD-KILL:telemetry-store-missing]` | The child wrote no `task_usage` row. | The scratch DB lives under the run's scratch dir; confirm the child spawned, then re-run `npx nx run agent-mcp:dist-manifest`. |
| `run-live-guarded: built agent-mcp entry missing …` | The child dist is absent. | `npx nx run agent-mcp:dist-manifest`. |
| `run-live-guarded: … ADHD_AGENT_DEEPSEEK_SECRET is unset` (or anthropic) | The provider secret is not in the environment. | `set -a; source ~/.adhd/.env; set +a` (or export the named secret). |
| `run-live-guarded: claudecli selected but 'claude auth status' …` | No authenticated local `claude` CLI. | Run `claude auth login`; re-check `claude auth status`. |
| Delegation row `SKIP` | Provider is `claudecli`, which cannot receive `agent-mcp__agent`. | Re-run with `DISPATCH_E2E_PROVIDER=deepseek` or `anthropic`. |
| Delegation row `FAIL … did not create a child session` | The dispatched agent never successfully called `agent-mcp__agent`. | Check `permissions.allowedAgents`, provider function-tool support, and the model's tool call; preflight the MCP servers with `agent_verify_mcp`. |
| Exit `2`, `[run-live-guarded] fatal:` | A fatal error outside any scenario (e.g. a prerequisite probe). | Read the stack; fix the cause above and re-run. |

## 7. Repeatability

- **Isolation.** Each scenario creates a fresh dir via `mkdtempSync` under
  `tmp/dispatch-cli/live-guarded/<scenario>-*`; the child's `agents.db` and
  `registry.db` live inside it. The real `~/.adhd` store is never touched: the
  child env strips every ambient `ADHD_AGENT_*` and points `ADHD_AGENT_CONFIG` at
  a nonexistent path so a developer's real config cannot replace the budget cap.
- **Deterministic cleanup.** The `finally` block closes the child and
  `rmSync`s the scratch dir — a failing run still cleans up. The process exits
  explicitly (`process.exit`) so no child handle keeps it alive; there is no
  daemon and no wall-clock sleep-based assertion.
- **Read-only telemetry.** The monitor opens the child DB read-only on a separate
  connection (`busy_timeout = 500`); a momentarily locked tick is skipped, never
  a crash.

**ONE-LINE reproduce** (paste from the repo root):

```bash
corepack pnpm install && npx nx run agent-mcp:dist-manifest && { set -a; source ~/.adhd/.env; set +a; } && DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
```

Swap `DISPATCH_E2E_LIVE=1` for the kill demo's leading vars, or add
`DISPATCH_E2E_SCENARIO=delegation`, to reproduce §4/§5 instead.
