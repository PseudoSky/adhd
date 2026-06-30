# Agent-MCP Full Workflow — Research & Audit Log

## Goal

Create a production-grade agentic workflow using agent-mcp's background task DAG:
specialized AI agents autonomously implement packages in the ADHD monorepo,
operating entirely within per-milestone git worktrees, with MCP-only tool access.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  opencode (ADK) — orchestration layer                        │
│  • Creates worktrees, generates security.yaml                │
│  • Opens sessions, dispatches background tasks               │
│  • Polls results via agent-mcp_result                        │
│  • Commits/pushes successful changes                          │
└───────────────────────┬──────────────────────────────────────┘
                        │ agent-mcp_task(background:true, depends_on:[...])
                        ▼
┌──────────────────────────────────────────────────────────────┐
│  agent-mcp server — runtime layer                            │
│  • Orchestrator: LLM tool-use loop (DeepSeek directly)       │
│  • McpClientRegistry: spawns MCP servers per agent            │
│  • PolicyEngine: recursion depth, tool loop, allowedAgents   │
│  • InProcessMcpClient: self-referential delegation            │
└─┬──────────────┬──────────────┬──────────────────────────────┘
  │              │              │
  ▼              ▼              ▼
┌─────────┐ ┌─────────┐ ┌──────────────┐
│filesys. │ │  shell  │ │  agent-mcp   │
│  MCP    │ │  MCP    │ │  (in-proc)   │
│  server │ │  server │ │  delegation  │
└─────────┘ └─────────┘ └──────────────┘
  locked to     locked to      agent-to-agent
  worktree      worktree       (interrupts, review)
```

## Core Architecture: Two Dispatch Paths

### Path 1: opencode-native agents (ADK tools)

```
`task` tool → dispatches agents from ~/.config/opencode/agents/*.md
  → Agent has full ADK tools: read, write, edit, bash, grep, glob
  → Used for: creating design docs, code review, single-file changes
```

### Path 2: agent-mcp agents (MCP tools only)

```
`agent-mcp_task` → dispatches agents from agent-mcp DB
  → Agent has ONLY MCP tools configured in mcpServers
  → Tool names prefixed as <server>__<tool> (e.g., filesystem__read_file)
  → Used for: autonomous implementation, multi-step workflows
```

## Worktree Convention

Per-milestone worktrees at `.claude/worktrees/{milestone-slug}/`.

```
.claude/worktrees/
├── dispatch-client/          # Agent: dispatch-client
├── dispatch-optimizer/       # Agent: dispatch-optimizer
├── dispatch-serializer-json/ # Agent: dispatch-serializer
└── dispatch-plugin-io/       # Agent: dispatch-plugin-io
```

Each worktree is a full `git worktree add` checkout at HEAD. Both filesystem and
shell MCP servers are locked to the worktree path — the agent never accesses
anything outside.

## Agent Lifecycle (Per Milestone)

```
Orchestrator                          Agent-mcp
────────────                          ─────────
1. git worktree add .claude/          (worktree created)
   worktrees/{slug} HEAD
2. Generate security.yaml inside       (config ready)
   worktree
3. agent_agent({name})                → session_id
4. agent-mcp_task({session,            → task_id (background)
   prompt, background:true})
   ─ or for dependent work: ─
   agent-mcp_task({session,            → task_id (depends_on)
   prompt, background:true,
   depends_on:[upstream_task_ids]})
5. LOOP:
   agent-mcp_result(task_id)
   if "awaiting_input": resume
   elif "completed": break
   elif "failed": handle
6. Commit worktree, remove worktree
```

## Reusable System Prompt Template

The same ADHD monorepo context template is used across all agent definitions:

```
You are an ADHD monorepo implementer.

## Available tools
- filesystem__read_file / write_file / edit_file / search_files / list_directory
  — restricted to your worktree
- shell__shell — restricted to your worktree. npx/npm/node/yarn only.
- agent-mcp__task/agent-mcp__result — delegate to other agents

## Monorepo rules (CLAUDE.md)
- platform:shared: NO fs, path, node builtins
- Dependency flow: shared → logic → data → workflows → entrypoints
- Use @adhd/<package> scoped imports between packages
- Zero comments in source files
- Run nx build/test after making changes

## Workflow
1. Read existing code in the worktree for patterns
2. Write implementation files
3. Run `npx nx build <project>` and `npx nx test <project>`
4. Report: files changed, build status, test status
```

## Dependency DAG (Dispatch Production)

```
Batch 1 (parallel):
  dispatch-client ───────────────┬─ depends_on: []
  dispatch-optimizer ────────────┴─ depends_on: []

Batch 2 (depends on Batch 1):
  dispatch-serializer-json ──────── depends_on: [client_task]
  dispatch-plugin-io ────────────── depends_on: [optimizer_task]

Batch 3 (depends on Batch 2):
  dispatch-orchestrator ─────────── depends_on: [serializer_task, plugin_task]

Batch 4 (depends on Batch 3):
  dispatch-tools ────────────────── depends_on: [orchestrator_task]

Batch 5 (depends on Batch 4):
  dispatch-cli ──────────────────── depends_on: [tools_task]
```

## Shell MCP Server

### Current: sonirico/mcp-shell (v0.7.0)

**Binary:** `/Users/nix/dev/go/bin/mcp-shell` (installed via `go install github.com/sonirico/mcp-shell@latest`)
**Config:** `scripts/mcp-shell-security.yaml`

| Feature | Implementation |
|---|---|
| AST parsing (v0.7.0) | `unfurl.go` — shell AST, only literal commands (no pipes/lists/substitution/redirection/globs) |
| Directory restriction | `working_directory` in `security.yaml` |
| Pattern banning | `blocked_patterns` regex against args |
| Executable allowlist | `allowed_executables` |
| Escape hatch blocking | `git -c`, `find -exec`, `tar --checkpoint-action` hard-blocked |
| **Interpreter hard-deny** | `node`, `bash`, `sh`, `python` — hard-denied even if allowlisted |
| Audit logging | `audit_log: true` |
| Resource limits | `max_execution_time: 300s`, `max_output_size: 5MB` |

**Key constraint:** `node` is hard-denied (interpreter). Agents use `npx nx build`
instead. `npx` is not an interpreter — it works in secure mode.

**Tool exposed:** `shell_exec` (prefixed as `shell__shell_exec`) — takes `command` string, optional `base64` bool

**Per-worktree security.yaml generated from template:**
```yaml
security:
  enabled: true
  use_shell_execution: false
  allowed_executables: [npx, npm, yarn, echo, ls, cat, which, head, tail, wc, pwd, true, false]
  blocked_patterns:
    - '(-e|--eval|--print|-p)\s+'
    - 'rm\s+(-rf|-r|-f|-fr)?(\s|$)'
    - 'sudo\s+'
    - 'chmod\s+'
    - 'chown\s+'
    - 'mkfs'
    - 'dd\s+'
    - 'curl\s+'
    - 'wget\s+'
    - 'kill\s+'
    - '>+\s+/'
  max_execution_time: 300s
  max_output_size: 5242880
  working_directory: /repo/.claude/worktrees/{slug}
  audit_log: true
```

### Retired: scripts/mcp-shell-restricted.mjs

Prefix-matching shell (no AST parsing). Replaced by sonirico/mcp-shell.

## Shell MCP Server — Research History

### Requirements
1. **Directory restriction** — commands only within the worktree
2. **AST parsing** — parse command AST to prevent injection
3. **Pattern banning** — regex against dangerous args
4. **Executable allowlist** — only npx/npm/node/yarn
5. **No shell interpreters** — prevent bash/sh/python injection

### Candidates Evaluated

| Candidate | Language | AST Parsing | Dir Restriction | Pattern Banning | Verdict |
|---|---|---|---|---|---|
| **sonirico/mcp-shell** | Go | ✅ `unfurl.go` v0.7.0 | ✅ `working_directory` | ✅ `blocked_patterns` | **Selected** |
| npm `mcp-shell` (matildepark) | Node | ❌ blacklist only | ❌ | ✅ basic | Rejected — no AST |
| Custom `scripts/mcp-shell-restricted.mjs` | Node | ❌ prefix match | ✅ | ✅ basic | Retired — no AST |

### sonirico/mcp-shell — Full Analysis

**Repo:** https://github.com/sonirico/mcp-shell | **Go** | **v0.7.0** | **87 stars** | **License:** GPL-3.0

**Security features:**

| Feature | Implementation |
|---|---|
| **AST parsing** (v0.7.0) | `unfurl.go` parses command into shell AST; only fully-literal simple commands accepted (no pipes, lists, substitution, redirection, globs) |
| **Executable allowlist** | `allowed_executables` in `security.yaml` |
| **Directory restriction** | `working_directory` config option |
| **Pattern banning** | `blocked_patterns` — regex against arguments |
| **Escape hatch blocking** | `git -c`, `find -exec`, `tar --checkpoint-action` hard-blocked |
| **Interpreter hard-deny** | bash/sh/python/node hard-denied even if allowlisted |
| **Audit logging** | `audit_log: true` records every execution |
| **Resource limits** | `max_execution_time`, `max_output_size` |

**Modes:**
- **Secure** (`use_shell_execution: false`, default): AST-parsed, no shell exec, allowlist only
- **Legacy** (`use_shell_execution: true`): shell-level allowlist/blocklist (more vulnerable)
- **Unsafe** (`MCP_SHELL_ALLOW_UNSAFE=true`): unrestricted — do not use in production

**Security trade-off:** We need `npx` for `nx build`/`nx test`. `npx` is NOT an interpreter
(not hard-denied). `node` IS hard-denied. Agents use `npx nx build <project>` instead of
`node ./node_modules/.bin/nx ...`. AST parsing ensures commands are single literal calls
— no pipes, redirects, substitution. Blocked patterns prevent `-e`/`--eval`. Acceptable
for build/test.

**Deployment options:**
- `go install github.com/sonirico/mcp-shell@latest` — binary at `~/go/bin` (selected)
- Docker: `docker run sonirico/mcp-shell:latest` (Docker daemon not running on host)
- From source: `git clone && make install`

### npm `mcp-shell` (matildepark-hdr) — Rejected

**npm:** `mcp-shell@0.1.3`  
**Security:** Blacklist-based pattern matching, no AST parsing  
**Verdict:** String matching is trivially bypassable. No directory restriction. Rejected.

## HITL & Structured Inter-Agent Messaging

### Current State (agent-mcp 1.0.0)
- `builtin__request_human_input` tool, hardcoded human target, free-text response
- Session-based only, `task_resume` with resumeToken
- Status `awaiting_input`, in-memory resolver map

### Proposed: Structured Inter-Agent Messaging
See `docs/ideas/agent-interrupts.md` for full proposal.

```
send_message({target, kind, options, prompt, default, timeout, context})
  → suspends task until response
poll_messages({from, status})
  → check pending messages from child agents
respond_to_message({message_id, option_id, text})
  → answer, triggering resume
```

Targets: `human`, `parent` (calling agent), `orchestrator` (cycle loop), `peer`
Kinds: `question`, `clarification`, `approval`, `error`, `status`, `decision`

### HITL Integration in Orchestrator
- `OrchestratorDeps` gains `messaging?: { request, respond }`
- Cycle loop checks for `orchestrator`-targeted messages
- Auto-resolve known patterns (guard failures, low-effort clarifications)
- Human questions escalate to `hitl.request()` → suspend

### HITL Integration in Dispatch Tools
- Destructive tools (`operation_delete`, `milestone_delete`) require `confirm: true`
- Tool descriptions tell agents: "Use send_message(target:human, kind:approval) first"

## Tool Plugins

### Current State (agent-mcp 1.1.x)
- Plugin system supports lifecycle hooks only (11 hooks)
- Custom MCP tools require external MCP server processes
- No mechanism for in-process tool registration

### Proposed: ToolPlugin Interface
See `docs/ideas/tool-plugins.md` for full proposal.

```typescript
interface ToolPlugin {
  name: string;
  version: string;
  registerTools(ctx: ToolPluginContext): ToolDefinition[];
}
```

### Use Cases
| Plugin | What it provides | Instead of |
|---|---|---|
| `@adhd/tool-plugin-filesystem` | File read/write/edit/search tools | External filesystem MCP server |
| `@adhd/tool-plugin-shell` | Restricted shell execution | External shell MCP server |
| `@adhd/tool-plugin-dispatch` | DAG mutation tools via IDagClient | dispatch-tools MCP server |
| `@adhd/tool-plugin-registry` | Agent registry queries | External registry calls |

## Monitoring & Safety

### Built-in safeguards

| Guard | Default | Config |
|---|---|---|
| `MAX_TOOL_LOOPS` | 50 | `ADHD_AGENT_MAX_TOOL_LOOPS` — hard ceiling |
| `MAX_DEPTH` | 5 | `ADHD_AGENT_MAX_DEPTH` — recursion hard ceiling |
| Per-agent `maxToolLoops` | — | Set in agent definition (can't exceed ceiling) |
| sonirico/mcp-shell `max_execution_time` | 30s | Per-worktree security.yaml |
| sonirico/mcp-shell `max_output_size` | 1MB | Per-worktree security.yaml |

### Post-task checklist
- [ ] `usage.toolCallCount` — reasonable? (< 20 for most tasks)
- [ ] `status` — `"completed"` or `"failed"`? If failed, why?
- [ ] FATAL_CODES: `MAX_TOOL_LOOPS_EXCEEDED`, `MAX_DEPTH_EXCEEDED`, `DELEGATION_NOT_ALLOWED`
- [ ] agent-mcp logs (`stderr`) — any warnings or errors?
- [ ] Worktree state — no unexpected files, no runaway processes

### Log access
agent-mcp uses pino logger writing to stderr. Enable debug via:
```json
"env": { "ADHD_AGENT_LOG_LEVEL": "debug" }
```

## Failure Modes

| Mode | Handling |
|---|---|
| **Partial failure** | Agent writes 3 files then fails. Leave worktree for inspection, log which ops completed. |
| **Merge conflicts** | Two worktrees touch adjacent files. Resolve manually, prompt via HITL. |
| **Retry strategy** | Failed task → retry same agent with same prompt | escalate to human. |
| **Context overflow** | Large milestones exceed context window. Chunk via sentinel prewarm/payload. |

## Operational Concerns

| Concern | Approach |
|---|---|
| **Session accumulation** | `session_clear` between dispatches to avoid context bloat |
| **Orchestrator reconnection** | Poll `agent-mcp_task_list` for running tasks after disconnect |
| **Cost tracking** | `usage_query` after each milestone |
| **Concurrency** | `ADHD_AGENT_QUEUE_CONCURRENCY` defaults to 5 |

## Git Hygiene

- **Commit messages**: Conventional Commits (`feat(scope):`) enforced on worktree commits
- **Branch strategy**: Named branches per milestone or all on HEAD? TBD.

## Key Links

| Resource | Path |
|---|---|
| agent-mcp server | `packages/ai/agent-mcp/` |
| agent-mcp ROADMAP | `packages/ai/agent-mcp/ROADMAP.md` |
| dispatch-spec types | `packages/shared/dispatch-spec/src/lib/types.ts` |
| plan dag.json | `docs/plan/dispatch-production/dag.json` |
| handoff doc | `.opencode/artifacts/HANDOFF.md` |
| opencode.json | `.opencode/opencode.json` |
| filesystem MCP | `node_modules/@modelcontextprotocol/server-filesystem/` |
| shell MCP | `/Users/nix/dev/go/bin/mcp-shell` + `scripts/mcp-shell-security.yaml` |
| shell MCP (legacy) | `scripts/mcp-shell-restricted.mjs` (retired) |
| sonirico/mcp-shell | https://github.com/sonirico/mcp-shell |
| agent interrupt proposal | `docs/ideas/agent-interrupts.md` |
| tool plugin proposal | `docs/ideas/tool-plugins.md` |

---

# Audit Log

## Agent Registry

| Agent | Version | Created | MCP Servers | Permissions | Worktree |
|---|---|---|---|---|---|
| dispatch-client | v11 | 2026-06-30 | filesystem+sonirico-mcp-shell+agent-mcp | →reviewer | — |
| dispatch-optimizer | v10 | 2026-06-30 | filesystem+sonirico-mcp-shell+agent-mcp | →client,reviewer | — |
| dispatch-reviewer | v10 | 2026-06-30 | filesystem+sonirico-mcp-shell | none | — |
| sessions & tasks | — | — | — | — | See Sessions & Tasks table below |

## Tool Installations

| Date | Tool | Version | Source | Purpose |
|---|---|---|---|---|
| 2026-06-30 | @modelcontextprotocol/server-filesystem | 2026.1.14 | npm | Filesystem MCP for agents |
| 2026-06-30 | scripts/mcp-shell-restricted.mjs | — | custom (temp) | Restricted shell (replace with sonirico/mcp-shell) |
| 2026-06-30 | sonirico/mcp-shell | v0.7.0 | go install | AST-secure shell MCP — replaces custom script |
| 2026-06-30 | scripts/mcp-shell-security.yaml | — | custom | Security config for sonirico/mcp-shell |
| 2026-06-30 | Agent updates | v7→v11 | agent-mcp_agent_update | Switched shell to sonirico/mcp-shell, corrected tool names |
| 2026-06-30 | Memory write (tool-result-proxy) | — | memory-server | Idea: auto-proxy large tool responses to storage, return stubs |
| 2026-06-30 | Memory write (git-plugin) | — | memory-server | Idea: agent-mcp plugin for auto git workflow scaffolding |
| 2026-06-30 | Memory write (virtual-pr) | — | memory-server | Idea: virtual PR process for dispatch DAG handoffs |
| 2026-06-30 | agent-mcp-tail | packages/ai/agent-mcp/src/scripts/agent-mcp-tail.ts | primary | Live DB tailer — token ctx size, agent filter, include-history, limit |
| 2026-06-30 | sonirico/mcp-shell security.yaml | scripts/mcp-shell-security.yaml | primary | Per-worktree shell config, AST-secure |
| 2026-06-30 | agent-mcp providers | dispatch-* agents | agent-mcp_agent_update | Switched all agents to openai+LM Studio (ADHD_AGENT_OPENAI_*) |
| 2026-06-30 | BACKLOG.md | FEAT-ENV-001 | primary | Added @adhd/environment feature request |

## Worktrees

| Date | Path | Branch | Created By | Removed | Commits |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## Sessions & Tasks

| Date | Agent | Session | Task | Status | Duration | Tokens | Notes |
|---|---|---|---|---|---|---|---|
| 2026-06-30 | dispatch-reviewer | ephemeral | filesystem read test | completed | 4s | 2.4K | Read serializer.ts via filesystem MCP |
| 2026-06-30 | dispatch-client | ephemeral | tool connectivity test | completed | 8s | 16.8K | Used filesystem__read_file + shell__shell |
| 2026-06-30 | adhd-implementer-flash | ADK task | Write agent-interrupts.md | completed | — | — | 155 lines, linked to ROADMAP.md feature #20 |
| 2026-06-30 | adhd-implementer-flash | ADK task | Write tool-plugins.md | completed | — | — | 285 lines, linked to ROADMAP.md plugin section |

## Documents Created

| Date | Path | Size | Agent | Description |
|---|---|---|---|---|
| 2026-06-30 | docs/ideas/agent-interrupts.md | 155 lines | adhd-implementer-flash | Structured inter-agent messaging proposal |
| 2026-06-30 | docs/ideas/tool-plugins.md | 285 lines | adhd-implementer-flash | Tool injection plugin system proposal |
| 2026-06-30 | docs/plan/agents-full-workflow/RESEARCH.md | — | primary | This document — research log |

## Merges

| Date | Branch | From Worktree | Commits | PR |
|---|---|---|---|---|
| — | — | — | — | — |

## Debug Incidents

| Date | Issue | Symptoms | Resolution |
|---|---|---|---|
| 2026-06-30 | MCP timeout | npx nx build timed out (120s default) | Need per-agent timeout + sonirico/mcp-shell max_execution_time |
| 2026-06-30 | Permission denied | agent tried to delegate to "developer" | Removed agent-mcp MCP server from leaf agents, use allowedAgents |
| 2026-06-30 | Not connected | agent-mcp connection lost after timeout | Connection restored, agent definitions updated with absolute paths |
