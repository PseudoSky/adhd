# Code-Tasking Study

**Question:** can a local LLM produce production-quality bug fixes when the work is
*offloaded* to it via `agent-mcp` — and how must the task be designed to make that work?

This folder is the full, replayable record of that investigation: the coding
**scenarios** (with ground-truth solutions and grading rubrics), a chronological
**LOG** of every test (hypothesis → result → gap), and the **actual MCP request
bodies** for every step.

---

## Environment

| | |
|---|---|
| Local model | `qwen2.5-14b-instruct` (LM Studio, OpenAI-compatible) |
| Provider config | `{ "type": "lmstudio", "model": "qwen2.5-14b-instruct", "timeoutMs": 180000 }` |
| MCP server | `agent-mcp-published` = `npx -y @adhd/agent-mcp@latest` (v1.0.1) |
| DB | `agents-published.db` (isolated from the dev DB) |
| Distributor | The strong session model acted as the DAG root, fanning tasks to local workers. Tasks are **ephemeral** (`agent_name` mode) unless a multi-turn session was needed. |
| Grader | Manual inspection against each scenario's rubric (see caveats). |

The subjects are **real** bugs/changes from earlier in the same engineering session,
so we have a verified ground-truth fix for each (see `scenarios/`).

### Controls / threats to validity

- **Tool-less by construction.** Every worker — local *and* Anthropic — was created
  with `mcpServers: {}` and `permissions: {}`, so it had **no filesystem, web, or
  repo access and no agent-mcp recursion** (Test 14's `lead` is the sole exception:
  it had `mcpServers:{agent-mcp}` to dispatch sub-agents, which also have no tools).
  Confirmed empirically: every graded run reports `modelCalls: 1, toolCallCount: 0,
  stopReason: "stop"` — a single completion with no tool calls. **No model could
  read the actual source or the shipped fix; all reasoning is from the inlined
  prompt.** The Anthropic differential (Experiment 6) is therefore apples-to-apples:
  identical system + user prompt, only the provider swapped. The capable model's
  edge is latent training knowledge, not repo access.
- **n=1, non-deterministic, manual grading** — see Caveats below.

---

## Layout

```
code-tasking/
  README.md                      ← this file
  LOG.md                         ← chronological test log (hypothesis/result/gap per test)
  scenarios/
    sse-eaddrinuse.md            ← BUG-001: SSE server crashes the process on EADDRINUSE
    fk-cascade-migration.md      ← migration 0005 cascade-wipes task_events (the hard one)
    audit-ref-policy-comment.md  ← a grep-based audit fooled by a comment
  tests/
    test-<n>/mcp.jsonl           ← the exact MCP request bodies for that test, in order
    test-<n>/mcp.anthropic.jsonl ← (Experiment 6 tests) the same prompt, anthropic worker
  results/                       ← authoritative server-side capture (responses + usage)
    runs.jsonl                   ← every task: prompt + full raw result + usage telemetry
    usage.json                   ← the task_usage table (tokens, tool_call_count, latency)
    INDEX.md                     ← chronological run table
```

`tests/` holds the **requests**; `results/` holds the **responses + usage**, dumped
verbatim from the published server's DB (the ephemeral-observability persistence).
Join them on the `prompt` text. The telemetry is what substantiates the
"tool-less by construction" control above (`tool_call_count = 0` for every worker
run). See [`results/README.md`](results/README.md).

- A **scenario** = the coding task, the raw correct solution, and the success rubric. Provider-/prompt-independent.
- A **test** = one way a scenario was posed to the local model (which context/levers were supplied) + the observed result. Tests cite a scenario and are graded by its rubric.
- `tests/test-<n>/mcp.jsonl` = one JSON object per line, each the literal request body sent to an `agent-mcp` tool, in execution order. Some tests reuse an agent created in an earlier test (noted in `LOG.md`); the jsonl records only the calls that test actually made.

---

## Scenarios

Two tiers. **Floor** = simple, additive, single-locus changes (mostly feature work)
— what the model *should* handle; they establish the competence floor and a control
for the harder set. **Discriminators** = subtle diagnosis / cross-layer fixes that
separate "produces plausible output" from "produces correct output."

### Floor (simple — feature/additive, no extended debugging)

| slug | task | what it probes |
|---|---|---|
| [`tasklist-ephemeral-filter`](scenarios/tasklist-ephemeral-filter.md) | add an optional `is_ephemeral` filter to the task-list tool + query | additive feature; `!== undefined` + boolean→0/1 |
| [`sse-port-param`](scenarios/sse-port-param.md) | add an optional, defaulted `port` parameter to `startSseServer` | optional param that preserves existing callers |
| [`task-status-enum-extend`](scenarios/task-status-enum-extend.md) | add `waiting` + `awaiting_input` to the status enum in **both** schema + Zod | find & update *all* declaration sites consistently |
| [`export-sqlite-type-annotation`](scenarios/export-sqlite-type-annotation.md) | export a `const` that triggers TS4023; make the build pass | knows the TS4023 "cannot be named" → explicit type annotation |

### Discriminators (hard — subtle diagnosis / cross-layer)

| slug | bug | why it's hard |
|---|---|---|
| [`audit-ref-policy-comment`](scenarios/audit-ref-policy-comment.md) | a `policy.check before Promise.all` audit greps the first `Promise.all` line — which is a *comment* | careful reasoning about a self-contained script |
| [`sse-eaddrinuse`](scenarios/sse-eaddrinuse.md) | SSE server's unhandled `'error'` event crashes the whole process when the port is taken | requires knowing `'error'` is an **async emitter event**, not a thrown exception |
| [`fk-cascade-migration`](scenarios/fk-cascade-migration.md) | migration 0005's table-rebuild cascade-wipes `task_events` despite an in-SQL `PRAGMA foreign_keys=OFF` | requires knowing `PRAGMA foreign_keys` is a **no-op inside a transaction** *and* that the fix lives in a different file (connection setup), not the SQL |

> Candidate scenarios not yet written up (proposed, from this session): `cancel-signal-threading`
> (mechanical multi-file), `no-bug-control` (false-positive control), `oauth-identity-system-block` /
> `vite-emptyoutdir-stale-version` / `nx-worktree-project-conflict` (niche discriminators),
> `cancel-reason-not-persisted` / `hitl-tool-unreachable` (cross-component), `toolcallcount-off-by-one`
> (small), `better-sqlite3-teardown-segfault` (multi-cause).

---

## Headline findings

1. **Full code context is necessary but not sufficient.** Given the real code + symptom but no diagnosis, the 14B failed all three subjects (Tests 6–8) — it confabulates a plausible-but-wrong cause and "fixes" that.
2. **The earlier "wins" were carried by hints, not reasoning.** `audit-ref-policy` flipped success→failure on a single pointer sentence (Test 4 vs Test 8).
3. **The wall is *synthesis*, not retrieval.** Given the exact facts among distractors (Test 10), it *selected* the right ones but couldn't compose them into the cross-layer fix — and hallucinated an API to fill the gap.
4. **Role priming + reasoning scaffolds improve *process and calibration*, not correctness** (Tests 9–11); a fact embedded in the role didn't even override the model's default (`try/catch` on SSE).
5. **No orchestration topology rescues a missing fact** (Tests 12–14): multi-turn, adversarial-architect, and orchestrator-dispatch each refined the *wrong* answer; broken fixes were rated **High** confidence.
6. **Two positives:** the offload *topology* works (a 14B `lead` reliably dispatched synth→coder→compose, Test 14), and the only reliable success was **spelling out the fix layer + handing the exact API** (Test 5) — i.e., offload *application*, not *diagnosis*.
7. **The failures are model-bound, not prompt-bound** (Experiment 6). Re-running the *exact* failing prompts on `claude-sonnet-4-6` — same system + user prompt, only the provider swapped — passed **5/5** (incl. the underspecified FK and the TS4023 gotcha; twice cleaner than the human-shipped fix). The same context that left the 14B confabulating was sufficient for a capable model.
8. **The floor (Tests 15–17) is real but knowledge-bounded:** pure additive/mechanical edits pass reliably; a *one-line* change with a specialized detail (Test 18, TS4023) fails the same way as the hard set.

### Recipe that actually works
> **Cognition at the root, application at the leaves, verification on every edge.**
> Diagnosis + fix-shape + exact target locus + **grounded API signatures** come from a capable model; the local model applies/orchestrates; an **execute-and-iterate test loop** gates everything (self-reported confidence is unreliable — broken fixes were rated High).

---

## Caveats

- **One model, n=1 per test, non-deterministic.** Treat the *pattern* across the ~14 runs as the signal, not any single transcript (e.g. SSE landed the right mechanism in Test 1 but not Test 7).
- **Manual grading.** No fix was executed against a build/test in-loop; grading is by inspection against the rubric. Closing that loop is itself finding #6.
- **Untested high-value variables:** a reasoning-tuned / larger local model as the synthesizer, and a real execution loop on the leaf.

## Replaying

Each `tests/test-<n>/mcp.jsonl` line is a literal `agent-mcp` request body. Replay against an `agent-mcp` ≥ 1.0.1 server with an LM Studio (or any) provider configured; mind cross-test agent reuse noted in `LOG.md`. Outputs are non-deterministic; the LOG records what was observed.
