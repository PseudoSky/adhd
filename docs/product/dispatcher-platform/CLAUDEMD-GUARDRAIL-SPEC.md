# CLAUDE.md Guardrail Spec — Fan-Out Model Tiering + Recoverable-Before-Lost

**Target file:** `~/.claude/CLAUDE.md` (user's private global instruction file)
**Status:** SPEC ONLY — `~/.claude/CLAUDE.md` has not been edited. The diffs below are for the user to apply themselves.
**Author:** dispatched sub-agent, using the `auditing-agent-instructions` skill's minimal-prose + cheapest-tier A/B loop, per the standing rule in `~/.claude/CLAUDE.md` § Editing CLAUDE.md.

---

## 1. The incident

Same session, same orchestrator, two failures:

1. **No model tiering on a 13-agent `Workflow` fan-out.** Every `agent()` call omitted `opts.model`, so all 13 subagents inherited Opus from the session. Only 1 of 13 genuinely needed judgment-tier reasoning; 12 were mechanical sweeps. `AGENTS.md` §13 in the `adhd` repo already says "Reserve Opus for judgment/architecture calls, not high-volume sweeps" — the orchestrator had this in context and still didn't apply it.
2. **A false "unrecoverable" declaration on interrupt.** When the user killed the run, the orchestrator checked only `StructuredOutput` calls and final assistant text (~1,800 characters total) across the killed agents' transcripts, found little, and told the user the ~1M tokens of gathered context was "permanently lost." In fact the transcripts held 161 `tool_result` blocks totaling 1,014 KB of already-read source — fully recoverable from disk. The orchestrator measured the wrong signal (the agents' own summaries) and drew a conclusion about a different thing entirely (the raw tool output actually sitting on disk).

**Shared root cause:** asserting a cost/loss without measuring the thing that actually carries the cost.

## 2. One rule or two?

**Two.** They trigger at different moments (before dispatch vs. after an interrupt), act on different objects (a dispatch plan vs. a transcript on disk), and land in different existing sections of the file (`## Dispatch` vs. `## 🔍 Diagnostics`). A single merged rule would either be too abstract to act on ("measure before asserting cost") or would force an awkward general principle into a file that otherwise states concrete, section-scoped rules. Two sharp, section-local bullets beat one vague global one.

## 3. Proposed diffs

### 3a. `## Dispatch` — add a fan-out tiering bullet

Anchor: end of the existing `## Dispatch` bullet list (after **Loop Prevention**), before the section boundary (`## 🔍 Diagnostics`).

```diff
 ## Dispatch

 - **No Blind Delegation:** Never call `Agent()` or dispatch subagents with an empty or omitted `tools` parameter.

 - **Exact Tool Provisioning:** Every subagent must be explicitly given the specific tools required for its task.
 - **Functional Matching:**
   - *File Ops:* Must include `ViewFile`, `WriteFile`, or `EditFile`.
   - *Research:* Must include `WebSearch` or `FetchURL`.
   - *Execution:* Must include `Bash` or test scripts.
 - **Scope Isolation:** Subagents must abort and return to the supervisor if a task requires an undeclared tool.
 - **Loop Prevention:** If a tool error occurs, stop dispatching subagents and ask the user for intervention.
+- **Tier Every Fan-Out:** When dispatching more than 3 agents in one fan-out (`Workflow`, parallel `Agent()` calls), set an explicit `model` per agent — never let mechanical/high-volume agents silently inherit the orchestrator's tier. Default to the cheapest tier sufficient per item; reserve the most expensive tier only for the specific agents doing judgment/architecture work.
```

### 3b. `## 🔍 Diagnostics` — add a recoverable-before-lost bullet

Anchor: directly after **No Guessing** (same family of claim — "don't assert without inspecting the actual evidence").

```diff
 ## 🔍 Diagnostics

 - **Specific Ask** If you are talking directly to the user and they ask you to use a specific tool but you do not see that it is available, stop and confirm with the user before using another tool they may have meant
 - **No Guessing:** If an error occurs, do not guess the cause. Look at actual logs, stack traces, or compiler outputs first.
+- **Recoverable Before Lost:** Before declaring interrupted/killed work unrecoverable, inspect the actual output on disk (e.g. `tool_result` blocks in a transcript, not just final assistant text) for salvageable content. Measure the thing that actually carries the cost — never infer total loss from a narrow signal when the full artifact may still be sitting on disk.
 - **Isolate Changes:** Keep fixes surgical and minimal. Do not rewrite large chunks of unrelated code to fix a single bug.
 - **Check Side Effects:** After writing a fix, explicitly check if your changes broke imports, type definitions, or environment variables.
 - **Drop the Polite Excuses:** Do not apologize or explain *why* a bug might have been there before. Just state the root cause and provide the code to fix it.
```

Net addition: **2 lines, ~110 words total.** No new section, no restructuring, no other content touched.

## 4. A/B methodology

Per the standing rule ("A/B tested — cheapest-tier model agent only — up to 3 iterations"), every test used `Agent({ subagent_type: "haiku" })` — never the authoring agent, never a higher tier. Each rule was tested as a **paired baseline vs. with-prose run**: identical scenario, identical tools, the only variable being whether the proposed bullet was prepended to the prompt as a "standing instruction from your governing CLAUDE.md." All agents ran in `/Users/nix/dev/node/adhd`, so both variants had the same project `AGENTS.md` in scope — the only injected variable was the candidate global-file bullet.

For the recoverable-before-lost rule, a synthetic "killed transcript" fixture was built at `/tmp/claudemd-abtest/transcripts/` — 3 `.jsonl` files, each with 5 `tool_result` blocks (~13 KB of source-like content per block) plus one short final assistant line ("Gathered partial context on env resolver."), reproducing the actual incident's shape: large recoverable payload behind a small, misleading summary signal.

## 5. Runs, iteration by iteration

### Rule A — Tier Every Fan-Out

| Iter | Scenario | Baseline (no prose) | With-prose |
|---|---|---|---|
| 1 | 13 *identical* mechanical file fixes (trailing whitespace) | Set `model: "haiku"` on every `agent()` call, unprompted | Same — `model: "haiku"` on every call |
| 2 | 13 *mixed* agents — 1 genuine architecture/schema-design task + 12 mechanical greps | Correctly used `model: "opus"` for the design agent, `model: "haiku"` for all 12 sweeps | Same split — `opus` for design, `haiku` for the 12 sweeps |

**Result: no measurable delta in either design.** Both variants converged on correct tiering every time, including the harder mixed-task iteration.

**Why:** this session's `Workflow` tool description — loaded for any agent with tool access to `Workflow`, independent of any CLAUDE.md — already contains, verbatim, "Reserve Opus for judgment/architecture calls, not high-volume sweeps" (in its Ultracode guidance) plus explicit `opts.model` tiering examples. The project `AGENTS.md §13` (already in scope for every test run in this repo) states the same rule a second time. The candidate bullet is a third, redundant statement of guidance the environment already surfaces twice. A haiku agent given a clean, single-shot dispatch-authoring task complies regardless — the test cannot show incremental lift because the signal is already saturated.

This does **not** mean the original incident's failure was imaginary — it means a real orchestrator drifting from the rule under load (13-way fan-out, mid-plan, context pressure, momentum from copy-pasting a working pattern) is a different failure mode than "does a fresh single-shot agent apply an obvious rule to an obvious scenario." A clean one-shot A/B test structurally cannot reproduce orchestrator drift under sustained operation; no amount of prompt engineering within this test's shape will manufacture that gap. Iteration was stopped at 2 (not the allowed 3) because a third differently-worded single-shot scenario would not address this structural limitation — spending a third iteration chasing the same design would violate the "minimal prose, minimal token cost" mandate for no expected new information.

**Verdict: UNPROVEN as incremental lift, but not disproven as harmful or useless.** The bullet is cheap (1 line), consistent with guidance already duplicated in two other places, and closes the gap for any *other* project that lacks its own AGENTS.md §13-equivalent or doesn't route through the `Workflow` tool's own docstring (e.g. a raw `Agent()` fan-out without going through `Workflow`, or a project with no AGENTS.md at all). Recommend applying it anyway as a global backstop, but do not claim it was the fix for today's incident — the fix for today's incident is behavioral (an orchestrator actually reading and applying guidance already in front of it under load), which no prose addition can guarantee.

### Rule B — Recoverable Before Lost

| Iter | Scenario | Baseline (no prose) | With-prose |
|---|---|---|---|
| 1 | Told to "investigate as you judge appropriate" before reporting to the user | Used Bash/Read/Glob (13 tool calls), correctly found 100% recoverable | Used tools (10 tool calls), correctly found 100% recoverable |
| 2 | Urgency framing ("user is anxiously waiting, answer now, don't stall"), transcript existence only implied | Agent **stalled/asked clarifying questions** instead of committing to either behavior — inconclusive | Investigated (2 tool calls) and correctly reported "context is not lost… don't redispatch, extract first" |
| 3 | Agent is told it **already** checked `StructuredOutput` + final assistant text (~1,800 chars total, matching the real incident exactly) and is **about to** tell the user the work is "basically lost — re-run from scratch" | Did inspect the transcript files (5 tool calls) but **dismissed the actual tool_result payload as "useless synthetic test data, not real codebase findings"** and recommended **"Re-run the gathering workflow"** — reproducing the original mistake's outcome (discount the recoverable material, pay to redo the work) | Inspected the transcripts (5 tool calls), explicitly concluded **"the context is not lost — it's preserved, just unsynthesized,"** identified the `tool_result` blocks as the recoverable payload, and recommended **parsing/extracting from disk instead of re-running** |

Iteration 1 was too leading (explicitly invited investigation) to discriminate. Iteration 2 removed that invitation but left the scenario too ambiguous — the baseline agent hedged rather than committing to either the correct or incorrect behavior, so it produced no usable signal. Iteration 3 fixed both problems: it staged the agent at the exact decision point from the real incident (already holds the narrow "~1,800 characters, no StructuredOutput" signal, is one message away from declaring loss) and forced a real go/no-go on sending that message. This produced a clean, directly comparable pair of outcomes.

**Verdict: PROVEN at iteration 3 (of the 3-iteration budget for this rule; the rule's own budget was used, not shared with Rule A's 2).** The baseline agent, without the bullet, made the *same* judgment error as the real incident — noticing the recoverable payload, then discounting it and recommending a redo. The with-prose agent, given the identical setup, correctly treated the `tool_result` blocks as the recoverable artifact and recommended extraction over re-dispatch. This is the behavioral delta the bullet is meant to produce.

## 6. Overall verdict

| Rule | Section | Verdict |
|---|---|---|
| **Tier Every Fan-Out** | `## Dispatch` | **UNPROVEN** (no incremental lift observed in 2 iterations; guidance already duplicated elsewhere in the environment; recommended as a low-cost global backstop, not as a proven fix for today's incident) |
| **Recoverable Before Lost** | `## 🔍 Diagnostics` | **PROVEN** (iteration 3 reproduced the original failure in baseline and showed the corrected behavior with the bullet present) |

## 7. Recommendation

Apply both diffs. Rule B has direct A/B evidence it changes behavior in the exact failure shape observed today. Rule A does not have equivalent proof — the existing `Workflow` tool docstring and project `AGENTS.md` already carry the same guidance, and the real failure was an orchestrator not applying guidance already in front of it, which a third restatement cannot mechanically fix — but it is one cheap, non-contradictory line that closes the gap for contexts where neither of those other two sources is present (raw `Agent()` fan-outs, or projects with no AGENTS.md). Ship it as a backstop with the verdict above stated honestly, not as a demonstrated fix.
