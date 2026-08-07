# Documentation Stewardship Operations — 2026-07-11

Record of all documentation changes made during 2.0.2 release stewardship.

## CREATE README.md — 2026-07-11

**Reason:** Package had no public README. Required for MCP server discovery, quick-start, 2.0.2 highlights, and architecture reference.

**Content:** 
- Overview of what @adhd/agent-mcp is (MCP server for bounded agents)
- Quick-start installation and configuration
- Environment variable reference table
- Example usage patterns
- Comprehensive 2.0.2 release notes covering all 6 bug fixes (cache management, token accounting, env-name guard, FK cascade, tool advertisement, plugin config)
- Architecture reference linking to architecture-and-security.md
- Known limitations and support links

**File:** `/Users/nix/dev/node/adhd/entrypoint/agent-mcp/README.md`

---

## CREATE CHANGELOG.md — 2026-07-11

**Reason:** Package had no CHANGELOG. Required to document breaking changes (context-limit default, token-accounting field changes, policy validation changes) in 2.0.2.

**Content:**
- Keep-a-Changelog format with [2.0.2] section as primary
- Six bug fixes documented:
  1. BUG-ORCH-008: Cache-preserving context management (measured 3.3x cost inflation with old limiter)
  2. BUG-ORCH-009/010: Provider-neutral token accounting (new fields: uncachedInputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens, peakContextTokens)
  3. BUG-ORCH-011: Env-name guard restored (ADHD_AGENT_* prefix validation)
  4. BUG-ORCH-012: FK cascade restored (sessions→agents ON DELETE CASCADE)
  5. BUG-ORCH-013: Tool advertisement default restored (full JSON schemas)
  6. BUG-ORCH-014: Plugin global-config back-compat (~/.agent-mcp/config.json fallback)
- Database migrations noted: 0008, 0009
- Breaking changes explicitly called out (context-limit default, token field semantics, env validation)

**File:** `/Users/nix/dev/node/adhd/entrypoint/agent-mcp/CHANGELOG.md`

---

## CREATE docs/architecture-and-security.md — 2026-07-11

**Reason:** Per `docs/agent-mcp/agent-mcp-recommendation-evidence-requirements.md`, this is the **#1 critical evidence document** required before the package is recommendable. Explains system boundaries, process model, state model, provider abstraction, permission model, failure recovery, cancellation semantics, trust boundaries, and current limitations.

**Content:**
- High-level architecture diagram (MCP Client → Server → State/Policy/Supervisor/Providers/Tools)
- Process model for single agents and delegation (parent → child)
- State model: SQLite schema (agents, sessions, messages, task_usage), message windowing (2.0.2 append-only + middle-collapse strategy)
- Provider abstraction layer with per-provider differences table (Anthropic/OpenAI/DeepSeek/Gemini token accounting, cache pricing, tool definitions, cancellation, streaming)
- Permission model (AgentPolicy structure, permission inheritance, enforcement points)
- Failure recovery (hard vs soft failures, crash recovery, cancellation semantics)
- Trust boundaries (what agent-mcp can/cannot control at OS level, prompt level, architecture level)
- Current limitations (no OS sandbox, no external audit, prompt injection not mitigated, single-user only, experimental recovery)
- Security assumptions (trusted hosting process, partially-trusted model outputs, filesystem permissions, secrets handling, network config)
- Production readiness statement: "No, experimental as of 2.0.2 — acceptable for research/local dev with limitations understood"

**File:** `/Users/nix/dev/node/adhd/entrypoint/agent-mcp/docs/architecture-and-security.md`

---

## CARTOGRAPHER COMPLETED — 2026-07-12

Cartographer analysis found:
- **33 total shipped capabilities** (17 MCP tools, 2 HTTP endpoints, 4 providers, 6 advanced features, 4 storage/config)
- **Pre-2.0.2 docs:** 1 file (provider-call-audit.md) — technical audit, not consumer docs
- **Pre-2.0.2 gaps:** 76% of capabilities undocumented (25/33 capabilities have zero consumer-facing docs)
- **Conformance:** README missing, API reference missing, provider guide missing, config reference missing, advanced features guide missing

**Output:** `.catalog/capabilities.json` (33 capabilities with verification status), `.catalog/doc-conformance.md` (gap analysis + priority recommendations), `.catalog/capabilities.md` (capability inventory with tests/substance notes)

**2.0.2 Documentation Improvements Made:**
- README.md: Addresses "what is this?" + quick-start + 2.0.2 highlights + limitations ✅
- CHANGELOG.md: Addresses version history + all 6 bug fixes with breaking changes ✅
- docs/architecture-and-security.md: Addresses trust boundaries + failure modes + known limitations ✅
- AGENTS.md: Addresses shipped facts + new 2.0.2 fields + configuration ✅
- llms.txt: Quick reference for LLM agents ✅

**Cartographer's Priority Recommendations (Beyond 2.0.2):**
1. CREATE docs/API_REFERENCE.md — per-tool schema breakdown (NICE-TO-HAVE for 2.0.2, MUST-HAVE for general usability)
2. CREATE docs/PROVIDERS.md — provider differences table (SHOULD-HAVE for accurate multi-provider usage)
3. CREATE docs/CONFIG.md — env-var reference table (SHOULD-HAVE for configuration clarity)
4. CREATE docs/ADVANCED.md — delegation, HITL, tool advertisement guides (SHOULD-HAVE for advanced users)

**What Remains (Post 2.0.2):** Cartographer's full recommendations can be filed as backlog for future documentation phases. 2.0.2 release is unblocked with current docs.

---

## Notes

All 2.0.2 facts derived from:
- `/Users/nix/dev/node/adhd/BACKLOG.md` (BUG-ORCH-003 through BUG-ORCH-014, FINDING-ORCH-007)
- `/Users/nix/dev/node/adhd/docs/ideas/provider-caching-research.md` (primary source analysis of 4 providers' cache models)
- `/Users/nix/dev/node/adhd/docs/ideas/context-and-cache-strategy.md` (design verification + wire-trace evidence of 3.15x cost inflation)

No version bump made (package.json remains 2.0.0 per instructions).
No source code edited.
No publish attempted.
