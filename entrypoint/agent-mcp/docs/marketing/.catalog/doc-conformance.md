# @adhd/agent-mcp — Documentation Conformance Audit

**Scope:** /Users/nix/dev/node/adhd/entrypoint/agent-mcp
**Audit date:** 2026-07-12
**Total existing docs:** 1 file (provider-call-audit.md)
**Total shipped capabilities:** 33 (17 MCP tools, 2 HTTP endpoints, 8 providers/config, 6 advanced features)

---

## Existing Documentation Summary

### 1. `docs/provider-call-audit.md` — **TECHNICAL AUDIT, NOT USER DOCS**

**Status:** ✅ Correct, valuable, but narrow scope — technical audit of token overhead + usage tracking, not consumer-facing capability docs.

**Content:**
- What goes to provider API each turn (tool list fetching, hook emission, provider call)
- What gets stored in DB (task_events, task_usage, cache_read_tokens fix)
- Comparison with OpenCode/Claude Code
- Opportunities (8 items, 3 marked SHIPPED: tool list hoisting, MODEL_RESPONSE token tracking, tool advertisement)
- Verbatim provider request breakdown with token annotations

**Issues:**
- ✅ Accurate and grounded (cites code line numbers, committed implementations)
- ✅ Valuable for future optimization decisions
- ❌ **NOT DOCUMENTED:** Performance metrics from the opportunities achieved (e.g., "tool advertisement saves ~1600 tokens/turn" is stated in capabilities.md but NOT in this audit — the audit was written before full measurement)
- ❌ **OUTDATED:** Refers to old file paths (packages/ai/agent-mcp/* instead of entrypoint/agent-mcp/*)
- ❌ **SCOPE MISMATCH:** Zero consumer-facing capability documentation (no task running examples, no workflow guide, no MCP tool reference)

**Recommendation:** `KEEP + REVISE` — Update file paths, add measured performance deltas (token/turn savings from opportunities shipped). Move to docs/technical/optimization-audit.md to separate technical research from user docs.

---

## Documentation Gaps (Major)

### Missing: Consumer-Facing README

**Gap:** No README.md in the package. Consumers cannot discover:
- What this package is (MCP server for multi-agent orchestration)
- How to install/run it
- How to create first agent (code example)
- How workflows differ (ephemeral vs session vs delegation vs HITL)
- Which providers are supported + how to configure
- Common error codes and what to do

**Impact:** A consumer opening the package repo sees only package.json, drizzle migrations, and tests. They must read test code or source to learn anything.

**Receipts:** No README.md exists. USAGE_GUIDE text exists in src/server.ts:160-281 (in-tool help) but is not discoverable from the package surface.

**Recommendation:** `CREATE README.md` with:
1. Overview (1 para)
2. Quick start (install + run)
3. First agent example (code)
4. Provider configuration (table)
5. Common workflows (session, ephemeral, delegation)
6. HTTP gateway section (OpenAI compat)
7. Error reference (link to built-in guide)

---

### Missing: CHANGELOG.md

**Gap:** No version history, feature announcements, or breaking change log.

**Receipts:** No CHANGELOG.md.

**Recommendation:** `CREATE CHANGELOG.md` with:
1. v2.0.0 (current): Tool advertisement names-only, orchestrator refactor, API stability
2. v2.0.1 (published): Patch notes (if any since 2.0.0)
3. Deprecation timeline (e.g., BUG-ORCH-014 path change)

---

### Missing: Configuration Reference (docs/CONFIG.md or in README)

**Gap:** ADHD_AGENT_* environment variables are scattered across config.ts and the USAGE_GUIDE in server.ts. No central reference.

**Receipts:** USAGE_GUIDE mentions ADHD_AGENT_OPENAI_SECRET, ADHD_AGENT_ANTHROPIC_SECRET, but omits many config options (ADHD_AGENT_DATABASE_PATH, ADHD_AGENT_LOG_LEVEL, ADHD_AGENT_QUEUE_CONCURRENCY, ADHD_AGENT_MAX_DEPTH, ADHD_AGENT_MAX_TOOL_LOOPS, ADHD_AGENT_CONTEXT_LIMIT, ADHD_AGENT_SSE_PORT, etc.).

**Recommendation:** `CREATE docs/CONFIG.md` with table: env var name | default | type | purpose | required | example.

---

### Missing: API Reference (MCP Tools Detail)

**Gap:** USAGE_GUIDE (in-tool help) documents 5 workflows, but individual tool schemas are not documented. Consumers must read the tool's inputSchema JSON to understand parameters.

**Receipts:** server.ts:160-281 has high-level workflows but no per-tool parameter breakdown (e.g., agent_create signature, task input options, result field descriptions).

**Recommendation:** `CREATE docs/API_REFERENCE.md` with per-tool section:
- Tool name + one-line description
- Input schema (table: parameter | type | required | description)
- Output schema (fields + types)
- Example (curl or MCP call)

---

### Missing: Provider Integration Guide

**Gap:** Which providers are supported? How to configure each? What are the limits/differences?

**Receipts:** USAGE_GUIDE has a 3-row provider table (openai, anthropic, claudecli) with just required fields. No guidance on:
- DeepSeek (is it supported? yes, via openai-compatible endpoint, but not mentioned in USAGE_GUIDE)
- Base URL override (LM Studio, Ollama)
- Cache behavior per provider (Anthropic compaction vs OpenAI prefix vs DeepSeek no-premium)
- Token usage normalization differences (Anthropic EXCLUDES cache tokens, others INCLUDE)

**Recommendation:** `CREATE docs/PROVIDERS.md` with per-provider section: name | supported models | auth | cache behavior | known limits | example config.

---

### Missing: Advanced Features Guide

**Gap:** Agent delegation, HITL, background tasks, tool advertisement are real, shipped features but undocumented as a user-facing feature (only in code comments and USAGE_GUIDE's single line "Workflow 3").

**Receipts:**
- Agent delegation: USAGE_GUIDE line 215-219 (5 lines, no example)
- HITL: USAGE_GUIDE lines 280 (1 line in error table) + tool_resume description (no workflow)
- Background: USAGE_GUIDE lines 207-211 (5 lines, workflow shown)
- Tool advertisement: zero mention in user-facing docs (only in provider-call-audit.md + code comments)

**Recommendation:** `CREATE docs/ADVANCED.md` with section per feature:
- Agent Delegation (example: coordinator→workers DAG)
- HITL (example: user input suspension)
- Tool Advertisement (names-only vs full; trade-offs)
- Prompt Caching (per-provider behavior; optimization tips)

---

### Missing: Deployment & Operations

**Gap:** How to run in production? SQLite vs. network DB? Where do logs go? How to scale? How to monitor?

**Receipts:** src/config.ts and src/index.ts define logging (Pino), database path (SQLite only, no network DB support), SSE streaming (separate port). No docs on these choices.

**Recommendation:** `CREATE docs/OPERATIONS.md` with:
- Database setup (SQLite WAL mode, file location, backups)
- Logging configuration + log parsing
- Monitoring (task queue depth, session count, token spend alerts)
- Scaling limits (single-process, SQLite concurrency)
- Deployment checklist (env vars, secrets)

---

### Missing: Security Guide (Environment Variables)

**Gap:** ADHD_AGENT_* prefix guard is a security feature, but no documentation of the intent or how to configure it.

**Receipts:** src/index.ts:96-128 (verifyAgentEnvRefs warns at startup), BACKLOG.md:BUG-ORCH-011 (security regression + guard weakened). USAGE_GUIDE has no security section.

**Recommendation:** `CREATE docs/SECURITY.md` (or add to README) with:
- Env-var-name allowlist rationale
- How to extend ADHD_AGENT_ENV_ALLOWLIST if needed
- Secret rotation (no docs on key rotation for stored credentials)
- Common attack surface (session hijacking, agent permission escapes)

---

## Conformance Proportion Breakdown

**Total capabilities (from capabilities.json):** 33 shipped
**Capabilities mentioned in ANY existing doc:** ~8 (agent_create/read/update/delete/list, task, result, session, usage_query, guide, providers table, workflows)
**Capabilities undocumented:** ~25

**Doc Quality by Category:**

| Category | Documented | Undocumented | Quality | Notes |
|----------|-----------|--------------|---------|-------|
| MCP tools (17) | 5/17 (30%) | 12/17 | POOR | Only high-level workflow; no tool reference |
| HTTP endpoints (2) | 0/2 | 2/2 | MISSING | Chat gateway + models endpoint exist but not documented |
| Providers (4) | 3/4 (75%) | 1/4 | FAIR | DeepSeek missing; Claude CLI minimal |
| Advanced (6) | 2/6 (33%) | 4/6 | POOR | Delegation + background shown; HITL/tool-ads missing |
| Storage/Config (4) | 0/4 | 4/4 | MISSING | Zero docs on SQLite setup, env config, logging |

**Overall conformance:**
- JUNK (wrong/stale): 0% — provider-call-audit.md is accurate but outdated paths
- REDUNDANT (duped elsewhere): 0%
- ORPHANED (real capability, zero docs): ~76% (25/33 capabilities)
- UNDOCUMENTED (real capability, minimal docs): ~24% (8/33 with high-level mention only)

→ **Verdict: SEVERE DOCUMENTATION DEFICIT. A new consumer cannot learn this package from its public surface.**

---

## Extracted Orphans (Undocumented but Real)

These capabilities exist in code, are tested/shipped, but have zero consumer-facing documentation:

1. **HTTP /v1/chat/completions** (OpenAI-compatible stateless endpoint) — implemented, untested in CI
2. **HTTP /v1/models** (OpenAI models listing) — implemented, untested in CI
3. **Claude CLI provider** — configured, untested in CI
4. **MCP server bindings & tool registration** — core feature, not explained
5. **Tool advertisement (name-only vs full schema)** — ~1600 token/turn savings, zero user-facing docs
6. **HITL suspension & task_resume** — real feature, only 1 line in error table
7. **Background task execution** — documented in workflow 2 but not as "background execution feature"
8. **Prompt caching per provider** — Anthropic compaction, OpenAI prefix, DeepSeek no-premium — zero guidance
9. **Agent permissions (allowedAgents)** — field exists in schema, not documented
10. **Task usage metrics (usage_query)** — tool exists, no explanation of filters/group_by
11. **SSE task streaming** — feature shipped, zero docs
12. **Registry compiler integration** — graceful fallback documented only in code comment

---

## Recommendations (Priority Order)

### IMMEDIATE (blocker for 2.0.2 docs):

1. **CREATE README.md** — 500 words: overview, quick start, first agent example, provider table, workflows, error reference
2. **CREATE docs/API_REFERENCE.md** — Per-tool schema breakdown for all 17 MCP tools
3. **CREATE docs/PROVIDERS.md** — Per-provider auth, cache behavior, token usage differences, example configs
4. **CREATE docs/CONFIG.md** — Env-var reference table

### NEXT PHASE:

5. **CREATE docs/ADVANCED.md** — Agent delegation, HITL, background, tool advertisement
6. **CREATE CHANGELOG.md** — v2.0.1 vs v2.0.0 delta + deprecation timeline
7. **Revise docs/provider-call-audit.md** — Fix paths, add measured performance deltas, move to docs/technical/

### NICE-TO-HAVE:

8. **CREATE docs/OPERATIONS.md** — Deployment, monitoring, scaling
9. **CREATE docs/SECURITY.md** — Env allowlist, secret rotation, attack surface
10. **CREATE docs/EXAMPLES/** — Runnable examples (Python/JS client code)

---

## Summary for Steward

**Current state:** 1 technical audit doc (accurate but narrow scope, outdated paths).

**User docs missing:** 10+ core docs (README, API reference, provider guide, config, advanced features, changelog, operations, security, examples).

**Conformance:** ~76% of shipped capabilities have zero consumer-facing documentation. A new user cannot discover agent delegation, HITL, tool advertisement, SSE streaming, or HTTP gateway from public docs.

**Blocker for 2.0.2 launch:** README + API reference + provider guide must exist before publishing. Otherwise consumers will file issues asking "how do I create an agent?" and "what's the HTTP endpoint for?"

→ **Action:** Cartographer has extracted 33 shipped capabilities and flagged 10+ doc gaps. Steward should prioritize README + 3 reference docs (API, Providers, Config) for 2.0.2.
