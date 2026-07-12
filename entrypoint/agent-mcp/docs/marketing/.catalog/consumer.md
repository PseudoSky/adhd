# Doc Consumer Test — @adhd/agent-mcp 2.0.2

**Test Date:** 2026-07-12  
**Tester:** doc-consumer agent  
**Scope:** README.md, CHANGELOG.md, AGENTS.md, llms.txt, architecture-and-security.md

**Summary:** 3/3 canonical tasks PASSED using documentation alone (no source code access).

---

## Task 1: Quick-Start Installation & First Agent

**Intent:** A developer with OpenAI API key installs the package, starts the MCP server, creates agents (Anthropic + OpenAI), sends tasks, and retrieves results.

**Documentation sections consulted:**
- README.md: Installation, quick-start example, environment variables
- AGENTS.md: MCP tool list (agent_create, task, result signatures)
- llms.txt: Configuration reference

**Deliverable test:**
```bash
npm install -g @adhd/agent-mcp
ADHD_AGENT_PROVIDER=anthropic ADHD_AGENT_MODEL=claude-opus-4-1 ANTHROPIC_API_KEY=<key> agent-mcp
```

Then (via MCP client):
1. `agent_create(name: "research", config: {...provider: "anthropic", model: "claude-opus-4-1", ...})`
2. `agent_create(name: "coder", config: {...provider: "openai", model: "gpt-4-turbo", ...})`
3. `task(agentName: "research", prompt: "Analyze this paper")` → taskId
4. `result(taskId: "...")` → {status, result, usage}

**Result:** ✅ **PASS**

All commands documented with correct syntax. Field names (e.g., `cacheReadTokens`) match AGENTS.md and CHANGELOG.md. Real JSON-RPC example in README.md shows exact call syntax. No invented tools (agent_message/agent_wait removed in 2.0.2 corrections). Configuration env vars clearly listed.

---

## Task 2: Provider Migration (Anthropic → DeepSeek)

**Intent:** A user switches from Anthropic to DeepSeek; needs to know configuration changes and behavioral differences in token accounting/caching.

**Documentation sections consulted:**
- llms.txt: Supported providers table
- README.md: Environment variables (ADHD_AGENT_PROVIDER, ADHD_AGENT_MODEL)
- CHANGELOG.md: BUG-ORCH-009/010 (provider-neutral token accounting changes)
- AGENTS.md: New token fields (cacheReadTokens, uncachedInputTokens, cacheCreationTokens)

**Deliverable test:**
```bash
# Before:
ADHD_AGENT_PROVIDER=anthropic ADHD_AGENT_MODEL=claude-opus-4-1 ANTHROPIC_API_KEY=<key>

# After:
ADHD_AGENT_PROVIDER=openai ADHD_AGENT_MODEL=deepseek-v4-flash DEEPSEEK_API_KEY=<key> OPENAI_API_BASE_URL=https://api.deepseek.com/v1
```

Expected behavioral differences:
- Token accounting: `cacheReadTokens` (DeepSeek: prompt_cache_hit) vs. `cacheCreationTokens` (none for DeepSeek)
- Caching: DeepSeek automatic prefix-cache (50x hit:miss price difference per provider-caching-research.md)
- Context management: 2.0.2 append-only history (vs 2.0.1's front-eviction that busted cache)

**Result:** ✅ **PASS**

README and AGENTS.md document provider table. CHANGELOG 2.0.2 section clearly explains normalized token fields and their provider-dependent meanings. DeepSeek's cache behavior mentioned in architecture-and-security.md with link to provider-caching-research.md. User can make the switch without source reading.

---

## Task 3: Debugging Token Usage (Advanced)

**Intent:** User sees usage report with `inputTokens: 715316`, `peakContextTokens: 43187`, `cacheReadTokens: 525056`, `uncachedInputTokens: 190260`. Needs to understand: which number is for "am I close to the context window?" and what each means.

**Documentation sections consulted:**
- AGENTS.md: Token Accounting section (2.0.2 Changes)
- CHANGELOG.md: BUG-ORCH-008 (3.3x cost inflation from cache busting) and BUG-ORCH-009/010 (new token fields)
- architecture-and-security.md: task_usage schema with field descriptions
- llms.txt: 2.0.2 highlights

**Deliverable test:**

Role of each field:
- `inputTokens` (715316): **Cumulative billed input** across all model calls (FINDING-ORCH-007: NOT a context size)
- `peakContextTokens` (43187): **MAX prompt size in any single call** — the number for "am I close to the 1M-token DeepSeek ceiling?" (this is the answer)
- `cacheReadTokens` (525056): **Cache-hit tokens** (discounted; 50x cheaper than cache-miss)
- `uncachedInputTokens` (190260): **Full-price tokens** (cache-miss; the expensive ones)
- `cacheCreationTokens`: Anthropic surcharge (0 for DeepSeek)

**Result:** ✅ **PASS**

CHANGELOG BUG-ORCH-008 explicitly explains the distinction (cumulative != context size). CHANGELOG BUG-ORCH-009/010 documents each new field. AGENTS.md provides the table with field meanings. Architecture doc schema block shows DB columns + comments. User can distinguish what `peakContextTokens` is for without guessing. The old bug's lesson (measuring cost as context) is corrected in the 2.0.2 release notes.

---

## Summary

| Task | Outcome | Notes |
|------|---------|-------|
| Quick-Start | ✅ PASS | Exact install/config/tool-call examples; no invented tools |
| Provider Migration | ✅ PASS | Configuration env vars clear; token-accounting differences explained |
| Token Usage Debugging | ✅ PASS | New 2.0.2 fields documented; cumulative vs. peak distinction clear |

**All canonical tasks completed using ONLY documentation. No source code required.**

---

## Notes

- The 2.0.2 corrections (16 real tools, correct field names, real quickstart JSON-RPC, 3-path plugin fallback chain, accurate schema) eliminated all gaps that would have forced source code reading.
- Remaining gap (SSE streaming endpoint undocumented) is acceptable for this release; flagged in metrics.md as ACTION ITEM for post-2.0.2 phase.
- Link integrity verified except for non-existent LICENSE file (noted in metrics.md as separate issue).

**Verdict: Consumer usability PASS. Documentation is sufficient for independent agent or developer use.**
