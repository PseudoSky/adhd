# USE_CASES — agent-final

> Owner method directive (2026-07-17, OBS-31): **builds are driven by actual use cases, not
> statements.** Every capability the demo exercises traces to a scenario below; a capability
> with no use case here has no reason to exist. Format: actor · concrete situation ·
> observable outcome. Contested designs appear as **falsifiable use-case questions**, not
> requirements. Sources: the mined superseded corpus (OBS-28/29), owner rulings D-A…D-G,
> O-1/O-3, OBS-30/31.

## Actors

- **Noa** — fleet owner: ~40 reviewer/auditor agents, compliance-driven.
- **Priya** — dispatch lead: authors `dag.json` plans, pays the token bills.
- **Orin** — an orchestrating *agent* (LLM) that composes sub-agents at runtime over MCP.
- **Dev** — a third-party TypeScript developer embedding the package clients directly.
- **Sam** — a small (2–14B) model given a task packet.
- **Op** — a human operator at a terminal (the agent CLI's user).

---

## A · Authoring & the component graph

- **UC-A1** Noa's compliance team changes the grounding rule. She edits **one** shared
  component; every agent that attaches it unpinned recompiles with the new text; the two
  agents she pinned stay on v1 until she unpins them. *(single-write propagation + pin/rollback)*
- **UC-A2** Orin needs a sub-agent for a security review. Over MCP alone: lists the prompt
  grammar (`prompt_types_list`), searches per slot (`component_search {type:'rule', query}`),
  reads finalists, checks legal tools/models (`tool_list`/`model_list`), then one
  `agent_define` — 3–5 calls, no store internals. *(the composing-agent journey; vocab tools
  are load-bearing: without them Orin is blind at each phase)*
- **UC-A3** Before editing the shared grounding rule, Noa asks who consumes it
  (`component_consumers`) — 14 agents — and sees the blast radius *before* the write.
- **UC-A4** Orin typos a component name in `agent_define`; the registry is byte-identical
  after the failed call. *(transactional rollback)*
- **UC-A5** Op has 200 spec documents (skills, agent .md files, playbook prose). He runs the
  **ingestion tool** (`agent <ingest-subcommand>`) pointed at his folder: every doc is parsed
  into typed components (nothing silently dropped — `unmapped[]` reports the leftovers), a
  consolidated use-case vocabulary is derived, and his corpus becomes searchable. *(OBS-30:
  ingestion as a user capability, not a one-time migration)*
- **UC-A6** The 346-agent corpus itself comes home via the same tool; ≥1 shared component
  lands in ≥5 real agents; the equivalence gate compiles each migrated agent and diffs
  against its source file; `retire` refuses to touch any file whose diff FAILs. *(the
  namesake; safety = refuse, never trust)*
- **UC-A7** Priya's legacy tooling still calls flat `agent_create({systemPrompt})`; it works
  identically forever. *(permanent compat shim)*

## B · Discovery & the graph+RAG value

- **UC-B1** Noa can't remember the rule's name; she describes what it *does* ("numbers must
  come from real output, not guesses") and rank 1 is `shared-grounding-rule` despite zero
  keyword overlap. *(hybrid retrieval earning its keep — sox-backed, zero retrieval code in adhd)*
- **UC-B2** Orin, mid-composition, asks "what components exist for OAuth token refresh?" and
  gets ranked summaries with the true match above three vocabulary-sharing distractors.
  *(hard-negative discipline; nDCG floor)*
- **UC-B3** Sam lists agents on a 60+ item registry; the response is capped summaries that
  never blow the host's context. *(the 464,821-char BUG-003 class, structurally impossible)*
- **UC-B4** After the corpus ingest, `component_search` runs over the REAL corpus — the
  vocabulary consolidation means "review code quality" finds the canonical reviewer
  components, not 12 near-duplicates. *(retrieval value exists only at scale — the reason
  UC-A6 precedes it)*

## C · Compilation — the task-intelligent prompt

- **UC-C1** The dispatcher (or Orin) asks the registry client: **"resolve the SP for this
  task"** — same agent, `{ticket_type:'security'}` yields the security criteria,
  `{ticket_type:'review'}` yields review criteria, empty context yields neither. What the
  caller does with the prompt is the caller's business. *(owner C2 use case, verbatim intent)*
- **UC-C2** A session starts (`agent {name, platform?, context?}`); its SP is resolved once
  and written to the session log; every subsequent turn reads the session log, **never**
  re-resolves. *(the session lifecycle per the owner's hypothesis)*
- **UC-C3 — falsifiable cache question (decides `composed_prompts`' fate):** two *different*
  sessions open the same agent with the identical context within a minute (Priya's wave of 8
  parallel units on one agent). Does anything measurably need the second resolve to be a
  cache hit rather than a recompute? **If no actor in the demo observes a difference, the
  cross-session cache has no use case and dies; if wave-scale resolve cost is visible, it
  lives.** *(to be settled by measurement in the demo, not by assertion)*
- **UC-C4** The same agent compiles for claude_code (YAML frontmatter, `Read`/`Grep` aliases)
  and claude_api (JSON, `read_file`/`grep`) from the same rows; adding a platform is a seed
  row, not code. *(platform portability)*
- **UC-C5** Op wants the artifact on disk: `agent compile <name> --platform claude_code >
  ~/.claude/agents/<name>.md` — the CLI surface of the same client call. *(compile-to-file,
  now a subcommand of the ONE agent CLI)*
- **UC-C6** An agent with neither components nor an inline prompt starts a session → a
  meaningful `COMPILE_MISSING_COMPONENTS` error at session start, not at create. *(deferred
  failure per the interface design)*

## D · Running — sessions, tasks, the task DAG

- **UC-D1** Sam receives a task packet naming a pre-authored agent: `agent({name})` →
  `task({session_id, prompt})` — two tools, three required args total. *(small-model
  steady-state; the hot path never grows)*
- **UC-D2** Orin fans out: task C `depends_on` [A, B], `on_upstream_failure:'skip'`; A's
  result arrives in C's `inputs`; a cycle is rejected at creation. *(agent-mcp's OWN task
  DAG — distinct altitude from dispatch's plan DAG, and the demo says so)*
- **UC-D3** A model emits three tool calls in one turn; they run in parallel; one errors
  (`isError:true`) without killing the batch; results key by `toolCallId`. *(parallel
  tool execution)*
- **UC-D4** A running task hits a decision only a human can make → `request_human_input` →
  status `awaiting_input` (excluded from `dispatchReady`), a durable `resumeToken` survives a
  server restart, `task_resume` delivers the answer, the task completes. *(HITL, the
  primitive — surfaced to users via UC-F4's dispatcher Q&A)*
- **UC-D5** Op watches a long task live: `task {stream:true}` → `stream_url` →
  `tool_call`/`tool_result`/`status_change`/`done` events over SSE — watching, not polling.
- **UC-D6** Priya audits delegation cost: the lead task's usage splits **`direct` vs
  `subtree`** — her bill shows the lead spent 2K itself and its delegates spent 40K. *(the
  rollup guarantee, proven against the DB)*

## E · Providers (ruling D-G)

- **UC-E1** Noa's agent carries only a model *hint*; the session inherits it; a task
  overrides it once; resolution is `task ?? session ?? agent ?? global`. *(un-welded)*
- **UC-E2** Three turns in on Anthropic, traffic shifts: `session_update` to `openai/gpt-5.2`;
  turn 4 still remembers the codename — history re-rendered across the provider boundary
  through the merged registry's tool-format layer. *(soft swap)*
- **UC-E3** A provider's key is revoked mid-shift; the session's ordered `models[]` list
  fails over; the usage ledger shows the failed attempt and the provider that finished.
- **UC-E4** One merged registry: dispatch, MCP host, and the TS client all read the same
  provider rows — the three historical schemas are gone. *(D-G(1))*

## F · Dispatching — Priya's system (the dispatch CLI + DAG, thoroughly)

- **UC-F1** Priya hands the dispatcher a plan: `validate` → `snapshot` (eligibility, waves,
  cost derivation) → `optimize` (cheapest packing into DispatchUnits by shape+tier) →
  `run` — the full derived-view journey of the retained demo, THE dispatch DAG demonstrated
  thoroughly: fan-in eligibility, completed milestones flip ineligible, causal replan rewires
  `depends_on` onto injected corrections, resume reaches terminal. *(owner: "thoroughly
  demonstrate its better implementation of the dag")*
- **UC-F2** Each dispatched unit's agent gets its SP **resolved for that unit's task
  context** (UC-C1 inside the dispatch loop) — the packing optimizer and the prompt composer
  are two halves of one cost machine, visible in one run.
- **UC-F3** A wave's guard fails; the orchestrator records `failed` (not a crash), injects a
  correction milestone, and the resumed run reaches `all-complete`.
- **UC-F4** Mid-plan, the dispatcher hits a blocking question (adhd-build lineage): Priya
  sees a **Q&A prompt** ("[A]ccept suggestion / [T]ype answer / [S]kip"); under the hood the
  dispatched task sits `awaiting_input` with a resumeToken; her answer flows through
  `task_resume`; non-blocking questions surface without halting the wave. *(HITL implicitly
  via the dispatcher's Q&A — owner directive)*
- **UC-F5** Priya A/Bs dispatch strategy: packed-unit vs `--stepwise` (op-granular turns with
  `ForwardContext`); the calibration store records tokens for both; she picks per plan-shape
  with data. *(stepwise A/B)*
- **UC-F6** A capability-tiered plan: a cheap lead routes *diagnose* to a frontier model and
  *apply* to a cheap one, an execute-and-iterate guard gating each edge; subtree cost beats
  the single-frontier baseline in the ledger. *(the empirically-validated pattern as a journey)*

## G · Observing & operating (the ONE agent CLI)

- **UC-G1** Op asks "what happened in run ⟨id⟩?": `agent trace <run-id>` → the full traced
  tree — spawn decisions, tool calls, budgets, retries, per-node tokens/cost/depth. *(the
  Inspector surface, as agent-CLI subcommands)*
- **UC-G2** Op lists the live fleet (`agent agents`/`agent inspect <name>`): who exists,
  what they're bound to, what they're doing, what they may touch.
- **UC-G3** Everything Orin can do over MCP, Op can do at the terminal — authoring,
  configuring, compiling, running, ingesting, tracing — **one** agent CLI, subcommand per
  client operation. Dispatch stays its own CLI. *(two-CLI ruling; full parity per C1 —
  restriction is a future system capability, not surface amputation)*
- **UC-G4** A runaway agent burns tokens; the budget plugin (loaded **by name** via server
  env — a deployment decision) kills call 2 with a structured budget error; the session
  survives. *(the 710K-token incident, never again)*

## H · The clients as packages (three surfaces, one truth)

- **UC-H1** Dev builds an internal dashboard: `import { createAgentEngineClient } from
  '@adhd/agent-<layer>-<pkg>'` — sessions, tasks, usage, compile — no MCP server, no CLI,
  real DB. *(third-party direct usage — the demo proves the import path, package name per
  the `<group>-<layer>-<package>` standard)*
- **UC-H2** The SAME client operation appears three ways, demonstrably equivalent: Dev's
  direct call, Orin's MCP tool, Op's CLI subcommand — one client interface, three surfaces,
  same DB row as the outcome. *(the three-surface architecture, per-package)*
- **UC-H3** Dispatch's orchestrator consumes the agent client **in-process** — no mirrored
  wire types, no `[CODE] msg` string parsing; the wire runner survives for remote-only.
- **UC-H4** agent-mcp's host is routing + transport only: every tool case is a thin
  delegation to a client the host did not implement. *(the host could be rewritten in an
  afternoon; the clients couldn't — that's the point)*

---

## Explicitly not use cases (ruled out, with dates)

- Policy *enforcement* beats — O-1 (2026-07-16): on hold; C1 (07-17) notes access-restriction
  as its future use case, unscheduled.
- A/B `EXPERIMENT` framework — GOAL's own "illustration, not design" disclaimer.
- Domain 4 playbooks/runbooks — no owner recognition (OBS-30); ingestion intent absorbed
  into UC-A5; the rest awaits explanation.
- Workspace governance — delegated out of the agent system entirely (target package still
  nonexistent; needs its own disposition, elsewhere).

## Open use-case questions (falsifiable, owner-visible)

1. **UC-C3** — does the cross-session compile cache have a real consumer? Measured in-demo.
2. **UC-F4** — does the dispatcher's Q&A need the `send_message` multi-target design
   (agents-full-workflow, 06-29) or is `request_human_input`+`task_resume` sufficient? The
   demo starts with the shipped primitive; multi-target messaging gets a use case only if a
   beat can't be written without it.
3. Sequencing: identity migration (C3, name-everywhere) **before** corpus ingest (UC-A6)
   before retrieval-at-scale (UC-B4) — order is load-bearing.
