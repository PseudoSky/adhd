# `run-registry-agent` — registry-driven workflow over agent-mcp

**Epic:** `4bbe63ed` — *Registry-driven .claude/workflow over agent-mcp (bridge epic)*.
**This file + `run-registry-agent.js` are the FIRST IMPLEMENTABLE SLICE (AC1 + AC5).**
AC2–AC4 and AC6 remain open (see *Status* below).

## What it does

Drives an agent **defined in the `@adhd/agent-*` registry** to completion through
agent-mcp's MCP tools, returning the task result **and** the `usage_query` row for
the run. The script is a thin orchestrator: the agent definition is resolved from
the registry (`agent_read`), never inlined. If the slug does not resolve, the
workflow **aborts loudly** rather than creating an inline agent — that shortcut is
explicitly rejected (it silently bypasses the registry, which is the point).

## Invocation

```
/run-registry-agent <agentSlug> <taskPayload>
```

Underlying args object (a JSON string is also accepted):

| arg | type | required | meaning |
|-----|------|----------|---------|
| `agentSlug` | string | yes | registry agent slug/name to run |
| `taskPayload` | string | yes | the prompt/task sent to the agent |
| `maxPolls` | number | no (default 200) | bounded poll budget for the terminal-state loop |

Example:

```json
{ "agentSlug": "code-reviewer", "taskPayload": "Review entrypoint/agent-mcp/src/streaming/follow-renderer.ts for correctness." }
```

## Phases

1. **Resolve** (`agent_read`) — registry provenance preflight. Aborts if the slug
   is not a registry definition, or if `mcp__agent-mcp__*` is absent.
2. **Run** (`agent` → `task` → poll `result`) — handles **both** lifecycle shapes:
   the synchronous-until-completion shape (terminal status in the `task` response)
   and the `{status:"running"}` + `result`-poll shape. Polling is keyed **only** on
   the returned `status` field, never on elapsed time, never a sleep.
3. **Usage** (`usage_query`) — asserts the run is recorded with real token/status data.
4. **Verdict** (pure JS) — `{ registryGrounded, completed, terminal, usageRecorded,
   credentialRisk }`.

## Return

```jsonc
{
  "agentSlug": "…",
  "registry": { "registryResolved": true, "providerType": "claudecli", … },
  "run":      { "sessionId": "…", "taskId": "…", "status": "completed", "result": "…" },
  "usage":    { "rowCount": 1, "totalInputTokens": 1234, "totalOutputTokens": 567 },
  "verdict":  { "registryGrounded": true, "completed": true, "usageRecorded": true, "credentialRisk": false }
}
```

An abort returns `{ aborted: true, reason, registry, run: null, usage: null, verdict }`
with `reason ∈ { no-agent-mcp-access, not-registry-grounded }`.

## Prerequisites (epic architect-decision conditions)

1. **Registry resolution must be verified** — that a slug resolves/compiles through
   the exposed MCP `agent_read` surface. If it does not, file a package-scope gap;
   this workflow treats non-resolution as a hard abort, not a fallback.
2. **MCP route is designed-in** via `.mcp.json` (default-on, never a toggle).
3. **Prefer `claudecli`-type agents** over `anthropic`/`openai` — the latter hit
   `DEBT-MCP-CREDENTIALS-001` (credential fallback fails silently on fresh hosts).
   The verdict surfaces this as `credentialRisk`.

## Limits

- Workflow-runtime limits: **16 concurrent / 1000 total agents**, and same-session
  resume is supported.
- Bounded to at most one resolve + one run + one usage subagent per invocation
  (sequential; no fan-out).

## Pinned Claude Code version + re-verify note

The Workflow runtime is a **research-preview surface** (v2.1.154+ at authoring).
The script uses only the stable bits of that surface (`meta`, `args`, `agent`,
`log`, top-level `return`, `agent({schema, phase, label, agentType, effort, model})`).
If a syntax error is reported on load, **re-verify against the then-current
`code.claude.com/docs/en/workflows` and `.claude/workflows/backlog-grooming.js`**
before changing anything here.

## Status (epic)

| AC | description | state |
|----|-------------|-------|
| AC1 | workflow script + `.md` taking `{agentSlug, taskPayload}`, runs to completion via `mcp__agent-mcp__*`, structured result | **delivered (this slice)** |
| AC2 | executed agent's compiled definition demonstrably from the registry (components/prompts), evidenced in a run report | open — the script captures `registryResolved` + provider type, but a *compiled-components* evidence capture is not yet written |
| AC3 | `usage_query`/`task`/`result` shows the run recorded with real token/status data | open — the script asserts `usageRecorded`, but no committed run artifact exists yet |
| AC4 | default-running verification harness drives the REAL workflow vs the REAL agent-mcp (built artifact, `.mcp.json`) | open — needs the harness (bounded, deterministic, exit-code-trusting) |
| AC5 | run documented (invocation, args, limits, pinned version, re-verify note) | **delivered (this `.md`)** |
| AC6 | `learnings.md` section at epic close | open — epic close |

**Blocking epic rule:** no feature ticket under this epic lands DONE without a
verification run reference (test/review, pass/fail + evidence); the epic closes
only with `learnings.md`.

## Why this shape (constraints, validated 2026-08-20)

The Workflow runtime **sandboxes the script**: no `import()`/`require`, no `fs`,
no shell, no `Date.now`, no documented network. `@adhd` packages can never be
imported into the script. The only supported path is the workflow's **subagents**
calling the agent-mcp MCP tools — identical to how `backlog-grooming.js` reaches
`mcp__backlog__*`. This is the `APPROVED_WITH_CONDITIONS` architect-decision shape.

## Roadmap tension (named)

The dispatcher-platform north star eventually replaces the Claude CLI entirely, so
this is a **tactical bridge** — it validates agent-mcp's tool surface through a
second real host and transfers lessons to the dispatcher, not the destination.
Deferred to `FEAT-DISPATCH-WORKFLOW-PARITY`: registry-ifying the two existing
workflows, skills-in-registry, personas-in-registry.

## Citations

Research: `docs/product/feature-research/claude-workflow-on-agent-packages.md`.
Sources: `code.claude.com/docs/en/workflows`; `github.com/anthropics/claude-code`
CHANGELOG; `code.claude.com/docs/en/agent-sdk/typescript.md`;
`.claude/workflows/code-quality-sweep.mjs:455-456,586`;
`.claude/workflows/backlog-grooming.js:62,182-198`; `.mcp.json`;
`packages/agent/agent-generator-plugin/REGISTRY-PACKAGE-RULES.md`;
`docs/product/dispatcher-platform/ROADMAP.md:11-33`;
`docs/product/dispatcher-platform/GAP-MATRIX.md:190-216`.

*Refs: `4bbe63ed`. Pairs with `entrypoint/agent-mcp/src/*` (the MCP tool surface)
and `entrypoint/agent-mcp/src/index.ts` (registry `buildPromptResolver`).*
