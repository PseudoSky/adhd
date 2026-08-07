# Agent Registry — Usage

> **Design-pass notice.** The interactions below represent the intended end state. CLI commands,
> API shapes, flag names, and package names are illustrative — they should be redesigned as part
> of the implementation architecture phase. The goal is to show how the system behaves from a
> user's perspective, not to spec the CLI surface.

This document describes the system from the perspective of someone who has no prior exposure to
the claude-agents repository or the agent-mcp runtime. They install the toolchain, compose
agents from the shared component library, apply policies, compile to their target platform, and
use the agents — without authoring a single markdown file.

---

## Installation

```bash
npm install -g @adhd/agent-registry @adhd/tool-registry @adhd/agent-policy @adhd/agent-compiler
```

On first run, the CLI initializes a local SQLite registry database and seeds it with the
standard component library, tool catalog, platform bindings, and core policy templates.

```bash
agent-registry init
# Initialized registry at ~/.agent-registry/registry.db
# Seeded: 18 prompt types, 80+ shared components, 3 policy templates
# Seeded: 42 canonical tools, 4 platforms, 12 model bindings
```

No configuration files required. The seed data ships with the package.

---

## Browsing the Component Library

Before creating anything, a user browses what already exists.

```bash
agent-registry components list --type role
# researcher        "You are a research specialist..."         v3  shared
# reviewer          "You are a senior code reviewer..."        v7  shared
# backend-dev       "You are a senior backend developer..."    v2  shared
# security-auditor  "You are a security specialist..."         v4  shared

agent-registry components list --type rule
# default-skeptic   "Default verdict is NEEDS-WORK..."         v2  shared
# no-credentials    "Never write API keys or secrets..."       v1  shared
# sox-handoff       "Structure handoffs with five sections..."  v4  shared
# bounded-retry     "Max rework attempts before escalate..."   v1  shared

agent-registry components show default-skeptic
# slug:     default-skeptic
# type:     rule
# version:  2
# shared:   yes
# content:
#   Default verdict is NEEDS-WORK. Before issuing an APPROVED verdict, explicitly
#   enumerate each success criterion and confirm it is met. If any criterion is
#   unverifiable from the provided evidence, the verdict is NEEDS-WORK.
# used by:  code-reviewer, security-auditor, qa-expert, architect-reviewer (+4 more)
# use cases: code-review, security-audit, refactor-review, design-review
```

---

## Creating an Agent From Shared Components

A developer on an API team wants a dedicated API design reviewer. They compose it from existing
components and one new component specific to their needs.

```bash
# Create the agent record
agent-registry agents create \
  --slug api-design-reviewer \
  --display-name "API Design Reviewer" \
  --description "Reviews REST and GraphQL API designs for correctness, security, and usability" \
  --category api-specialists

# Attach components in order
agent-registry agents add-component api-design-reviewer \
  --component reviewer --position 1

agent-registry agents add-component api-design-reviewer \
  --component api-expertise --position 2

agent-registry agents add-component api-design-reviewer \
  --component default-skeptic --position 3

# Author one new component specific to this agent
agent-registry components create \
  --slug api-review-criteria \
  --type success_criteria \
  --content "All endpoints follow REST constraints. Auth on every non-public route.
No PII in query params. Pagination on all collection endpoints. Error schema consistent."

agent-registry agents add-component api-design-reviewer \
  --component api-review-criteria --position 4

# Assign tools
agent-registry agents add-tool api-design-reviewer --tool file_read --permission read_only
agent-registry agents add-tool api-design-reviewer --tool web_fetch --permission full
agent-registry agents add-tool api-design-reviewer --tool search_grep --permission read_only

# Preview the composed prompt before compiling
agent-registry agents compose api-design-reviewer --platform claude_code
# [outputs full header + body to stdout]
```

---

## Compiling to Markdown (Claude Code)

The registry emits raw markdown text that Claude Code's agent resolver understands. This is the
primary interop surface — the compiler is a code-generation step, not a runtime dependency.

```bash
# Compile to stdout and inspect
agent-registry compile api-design-reviewer --platform claude_code

# Pipe to a file for immediate use in Claude Code
agent-registry compile api-design-reviewer --platform claude_code \
  > ~/.claude/agents/api-design-reviewer.md

# Compile all agents in a category
agent-registry compile --all --category api-specialists \
  --platform claude_code --out-dir ~/.claude/agents/

# Compile for Claude API (JSON with systemPrompt + tools array)
agent-registry compile api-design-reviewer --platform claude_api --format json
```

After the last command, `~/.claude/agents/api-design-reviewer.md` exists and the agent is
immediately available in Claude Code as `/api-design-reviewer`. No files were authored by hand.

---

## Context-Conditional Composition

The same agent should apply different success criteria depending on what kind of review is
requested. The user adds two success criteria components and conditions them.

```bash
# Already have api-review-criteria for general API reviews
# Add a stricter set for security-focused reviews
agent-registry components create \
  --slug api-security-criteria \
  --type success_criteria \
  --content "Zero authentication bypasses. All inputs validated at boundary.
No SSRF vectors. Rate limiting present. CORS policy explicit. No sensitive data in logs."

# Attach both; context_condition selects at compose time
agent-registry agents add-component api-design-reviewer \
  --component api-review-criteria \
  --position 4 \
  --context '{"ticket_type": "review"}'

agent-registry agents add-component api-design-reviewer \
  --component api-security-criteria \
  --position 4 \
  --context '{"ticket_type": "security"}'

# Compile with context — only the matching criteria component is included
agent-registry compile api-design-reviewer \
  --platform claude_code \
  --context '{"ticket_type": "security"}' \
  > ~/.claude/agents/api-design-reviewer.md
```

---

## Applying Policies

The team wants to ensure all agents in the `api-specialists` category never output credentials
and always follow the SOX audit trail requirement.

```bash
# Browse available policies
agent-policy list
# no-credentials     safety      convention  "Never write API keys or tokens to files"
# sox-audit-trail    audit       hook        "All file writes emit a task_event"
# reviewer-posture   safety      agent       "Default verdict NEEDS-WORK"
# max-rework-3       rate        runtime     "Escalate after 3 rework cycles"

# Attach to category — all current and future agents in the category inherit these
agent-policy attach-to-category \
  --category api-specialists \
  --policy no-credentials \
  --mandatory

agent-policy attach-to-category \
  --category api-specialists \
  --policy sox-audit-trail \
  --mandatory

# Verify inheritance on the agent
agent-policy list --agent api-design-reviewer
# no-credentials     [inherited: api-specialists]   mandatory   convention
# sox-audit-trail    [inherited: api-specialists]   mandatory   hook

# The compiler incorporates policy-derived constraints into the compiled output
agent-registry compile api-design-reviewer --platform claude_code \
  > ~/.claude/agents/api-design-reviewer.md
```

---

## Setting Up an A/B Test

The user wants to know whether adding a detailed handoff template improves the quality of
downstream tasks. They test two versions of the handoff component.

```bash
# Current handoff component is sox-handoff v4
# They author a richer variant
agent-registry components create \
  --slug sox-handoff-extended \
  --type handoff \
  --content "## Context\n[what you started with]\n## Files Changed\n[specific paths]\n
## Deliverable\n[what was produced and where]\n## Evidence\n[how to verify it works]\n
## Blockers\n[anything the next agent must know]\n## Next Steps\n[recommended actions]"

# Register as a new version of the handoff component family
agent-registry components version sox-handoff-extended --alias-of sox-handoff --version 5

# Create the experiment
agent-registry experiment create \
  --name "handoff-detail-v4-vs-v5" \
  --agent api-design-reviewer \
  --component sox-handoff \
  --control-version 4 \
  --variant-version 5 \
  --metric completion_rate

agent-registry experiment start handoff-detail-v4-vs-v5

# Sessions are now split between control (v4) and variant (v5)
# TASK_USAGE metrics are correlated after completion

# Check results after sufficient sessions
agent-registry experiment results handoff-detail-v4-vs-v5
# Control  (v4): sessions=48  completion_rate=91%  mean_output_tokens=1180
# Variant  (v5): sessions=51  completion_rate=96%  mean_output_tokens=1420
# Verdict:  variant shows +5pp completion at +20% token cost — promote or tune

# Promote the variant to the default
agent-registry experiment promote handoff-detail-v4-vs-v5 --variant
# sox-handoff is now pinned to v5 for api-design-reviewer
```

---

## Runtime Integration via agent-mcp

When a session is started against an agent through the agent-mcp MCP server, the compiler
resolves the system prompt automatically. The user does not need to interact with this step —
it happens inside agent-mcp after the refactor.

```typescript
// agent-mcp internals after refactor (illustrative)
import { compileAgent } from '@adhd/agent-compiler';

const composed = await compileAgent({
  agentSlug: 'api-design-reviewer',
  platform: 'claude_api',
  context: { ticket_type: task.metadata?.ticket_type }
});

// composed.content  — flat system prompt string (same interface as before)
// composed.tools    — resolved tool definitions for this platform
// composed.id       — written to sessions.composed_prompt_id for audit trail
// composed.componentVersions — recorded for experiment correlation
```

The `systemPrompt` field in `AgentDefinition` is populated from `composed.content`. Everything
downstream in the orchestrator, tool dispatch, and streaming layers is unchanged.

---

## End-to-End: New Team, Three Agents, Production Use

A four-person engineering team joins a company that runs agent-mcp as their agent runtime.
They have never touched the claude-agents repository.

```bash
# 1. Install
npm install -g @adhd/agent-registry @adhd/tool-registry @adhd/agent-policy @adhd/agent-compiler
agent-registry init

# 2. Create a category for their domain
agent-registry taxonomy create --slug data-platform --name "Data Platform"

# 3. Create three agents by composing from the shared library
agent-registry agents create --slug pipeline-builder --category data-platform \
  --description "Designs and implements data ingestion pipelines"
agent-registry agents create --slug pipeline-reviewer --category data-platform \
  --description "Reviews pipeline designs for correctness, idempotency, and cost"
agent-registry agents create --slug data-documenter --category data-platform \
  --description "Generates data lineage docs and schema contracts from implementation"

# 4. Compose each from shared components + one team-authored component per agent
#    pipeline-builder:  role=backend-dev + capability=data-engineering + process=pipeline-workflow
#    pipeline-reviewer: role=reviewer + rule=default-skeptic + criteria=pipeline-review-criteria
#    data-documenter:   role=researcher + style=technical-docs + deliverable=schema-contract-template

# 5. Attach category-level policies (auto-inherits to all three)
agent-policy attach-to-category --category data-platform --policy no-credentials --mandatory
agent-policy attach-to-category --category data-platform --policy sox-audit-trail --mandatory

# 6. Compile all to Claude Code
agent-registry compile --all --category data-platform \
  --platform claude_code --out-dir ~/.claude/agents/

# 7. Agents are live in Claude Code immediately
#    /pipeline-builder, /pipeline-reviewer, /data-documenter — all available

# 8. Usage flows back through agent-mcp to agents.db
#    Experiment data accumulates; the team can run A/B tests after 50+ sessions per variant

# 9. When the company upgrades the global default-skeptic rule to v3,
#    all three agents pick it up on the next compile — no team action required
```

The team authored four prompt components (one per agent plus one shared), zero markdown files,
and zero policy definitions. Everything else came from the shared library.
