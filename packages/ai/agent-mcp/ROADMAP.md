# agent-mcp Roadmap

Feature evaluation and strategic prioritisation for `@adhd/agent-mcp`.

---

## Scoring Methodology

Each feature is scored across nine dimensions:

| Dimension | Scale | Description |
|-----------|-------|-------------|
| **Impact** | 1–10 | User / developer value delivered |
| **Ease** | 1–10 | Inverse of effort (10 = trivial, 1 = enormous) |
| **Safety** | 1–10 | Inverse of risk (10 = zero risk, 1 = high breakage) |
| **Lib Growth** | 1–10 | Public API surface added to the package |
| **Necessity** | 1–10 | How essential this is for production use |
| **MCP Fit** | 1–10 | How cleanly this maps to MCP tool calls |

**Extended Score** = (Impact + Ease + Safety + LibGrowth + Necessity + McpFit) / 6

### Belongs-In Score (with middleware)

Assumes lifecycle event hooks exist at 11 orchestrator points (see §Middleware). Higher = must live in the core package.

| Dimension | Scale | Description |
|-----------|-------|-------------|
| **Core-Only** | 1–10 | Requires modifying the orchestrator loop directly |
| **DB Coupling** | 1–10 | Needs new SQLite tables or FK relationships |
| **Domain Centrality** | 1–10 | Is agent/session/task state fundamentally required? |
| **Dep Purity** | 1–10 | Heavy 3rd-party deps pull this toward a separate package |
| **Specificity** | 1–10 | Very specific-use → SERVICE; broad → CORE |

**BI Score** = (CoreOnly + DBCoupling + DomainCentrality + DepPurity + Specificity) / 5

- **≥ 7.0** → **CORE** — implement in agent-mcp
- **5.0 – 6.9** → **PLUGIN** — separate `@adhd/*-plugin` package consuming hooks
- **< 5.0** → **SERVICE** — standalone service or external integration

### Framework Coverage & Differentiation

**Coverage** (1–10): How fully the feature is already implemented across LangGraph, CrewAI, AutoGen/AG2, OpenAI Agents SDK, Semantic Kernel, and LangChain.

**Differentiation** = 11 − Coverage

**Strategic Score** = Extended × 0.6 + Differentiation × 0.4

### Signal Quadrant

Axes: **Necessity** (production essentialness) × **Differentiation** (coverage gap).

| | High Differentiation (≥6) | Low Differentiation (<6) |
|---|---|---|
| **High Necessity (≥6)** | **MOAT** — build and own | **TABLE STAKES** — must match competitors |
| **Low Necessity (<6)** | **NICHE** — useful specialty | **INTEGRATE** — use external tool |

---

## Middleware Architecture

The orchestrator currently exposes no hooks. Implementing a lifecycle event system at the 11 natural insertion points transforms the CORE/PLUGIN boundary for 8 features.

### Lifecycle Events

| Hook | Fires |
|------|-------|
| `task:start` | Before first model call |
| `pre:model_request` | Before each provider call |
| `post:model_response` | After each provider response |
| `pre:tool_call` | Before each tool is dispatched |
| `post:tool_call` | After each tool returns |
| `message:appended` | When a message is persisted to session history |
| `task:completed` | On successful completion |
| `task:failed` | On unrecoverable error |
| `task:cancelled` | On cancellation signal |
| `session:created` | After a new session row is inserted |
| `agent:mutated` | After agent definition is updated |

### Plugin Package Design

Features that become hook consumers:

| Package | Hooks consumed | Replaces |
|---------|---------------|----------|
| `@adhd/metrics-plugin` | `task:completed`, `task:failed`, `task:cancelled` | Agent and task metrics (read-only; queries task_usage + tasks tables) |
| `@adhd/budget-plugin` | `pre:model_request`, `post:model_response` | Cost budget enforcement (CORE → PLUGIN) |
| `@adhd/guardrails-plugin` | `pre:tool_call`, `post:model_response` | Inline guardrails (CORE → PLUGIN) |
| `@adhd/tracing-plugin` | all | OTLP trace export (SERVICE → PLUGIN) |
| `@adhd/checkpoint-plugin` | `task:completed`, `task:failed`, `message:appended` | Checkpointing + replay (PLUGIN) |
| `@adhd/memory-plugin` | `task:completed`, `message:appended` | Persistent tool memory, entity memory (PLUGIN) |
| `@adhd/retry-plugin` | `task:failed` | Task-level auto-retry (CORE → PLUGIN) |
| `@adhd/webhook-plugin` | `task:completed`, `task:failed`, `task:cancelled` | Webhook notifications (PLUGIN) |
| `@adhd/summary-plugin` | `message:appended` | Conversation summarisation (PLUGIN) |

---

## Full Feature Evaluation

29 features scored. Sorted by Strategic Score descending.

| # | Feature | Ext | BI (w/mw) | Coverage | Diff | Strategic | Signal | Verdict |
|---|---------|-----|-----------|----------|------|-----------|--------|---------|
| 0 | Agent and task metrics | 7.5 | 6.0 | 2 | 9 | 8.10 | MOAT | **PLUGIN** |
| 1 | Per-task priority queue | 6.3 | 7.2 | 1 | 10 | 7.78 | NICHE | **CORE** |
| 2 | Session message pinning | 6.5 | 6.4 | 2 | 9 | 7.50 | NICHE | **PLUGIN** |
| 3 | Agent capability profiles | 6.7 | 6.8 | 3 | 8 | 7.22 | MOAT | **PLUGIN** |
| 4 | Cost budget enforcement | 6.3 | 6.4 | 3 | 8 | 6.98 | MOAT | **PLUGIN** |
| 5 | Per-agent concurrency limit | 6.2 | 7.0 | 3 | 8 | 6.92 | Moat | **CORE** |
| 6 | Scheduled tasks | 5.8 | 4.0 | 3 | 8 | 6.68 | MOAT | SERVICE→**PLUGIN** |
| 7 | Persistent tool memory | 7.7 | 5.6 | 7 | 4 | 6.22 | TABLE STAKES | **PLUGIN** |
| 8 | Session branching | 7.0 | 6.4 | 6 | 5 | 6.20 | NICHE | **PLUGIN** |
| 9 | Webhook notifications | 6.3 | 5.4 | 5 | 6 | 6.18 | MOAT | **PLUGIN** |
| 10 | Token usage tracking | 8.2 | 7.0 | 8 | 3 | 6.12 | TABLE STAKES | **CORE** |
| 10a | max_tokens + stop_reason tracking | 7.5 | 9.0 | 10 | 2 | 6.38 | TABLE STAKES | **CORE** |
| 10b | Context window full handling | 8.5 | 6.0 | 8 | 3 | 6.50 | TABLE STAKES | **CORE** |
| 11 | Session export | 7.5 | 6.2 | 7 | 4 | 6.10 | TABLE STAKES | **PLUGIN** |
| 12 | Shared blackboard | 6.8 | 4.2 | 6 | 5 | 6.08 | NICHE | **SERVICE** |
| 13 | Session message pinning | 6.5 | 6.4 | 2 | 9 | 7.50 | NICHE | **PLUGIN** |
| 14 | Task chaining | 7.5 | 8.4 | 8 | 3 | 5.70 | TABLE STAKES | **CORE** |
| 15 | Dynamic context injection | 7.2 | 6.8 | 9 | 2 | 5.12 | TABLE STAKES | **PLUGIN** |
| 16 | Task prompt templates | 7.0 | 5.0 | 8 | 3 | 5.40 | INTEGRATE | **PLUGIN** |
| 17 | Session message pinning | 6.5 | 6.4 | 2 | 9 | 7.50 | NICHE | **PLUGIN** |
| 18 | Task-level auto-retry | 5.8 | 6.6 | 6 | 5 | 5.48 | TABLE STAKES | **PLUGIN** |
| 19 | Provider fallback chain | 6.0 | 6.8 | 7 | 4 | 5.20 | INTEGRATE | **PLUGIN** |
| 20 | HITL interrupts | 7.0 | 7.8 | 9 | 2 | 5.00 | TABLE STAKES | **CORE** |
| 21 | OTLP trace export | 6.3 | 3.6 | 8 | 3 | 4.98 | INTEGRATE | SERVICE→**PLUGIN** |
| 22 | Entity memory | 6.3 | 3.8 | 6 | 5 | 5.78 | INTEGRATE | SERVICE→**PLUGIN** |
| 23 | Task dependency DAG | 6.2 | 7.4 | 8 | 3 | 4.92 | INTEGRATE | **CORE** |
| 24 | Structured output enforcement | 6.7 | 6.4 | 9 | 2 | 4.82 | TABLE STAKES | **PLUGIN** |
| 25 | Inline guardrails | 5.8 | 5.0 | 8 | 3 | 4.68 | TABLE STAKES | **PLUGIN** |
| 26 | Conversation summarisation | 5.7 | 6.4 | 8 | 3 | 4.62 | TABLE STAKES | **PLUGIN** |
| 27 | Structured task decomposition | 5.7 | 7.0 | 8 | 3 | 4.62 | INTEGRATE | **CORE** |
| 28 | Parallel tool execution | 5.7 | 8.2 | 9 | 2 | 4.22 | TABLE STAKES | **CORE** |
| 29 | Checkpointing + replay | 5.0 | 6.0 | 9 | 2 | 3.80 | INTEGRATE | **PLUGIN** |
| 30 | Task streaming via SSE | 4.8 | 5.6 | 9 | 2 | 3.68 | TABLE STAKES | BORDERLINE |

---

## Strategic Quadrant Analysis

### MOAT — Build and Own

These features have high necessity in production AND low framework coverage. They represent agent-mcp's genuine competitive advantage as a server-management infrastructure layer.

| Feature | Strategic | Why frameworks don't have it |
|---------|-----------|------------------------------|
| **Agent and task metrics** | **8.10** | Frameworks are ephemeral — no persistent store to aggregate across sessions, agents, or time windows |
| Agent capability profiles | 7.22 | Frameworks are single-process; no multi-tenant agent isolation |
| Cost budget enforcement | 6.98 | Python frameworks run user-owned scripts; no multi-tenant billing layer |
| Per-agent concurrency limit | 6.92 | No persistent server to enforce limits against |
| Scheduled tasks | 6.68 | No persistent scheduler; users run cron externally |
| Webhook notifications | 6.18 | Async notification requires a persistent server to fire them |
| Per-task priority queue | 7.78 | No task queue abstraction; Python frameworks execute inline |

### TABLE STAKES — Must Match

High necessity, lower differentiation. Needed to be a complete product but won't be the differentiator.

- Token usage tracking
- Persistent tool memory
- Session export
- Task chaining
- HITL interrupts
- Task streaming via SSE
- Structured output enforcement
- Task-level auto-retry

### NICHE — Useful Specialty

Lower necessity but genuinely differentiated. Worth building once core is solid.

- Per-task priority queue (high diff, production use cases in orchestration servers)
- Session message pinning
- Session branching

### INTEGRATE — Use External Tools

Both low necessity and low differentiation. Wire in existing best-in-class solutions rather than building.

| Feature | Recommended external tool |
|---------|--------------------------|
| Checkpointing + replay | LangGraph checkpointing API |
| OTLP trace export | LangSmith / AgentOps / OpenTelemetry SDK |
| Task prompt templates | LangChain `PromptTemplate` |
| Provider fallback chain | LiteLLM |
| Entity memory | Mem0 / CrewAI memory |
| Task dependency DAG | LangGraph Send API |

---

## Shipped in 1.0.0

The first consolidated release ships the full task-orchestration core as one
interdependent version:

- **Task schema foundation** — `depends_on`, `on_upstream_failure`, `inputs`,
  `resume_token` columns; `waiting` + `awaiting_input` statuses.
- **Parallel tool execution** — concurrent (`Promise.all`) tool dispatch per turn.
- **Task dependency DAG** (#14 task chaining) — fan-in via `depends_on`, cycle
  rejection, fail/skip upstream policy.
- **HITL interrupts** (#13) — `request_human_input` + `task_resume`.
- **Task streaming (SSE)** — `stream: true` → `stream_url`; tool/status/done events.
- **Token usage tracking** (#2) — `task_usage` + `usage_query`.
- **Ephemeral task observability** — `agent_name` one-shot runs persist
  tasks/events/usage (nullable `session_id` + `is_ephemeral`).

---

## Recommended Build Order

### Phase 1 — Foundation (Core + Middleware)

Prerequisite for everything else. No new user-facing features, but unblocks the plugin ecosystem.

1. **Lifecycle event middleware** — 11 hooks in orchestrator
2. **Token usage tracking** — CORE, straightforward, high necessity ✓ (implemented)
   - *0.0.6 follow-on:* `max_tokens` + `stop_reason` columns in `task_usage` — detect truncated outputs; see Gap #6
3. **Context window full handling** — CORE; detect `CONTEXT_WINDOW_EXCEEDED` + sliding-window truncation; configurable via `AGENT_MCP_CONTEXT_LIMIT`; see Gap #7
4. **Per-task priority queue** — CORE, highest strategic score among infrastructure features
5. **Per-agent concurrency limit** — CORE, needed before multi-agent production use

### Phase 2 — Moat Features (Plugins)

Ship as separate `@adhd/*-plugin` packages consuming Phase 1 hooks.

5. **Agent and task metrics** (`@adhd/metrics-plugin`) — Strategic 8.10; blocked on Phase 1 token usage tracking (task_usage table)
6. **Cost budget enforcement** (`@adhd/budget-plugin`) — Strategic 6.98
7. **Agent capability profiles** — Plugin, extends agent definition schema
8. **Webhook notifications** (`@adhd/webhook-plugin`) — Strategic 6.18
9. **Scheduled tasks** — SERVICE or PLUGIN depending on persistence model chosen

### Phase 3 — Table Stakes (Plugins)

9. **Persistent tool memory** (`@adhd/memory-plugin`)
10. **Session branching** — Extends session store
11. **Session export** — Low-risk, high impact, pure read path
12. **Task-level auto-retry** (`@adhd/retry-plugin`)

### Phase 4 — Completeness

13. **HITL interrupts** — ✓ shipped 1.0.0 (`request_human_input` + `task_resume`)
14. **Task chaining** — ✓ shipped 1.0.0 (task dependency DAG: `depends_on` fan-in)
15. **Conversation summarisation** (`@adhd/summary-plugin`)
16. **Structured output enforcement** — Mostly provider-side

---

## Framework Coverage Reference

Scores (1–10, higher = better covered by existing frameworks):

| Feature | LangGraph | CrewAI | AutoGen | OAI SDK | Sem Kernel | LangChain | Avg |
|---------|-----------|--------|---------|---------|------------|-----------|-----|
| Checkpointing | 10 | 6 | 8 | 5 | 7 | 7 | 7.2 |
| Task streaming | 9 | 8 | 9 | 10 | 8 | 8 | 8.7 |
| HITL interrupts | 10 | 7 | 8 | 9 | 6 | 7 | 7.8 |
| Structured output | 9 | 9 | 9 | 10 | 8 | 9 | 9.0 |
| Parallel tools | 10 | 8 | 9 | 9 | 8 | 9 | 8.8 |
| Provider fallback | 8 | 6 | 7 | 7 | 8 | 7 | 7.2 |
| Token tracking | 8 | 7 | 8 | 9 | 8 | 8 | 8.0 |
| Cost budgets | 4 | 3 | 3 | 4 | 3 | 3 | 3.3 |
| Concurrency limits | 3 | 4 | 3 | 2 | 4 | 3 | 3.2 |
| Priority queue | 1 | 1 | 1 | 1 | 2 | 1 | 1.2 |
| Scheduled tasks | 2 | 3 | 3 | 3 | 4 | 3 | 3.0 |
| Agent profiles | 3 | 4 | 3 | 3 | 4 | 3 | 3.3 |
| Webhook notifs | 4 | 5 | 5 | 6 | 5 | 5 | 5.0 |
| Session pinning | 2 | 2 | 2 | 2 | 3 | 2 | 2.2 |
| Session branching | 6 | 5 | 5 | 5 | 6 | 6 | 5.5 |

---

## Strategic Thesis

Python agent frameworks (LangGraph, CrewAI, AutoGen, OAI SDK) are designed for single-user, single-process, ephemeral execution. They excel at AI-native capabilities: structured output, HITL, checkpointing, tool orchestration. These are solved problems.

agent-mcp's opportunity is the infrastructure layer that persistent, multi-tenant, server-managed agent deployments require — capabilities that simply don't exist because those frameworks never needed them:

- **Who gets to run** (capability profiles, allowlists)
- **How many run at once** (concurrency limits, priority queues)
- **How much they cost** (budget enforcement per agent, per session, per period)
- **When they run** (scheduled tasks)
- **Who gets notified** (webhooks, async completion signals)

This is not an AI problem. It is a server management problem applied to AI agents. That is the moat.
