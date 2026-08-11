# Run-Control Cap Research — External Vocabulary & User Perception

Status: RESEARCH RECORD (2026-08-11) — persisted because memory/backlog stores were down
Researcher: dispatched by product (research agent), 25 queries, 7 pages fetched
Access date for all URLs: 2026-08-11
Companion to: `docs/agent-mcp/PLAN-run-control-v2.md`

> Why this exists: the research agent's findings could not be written to memory
> (memory DB down — stale WAL-index sidecar, BL-373; `retryable:false`). This doc is
> the durable record. On store recovery, the per-finding items below should be
> ingested as memory episodes tagged `agent:approved` / `pattern:recommended` /
> `use-case:reference`, topic `tool-catalog`.

---

## 1. Products → cap vocabulary → units → where surfaced

| Product | Cap vocabulary exposed | Units / fields | Where surfaced |
|---|---|---|---|
| **OpenAI Platform** | RPM, RPD, TPM, TPD, IPM, audio-minutes; usage tiers 1–5; rate limits vs quotas as distinct concepts | requests/tokens per min/day, images/min, audio min | https://developers.openai.com/api/docs/guides/rate-limits ; https://tokenswise.com/rate-limits/openai/ |
| **Anthropic Platform** | Org-level spend limits (monthly USD); API rate limits; Usage & Cost API; Claude Enterprise spend caps at every level | USD/month; requests per period; tokens | https://platform.claude.com/docs/en/api/rate-limits ; https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend |
| **Claude Code** | `--max-turns` (agentic turns, no default, exits with error at limit); `--max-budget-usd` (subagent spend counts toward cap; `Budget limit reached` abort) | turns; USD | https://code.claude.com/docs/en/cli-reference |
| **Claude Agent SDK (Python)** | Session resource limits & cost control: bound turn count, cumulative spend, typed `RateLimitEvent` | turns; cumulative spend | https://deepwiki.com/anthropics/claude-agent-sdk-python/6.4-resource-limits-and-cost-control |
| **OpenAI Agents SDK** | `max_turns` (default 10, `MaxTurnsExceeded`); `max_output_tokens`; guardrail tripwires; `error_handlers` by error kind | turns; tokens; events | https://openai.github.io/openai-agents-python/ref/run/ ; https://github.com/openai/openai-agents-python/issues/551 |
| **LangGraph / LangChain** | `recursion_limit` (default 25 supersteps, `GraphRecursionError`); deepagents 2000; no built-in cost cap | steps/supersteps | https://reference.langchain.com/python/langgraph/errors/GraphRecursionError |
| **CrewAI** | `max_iter` (default 20; 25 in v1.14.7); `max_execution_time` (seconds); `max_rpm`; `max_retry_limit` (default 2); `max_reasoning_attempts`; `respect_context_window` | iterations; seconds; RPM; retries | https://docs.crewai.com/en/concepts/agents |
| **Vercel AI SDK** | `maxSteps` (deprecated SDK 6 → `stopWhen`/`prepareStep`; SDK6 20-step `ToolLoopAgent` cap); ESLint `require-max-steps` | steps | https://ai-sdk.dev/docs/agents/loop-control ; https://eslint.interlace.tools/docs/security/plugin-vercel-ai-security/rules/require-max-steps |
| **AutoGen (MSFT)** | `max_consecutive_auto_reply` (termination when auto-replies to same sender exceed threshold; default None → class constant, observed 10); `is_termination_msg`; `human_input_mode` | consecutive auto-replies | https://microsoft.github.io/autogen/0.2/docs/tutorial/chat-termination/ |
| **LangSmith** | Alerts on error rate, latency, feedback scores (Slack/PagerDuty/webhook) | error rate %, latency, scores | https://www.langchain.com/blog/langsmith-alerts |
| **AWS Bedrock** | Guardrails = content policies (filters, PII), not budget caps | policy blocks | https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html |
| **Cursor** | 500 fast requests/month (Pro) + unlimited slow; premium-model quota; slow-mode fallback | requests (fast/slow) | https://cursor.com/help/models-and-usage/usage-limits |
| **GitHub Copilot** | 5 limit categories: request-rate, token-window, token-quota, daily quotas, concurrency; AI-credit session limits (2026-07-01, covers subagents + background) | requests, tokens, quotas, AI credits | https://docs.github.com/en/copilot/concepts/usage-limits ; https://github.blog/changelog/2026-07-01-set-ai-credit-session-limits-in-copilot-cli-and-sdk/ |
| **Devin (Cognition)** | ACUs (Agent Compute Units): number+complexity of actions + VM time + bandwidth; sleeps after ~0.1 ACU idle; no user-configurable per-task caps | ACUs; VM time | https://docs.devin.ai/admin/billing/usage |
| **OpenCode** | Agent `steps` (max agentic iterations before forced text response); `doom_loop` permission key (recovery prompts when agent appears stuck) | iterations | https://opencode.ai/docs/agents/ |
| **mcp-agent** | Temporal `timeout_seconds`, `max_concurrent_activities`; Deep Orchestrator advertises "budget management" (internals not published) | seconds; activities | https://docs.mcp-agent.com/reference/configuration |
| **n8n (pattern)** | Retry budget across executions: disable trigger + alert if >5 runs fail in 10 min | failures per window | https://medium.com/@automation.labs/the-n8n-agent-retry-budget-stop-runaway-loops-before-they-drain-your-api-credits-53626e09d812 |

## 2. User perception — complaints with evidence

- **Token caps kill tasks at trivial cost (cache/context re-evaluation):**
  - "every time your AI agent makes an API call, it re-sends the entire conversation
    history… In a 10-turn agent loop, you're paying for your system prompt 10 times,
    your tool results 10 times, and every previous response 10 times." —
    https://tokenfence.dev/blog/ai-agent-context-window-cost-optimization
  - "It really highlights the hidden cost of context window re-evaluation… 2x $200
    Max fully every week ≈ $5000 API usage?" — Show HN https://news.ycombinator.com/item?id=48297491
- **Context-limit creep feels like a silent backend change:** "The context limit
  seems to fill up much faster on the same project that was working fine just days
  ago… feels like a backend or token allocation shift." —
  https://news.ycombinator.com/item?id=47096937
- **Missing per-task cost enforcement → real money incidents:** "$6,000 in Claude
  Code credits overnight… $1,800 in two days" —
  https://devtoolpicks.com/blog/ai-agents-runaway-claude-code-bills-overnight-2026 ;
  Microsoft reportedly dropping Claude Code after burning its yearly AI budget —
  https://cybernews.com/ai-news/microsoft-claude-code-burn-yearly-ai-budget/
- **Unit/name confusion:** CrewAI `max_execution_time` — "can this explicitly state
  if it's seconds or minutes… the agent didn't stop at or slightly after 60th
  second mark" — https://github.com/crewAIInc/crewAI/issues/732
- **Rate limit ≠ quota confusion:** "You can be comfortably under one axis and
  blocked by another, which is why 'I'm nowhere near my request limit' and a 429
  happily coexist." — https://tokenswise.com/rate-limits/openai/
- **Budget alerts arrive too late for autonomous agents:** "We had budget alerts.
  They fired daily. Problem is agents don't wait for emails, they run 24/7. By the
  time AWS sends 'you hit 80% of daily budget,' agents have already executed
  2,000…" — https://medium.com/@teja.kusireddy23/we-had-budget-alerts-855feb81658b
- **Crash-don't-degrade limits:** "The native recursion_limit is a blunt instrument.
  It throws a GraphRecursionError, crashes the run, and wipes your checkpointed
  state." — https://www.reddit.com/r/LangChain/comments/1u93lof/

## 3. Loop/stall/error detection — what ships

| Mechanism | Product | Published threshold | Source |
|---|---|---|---|
| Superstep cap | LangGraph | `recursion_limit` 25; deepagents 2000 | https://reference.langchain.com/python/langgraph/errors/GraphRecursionError |
| Turn cap | OpenAI Agents SDK | `max_turns` 10 | https://github.com/openai/openai-agents-python/issues/551 |
| Iteration cap | CrewAI | `max_iter` 20 (25 v1.14.7) | https://docs.crewai.com/en/concepts/agents |
| Consecutive auto-reply cap | AutoGen | `max_consecutive_auto_reply` default None→class constant (observed 10) | https://microsoft.github.io/autogen/0.2/docs/tutorial/chat-termination/ |
| Agentic-step cap | Vercel AI SDK / OpenCode | `maxSteps`; SDK6 20-step; OpenCode `steps` | https://ai-sdk.dev/docs/agents/loop-control |
| Error-rate alerting | LangSmith | Alerts on error rate | https://www.langchain.com/blog/langsmith-alerts |
| Error-handler dispatch | OpenAI Agents SDK | `error_handlers` by error kind | https://openai.github.io/openai-agents-python/ref/run/ |
| No-progress detection | Community only (not shipped by major frameworks) | hash repeated (tool, args, error) tuples | https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress |
| Cross-run failure window | n8n | >5 failures in 10 min → disable + alert | https://medium.com/@automation.labs/the-n8n-agent-retry-budget-stop-runaway-loops-before-they-drain-your-api-credits-53626e09d812 |
| Stuck-agent recovery prompt | OpenCode | `doom_loop` permission key | https://opencode.ai/docs/agents/ |
| Wall-clock timeout | Claude Code SDK / community | session bounds; community 10 min | https://deepwiki.com/anthropics/claude-agent-sdk-python/6.4-resource-limits-and-cost-control |
| Retry waste benchmark | Research | "90.8% of retries spent on hallucinated tool calls" (200-task benchmark) | https://towardsdatascience.com/your-react-agent-is-wasting-90-of-its-retries-heres-how-to-stop-it/ |

**Key takeaway:** shipped loop detection is almost entirely step/turn counting.
No major framework ships no-progress/repeated-action detection as a first-class
budget — only community/advisory patterns + OpenCode's `doom_loop`.

## 4. The "error cap" — precedent

- **CrewAI — shipped:** `max_retry_limit` (agent-level): "Maximum number of retries
  when an error occurs. Default is 2." — https://docs.crewai.com/en/concepts/agents
- **Task-level failure budget — production pattern with numbers** (dev.to, Apr 2026,
  Anythoughts.ai): Layer 1 per-tool `max_retries=3` + backoff; Layer 2 task-level
  failure budget — "Each agent run gets a failure budget — a max number of errors
  across all tool calls. Once exceeded, the entire run halts… For our outreach
  agent, the budget is 5" (code default `failure_budget=10`); Layer 3 wall-clock
  timeout 10 min. Incident: agent retried a 429 ~90 min / "several hundred
  unnecessary API calls" → "We almost burned $400 in one afternoon." —
  https://dev.to/alex_wu_anythoughts_ai/the-infinite-loop-problem-how-we-stopped-our-agent-from-running-forever-3ckb
- **n8n cross-execution:** >5 failures in 10-min window → disable trigger + alert.
- **Per-run triple budget (advisory):** `max_tool_calls=8, max_seconds=45,
  max_usd=1.00` → stop at limit. — https://www.agentpatterns.tech/en/governance/budget-controls
- **No published rationale for any specific error-cap number** (why 5 vs 10) — a
  design gap: defaults exist, data-driven rationale doesn't.

## 5. What users ask for that products DON'T ship

1. **Enforced (not just tracked) token budgets per agent/team** — open-multi-agent
   #60: "tracking is read-only observability — there is no mechanism to enforce a
   budget and abort when spending exceeds a threshold" →
   https://github.com/open-multi-agent/open-multi-agent/issues/60
2. **Per-step loop control / hookable iteration limits** — vercel/ai #4954 →
   https://github.com/vercel/ai/issues/4954
3. **Turn-limit propagation to sub-agents-as-tools** — openai-agents-python #551 →
   https://github.com/openai/openai-agents-python/issues/551
4. **Agent-level retry limiting** — CrewAI community →
   https://community.crewai.com/t/limit-agent-retries/1657
5. **Budget intelligence/remaining-budget visibility in UI** — cc-budget exists
   because Claude Code lacks it → https://github.com/boyand/cc-budget
6. **"Stop if no progress"** — no framework ships it; repeatedly requested →
   https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress
7. **Progressive spend-threshold alerts (80% soft cap before hard cut)** →
   https://www.agentpatterns.ai/patterns/agent-design/progressive-spend-threshold-alerting/

## 6. Implications for our design (fed into PLAN-run-control-v2)

(a) **Error cap + consecutive errors** = most differentiated cap available (weak
competition: only CrewAI ships a version; strong user pull). → Packet C.
(b) **No-progress/repeated-action guard** = novel, kills the top complaint class
(loops burning budget). → Packet D (design only).
(c) **Vocabulary:** rename `calls`→`turns` aligns with industry; name units
explicitly (CrewAI #732); disclose defaults. → see plan §5 open points.
(d) **Cost/time caps have strong precedent** (Claude Code --max-budget-usd counts
subagent spend; Copilot AI-credit session limits). → recursion rollup future feature
(plan §6).
(e) **Thresholds to copy:** turns 10-25; per-tool retries 3; task failure budget
5/10; wall-clock 10 min; error retry 2; 5 failures/10min; 80% budget alert.

## 7. Coverage & failure disclosure

- Covered: OpenAI, Anthropic/Claude Code + Agent SDK, OpenAI Agents SDK,
  LangGraph/LangSmith, CrewAI, Vercel AI SDK, AutoGen, AWS Bedrock, Cursor, GitHub
  Copilot (+Workspace + AI-credit session limits), Devin, OpenCode, mcp-agent, n8n.
- Scholarly/arxiv: NOT searched (production posts + framework docs are higher signal
  for a cap-vocabulary question) — flagged coverage gap.
- Google captcha: 1 query rerouted to duckduckgo, no data lost.
- Unverified (LOW confidence): AutoGen `MAX_CONSECUTIVE_AUTO_REPLY` class-constant
  value (observed 10 via issue #254, not confirmed in source); mcp-agent Deep
  Orchestrator budget internals; CrewAI default drift 25→20 changelog date.
- Memory write: BLOCKED (stale WAL sidecar, BL-373) — this doc is the durable record.
