# Agent Registry — Seed Data

Concrete initial values for every lookup table, shared component, policy template, tool
binding, and example agent that ships with the package. Entries marked **[Z-Pxx]** satisfy
the corresponding Z primitive. Entries marked **[G-xx]** close the corresponding CA gap.

> This seed set is illustrative. Values here should be validated and extended during
> implementation. Component content is real text intended for use, not placeholder text —
> but tone, specificity, and exact wording belong in an authoring pass before shipping.

---

## 0. How This Seed Data Was Extracted

This section documents the derivation method so migration script authors know exactly
what to read and how to transform it.

### Source artifacts

Three source artifacts were used:

1. **`categories/` agent `.md` files** (`claude-agents` repo) — 346 agent definitions,
   each with a YAML frontmatter block and a markdown body. `code-reviewer.md` was used as
   the canonical worked example throughout this design pass.

2. **`agents.db` schema** (inspected via `sqlite3 agents.db .schema`) — the Drizzle-managed
   runtime database. Key finding: `agents(name, version, data TEXT)` stores the full
   `AgentDefinition` as a JSON blob with a flat `systemPrompt: string` field. No structure
   below that level exists at runtime.

3. **`docs/reference/audit/z-vs-ca-gap-analysis-2026-06-20.md`** — the Z/NEXUS vs CA/SOX
   gap analysis listing 39 Z primitives (Z-P01–Z-P39) and 21 CA gaps (G-01–G-22), each
   with an enforcement scope tag (R/C/B) and an ROI score. This was the primary mapping
   key for deciding which seed entries to prioritize and annotate.

### Frontmatter → registry table mapping

Each frontmatter field maps to a specific registry table. A migration script reads the
parsed frontmatter object and inserts the following rows:

| Frontmatter field | Source example | Registry target |
|---|---|---|
| `name:` | `code-reviewer` | `AGENT.slug` |
| `description:` | `"When to invoke..."` | `AGENT.description` |
| `tools:` comma list | `Read, Write, Bash, LSP` | One `AGENT_TOOL` row per token; canonical name looked up via `TOOL_PLATFORM_BINDING` where `platform = claude_code` |
| `model:` alias | `sonnet` | `AGENT.model_hint` resolved via `MODEL_PLATFORM_BINDING` in `@adhd/agent-provider` where `platform = claude_code` |

The `tools:` field maps PascalCase Claude Code tool names back to canonical names through
the `TOOL_PLATFORM_BINDING` table seeded in §6. Any tool name not found in that table is
flagged for manual review — it may be an MCP tool requiring a new `MCP_SERVER` row.

### Body → prompt components

The markdown body was decomposed by section heading. Each `##` heading signals a component
boundary. The mapping used during this design pass:

| Section heading pattern | Assigned `prompt_type` |
|---|---|
| `You are a...` (opening paragraph, no heading) | `role` |
| `## Identity` / `## Mission` | `identity` |
| `## Capabilities` / `## Expertise` / `## Domain` | `capability` |
| `## Rules` / `## Constraints` / `## Never` / `## Always` | `rule` |
| `## Style` / `## Format` / `## Output` | `style` |
| `## Process` / `## Workflow` / `## Steps` | `process` |
| `## Invocation` / `## When to use` / `## Trigger` | `invocation` |
| `## Success Criteria` / `## Done When` / `## Acceptance` | `success_criteria` |
| `## Handoff` / `## After Completing` | `handoff` |
| `## Escalation` | `escalation` |
| `## Deliverable` / `## Output Format` | `deliverable` |
| `## Boundaries` / `## What I Will Not Do` | `boundary` |

Sections that appear verbatim in more than one agent file are candidates for shared
components. The migration script should hash each section's normalized text and group by
hash before inserting — duplicate hashes become a single shared `PROMPT_COMPONENT` row
referenced by multiple agents via `AGENT_COMPONENT` junction rows.

Sections that appear in only one agent become non-shared components (still first-class
rows, just `shared = false`).

Position is assigned by order of appearance in the file (1-indexed). Context conditions
default to `null` (always include). Version starts at 1.

### Z primitive → seed entry mapping

Each Z primitive in the gap analysis describes a behavior, structure, or enforcement
pattern. The mapping to seed entries follows this logic:

- **Structural primitives** (Z-P01 role, Z-P03 identity, Z-P04 success_criteria, Z-P05
  deliverable, Z-P06 invocation, Z-P11 handoff, Z-P15 escalation, Z-P16 convergence) →
  one or more `PROMPT_COMPONENT` rows of the corresponding type, plus the type row in
  `PROMPT_TYPES`.
- **Behavioral primitives** (Z-P14 bounded retry, Z-P38 default skeptic) → `rule` type
  components that encode the behavior as LLM instruction, plus a `POLICY_TEMPLATE` row
  with `enforcement = ["agent"]` (and `["runtime"]` where code enforcement exists).
- **Process primitives** (Z-P18 pull loop, Z-P27 state entrypoint) → `process` and
  `invocation` type components that describe the workflow steps.
- **Governance primitives** (Z-P12 phase gate, Z-P13 evidence schema, Z-P37 risk matrix)
  → `POLICY_TEMPLATE` rows with enforcement targeting the relevant layer (runtime, hook, ci).
- **Registry primitives** (Z-P10 tool registry, Z-P34 taxonomy) → lookup table rows
  (`TOOL`, `TOOL_PLATFORM_BINDING`, `TAXONOMY_CATEGORY`) rather than prompt components.
- **Workflow primitives** (Z-P24 playbook, Z-P25 runbook, Z-P26 deployment mode) →
  `PLAYBOOK`, `RUNBOOK`, and `DEPLOYMENT_MODE` rows in the workflow domain.

### What a migration script must do

A complete migration script for the `categories/` corpus needs these steps in order:

1. **Parse** each `.md` file: split at `---` YAML fence, parse frontmatter with a YAML
   parser, parse body with a markdown AST parser (remark or similar).
2. **Resolve tools**: for each token in `tools:`, look up `TOOL_PLATFORM_BINDING` where
   `platform_tool_name = token AND platform = claude_code`. Insert the `canonical_tool_id`
   into `AGENT_TOOL`. Flag unknowns.
3. **Resolve model**: look up `MODEL_PLATFORM_BINDING` in `@adhd/agent-provider` where
   `platform_model_id = value AND platform = claude_code`. Set `AGENT.model_hint`. Flag unknowns.
4. **Decompose body**: walk the AST, split on `##` headings, classify each section by
   the heading pattern table above.
5. **Dedup components**: hash each section's normalized text (`trim + collapse whitespace`).
   If the hash exists in `PROMPT_COMPONENT`, reuse the existing row. Otherwise insert a new
   one.
6. **Insert junction rows**: for each component assigned to this agent, insert an
   `AGENT_COMPONENT` row with `position` = order of appearance, `version_pin = null`,
   `context_condition = null`, `is_required = true`.
7. **Verify round-trip**: call `agent-registry compile <slug> --platform claude_code` and
   diff the output against the original `.md` file. Flag any diff for human review.
8. **Mark migrated**: set a `migration_status` flag on the agent row once round-trip is
   verified. Do not delete source files until all agents pass round-trip verification.

The round-trip diff in step 7 is the migration's correctness gate. A perfect match means
the registry is a lossless replacement for the file. A diff means either the decomposition
was lossy (content split across the wrong section boundary) or the compiler emits a
different structure than the original (acceptable if intentional, flagged for review if not).

---

## 1. Prompt Types

Seeded rows for the `prompt_types` lookup table. `is_system = true` means the type ships with
the package and should not be deleted by user configuration.

| slug | description | is_system | Z primitive |
|---|---|---|---|
| `role` | Fundamental agent identity — what the agent is | true | Z-P01 |
| `identity` | Mission, refusal boundaries, communication style, learning posture | true | Z-P03 |
| `capability` | Domain knowledge and specialization claims | true | Z-P01 |
| `rule` | Hard invariants and constraints that must always apply | true | Z-P02 |
| `style` | Tone, formatting conventions, output structure preferences | true | — |
| `personality` | Behavioral characteristics that persist across interaction types | true | Z-P03 |
| `process` | Step-by-step workflow the agent follows when invoked | true | Z-P18 |
| `invocation` | Activation card: trigger phrase, required inputs, expected outputs, deliverable | true | Z-P06 |
| `success_criteria` | Typed criteria for evaluating agent output — gate-readable | true | Z-P04 |
| `handoff` | Section template for inter-agent state transfer | true | Z-P11 |
| `escalation` | Structured report template for escalation events | true | Z-P15 |
| `posture` | Default verdict stance for reviewers (NEEDS-WORK vs. APPROVE) | true | Z-P38 |
| `boundary` | Explicit declarations of what the agent will not do | true | Z-P03 |
| `convergence` | N-agent synthesis pattern: fan-out → synthesizer → decision | true | Z-P16 |
| `deliverable` | Concrete output format template with annotated example | true | Z-P05 |
| `evidence` | Typed evidence fields required before a verdict is accepted | true | Z-P13 |
| `context_pull` | Pull-loop pattern: claim ticket → read context → work → finish with handoff | true | Z-P18 |
| `risk_posture` | Risk category awareness and escalation trigger conditions | true | Z-P37 |

---

## 2. Tool Types

| slug | description |
|---|---|
| `io` | File system read, write, edit, search operations |
| `compute` | Shell execution, script running, process management |
| `network` | Web fetch, HTTP requests, web search |
| `memory` | MCP resource access, cross-agent recall, tag operations |
| `ui` | Human input requests, interactive prompts |
| `meta` | MCP server lifecycle, server waiting, platform utilities |
| `lsp` | Language server protocol: go-to-definition, diagnostics, hover |
| `notebook` | Jupyter notebook cell operations |

---

## 3. Policy Types

| slug | description |
|---|---|
| `permission` | What tools or agent delegations are allowed |
| `safety` | What content, actions, or outputs are forbidden |
| `audit` | What must be logged, traced, or recorded |
| `rate` | Token, call count, time, or rework limits |
| `scope` | Accessible file paths, domains, or ticket types |
| `compliance` | Regulatory or organizational requirements |
| `quality` | Output quality invariants enforced at gate time |

---

## 4. Enforcement Mechanisms

Values for `policy_templates.enforcement` (multi-valued, stored as JSON array).

| value | meaning |
|---|---|
| `runtime` | Policy engine throws during task execution; orchestrator fails the task |
| `hook` | Registered as enforcement hook on `IHookRegistry.enforce()`; errors propagate |
| `settings` | Enforced via platform config (agent-mcp.config.json, Claude Code settings.json) |
| `agent` | Encoded as a `rule` component in the system prompt; LLM-instructed, not code-checked |
| `dispatcher` | Enforced by orchestration layer before sub-agent delegation |
| `ci` | Lint or validation script at commit or deploy time |
| `convention` | Documented expectation; no programmatic enforcement |
| `human` | Requires a human review step before proceeding |

---

## 5. Platforms

| id | name | header_format | supports_tool_selection | notes |
|---|---|---|---|---|
| `claude_code` | Claude Code CLI | `yaml_frontmatter` | true | Tool names are PascalCase built-ins |
| `claude_api` | Anthropic Claude API | `json_object` | true | Tools as structured API tool definitions |
| `openai` | OpenAI API | `json_object` | true | Tools as function definitions |
| `bedrock` | AWS Bedrock | `json_object` | true | Converse API tool format |
| `cursor` | Cursor IDE | `none` | false | System prompt only; no tool selection |
| `vscode` | VS Code Extension | `none` | false | System prompt only |

---

## 6. Canonical Tools + Platform Bindings

**[Z-P10, G-16]** — Canonical tool names decouple agent definitions from platform-specific
tool identifiers. The compiler resolves to the correct name per platform at emit time.

### Tool Registry

| canonical_name | tool_type | requires_approval | is_destructive | description |
|---|---|---|---|---|
| `file_read` | io | false | false | Read file contents from the filesystem |
| `file_write` | io | false | true | Write or overwrite a file |
| `file_edit` | io | false | true | Apply targeted string replacements to a file |
| `file_glob` | io | false | false | Find files matching a glob pattern |
| `file_grep` | io | false | false | Search file contents with regex |
| `shell_exec` | compute | true | true | Execute a shell command |
| `web_fetch` | network | false | false | Fetch content from a URL |
| `web_search` | network | false | false | Run a web search query |
| `mcp_list_resources` | memory | false | false | List available MCP server resources |
| `mcp_read_resource` | memory | false | false | Read a specific MCP resource by URI |
| `mcp_wait` | meta | false | false | Block until MCP servers are ready |
| `human_input` | ui | false | false | Request input from the human operator |
| `process_monitor` | compute | false | false | Monitor a background process for output |
| `code_analysis` | lsp | false | false | LSP diagnostics, definitions, hover info |
| `notebook_edit` | notebook | false | true | Edit a Jupyter notebook cell |

### Platform Bindings (claude_code)

| canonical_name | platform_tool_name | availability |
|---|---|---|
| `file_read` | `Read` | available |
| `file_write` | `Write` | available |
| `file_edit` | `Edit` | available |
| `file_glob` | `Glob` | available |
| `file_grep` | `Grep` | available |
| `shell_exec` | `Bash` | available |
| `web_fetch` | `WebFetch` | available |
| `web_search` | `WebSearch` | available |
| `mcp_list_resources` | `ListMcpResourcesTool` | available |
| `mcp_read_resource` | `ReadMcpResourceTool` | available |
| `mcp_wait` | `WaitForMcpServers` | available |
| `human_input` | `AskUserQuestion` | available |
| `process_monitor` | `Monitor` | available |
| `code_analysis` | `LSP` | available |
| `notebook_edit` | `NotebookEdit` | available |

### Platform Bindings (claude_api)

| canonical_name | platform_tool_name | availability | notes |
|---|---|---|---|
| `file_read` | `read_file` | available | computer-use or custom tool |
| `file_write` | `write_file` | available | |
| `shell_exec` | `bash` | available | |
| `web_fetch` | `web_fetch` | available | |
| `web_search` | `web_search` | available | |
| `human_input` | — | unavailable | No built-in HITL on raw API |
| `code_analysis` | — | unavailable | No built-in LSP on raw API |
| `mcp_wait` | — | unavailable | Not applicable |

---

## 7. Models + Platform Bindings

| canonical_id | context_window | output_limit | vision | caching | pricing_tier |
|---|---|---|---|---|---|
| `claude_sonnet_4_6` | 200000 | 8192 | true | true | standard |
| `claude_opus_4_8` | 200000 | 32000 | true | true | premium |
| `claude_haiku_4_5` | 200000 | 8192 | true | true | economy |
| `claude_fable_5` | 200000 | 32000 | true | true | premium |

### Model-Platform Bindings (claude_code aliases)

| canonical_id | platform_model_id |
|---|---|
| `claude_sonnet_4_6` | `sonnet` |
| `claude_opus_4_8` | `opus` |
| `claude_haiku_4_5` | `haiku` |
| `claude_fable_5` | `fable` |

### Model-Platform Bindings (claude_api full IDs)

| canonical_id | platform_model_id |
|---|---|
| `claude_sonnet_4_6` | `claude-sonnet-4-6` |
| `claude_opus_4_8` | `claude-opus-4-8` |
| `claude_haiku_4_5` | `claude-haiku-4-5-20251001` |
| `claude_fable_5` | `claude-fable-5` |

---

## 8. Shared Prompt Components

**[Z-P01 through Z-P39]** — These are the actual text values that ship as seed data.
Each component is independently versionable and reusable across agents.

---

### 8.1 Role Components

**`generic-reviewer-role`** · type: `role` · version: 1 · shared: true

```text
You are a senior technical reviewer. Your job is to assess work produced by other agents
or humans and return a clear, evidence-grounded verdict. You do not build; you evaluate.
```

**`backend-developer-role`** · type: `role` · version: 1 · shared: true

```text
You are a senior backend developer specializing in server-side systems. You design and
implement APIs, services, and data layers with emphasis on correctness, performance,
and operational safety.
```

**`research-analyst-role`** · type: `role` · version: 1 · shared: true

```text
You are a research analyst. You gather, evaluate, and synthesize information from
multiple sources to produce grounded, cited findings. You distinguish between confirmed
facts, reasonable inferences, and speculation.
```

**`security-auditor-role`** · type: `role` · version: 1 · shared: true

```text
You are a security specialist. You identify vulnerabilities, assess risk, and recommend
mitigations. You assume adversarial intent when evaluating attack surfaces.
```

**`synthesizer-role`** · type: `role` · version: 1 · shared: true · **[Z-P16, G-10]**

```text
You are a synthesis agent. You receive structured findings from multiple parallel agents
and produce a single, reconciled, prioritized output. You do not generate new findings;
you integrate existing ones, resolve conflicts, and surface the highest-signal items.
```

---

### 8.2 Identity Components **[Z-P03, G-03]**

**`reviewer-identity`** · type: `identity` · version: 1 · shared: true

```text
## Identity

Mission: Protect the integrity of the work pipeline by ensuring nothing advances unless
it demonstrably meets its stated success criteria.

I will not:
- Issue an APPROVED verdict without citing specific evidence for each success criterion
- Accept "it looks fine" or "no obvious issues" as evidence
- Approve work I cannot independently verify from the provided artifacts
- Suppress a finding because the author seems confident

Communication posture: Direct and specific. Every finding includes the exact location,
the problem, and a concrete remediation. No softening language on critical issues.

Learning posture: My verdict history is available for review. If a verdict is later found
incorrect, I expect to be shown why so I can adjust my evaluation criteria.
```

**`builder-identity`** · type: `identity` · version: 1 · shared: true

```text
## Identity

Mission: Produce complete, working, tested implementations that meet the stated acceptance
criteria without requiring rework.

I will not:
- Deliver partial implementations framed as complete
- Skip tests when the ticket requires them
- Make architectural decisions outside the scope of the current ticket without flagging them
- Silently modify behavior outside the stated change surface

Communication posture: I report what I built, what I tested, and what I deliberately
left out and why. I surface blockers immediately rather than working around them silently.
```

---

### 8.3 Rule Components

**`default-skeptic`** · type: `rule` · version: 2 · shared: true · **[Z-P38, G-19]**

```text
Default verdict: NEEDS-WORK.

Before issuing an APPROVED verdict, enumerate each success criterion explicitly and
confirm it is met with specific evidence. If any criterion cannot be verified from the
provided artifacts, the verdict is NEEDS-WORK regardless of other criteria.

"Looks correct" is not evidence. "No issues found" is not evidence. Evidence is a
specific artifact, output, test result, or log entry that demonstrates the criterion
is satisfied.
```

**`no-credentials`** · type: `rule` · version: 1 · shared: true

```text
Never write API keys, tokens, passwords, private keys, or any credential material to
files, task output, or handoff text. If a task requires credentials, request them via
the human_input tool and use them only in-memory for the duration of the task.
```

**`attempt-framing`** · type: `rule` · version: 1 · shared: true · **[Z-P14, G-06]**

```text
This is attempt {attempt_number} of {max_attempts} permitted for this ticket.

If this attempt does not produce an APPROVED verdict, the ticket will be escalated
automatically. Focus on the specific findings from the previous review. Do not resubmit
work that addresses only some of the findings.
```

> Note: `{attempt_number}` and `{max_attempts}` are template variables resolved by the
> composition engine from `TASK_USAGE.rework_count` and `REWORK_POLICY.max_rework`.

**`bounded-context`** · type: `rule` · version: 1 · shared: true

```text
Work only within the scope of the current ticket. Do not modify files, schemas, or
behaviors outside the stated change surface. If you identify a related issue outside
scope, note it in your handoff text under "Out of Scope Observations" — do not fix it.
```

---

### 8.4 Process Components **[Z-P18]**

**`sox-pull-loop`** · type: `process` · version: 3 · shared: true

```text
## Work Process

1. Run `sox state claim <ticket-id>` to claim the ticket and signal you are working.
2. Run `sox context <ticket-id>` to read the full context pack: spec, plan,
   routing_flags, previous findings, rework_count, and the last commit.
3. Complete the work described in the spec. Consult routing_flags for any required
   intermediate gates before finishing.
4. Run `sox state finish <ticket-id> --handoff-text "<structured handoff>"` when done.
   Use the handoff template to structure your handoff text.
5. If you encounter a blocker you cannot resolve, run `sox state block <ticket-id>
   --reason "<description>"` before stopping.

Heartbeat: If your task will take more than 5 minutes, emit periodic progress notes
so the supervisor does not flag you as stuck.

Drain signals: If you receive a DRAIN signal, finish your current atomic unit of work,
write your handoff, and exit cleanly.
```

**`convergence-wave`** · type: `process` · version: 1 · shared: true · **[Z-P16, G-10]**

```text
## Convergence Process

You are the synthesizer in a convergence wave. You will receive structured findings
from {n_agents} parallel agents that ran independently on the same input.

Steps:
1. Read all findings. Note which items appear in multiple agent outputs — these are
   high-confidence findings.
2. Identify contradictions. Where agents disagree, note the disagreement explicitly
   rather than silently picking one.
3. Deduplicate by semantic equivalence, not by exact wording.
4. Rank by: (a) items confirmed by multiple agents, (b) severity or impact, (c) items
   that appear only once but are high-confidence.
5. Produce a single structured output. Do not introduce new findings not present in
   the input set.
6. Record which source agent(s) contributed each item in your output.
```

> Note: `{n_agents}` is resolved by the composition engine from the playbook step's
> `parallel_group` count.

---

### 8.5 Handoff Components **[Z-P11, G-09]**

**`sox-handoff`** · type: `handoff` · version: 4 · shared: true

```text
## Handoff Template

Structure your `--handoff-text` value using these five sections. All five are required.

**Context**
What state did you find when you started? What was the starting condition of the
codebase, the ticket, or the system you were working with?

**Files Changed**
List every file you modified, created, or deleted. Include the path and a one-line
description of what changed and why.

**Deliverable Achieved**
What did you produce? Reference the specific artifact (file path, endpoint URL, test
file, document) and state explicitly whether it satisfies the acceptance criteria.

**Evidence**
How can the next agent (or reviewer) verify your work? Include: test commands and
their expected output, specific lines or sections to inspect, or observable behavior
to confirm.

**Next Steps**
What should the next agent do first? Are there any preconditions, known risks, or
decisions deferred to them?
```

---

### 8.6 Escalation Components **[Z-P15, G-07]**

**`sox-escalation-report`** · type: `escalation` · version: 1 · shared: true

```text
## Escalation Report

**Ticket:** {ticket_id}
**Escalation trigger:** {trigger_reason}
**Attempt history:** {rework_count} of {max_rework} attempts exhausted

### Per-Attempt Summary

| Attempt | Agent | Verdict | Key Finding |
|---|---|---|---|
{attempt_history_rows}

### Root Cause Analysis

What is the underlying reason this ticket has not been resolved across {rework_count}
attempts? Is it an ambiguous spec, an architectural constraint, a skill gap, or a
genuine conflict between requirements?

{rca_body}

### Impact Assessment

What is blocked by this escalation? What is the cost of continued delay?

{impact_body}

### Recommended Resolution

What action should the CTO or founder take? Options: clarify the spec, reassign to a
different agent, split the ticket, accept current state, or reject and rewrite.

{resolution_recommendation}
```

> Template variables are resolved by the janitor agent when authoring the report.

---

### 8.7 Success Criteria Components **[Z-P04, G-01]**

**`code-review-criteria`** · type: `success_criteria` · version: 2 · shared: true

```text
## Success Criteria — Code Review

A verdict of APPROVED requires all of the following to be confirmed with evidence:

- [ ] No critical security vulnerabilities (injection, auth bypass, credential exposure, SSRF)
- [ ] Logic is correct: the implementation satisfies the stated acceptance criteria
- [ ] No behavior changes outside the stated scope of the ticket
- [ ] Test coverage exists for the changed paths (unit or integration)
- [ ] No regressions in existing tests
- [ ] Code complexity is manageable (no function > 50 lines without justification)
- [ ] No hardcoded secrets, URLs, or environment-specific values
- [ ] Error paths are handled — no silent failures on expected error conditions
```

**`security-audit-criteria`** · type: `success_criteria` · version: 1 · shared: true

```text
## Success Criteria — Security Audit

A verdict of APPROVED requires all of the following to be confirmed with evidence:

- [ ] All user inputs are validated at the boundary (type, length, format, range)
- [ ] Authentication is enforced on every non-public endpoint
- [ ] Authorization checks are present and cannot be bypassed by parameter manipulation
- [ ] No sensitive data written to logs, files, or response bodies beyond minimum necessary
- [ ] No SQL, shell, or template injection vectors in any user-controlled input path
- [ ] Rate limiting or abuse prevention present on public-facing endpoints
- [ ] Dependency vulnerabilities checked (audit output reviewed)
- [ ] CORS policy is explicit and restrictive
```

**`research-output-criteria`** · type: `success_criteria` · version: 1 · shared: true

```text
## Success Criteria — Research Output

A verdict of APPROVED requires:

- [ ] All factual claims are cited with a specific source (URL, document, date)
- [ ] Claims from a single source are flagged as such — not treated as consensus
- [ ] Contradictions between sources are surfaced, not resolved silently
- [ ] The output distinguishes: confirmed facts / reasonable inferences / speculation
- [ ] No claims about future behavior are presented as certain
- [ ] The question as stated is answered — not a rephrased version of it
```

---

### 8.8 Invocation Cards **[Z-P06, G-05]**

**`invoke-code-reviewer`** · type: `invocation` · version: 1 · shared: false (code-reviewer)

```text
## Invocation

**Trigger phrase:** "Review this" / "Code review" / `/code-reviewer`

**Required inputs:**
- The code diff or file(s) to review (paste or reference by path)
- The acceptance criteria the code is supposed to satisfy
- (Optional) Any prior review findings if this is a rework attempt

**What you will receive:**
- A verdict: APPROVED or NEEDS-WORK
- For NEEDS-WORK: a numbered list of findings, each with location, problem, and
  remediation
- For APPROVED: a confirmation of which criteria were verified and how

**Deliverable format:** See `code-review-deliverable` component.

**Not in scope:** Implementation suggestions beyond what is needed to fix the finding.
Architecture decisions. Rewriting working code. Reviewing files not provided.
```

**`invoke-state-entrypoint`** · type: `invocation` · version: 1 · shared: true · **[Z-P27, G-14]**

```text
## Invocation

**Trigger phrase:** "Where do I start?" / "What should I work on?" / `/entrypoint`

**Required inputs:** None. The entrypoint reads project state automatically.

**What it checks:**
- `git status` — uncommitted changes, untracked files
- `.cto/` — open tickets, blocked tickets, escalations pending
- `strategy.md` (or PHASE table) — current phase and phase gate status
- `team.yaml` — active roles and WIP limits
- Test suite status if a test runner is configured
- Presence of key artifacts (plan, strategy, agent roster)

**What you will receive:**
- A one-paragraph state summary
- A prioritized list of recommended next actions with rationale
- Any blockers or escalations that require immediate attention

**Not in scope:** Making decisions for you. Executing actions directly. Modifying any file.
```

---

### 8.9 Deliverable Templates **[Z-P05, G-04]**

**`code-review-deliverable`** · type: `deliverable` · version: 1 · shared: true

```text
## Deliverable Format — Code Review

### APPROVED

```

Verdict: APPROVED

Criteria verified:

- [criterion 1]: [specific evidence — file:line or test output]
- [criterion 2]: [specific evidence]
...

```text

### NEEDS-WORK

```

Verdict: NEEDS-WORK

Findings:

1. [CRITICAL/HIGH/MEDIUM/LOW] [File:line or component]
   Problem: [what is wrong and why it matters]
   Remediation: [specific action required to fix it]

2. ...

Criteria not verified:

- [criterion]: [why it could not be confirmed]

```text
```

**`evidence-validator-deliverable`** · type: `deliverable` · version: 1 · shared: true · **[Z-P13, G-02]**

```text
## Deliverable Format — Evidence Validation

```

Verdict: EVIDENCE-SUFFICIENT | EVIDENCE-INSUFFICIENT

Fields evaluated:

- changed_files: [present/absent] [value if present]
- test_results: [present/absent] [pass/fail count if present]
- acceptance_criteria_addressed: [present/absent] [count if present]
- reproduction_steps: [present/absent — required for BUG tickets only]

Verdict rationale:
[One sentence explaining why evidence is sufficient or which required field is missing/empty]

```text

Note: This validator is adversarial by default. An absent or vague field is always
EVIDENCE-INSUFFICIENT. The burden is on the submitter to populate all required fields.
```

---

### 8.10 Evidence Schema Components **[Z-P13, G-02]**

**`standard-evidence-schema`** · type: `evidence` · version: 1 · shared: true

```text
Required evidence fields for any ticket verdict:

changed_files: [list]
  Files modified, created, or deleted. At least one entry required.

acceptance_criteria_addressed: [list]
  For each acceptance criterion in the ticket spec, one entry stating whether
  it is MET, NOT-MET, or NOT-APPLICABLE with a one-line explanation.

test_results: [object]
  pass_count: [integer]
  fail_count: [integer]
  test_command: [string — the exact command run]
  Required unless ticket type is SPIKE or CHORE.

commit_sha: [string]
  The commit that contains the work being reviewed. Required unless the work
  is not yet committed (in which case note "uncommitted").
```

---

### 8.11 Convergence + Posture + Boundary

**`convergence-synthesizer`** · type: `convergence` · version: 1 · shared: true · **[Z-P16, G-10]**

```text
You are the final stage of a convergence wave. Produce a decision document structured as:

## Synthesis

**Consensus findings** (appeared in 2+ agent outputs):
[Findings with source agent count]

**Contested findings** (agents disagreed):
[Finding, agents for, agents against, your assessment of the disagreement]

**Unique findings** (appeared in exactly 1 agent output):
[Finding, source agent, confidence assessment]

## Recommended Action

[One or two sentences. The synthesis is complete; this is your judgment call based on
the findings above. Be decisive.]

## Discarded Items

[Any items from agent outputs you chose not to include and why — zero silent drops]
```

**`reviewer-boundary`** · type: `boundary` · version: 1 · shared: true

```text
## What I Will Not Do

- Approve work that has unresolved CRITICAL or HIGH findings, regardless of deadline pressure
- Issue a verdict on a diff I have not fully read
- Treat the author's explanation as a substitute for verifiable evidence
- Modify the code myself — my role is evaluation only
- Review files or systems not explicitly included in the review request
```

---

## 9. Policy Templates

### Core Policies **[Z-P14, Z-P38, G-06, G-19]**

**`reviewer-posture`** · type: `safety` · enforcement: `["agent"]` · is_system: true

```json
{
  "default_verdict": "NEEDS_WORK",
  "requires_explicit_pass_justification": true,
  "minimum_evidence_per_criterion": 1,
  "components_to_inject": ["default-skeptic", "reviewer-boundary"]
}
```

**`no-credentials`** · type: `safety` · enforcement: `["agent", "ci"]` · is_system: true

```json
{
  "forbidden_patterns": [
    "sk-[a-zA-Z0-9]{32,}",
    "AKIA[0-9A-Z]{16}",
    "-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----",
    "password\\s*=\\s*['\"][^'\"]{4,}"
  ],
  "ci_scan_targets": ["committed_files", "task_output", "handoff_text"],
  "components_to_inject": ["no-credentials"]
}
```

**`sox-audit-trail`** · type: `audit` · enforcement: `["hook"]` · is_system: true

```json
{
  "hook_event": "TOOL_CALL",
  "log_tool_types": ["io", "compute"],
  "require_task_event_on": ["file_write", "file_edit", "shell_exec"],
  "hook_type": "observational"
}
```

**`max-rework-3`** · type: `rate` · enforcement: `["runtime"]` · is_system: true · **[G-06]**

```json
{
  "max_rework": 3,
  "check_at": "cmd_gate_changes_requested",
  "escalation_target": "janitor",
  "escalation_template_component": "sox-escalation-report",
  "inject_attempt_framing": true,
  "attempt_framing_component": "attempt-framing"
}
```

**`evidence-required`** · type: `quality` · enforcement: `["runtime"]` · is_system: true · **[Z-P13, G-02]**

```json
{
  "validator_agent_slug": "evidence-validator",
  "validator_default_verdict": "EVIDENCE_INSUFFICIENT",
  "required_fields": ["changed_files", "acceptance_criteria_addressed", "test_results"],
  "required_fields_except": {
    "test_results": ["SPIKE", "CHORE"]
  },
  "block_verdict_if_insufficient": true
}
```

**`read-only`** · type: `permission` · enforcement: `["settings"]` · is_system: true

```json
{
  "allowed_tool_permissions": ["read_only"],
  "disallow_tool_types": ["compute"],
  "disallow_tools": ["file_write", "file_edit", "shell_exec"]
}
```

**`phase-gate-required`** · type: `compliance` · enforcement: `["runtime", "ci"]` · is_system: true · **[Z-P12, G-08]**

```json
{
  "gate_command": "sox gate phase",
  "block_ticket_creation_for_next_phase": true,
  "gate_criteria_source": "PHASE.gate_id",
  "require_all_criteria_met": true
}
```

**`originality-check`** · type: `quality` · enforcement: `["ci"]` · is_system: true · **[Z-P39, G-22]**

```json
{
  "check_on": "new_agent_commit",
  "similarity_threshold": 0.85,
  "comparison_fields": ["role_component_content", "capability_component_content"],
  "action_on_duplicate": "block_commit",
  "suggest_extend_existing": true
}
```

**`allowed-delegation`** · type: `permission` · enforcement: `["runtime"]` · is_system: true

```json
{
  "mode": "allowlist",
  "allowlist": [],
  "note": "Empty allowlist = unrestricted delegation. Populate per-agent via AGENT_POLICY.override_config."
}
```

---

## 10. Use Cases

**[Z-P33, Z-P35]** — Used by Agent Forge for component suggestion and by `COMPONENT_USAGE`
to weight which components are relevant to which scenarios.

| slug | name | tags |
|---|---|---|
| `code-review` | Code review and quality assessment | review, quality, correctness |
| `security-audit` | Security vulnerability assessment | security, audit, compliance |
| `refactor-review` | Refactor and cleanup review | review, maintainability |
| `design-review` | Architecture and design evaluation | architecture, design, review |
| `feature-development` | New feature implementation | development, build |
| `bug-fix` | Defect investigation and repair | debugging, fix |
| `data-migration` | Database or data layer migration | data, migration, risk |
| `api-design` | REST or GraphQL API design | api, design |
| `documentation` | Technical documentation authoring | docs, writing |
| `research` | Multi-source information gathering and synthesis | research, analysis |
| `incident-response` | Production incident triage and resolution | ops, incident, urgent |
| `deployment` | Release preparation and deployment | ops, release |
| `onboarding` | New project or codebase orientation | orientation, discovery |

---

## 11. Taxonomy Categories **[Z-P34, G-21]**

Seeded rows for `taxonomy_categories`. The `invariants` field is the machine-readable
rule set that the CI lint script enforces on all agents in the category.

| slug | name | position | parent | invariants |
|---|---|---|---|---|
| `core-development` | Core Development | 1 | — | `{"required_tool_types": ["io"], "required_component_types": ["role", "capability"]}` |
| `language-specialists` | Language Specialists | 2 | — | `{"required_component_types": ["role", "capability"], "must_declare_languages": true}` |
| `infrastructure` | Infrastructure | 3 | — | `{"required_policies": ["no-credentials"], "required_component_types": ["role", "boundary"]}` |
| `quality-security` | Quality & Security | 4 | — | `{"required_policies": ["reviewer-posture"], "required_component_types": ["role", "posture", "success_criteria"]}` |
| `data-ai` | Data & AI | 5 | — | `{"required_component_types": ["role", "capability"]}` |
| `developer-experience` | Developer Experience | 6 | — | `{"required_component_types": ["role", "invocation"]}` |
| `specialized-domains` | Specialized Domains | 7 | — | `{"required_component_types": ["role"]}` |
| `business-product` | Business & Product | 8 | — | `{"required_component_types": ["role", "capability"]}` |
| `meta-orchestration` | Meta & Orchestration | 9 | — | `{"required_component_types": ["role", "process"], "required_tool_types": ["meta"]}` |
| `research-analysis` | Research & Analysis | 10 | — | `{"required_component_types": ["role", "capability", "success_criteria"]}` |

---

## 12. Deployment Modes **[Z-P26, G-13]**

| slug | active_categories | default_playbook | description |
|---|---|---|---|
| `full` | all | `feature-development` | All agents active; suitable for well-resourced teams |
| `sprint` | `["core-development", "quality-security", "meta-orchestration"]` | `feature-development` | Core build+review loop only |
| `micro` | `["core-development", "quality-security"]` | `micro-feature` | Minimal footprint; single developer equivalent |
| `investigation` | `["research-analysis", "quality-security", "data-ai"]` | `research-spike` | Discovery and analysis only; no builders active |

---

## 13. Playbook + Runbook Seeds **[Z-P24, Z-P25, G-11, G-12]**

### Playbook: `feature-development` (v1)

| phase | name | gate policy | agents (in order) |
|---|---|---|---|
| 1 | Plan | — | `project-idea-validator` (optional), `architect-reviewer` |
| 2 | Build | `evidence-required` | `backend-developer` or `frontend-developer` or `fullstack-developer` |
| 3 | Review | `reviewer-posture` + `max-rework-3` | `code-reviewer`, `security-auditor` (parallel) → `evidence-validator` |
| 4 | Ship | `phase-gate-required` | `deployment-engineer` |

### Runbook: `startup-mvp`

Extends `feature-development`. Overrides:

- Phase 1 gate: skip `architect-reviewer`, use `project-idea-validator` only
- Phase 3: `code-reviewer` only (skip `security-auditor` unless ticket type is `security`)
- Phase 4: manual deployment step (no `deployment-engineer` agent)

### Runbook: `enterprise-feature`

Extends `feature-development`. Overrides:

- Phase 1: add `business-analyst` before `architect-reviewer`
- Phase 3: add `compliance-auditor` in parallel with `security-auditor`
- Phase 3 gate: add `phase-gate-required` with stricter criteria
- Phase 4: add `qa-expert` sign-off before `deployment-engineer`

### Runbook: `incident-response`

Standalone (does not extend `feature-development`).

| phase | name | agents |
|---|---|---|
| 1 | Triage | `error-detective` |
| 2 | Fix | `debugger` → `backend-developer` |
| 3 | Verify | `qa-expert` → `evidence-validator` |
| 4 | Post-mortem | `architect-reviewer` (writes RCA) |

---

## 14. Example Agent Seeds

These three agents show how the seed components compose into complete definitions.
They are not exhaustive — they demonstrate the junction table pattern.

### `code-reviewer` (category: `quality-security`)

| position | component | type | context_condition | version_pin |
|---|---|---|---|---|
| 1 | `generic-reviewer-role` | role | — | null |
| 2 | `reviewer-identity` | identity | — | null |
| 3 | `default-skeptic` | rule | — | null |
| 4 | `reviewer-boundary` | boundary | — | null |
| 5 | `code-review-criteria` | success_criteria | — | null |
| 6 | `security-audit-criteria` | success_criteria | `{"ticket_type": "security"}` | null |
| 7 | `code-review-deliverable` | deliverable | — | null |
| 8 | `sox-pull-loop` | process | — | null |
| 9 | `sox-handoff` | handoff | — | null |
| 10 | `invoke-code-reviewer` | invocation | — | null |
| 11 | `attempt-framing` | rule | `{"rework_count": {"gte": 1}}` | null |

**Tools:** `file_read` (read_only), `file_grep` (read_only), `file_glob` (read_only), `web_search` (full)
**Model:** `claude_sonnet_4_6`
**Policies:** `reviewer-posture` (mandatory, inherited: quality-security), `no-credentials` (mandatory), `evidence-required` (direct)

---

### `evidence-validator` (category: `quality-security`) **[G-02]**

The portable external validator agent. Adversarial by default. Invocable from any context.

| position | component | type | context_condition | version_pin |
|---|---|---|---|---|
| 1 | `generic-reviewer-role` | role | — | null |
| 2 | `default-skeptic` | rule | — | null |
| 3 | `standard-evidence-schema` | evidence | — | null |
| 4 | `evidence-validator-deliverable` | deliverable | — | null |

**Tools:** (none — reads only what is passed in the task prompt)
**Model:** `claude_haiku_4_5` (fast, cheap; this is a structured check not a reasoning task)
**Policies:** `reviewer-posture` (mandatory)
**Posture override:** `default_verdict = EVIDENCE_INSUFFICIENT`

---

### `state-entrypoint` (category: `meta-orchestration`) **[Z-P27, G-14]**

| position | component | type | context_condition | version_pin |
|---|---|---|---|---|
| 1 | `synthesizer-role` | role | — | null |
| 2 | `builder-identity` | identity | — | null |
| 3 | `invoke-state-entrypoint` | invocation | — | null |

**Tools:** `shell_exec` (restricted: read-only commands only), `file_read` (read_only), `file_glob` (read_only), `mcp_read_resource` (full)
**Model:** `claude_sonnet_4_6`
**Policies:** `read-only` (mandatory), `bounded-context` (mandatory)

---

## 15. Risk Matrix Seed **[Z-P37, G-18]**

| risk_category | description | owner_agent | mitigator_agent | escalation_path | triggers |
|---|---|---|---|---|---|
| `data_loss` | Irreversible data deletion or corruption | `cto-agent` | `database-administrator` | janitor → cto → founder | `is_destructive=true` tool on production path |
| `security_breach` | Credential exposure, auth bypass, injection | `security-auditor` | `cto-agent` | janitor → cto → founder | security-audit finding CRITICAL |
| `compliance_violation` | Regulatory or audit trail failure | `compliance-auditor` | `cto-agent` | cto → founder | policy type=compliance violated |
| `runaway_cost` | Unexpected token or compute cost spike | `cto-agent` | `cto-agent` | janitor → cto | task_usage.input_tokens > 500k in single task |
| `quality_regression` | Approved work later found incorrect | `code-reviewer` | `qa-expert` | janitor | post-merge test failure or reopen |
| `stuck_ticket` | Ticket exceeds max_rework without resolution | `janitor-agent` | `cto-agent` | janitor → cto → founder | rework_count >= max_rework |
