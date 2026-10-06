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

---

# Documentation Stewardship Operations — 2026-10-05 (dispatch-2026-10-04-9c4e, NAT-TOOL-10)

Documentation/ADR reconciliation for the merged native-tooling feature (ADR-0008 /
NAT-TOOL-1…8). No prose removed without preservation; no source code edited. Base `27c194cd`.

## REVISE entrypoint/agent-mcp/README.md — 2026-10-05T22:39:49-04:00

**Reason:** NAT-TOOL-10 AC2 (worked `{fs:true, shell:{permissions}}` example), the env-var table for
the typed native-tooling surface, and the NAT-TOOL-6 gate-enforcement / one-producer facts were
absent from the consumer README.

**Added:** resolved-default table (fs/shell/dispatch/hitl); `srt` + `ADHD_AGENT_SRT_SETTINGS` note;
ONE-producer statement; "permission / HITL gate is enforced" paragraph (fixed chain, last-match-wins,
terminal `deny`); a worked `{ fs: true, shell: { permissions: { "shell.shell_execute": "ask" } }, dispatch: true, hitl: true }` JSONC example; the `ADHD_AGENT_NATIVE_TOOLING_*` env-var table (11 rows); a link to `../../docs/decisions/0008-agent-mcp-native-tooling.md` (link resolved, EXISTS).

**removed (verbatim):**

```
- `fs` → `srt npx -y @modelcontextprotocol/server-filesystem <cwd>`
- `shell` → `srt uvx mcp-shell-server` (allowlisted argv — never a shell string)
- `dispatch` → the REAL agent-mcp server, so the agent can dispatch sub-agents

The `fs`/`shell` builtins are wrapped by `@anthropic-ai/sandbox-runtime` (`srt`),
and the host provisions the matching policy automatically. Merge precedence is
explicit `mcpServers` > `nativeTooling` > the `dispatch` self floor, and
`allowedTools`/`disallowedTools` remain enforced on every call. See `AGENTS.md`
§“Native tooling for dispatched agents”.
```

## REVISE entrypoint/agent-mcp/AGENTS.md — 2026-10-05T22:39:49-04:00

**Reason:** (a) `AgentMcpConfig` now declares `nativeTooling` (src/config.ts) — the old field list
contradicted the merged code; (b) added the native-tooling env-var table; (c) added the
NAT-TOOL-6 gate-enforcement and NAT-TOOL-4 single-producer facts to the native section.

**removed (verbatim):**

```
`AgentMcpConfig` (`src/config.ts`) declares only `db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins` as cascade-managed fields — no `providers`/secret field exists.
```

```
| member | resolved server (adopted) |
|---|---|
| `fs` | `srt npx -y @modelcontextprotocol/server-filesystem <cwd>` |
```

## REVISE docs/decisions/0008-agent-mcp-native-tooling.md — 2026-10-05T22:39:49-04:00

**Reason:** Reconcile stale text against the merged code (NAT-TOOL-1…8): the third-party adoption is
APPROVED/implemented (not pending); `ADHD_AGENT_SHELL_MCP_PATH` is removed (not "migrates");
`withDefaultMcpServers` now merges (not "no-ops"); NAT-TOOL-6 AC4 is aligned; add the single-producer
fact and the gate-enforcement wiring; add the NAT-TOOL-1 askPolicy retirement delta to Backlog
reconciliation. Status was already `ACCEPTED` (a6db9730) — unchanged.

**removed (verbatim, each replaced sentence):**

```
the spec records that `withDefaultMcpServers` currently **no-ops** where it should merge (NAT-TOOL-4).
```
```
`withDefaultMcpServers` MUST **merge** (currently it no-ops — `entrypoint/agent-mcp/src/defaults.ts`); the fix is at that source (`adhd ADR-0002`), never a per-caller workaround.
```
```
- `resolveNativeTooling(cfg, { cwd, env, dispatchSelf }) -> McpServerConfig[]`
- `matchPermission(ruleMap, toolName) -> PermissionAction` — matches the **tool name**, last-match-wins with `deny` terminal (D5). It **never** parses, matches, or segments command text.
- the **server catalog** (the fs/shell/dispatch server specs; the `dispatch` spec resolves to the real agent-mcp server, D1)
```
```
(a) The concrete third-party server adoption in D7 is **not yet executed** — NAT-TOOL-8 is explicitly a human-gated decision item, its **named human owner is supplied by the owner** (left blank here), and no dependency is added by this record alone.
```
```
**This is a HUMAN-GATED decision (NAT-TOOL-8).** No dependency may be added and `tools/mcp-shell/server.mjs` may not be removed until the human approval is recorded with a **named owner in all three of `README.md`, `AGENTS.md`, and the gated test header** (per the repo's live-testing/gating rule), and license + maintenance status is written to memory. **The named human-approval owner is intentionally left blank in this record for the owner to supply.** The authored shell server is retired — **removed, not grown** (Consequences). No bash-string ever reaches a shell: shell execution is allowlisted command **names as argv arrays**.
```
```
The legacy `ADHD_AGENT_SHELL_MCP_PATH` migrates onto the typed surface (it is a path *value*, legitimate environment configuration, not a feature switch).
```
```
The upstream-server adoption in D7 additionally waits on the **separate** human-gated approval NAT-TOOL-8 requires, documented in all three required places with a named owner.
```
```
Its removal is gated by NAT-TOOL-8's human approval (D7).
```
```
`ADHD_AGENT_SHELL_MCP_PATH` migrates to the typed surface.
```
```
Shell overrides carry the adopted server's **argv allowlist** (`allowCommands`) plus tool-NAME rules; `rm *` is expressed server-side, not as a harness permission.
```
```
2. **NAT-TOOL-8 named human-approval owner — RESOLVED as left blank by design.** The name is supplied by the owner at the NAT-TOOL-8 adoption gate and is required in `README.md` + `AGENTS.md` + the gated test header; it is intentionally not invented here.
```
```
NAT-TOOL-6 AC4 (most-restrictive-wins) is **superseded** and must be aligned (Backlog reconciliation).
```
```
NAT-TOOL-2 AC3 stands; NAT-TOOL-6 AC4 (most-restrictive-wins) is superseded and must be aligned.
```
```
the earlier NAT-TOOL-2 / NAT-TOOL-6 conflict is resolved and NAT-TOOL-6 AC4 must be aligned.
```

## REVISE entrypoint/agent-mcp/CHANGELOG.md — 2026-10-05T22:39:49-04:00

**Reason:** Record the shipped native-tooling surface, the removal of the authored shell server + its
`ADHD_AGENT_SHELL_MCP_PATH` override (NAT-TOOL-4), and the enforced permission/HITL gate (NAT-TOOL-6)
under `## Unreleased`. No prior text removed.

**Outstanding (not a docs edit — left to the backlog operator):** debt `675a6ba6` — the LIVE
NAT-TOOL-1 and NAT-TOOL-7 ticket bodies still name the retired `askPolicy`; ticket bodies are edited
via `adhd-backlog`, never by hand. The ADR's Backlog-reconciliation NAT-TOOL-1 bullet now records the
askPolicy retirement.
