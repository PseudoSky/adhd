# Doc Review — @adhd/agent-mcp 2.0.2 — 7c400a7

**Final Review Gate Run**  
**Timestamp:** 2026-07-12T02:50:00Z  
**Reviewer:** Documentation Assessment Gate (Final)

---

## VERDICT: FAIL

**Reason:** Lens 2 failure — AGENTS.md contains 2 critical inaccuracies referencing removed/renamed tools incompatible with current capabilities.json.

---

## Lens 1 — Closed-Loop Metrics

**STATUS: PASS**

### Evidence

The steward re-ran the cartographer after fixes; metrics.md now contains a post-fix block (lines 74-119).

**Post-fix results (lines 75-89):**
- **metric_1_eliminated_reader_searches:** 23 → 5 (78% improvement; goal was < 10) ✓ PASS
- **metric_3_undocumented%:** 76% → 3% (97% improvement; goal was < 50%) ✓ PASS
- **junk%:** 0% → 0% ✓ PASS

**Contradictions with capabilities.json:**
- All 33 shipped capabilities (per capabilities.json) are status:shipped
- No deprecated items claimed as current
- Roadmap items (AGENTS.md lines 134-145) explicitly marked "Do not document these as shipped features"
- Architecture schema field names verified: snake_case correct (`cache_read_input_tokens`, `cache_creation_input_tokens`, `uncached_input_tokens`, `peak_context_tokens`)
- `peak_context_at` correctly defined as INTEGER (line 157), not TIMESTAMP

✓ **Lens 1 Result: PASS**

---

## Lens 2 — Template Conformance & Accuracy

**STATUS: FAIL**

### Per-Document Scores

| Doc | Score | Status | Finding |
|---|---|---|---|
| README.md | 98/100 | PASS | Quickstart, release notes, env vars all correct; LICENSE file exists |
| CHANGELOG.md | 100/100 | PASS | Keep-a-Changelog compliant; 6 regression fixes documented |
| AGENTS.md | 92/100 | **FAIL** | 16 tools in table correct; but example section uses removed tools |
| llms.txt | 98/100 | PASS | Quick reference accurate; correct 2.0.2 highlights |
| architecture-and-security.md | 98/100 | PASS | Token field names correct (post-fix); schema accurate |

### Critical Failures

**FAIL #1: AGENTS.md Example Uses Removed Tool "agent_message"**

- **Location:** AGENTS.md, lines 208-213
- **Issue:** JSON-RPC example calls `"method": "agent_message"` which does NOT exist in capabilities.json or shipped 2.0.2
- **Evidence:**
  - capabilities.json lists 16 MCP tools; `agent_message` is absent
  - README.md quickstart (lines 82-89) correctly uses `"method": "task"`
  - Consumer test confirms `task` is the correct tool
- **Impact:** LLM reading AGENTS.md will attempt to use a non-existent tool, breaking playbook integration
- **Fix:** Replace lines 208-213 example with correct `task` method call (template: README.md lines 82-89)

**FAIL #2: AGENTS.md References Renamed Tools in Explanation**

- **Location:** AGENTS.md, line 225
- **Issue:** States "client can later call `task_status(taskId)` or `task_usage(taskId)`" but these tools don't exist; correct names are `result` and `usage_query`
- **Evidence:**
  - AGENTS.md's own tool table (lines 24-41) correctly lists `result` (line 33) and `usage_query` (line 40)
  - Line 225 contradicts the same document's tool inventory
- **Impact:** LLM reading explanation section will use wrong tool names, causing failures
- **Fix:** Replace `task_status(taskId)` → `result(taskId)` and `task_usage(taskId)` → `usage_query({task_id: taskId})`

### Conformance Summary

✓ **Token field naming:** Correct and consistent across README, AGENTS, CHANGELOG, llms.txt, architecture-and-security.md (cacheReadTokens, uncachedInputTokens, cacheCreationTokens, peakContextTokens)  
✓ **Plugin config chain:** Documented correctly (3 paths in order)  
✓ **All 16 tools:** Listed in AGENTS.md table with correct signatures  
✓ **Link integrity:** All links resolve (LICENSE file verified to exist)  
✓ **Architecture schema:** Snake_case DB names correct; peakContextAt is INTEGER  
✗ **Example consistency:** 2 instances of removed/renamed tools in narrative sections

✗ **Lens 2 Result: FAIL** (2 critical inaccuracies prevent PASS)

---

## Lens 3 — Consumer Usability Test

**STATUS: PASS**

### Evidence

File `/docs/marketing/.catalog/consumer.md` exists and shows completion of all canonical tasks.

**Task Results:**
1. **Quick-Start Installation & First Agent:** ✓ PASS
   - Docs sufficient for install, config, agent creation, task execution, result retrieval
   - No source code required; correct tool names and JSON-RPC format documented

2. **Provider Migration (Anthropic → DeepSeek):** ✓ PASS
   - Env vars and token accounting differences clearly explained
   - README, AGENTS.md, CHANGELOG all provide needed information

3. **Debugging Token Usage:** ✓ PASS
   - Token field meanings documented; cumulative vs. peak distinction clear
   - AGENTS.md token accounting section and CHANGELOG break down each field

**Consumer Verdict:** Documentation is sufficient for independent use; no source-code reading required.

✓ **Lens 3 Result: PASS**

---

## Summary by Lens

| Lens | Status | Gate Impact |
|------|--------|-------------|
| **Lens 1: Metrics** | PASS | Improvement verified (23→5 searches, 76→3% undoc) |
| **Lens 2: Conformance** | FAIL | 2 critical tool-name inaccuracies in AGENTS.md |
| **Lens 3: Consumer** | PASS | All 3 canonical tasks pass; docs are self-sufficient |

**Gate Rule:** ALL THREE LENSES must PASS for overall PASS.  
**Result:** 2/3 PASS → **OVERALL FAIL**

---

## Required Fixes (Before Resubmission)

**Fix #1 (CRITICAL):** AGENTS.md lines 208-213 — Remove incorrect tool reference
- Delete the `agent_message` example block (lines 208-213)
- Replace with correct `task` method call using README.md lines 82-89 as template:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "task",
    "params": {
      "agentName": "research-agent",
      "prompt": "Find all TypeScript files in /Users/me/code"
    }
  }
  ```

**Fix #2 (CRITICAL):** AGENTS.md line 225 — Fix tool name references
- Current: `"client can later call task_status(taskId) or task_usage(taskId)"`
- Corrected: `"client can later call result(taskId) to retrieve results, or usage_query(filter, groupBy) to query usage across tasks"`
- Reason: Aligns with correct tool names from the MCP tool table (lines 33, 40)

---

## Resubmission Process

1. **Apply both fixes to AGENTS.md** (2 surgical edits, ~3 minutes)
2. **Re-run cartographer** to verify no new broken links: `npx nx run agent-mcp:cartographer`
3. **Verify consumer test still passes** (it will; consumer uses README examples, not AGENTS.md)
4. **Re-submit for final gate review**

---

**Gate Decision:** FAIL — 2 critical inaccuracies in tool naming blocks publication.  
**Resubmit After:** Fixes applied and cartographer re-run (est. 10 minutes).  
**This is the final gate run.** No further iterations after this.
