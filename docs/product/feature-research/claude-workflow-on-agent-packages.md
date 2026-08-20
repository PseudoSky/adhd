# Feature Research: `.claude/workflow` on top of the @adhd/agent-* packages

**Date:** 2026-08-20 · **Author:** product · **Status:** VALIDATED (architect gate APPROVED_WITH_CONDITIONS) · **Verdict:** PROCEED as a bridge epic

## 1. Problem statement

The team runs two Claude Code workflow scripts (`.claude/workflows/code-quality-sweep.{md,mjs}`, `backlog-grooming.js`) that hardcode their agent personas, prompts, and policies inside the scripts. Meanwhile, the `@adhd/agent-*` registry family (12 packages: `agent-base-types`, `agent-core-env`, `agent-core-policy`, `agent-core-provider`, `agent-engine-compiler`, `agent-engine-orchestrator`, stores, plugins) exists precisely to be the durable source of truth for agents — prompts as components, tool grants, policies, budgets, models — compiled by `compileAgent` and executed by the `Orchestrator` behind the `agent-mcp` MCP server. The question: can a `.claude/workflow` script be written *on top of* these packages, so workflows drive registry-defined agents instead of re-implementing agent logic inline?

## 2. Evidence

### External contract (researcher, primary sources)

The Claude Code Workflow runtime (research preview, v2.1.154+, May 2026; trigger keyword renamed `workflow`→`ultracode` in v2.1.160) is a **hard sandbox for the script itself**:

- **No module loading** — a script containing `import()`/`require` fails before the run starts; a dynamic-`import()` sandbox escape was found and closed (anthropics/claude-code CHANGELOG).
- **No filesystem, no shell/child_process** from the script; no `Date.now()`/`Math.random()` (resume determinism); no documented network.
- Official guidance: *"Put work that needs a library in an agent's task."*
- **Subagents the script dispatches have full tool access** — bash, file edits (auto-approved), web, and **MCP tools per the session allowlist**.
- The script itself has no direct MCP surface; globals are `meta`, `agent`, `parallel`, `pipeline`, `phase`, `args` (+ community-documented `log`/`budget`).
- Limits: 16 concurrent / 1,000 total agents per run; resume is same-session only.

Consequence: **the packages can never be imported into the workflow script.** The only supported ways for a workflow to drive a Node library are (a) its subagents calling an MCP server, or (b) subagents shelling out. Sources: code.claude.com/docs/en/workflows, github.com/anthropics/claude-code CHANGELOG, code.claude.com/docs/en/agent-sdk/typescript.md.

### Architecture gate (architect-decision, one-shot)

**VERDICT: APPROVED_WITH_CONDITIONS** — routing the workflow through the `agent-mcp` MCP seam is the only viable architecture:

- Direct import is structurally impossible in the sandbox (SQLite via `better-sqlite3` needs fs; `ClaudeCliProvider` needs child_process; providers need network; `REGISTRY-PACKAGE-RULES.md` §2 forbids import-time DB opens anyway).
- MCP routing matches the repo's existing convention: `backlog-grooming.js` subagents already call `mcp__backlog__*`; `code-quality-sweep.mjs` too.
- No `docs/decisions/` ADR catalog exists in this repo; registry-family invariants are satisfied (DB opens live in the server process).
- Durability favors the seam: sessions/tasks persist in agent-mcp's SQLite across tool calls and restarts, recoverable via `task_list`/`result` — not trapped in a sandbox that cannot hold a file handle.

**Conditions before building:**
1. Verify *registry-defined* agents actually resolve through the exposed tools (`agent_create` takes inline config, not a registry slug — exercise the prompt-resolver seam, `engine/prompt-resolver.ts`).
2. Pin the `task` sync/async contract in subagent prompts (AGENTS.md says synchronous-until-completion; README shows `{status:"running"}` + `result` poll — handle both deterministically).
3. Prefer `claudecli`-type agents over `anthropic`/`openai` (credential fallback debt `DEBT-MCP-CREDENTIALS-001` fails silently on fresh hosts).
4. The MCP route is designed-in (default-on via `.mcp.json`), never a toggle.

## 3. Strategic fit

- **Shortcut:** a workflow that calls `mcp__agent-mcp__*` tools ad hoc with inline agent configs. Works today but silently bypasses the registry — the thing the question is about.
- **Real path:** a workflow whose subagents drive *registry-defined* agents: agent definition (components → compiled prompt, tools, policy, budget) lives in the registry, the workflow is a thin orchestration shell, and `usage_query` closes the loop.
- **Roadmap tension (named explicitly):** the dispatcher-platform ROADMAP north star is eliminating the need for `claude` CLI/opencode entirely ("on par with sox"). A `.claude/workflow` depends on the very host being replaced. So this epic is a **tactical bridge**: it validates agent-mcp's tool surface through a real second host (the repo's own "prove the consumer outcome through real components" bar), returns near-term value, and the lessons (registry-driven definitions, task lifecycle, usage accounting) transfer directly to dispatcher. It is not the destination.
- **Parity tie-in:** GAP-MATRIX #26/#27 (EPIC-DISPATCH-07-workflow-parity; backlog family `FEAT-DISPATCH-WORKFLOW-PARITY`, 4 items) are the same-shaped gap — personas/skills not in the registry. This epic is the first concrete consumer of that parity.

## 4. Effort / value

- **Effort:** M (one workflow script + one verification harness; no package changes expected unless condition 1 exposes a resolver gap).
- **Value:** dogfooding proof for agent-mcp; registry becomes the single source of agent truth across hosts; policy/budget enforcement + usage accounting free for workflows.
- **Risks:** research-preview host surface (pin versions, re-verify on upgrade); condition 1 may expose that registry resolution through MCP tools is not yet wired (would become a package-scope addition — escalate to architect).

## 5. RICE

- **Reach:** low (2 existing workflows, internal), but the *capability* unlocks every future workflow.
- **Impact:** medium (registry-governed agents, validated second host).
- **Confidence:** high (both gates passed; existing scripts prove the dispatch shape).
- **Effort:** low-medium. → **RICE ~ 1.8–2.5**, right-sized as a bridge epic, not a platform bet.

## 6. Decision

**PROCEED** — one bridge epic (see backlog `FEAT-AGENTMCP-WORKFLOW-*`). Conditions 1–4 from the architect gate are pre-requisites in the epic's acceptance criteria. Deferred (logged): registry-ification of the two existing workflows, skills-in-registry, personas-in-registry — already tracked under `FEAT-DISPATCH-WORKFLOW-PARITY`.

## Citations

- [code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows) — workflow script runtime contract, sandbox limits, agent capabilities
- [github.com/anthropics/claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — v2.1.154 launch, sandbox hardening, keyword rename
- [code.claude.com/docs/en/agent-sdk/typescript.md](https://code.claude.com/docs/en/agent-sdk/typescript.md) — `Workflow()` SDK tool, globals
- `.claude/workflows/code-quality-sweep.mjs:455-456` — sandbox comment; `:586` — `mcp__backlog__*` convention
- `.claude/workflows/backlog-grooming.js:62,182-198` — `Date.now()` restriction; `BACKLOG_MECHANICS` MCP convention
- `.mcp.json` — agent-mcp stdio wiring (`ADHD_AGENT_REGISTRY_DB_PATH`)
- `packages/agent/agent-generator-plugin/REGISTRY-PACKAGE-RULES.md` §2 — registry-family invariants
- `entrypoint/agent-mcp/README.md` / `AGENTS.md` — tool surface, provider model, credential fallback
- `docs/product/dispatcher-platform/ROADMAP.md:11-33` — north star (replace claude cli/opencode)
- `docs/product/dispatcher-platform/GAP-MATRIX.md:190-216` — EPIC-DISPATCH-07-workflow-parity (personas/skills)
