# Dispatcher as Primary Interface — Vision, Ground Truth, and Path

**Status:** ANALYSIS. Not a plan. Does not re-decide anything ratified in
[`docs/plan/agent-final/GOAL.md`](../../plan/agent-final/GOAL.md).
**Written:** 2026-08-12 · **Revised:** 2026-08-17 (sox parity; work-graph store; autonomy
as substrate). **Supersedes:** `GAP-MATRIX.md` in this directory — delete it rather than
reconcile.

---

## 1. The goal

Verbatim, from the owner:

> "I want to start using dispatcher package for everything & agent mcp underneath to
> eliminate my need for opencode, claude cli etc."

> "My target is that its a fully functional claude/opencode interactive cli backed by an
> intelligent agent swarm underneath operating cross provider optimized through
> dispatcher planning & agent mcp runtime."

> "Part of my goal is to get it on par with [sox]" — a fully-automatic workflow system the
> owner built and runs successfully.

Three clarifications the owner has stated, each correcting an earlier misreading:

- **Work intake is not the crux of the interactive goal.** HITL, questions, chat
  injection, status reporting exist to give the platform a usable face. But intake *is*
  the crux of the autonomy goal — see §5.4.
- **The interactive lane is scoped separately on purpose**, to keep it from muddying the
  programmatic implementation. Separate ≠ out of scope.
- **Autonomy is the substrate, not a branch.** sox has no interactive surface at all and
  works; the CLI is one consumer of a running system, not the thing it is built around.

## 2. What this document is

A bridge between three things that do not currently talk to each other: the ratified
rulings in `agent-final/GOAL.md`, the ~496 open backlog items, and
[`docs/dispatcher/FEATURE_COMPARISON_SOX.md`](../../dispatcher/FEATURE_COMPARISON_SOX.md)
— a 41-feature, 15-system-finding comparison against sox.

**It is not a plan.** It authors no `dag.json`, claims no states, reopens no ruling.

### Evidence standard

The plan corpus is not reliable. In a nine-item sample of open backlog entries, **nine
described code that had since changed.** `agent-final/README.md:19-21` governs here too:

> "a plan document is not evidence… Verify against code, or ask."

Claims marked ✔ were verified against source or by running something, in the sessions that
produced this document. Unmarked claims are second-hand and should be re-verified before
anyone builds on them.

**That warning is not boilerplate.** A spot-check of three second-hand claims carried into
an early draft of this document found one materially wrong: `agent-core-provider` was
described as having "zero runtime consumers" when it has 34 references including live
imports in the orchestrator and compiler, and the tool-format emission path was described
as "unwired" when it is called in two places and merely reads an unseeded table. Both
errors originated in a 2026-07-16 architecture note that was accurate when written. **Age
is the failure mode here, not carelessness** — and it applies to this document from the day
it was written.

All `file:line` citations below were checked mechanically for resolution and line-range
validity (38 of 38 ✔). That proves the citation points somewhere real; it does not prove
the cited line still says what the claim says. Only a ✔ means that.

### Absence claims require a higher bar than presence claims

"X is used" needs one call site. **"X is not used" needs proof that no call site can
exist** — and three distinct false negatives were made and corrected while writing this
document. Each is a technique that is valid for a different question than the one asked:

| Trap | Why it fails | Correct test |
|---|---|---|
| **Counting static imports** of a runtime-loaded plugin | Plugins load *by name*, so zero importers is the designed state (`agent-dispatch-systems.md` §2-D: *"Counting host imports is the wrong test"*) | Read the deployment config |
| **Grepping this repo** for consumers of a **published** package | `@adhd/backlog`'s exports and MCP tools have consumers outside this tree; the `.d.ts` in a build artifact *is* the public surface | Treat in-repo absence as scope-limited, and say so |
| **Trusting a catalog's failure-mode label** | A classification is an opinion about code, not the code. `renewClaimNode` is labelled an invariant violation and is specified behaviour (`claim.ts:87`) | Open the function and look for a spec citation |

Every absence claim in this document is either marked ✔ (source read) or should be read as
*"not found by the stated method,"* not as *"does not exist."*

---

## 3. Ground truth

### 3.1 Built and working

| Capability | Evidence |
|---|---|
| Deterministic prompt composition — versioned components, junction-ordered composition, context rules, SHA-256 cache | `agent-store-prompts/src/store/` — 4 stores, no stubs |
| Agent compilation to runtime manifests | `agent-engine-compiler`, v2.1.2 |
| HITL suspend/resume with durable `resumeToken` | `orchestrator.ts:504-545` ✔ |
| SSE task streaming | `entrypoint/agent-mcp/src/streaming/sse-server.ts` |
| OpenAI-compatible chat gateway | `chat-gateway.ts`; auto-resumes `awaiting_input` by treating the next chat message as the user input ✔ (`:307-324`). A second *surface* for HITL, **not an independent channel** — it wraps `taskResume` and filters by `session_id`, so it carries the same session precondition |
| Per-unit provider dispatch, including non-Claude providers | `orchestrator.ts:707-711` ✔ + `agent-runner.ts:231-278` ✔ |
| Multi-writer claim lease — `BEGIN IMMEDIATE` CAS, `DEFAULT_STALE_AFTER_MIN = 30` ✔, `agentName:instanceId` identity | `claim.ts:28` ✔. Race-proven by `claim.spec.ts` ✔ — real `worker_threads`, each with its **own** turso connection to the same on-disk file, through the built `dist/`; `concurrency-scale.spec.ts` scales it to N workers released by a `SharedArrayBuffer` barrier. **Threads, not processes** — see the F1 caveat in §5.6 |
| Dependency representation — `DEPENDS_ON`, `blockers()`, `dependencyGraph`, Kahn `topoOrder` | backlog-C5 |
| Dispatch execution cluster — orchestration cycle, state-derived eligibility, terminal conditions, bounded polling, context-window packing, cost accounting, guard verification, correction injection, dry-run default | F23–F40, the strongest column in the comparison |
| Budget enforcement — caps by task/session/agent/global, cache-class-aware, **deployed and enforcing** | `agent-plugin-budget`, loaded via `~/.adhd/agent-mcp/config.json` ✔ — live caps include `context ≤128k` (block), `cost ≤$0.30` per task (block), `inputTokens ≤500k`/24h global (warning) |

### 3.2 Built but unreachable, unwired, or off

| Thing | Reality | Evidence |
|---|---|---|
| **Tools for dispatched agents** | `ensureAgent` hardcodes `mcpServers: {}`; `DispatchUnit.mcp_servers` written `null` by the optimizer, read by nothing. Dead both ends. | `agent-runner.ts:396` ✔, `optimize.ts:464` |
| **The multi-cycle loop** | `orchestrate()` with `DEFAULT_MAX_CYCLES=500` is exported and has **zero production callers** ✔ — `run` executes exactly one cycle. This is the DEMO.md climax (⟦U7⟧). | S3 |
| **HITL from dispatch** | Hard-throws for ephemeral tasks; every dispatch task is ephemeral. | `orchestrator.ts:505-510` ✔ |
| **Chat / streaming from dispatch** | Both key on a session; `fire()` sends `{agent_name, prompt}` only. | `agent-runner.ts:400-411` ✔ |
| **Provider *resolution*** | The provider/model/**binding** registry is unconsumed for choosing a provider — resolution is a `switch` over 3 literals. **Not the whole package:** `estimateCostUsd` is imported live by the orchestrator's usage path, and `ToolFormatStore`/`emitToolsForProvider` by the compiler ✔ | `usage.ts:15`, `usage-plugin.ts:5`, `compile.ts:39` |
| **Tool-format emission** | **Wired, not unwired** — `emitToolsForProvider` is called at `compile.ts:243` and `:344` ✔. But the seed set is `bindings/models/providers` with **no tool-format seed** ✔, so the live code path reads an empty table. Inert for lack of data, not for lack of wiring. | `agent-core-provider/src/seed/` |
| **Tool grants** | `toResolveResult` returns `{ content, id }` only — everything else on the composed prompt, `compiled.tools` included, is dropped ✔ | `prompt-resolver.ts:46-48` |
| **Prompt caching** | `cache_control`: **zero occurrences** repo-wide ✔ | — |
| *(no row — see the correction note below)* | | |

> **Correction, and a methodology warning.** An earlier draft listed the budget plugin here
> as "opt-in, zero production imports, therefore off." **That was wrong** — it is loaded and
> enforcing via `~/.adhd/agent-mcp/config.json` ✔. The error is instructive: plugins load
> **by name at runtime**, so they have zero static importers *by design*
> (`agent-dispatch-systems.md` §2-D says so explicitly — *"Counting host imports is the
> wrong test"*). Import-counting is a valid technique that answers a different question than
> the one being asked. **For anything runtime-loaded, check the deployment config, not the
> call graph.** The same caution applies to every other plugin-shaped capability assessed in
> this document or in the sox comparison.
| **`assignee`** | Recorded, consumed by no enforcement path — no claim matching, no WIP gate, no `startWork` gate, no `readyItems` partition. | `structure.ts:244-255` |
| **`importance` column** | Write-only; `spotlight` sorts by `PRIORITY_RANK`. Source of a non-atomic dual-write. | SL2-04/05 |

### 3.3 The sox parity gap — supervision, not features

The superset covers **39 of 41 features**. Parity is not a feature checklist problem. What
sox has and adhd has *no equivalent of*:

| | sox | adhd |
|---|---|---|
| Persistent supervisor | daemon, respawn, crash-state persistence, boot reconstruct | one-shot poll |
| Self-healing | 7 healers at distinct cadences and authorities (S10) | none |
| Stuck-work backstop | `excessive_rework`, `stuck_in_review` (2h), `stuck_blocked` (6h) → janitor reopen/reassign/quarantine (S11) | correction loop has no reachable cap |
| Crash-loop breaker | poison-pill isolation, backoff 30/60/120/300s (S13) | none |
| Startup recovery | kills stale PIDs, re-releases tickets, boot-drift auto-fix (S14) | none |
| Spawn model | WIP → process count, demand-based saturation (S12) | none |
| Replay | event log authoritative; `reconstruct --verify` with drift exit 0/1 (S2) | audit nodes gate nothing; no replay |
| Write serialization | sentinel lockfiles + single daemon (S1) | `dag.json` atomic rename, **fixed temp name, no lock** — concurrent cycles clobber, last-writer-wins |
| **Worktree isolation** | runtime-**enforced** (F13) | dispatch touches it as a non-enforced consumer convention. **Superset GAP.** |
| **Install snapshots & restore** | whole-`.cto` tree, committable, diffable, restorable with forensics (F14) | single-file `VACUUM INTO` DB copies. **Superset GAP.** |
| **Connection liveness** | supervisor respawns and re-adopts | `AgentMcpRunner` memoizes the client once and **never reconnects** — a dead stdio subprocess poisons the whole cycle (S6) |

The last three are the ones most easily missed, because two are the comparison's only
outright superset gaps and the third reads as a minor robustness note. Under autonomy they
are load-bearing: **worktree isolation is the precondition for running plans in parallel
against one repo at all**, and a memoized dead client turns a long-running daemon into a
process that fails silently and stays up.

### 3.4 Not built

- **Interactive surface.** No REPL, no `--follow`, no streaming renderer. `dispatch-cli`
  registers seven non-interactive commands; `run` fires one scheduling cycle.
- **Dynamic provider selection** — deferred by D-G(4).
- **Session-held provider binding and soft swap** — D-G(2)/(3).
- **Retrieval / semantic discovery** — owned by sox per D-A.
- **Sentinel-Fanout** — `sentinel_role` is a schema field with no algorithm.
- **Multi-recipient agent messaging** — `docs/ideas/agent-interrupts.md`, zero code.

---

## 4. The rulings that govern this

| Ruling | Effect |
|---|---|
| **D-A** — sox owns all RAG/embedding/vector work | Discovery is not adhd's to build. |
| **D-B** — **sox's own plans/backlog are authoritative for sox's design**; adhd docs *guessing* at sox internals have been *"wrong 3-for-4"* | Governs adhd docs that infer sox behaviour without checking. Does **not** apply to `FEATURE_COMPARISON_SOX.md`, which was produced by two-sided verification — see below. |
| **D-C** — `agents` + `AgentStore` fold into `agent-store-runtime` | Kills the re-droppable session FK structurally. |
| **D-D** — **dispatch uses the agent client, never rewrites it** | `agent-runner.ts`'s mirrored types "get deleted in a seam plan." Load-bearing for everything below. |
| **D-E** — `adhd-build` is the dispatch lineage; *"harvest, don't reinvent."* The **goal→questions→milestones authoring half lives in sox's `workflow:plan-builder`, not here** | A scope boundary: adhd stores and executes plans; it does not author them. Constrains capability 1 and §5.7 — see below. |
| **D-F** — fix things, don't file debt | — |
| **D-G(1)** — merge the three provider representations | "Retired, not mapped." |
| **D-G(2)** — binding is an inheritance chain; **session holds live provider/model** | Requires sessions. |
| **D-G(3)** — soft swap via `emitTool()`/`provider_tool_formats` | Smaller than the corpus implies: the emission path is already wired into the compiler ✔; what is missing is seed data for `provider_tool_formats`. A seeding job, not a wiring job. |
| **D-G(4)** — ordered `models[]` fallback only, **no price/latency sort this pass** | Conflicts with "optimized" as stated — §8. |
| **O-1** — policy enforcement unratified; *"do not build toward it"* | Do not make `core-policy` load-bearing. |
| **O-3** — the dispatch demo is retained as acceptance | `dispatch-completion/demo/DEMO.md` and its 15 ⟦U#⟧ ledger. |


**Two rulings were omitted from an earlier draft of this table, and both change something.**

**D-B does not discount the sox comparison, and an earlier draft of this document wrongly
claimed it did.** The ruling governs adhd documents that *guess* at sox internals.
`FEATURE_COMPARISON_SOX.md` is not that: its method is two-sided exploratory verification
with sox-side reports and recorded correction episodes. **Its sox-side claims are confirmed
correct by the owner of sox**, who commissioned it — which is the authoritative source, and
outranks any inference drawn from a ruling about different artifacts.

The draft's supporting evidence was also misapplied. The one classification found wrong
(`renewClaimNode`, §5.6 ✔) is an **adhd-side** claim about `backlog`'s `claim.ts`. Using an
adhd-side error to cast doubt on sox-side claims conflates two independent halves of the
document. Where this document says "sox does X," treat it as established.

**D-E draws a scope boundary this document was missing.** Plan *authoring* — the
goal→questions→milestones pipeline — is ruled to live in sox, not here. So adhd **stores and
executes plans it does not author**. That refines capability 1 (§4 of `GOAL.md`): the value
is durable, inspectable, re-runnable plans, not a plan-authoring surface. It also sharpens
§5.7 — if the plan definition stays a file, that file is an *input produced upstream*, which
strengthens the case for keeping it a file rather than absorbing it into a store, since the
producer is a separate system.

`GOAL.md`'s end-state already contains the interactive goal (item 8: same agent, two
providers, mid-session swap, failover visible in the usage ledger) and item 5 (dispatch a
plan wave through the same client — no mirrored types). It does **not** contain the
autonomy goal; that arrives from sox parity.

---

## 5. Analysis

### 5.1 One change unlocks four things

Dispatch fires **ephemeral, session-less, synchronous** tasks. Four capabilities are
blocked by that single fact — three of them already shipped:

```
                      ┌─ HITL              (ephemeral hard-throw)
  session-based ──────┼─ chat injection    (gateway keys on agent#sessionId)
  dispatch            ├─ SSE streaming     (needs a durable task row)
                      └─ D-G(2) provider   (the session IS where provider lives)
```

They are not missing features; they are unreachable ones. Caveat worth checking before
scoping — and the answer is no. An earlier draft speculated that the chat gateway's
auto-resume might route around the ephemeral-task blocker and shrink F2. It does not:
`chat-gateway.ts:307` filters `awaiting_input` tasks **by `session_id`** and then calls
`taskResume` ✔. It is a second surface on the same mechanism with the same precondition, so
it needs a session exactly as `task_resume` does. **F2 is not reduced by it.**

### 5.2 The capability floor comes first

An interactive CLI whose agents cannot read a file, edit a file, or run a command is a
chat window. Every dispatch-created agent gets `mcpServers: {}` unconditionally.

The comment at `agent-runner.ts:388-391` records this as a deliberate scope-cut —
"claudecli agents need no MCP servers" — which was true when dispatch only fired claudecli
and stopped being true when provider dispatch started working.

**Nothing else on this list matters until a dispatched agent can act.**

### 5.3 "Intelligent swarm" is composition, and it is real but decorative

The composition stack is built, tested, and shipped. Its *output* is discarded at the
runtime boundary: `compiled.tools` thrown away, provider registry unconsumed, policy
rendered as prose. Making the swarm intelligent means **consuming the layer that already
exists** — D-G(1) for provider, the tool-grant path for tools, and explicitly *not* policy
per O-1.

### 5.4 The loop does not close in code

`@adhd/backlog` imports outside backlog itself: **zero** ✔. The work-order → dispatch →
agent → verify loop closes only at `dag.json`; the "→ backlog update" leg is 100% human
convention. sox's role queues are read programmatically by its supervisor; backlog's
`readyItems()` is read by no program (S5).

This is why intake felt irrelevant to the interactive goal and is unavoidable for
autonomy. A supervisor with nothing to supervise is a timer.

### 5.5 Ownership boundary

Three owners, split by what kind of guarantee each needs:

```
backlog      plan graph · task identity · claims · dependencies · status
             ── needs STRUCTURAL INTEGRITY, therefore needs the database ──
                    │  (dispatch reads)         ▲  (dispatch writes back)
                    ▼                           │
dispatch     DERIVED  → packing · eligibility · blast_radius · conflict   (recomputable)
             OBSERVED → tokens_actual · guard_output · turns · attempt_count
                        ── irreducible; TODAY dispatch is their only durable home ──
                    │
                    ▼
agent-mcp    transcripts · messages · usage · sessions
             ── high-volume append, already owned, stays owned ──
```

**An earlier draft of this section claimed dispatch's outputs are "derived and recomputable,
therefore it needs no durable authority of its own." That was false**, and it was the
load-bearing claim of the whole split. Verification ✔ found dispatch persists two different
kinds of thing:

- **Derived** — packing decisions, eligibility, `blast_radius`, `conflict`. Functions of
  the graph plus the code. Genuinely recomputable.
- **Observed** — `OperationDag.status`, `attempt_count`, `guard_result`, `guard_output`,
  `guard_ran_at`, `tokens_actual` (`types.ts:481-495`) ✔, plus `DispatchLogEntry.turns` and
  `.results` (`types.ts:442-455`) ✔. These are **records of what happened**. No amount of
  recomputation reproduces "the guard printed this at 14:03" or "this dispatch consumed
  4,312 tokens."

And the observed set has nowhere else to go, because **dispatch fires ephemeral tasks and
agent-mcp deliberately does not persist their context** — its own tool description says "a
one-shot ephemeral task with **no persisted context**" (`server.ts:524`) ✔, and the queue
logs "skipping ephemeral task — context lost on restart" (`task.ts:356`) ✔.

**Two consequences.**

*First, this makes S1 worse, not better.* `dag.json` is written by atomic rename with a
fixed temp name and no lock, so concurrent cycles clobber each other. What gets lost is
precisely the **irreplaceable** half — the observation record — not the recomputable half.
The strongest argument for F1 is not tidiness; it is that the only copy of what the system
actually did currently lives in a file with last-writer-wins semantics.

*Second, the clean split is a consequence of F2, not a precondition.* Once dispatch fires
**sessioned** tasks, agent-mcp persists the task record, and `dispatch_log` degrades from
sole authority to a projection that can be rebuilt. So the ownership chart above describes
the **target** state; today the middle row holds real authority. Any plan that assumes the
target shape before F2 lands will lose data.

**This makes backlog's partial features a liability rather than a foundation.** They are
half-implementations of a domain with a real owner, which is worse than absence because
they look usable. §6's R-track removes them.

### 5.6 The work-graph store — decision and evidence

Requirement: parallel plan execution with structural assurance that a task is not claimed
by two plans, and referential integrity as tasks move between states. **A lockfile cannot
express this.** It serializes writers; it has no opinion about what they write. The
guarantee needed is a constraint — a partial unique index on task identity where a claim
is active, plus CAS — which is a database's job.

Two candidate shapes were evaluated:

**(a) Separate DAG store, mounted alongside backlog via turso ATTACH.**
Two probes were run against `@tursodatabase/database@0.7.2`
(`tmp/dispatcher-fk-probe/{probe,atomicity}.mjs`) ✔, each with a control that bites first
so a silent no-op cannot pass as success:

```
foreign_keys pragma:              1
control (same-file FK):           ENFORCED
ATTACH:                           OK  (requires experimental: ['attach'])
cross-file FK declaration:        ACCEPTED
cross-file FK enforcement:        ENFORCED          orphan rows: 0
main / attached journal mode:     wal / wal
cross-db write transaction:       PERMITTED
ROLLBACK across both files:       REVERTS BOTH
cross-db CRASH atomicity:         NOT PROVABLE IN-PROCESS
```

Turso **does** enforce foreign keys across attached files — diverging from stock SQLite,
where FKs cannot span databases — and cross-file write transactions commit and roll back
atomically. Experimental-flag gating is acceptable to the owner, so that is not a cost.

**One residual risk, and it is the deciding factor.** Stock SQLite documents that
transactions spanning attached databases are atomic *only when the main database is not in
WAL mode*; in WAL mode each database commits atomically on its own but the set does not. A
crash mid-commit can leave one file committed and the other not. Both files here are in
WAL. Turso is a Rust rewrite and may differ, but **this is not provable in-process** — it
needs a kill-mid-commit harness — and it must not be assumed.

**(b) A capability slot on backlog's plugin host.**
`docs/spec/backlog/PLUGIN_ARCHITECTURE.md` §2.1 already types this:

```typescript
capabilities: {
  embedding?: EmbeddingCapability<Opts>;
  // Future capability slots are added when a real consumer exists.
}
```

…and §2.2 states slots are added "when a real second consumer exists." Dispatch is that
consumer. The seam is being built for embeddings regardless, so the cost is amortized.
Single file, single WAL — **crash atomicity is native, with no residual assumption.**

**Recommendation: (c) — the split that follows from the probes.**

The two options are not actually exclusive, and the probe results point at the right line:

- **Integrity-critical state in one file** (backlog, option b): task identity, claims,
  status, dependency edges. These are what must never half-commit — "the task moved state
  AND its claim was written" is exactly the invariant crash atomicity protects.
- **Derived and high-volume data in an attached store** (option a): packing snapshots,
  cycle logs, calibration, `dispatch_log`. These are recomputable or append-only; a partial
  commit is recoverable by re-deriving, so the residual risk costs nothing.

This uses ATTACH where it is proven safe and avoids it precisely where the unproven
property would matter. It also keeps backlog's added surface to one capability slot rather
than a scheduling subsystem.

**To promote (a) to the integrity tier**, one experiment settles it: a kill-mid-commit
harness across two attached WAL files, run enough times to be meaningful. Worth doing if
independent store lifecycles become valuable; not worth blocking on now.

Constraint to respect: §10 of the plugin spec is explicitly *"No general plugin
framework."* A `scheduling` slot beside `embedding` is in-spirit; a generalized hook system
is what the spec refused.

**Prerequisites — smaller than a second-hand reading suggests.**

An earlier draft listed three "blockers" taken from the comparison's **adhd-side**
failure-mode classifications. Reading the source ✔ dissolved two of them. Note the scope
precisely: these are severity labels applied to *this repo's* code, not to sox. The
comparison's sox-side claims are established (§4, D-B note). The pattern worth recording is
narrower than "the comparison is unreliable" — it is that **a severity label is an opinion
about code and the code's own spec comment outranks it**:

- **`renewClaimNode`'s missing contention check is SPECIFIED, not a defect.** The function
  carries its own citation: *"SPEC.md §5.3 — always succeeds (bumps claimedAt), no
  contention check, ever."* (`claim.ts:87`) ✔. The comparison classifies it
  `FAILURE-MODE+INVARIANT-VIOLATION`; the code says it is the design. The real question is
  therefore a **design question, not a bug fix**: renew-without-contention is incompatible
  with cross-plan claim exclusivity, so F1 needs a ruling on whether §5.3 changes for
  plan-scoped claims, or whether plan exclusivity is enforced by a separate constraint that
  leaves renew alone.
- **`blockers()` is not on the scheduling path.** It does return `[]` on a miss
  (`query.ts:226`) ✔ — but `readyItems()`, the query A2 would consume, never calls it. It
  runs its own check and **fails closed**: `if (!node) continue` skips a missing item rather
  than treating it as ready, and `if (item.claimedBy) continue` already respects claims
  (`query.ts:233-243`) ✔. So this is a reporting inconsistency, not a scheduling hazard.
  Worth fixing; not a blocker.
- **`startWork` two-transaction dirty state** (`lifecycle.ts:109-116`) — **not verified
  here.** Carried from the comparison, unconfirmed against source. Treat as a lead.

**One caveat on the existing proof.** The claim lease's race test uses `worker_threads`
with independent connections to one file ✔ — rigorous (real adapter, built artifact,
barrier-synchronised, not sleep-based) but **in-process**. F1's requirement is exclusivity
across *plans*, and under the A-track those run in separate OS processes spawned by a
supervisor. Connection-scoped and process-scoped locking are not automatically the same
thing. The test comment asserts it exercises "multiprocess WAL coordination," which is
plausible given each worker holds its own connection — but it has not been demonstrated
across process boundaries. **F1's acceptance test should spawn real processes**, not
threads, or the exclusivity guarantee is proven one level below where it is needed.

**What this means for F1:** its genuine prerequisite is a *design decision* about
plan-scoped claim semantics, not a defect-clearing exercise. That is a smaller and
differently-shaped piece of work than "fix six bugs first."

**Accepted cost:** dispatch would depend on backlog, which already sits on sox's published
store packages (S8) — a three-link chain where a sox store release can move dispatch's
scheduling semantics. Argues for pinning those deps deliberately and running conformance
against the pin.

### 5.7 What F1 costs — files-as-UI, and how to keep it

The state-location asymmetry (S4) is the one place adhd currently *matches* sox and F1
would break it. sox state lives in `.cto/` — committable, diffable, PR-able, reviewable in
the same tools as the code it governs. adhd's state is deliberately out-of-tree SQLite,
reachable only through CLI/MCP. **`dag.json` is the exception**: it is a file, in the repo,
and `git diff` shows you what a plan changed.

Moving the plan graph into a database deepens the asymmetry rather than closing it. That is
a real cost and it should not be paid silently.

The obvious mitigation — render a projection back to a file — is the pattern this repo has
already been burned by: `BACKLOG.md` is a generated projection that agents kept
hand-editing, and it now needs a parity gate to stay honest. Do not repeat it.

**The resolution is the same line as §5.5, applied to the authoring axis:**

- **Plan *definition* stays a file** — what work exists, its dependencies, which agent,
  which tier. This is authored content. It belongs in git, reviewed in PRs, diffed like
  code, and it is what `dispatch run --dag-path <plan>` already consumes.
- **Execution *state* moves to the store** — claims, status transitions, cycle results,
  usage. This is runtime, high-churn, and needs the constraints; it was never meaningfully
  reviewable in a diff anyway.

That keeps the reviewable artifact reviewable, gives the integrity guarantees to the data
that needs them, and means a plan is still something you can read in a pull request. It
also means F1 is narrower than "move `dag.json` into backlog" — it is "stop keeping
mutable execution state in an unlocked file."

### 5.8 Cost governance is optimistic against wire reality

`tokens_estimated` uses sentinel multipliers defaulting to 0.215× — assuming 90% cache
read-hits — while dispatch sends no `cache_control` and every task is a cold session-less
prompt (S9). Packing runs on estimates that cannot be met. Combined with `si_bytes=0` and
write-only calibration, every CLI-produced estimate understates real cost.

This is not a missed optimization. It is a **wrong input to the packer**, and it means the
two designed optimizations (Sentinel-Fanout, fork-join) both rest on a primitive that
isn't implemented.

---

## 6. Path

Ordered by dependency. Four tracks; the foundation is shared.

### Foundation — both goals require it

**F0 · Capability floor.** Thread `mcp_servers` from config through the optimizer onto the
unit; have `ensureAgent` read it. *Acceptance:* a dispatched agent edits a file in a
scratch worktree; the diff is on disk.

**F1 · Work-graph store.** Per §5.6(b) — a scheduling capability slot on backlog's plugin
host, holding two things under real constraints:
 (i) the plan graph, task identity, claims, and dependencies; and
 (ii) **the observation record** — `status`, `attempt_count`, `guard_result`/`guard_output`,
 `tokens_actual`, and dispatch turns/results. §5.5 ✔ establishes this half is *irreducible*
 and that `dag.json` is currently its only durable home, in a file with last-writer-wins
 semantics. Losing it loses the only account of what the system did.
*Blocked on:* a design ruling on plan-scoped claim semantics (below), **not** a defect
sweep. *Acceptance:* two plans race for one task — exactly one wins, by constraint rather
than convention; and a forced concurrent double-write loses no observation rows, which
`dag.json` demonstrably would.

**F2 · Session continuity.** Dispatch fires sessioned tasks; `dispatch-cli status`
surfaces `awaiting_input` and `resumeToken`. *Acceptance:* a unit suspends on
`request_human_input`, survives a server restart, resumes.

**F3 · Client seam (D-D).** `createAgentEngineClient()`; dispatch depends in-process;
mirrored wire types, provider translation, and `[CODE] msg` parsing deleted. Wire runner
survives for remote only.

### R — Removals and repairs

A consumer check ✔ found that `readyItems`, `topoOrder`, `blockers`, `assignItem`, and
`assignee` have **zero importers in this repo** — every hit is a `.d.ts` in a build
artifact. That is not licence to delete them: those declarations *are* the published API
of `@adhd/backlog`, and each is also an MCP tool. "No in-repo importer" is not "no
consumer"; removal is a semver-major break plus the loss of a tool surface agents may be
using.

The line that matters is **graph fact vs. scheduling decision**:

- *"Which items have no unmet dependencies"* is a fact about the graph. It is legitimately
  backlog's, and under A2 it is precisely the query dispatch needs. **Keep it.**
- *"What should run next given capacity, packing, and tier"* is a scheduling decision.
  That is dispatch's, and backlog should never grow it.

So the track is mostly repair, not removal:

**R1 · `assignee` — decide, don't drift.** Recorded and consumed by no enforcement path
(`structure.ts:244-255`). Under A2, dispatch is the natural consumer; making it live is
better than deleting it. Deleting is the fallback if it stays unconsumed after A2.
**R2 · `importance` column — remove.** The only clean deletion here: internal, write-only
(`spotlight` sorts by `PRIORITY_RANK`), derived deterministically from priority anyway, and
it is the sole reason `setPriority` dual-writes non-atomically. Removing the field removes
the divergence bug outright, with no API impact.
**R3 · `blockers()` returns `[]` on a miss — fix, low priority.** Real
(`query.ts:226`) ✔, but it is a *reporting* inconsistency: `readyItems()` — the scheduling
query — does not call it and fails closed on the same condition ✔. Fix for consistency with
the typed-error contract the rest of the read surface honours; do not treat it as gating.

### A — Autonomy (sox parity; the substrate)

**A0 · Isolation and liveness** — the two prerequisites autonomy cannot start without.
*Worktree isolation* (F13) enforced at runtime rather than by convention: parallel plans
editing one repo without it is a corruption engine, and it is one of only two outright
superset gaps. *Reconnect* (S6): `AgentMcpRunner` memoizes its client and never
reconnects, so a dead stdio subprocess poisons every subsequent cycle — survivable in a
one-shot CLI, fatal in a daemon.
**A1 · Wire `orchestrate()`** to a `--to-terminal` flag. The loop exists; nothing calls it.
Small, and it is the demo's own climax (⟦U7⟧) — which makes it the most tempting thing on
this list to do first. **Do not.** It must land after F1. Multi-cycle execution is exactly
the condition under which `dag.json`'s unlocked last-writer-wins semantics destroy the
irreplaceable observation record (§5.5 ✔, §9). Shipping A1 before F1 converts a latent
data-loss risk into an active one, and does it in the feature that looks like a quick win.
**A2 · Close the loop** — dispatch reads work from F1 and writes status back.
**A3 · Supervision** — daemon, heartbeat, crash-state persistence, startup recovery, plus
the two runtime models that make a supervisor more than a loop: **demand-based saturation
spawn** (S12 — workers spawn to `min(assignableWork, wipLimit)` only when work is actually
assigned, and drain rather than idle) and a **crash-loop circuit breaker** with poison-pill
isolation (S13). Without the first, a daemon burns cost idling; without the second, one
poisoned task takes the fleet down repeatedly.
**A4 · Healers + stuck-work backstop** — the reachable cap dispatch's correction loop lacks.
**A5 · Replay** — authoritative event log, `reconstruct --verify` with drift detection.
**A6 · Snapshots** (F14) — the second superset gap. Restore granularity for an unattended
system that can now damage things unattended.

### Mapping onto `agent-final`'s milestone table

`GOAL.md` declares agent-final one plan with milestone gates; five are marked "to author."
These tracks are those milestones, not a parallel structure:

| agent-final milestone | This document |
|---|---|
| `store-move` (written) | Prerequisite of F1 — D-C's fold restores the session FK |
| `dispatch` (exists; `DEMO.md` retained by O-3) | F0 + A1 — the demo's climax is A1 |
| `client-factory` | F3 |
| `seam` | F3 (D-D's deletion of the mirrored types) |
| `authoring-lane` (consuming sox) | Out of scope here — D-A |
| `compile` | §5.3 — consuming the composition layer at runtime |
| `plugins/test-wiring` | F1's capability slot; the budget plugin already loads via operator config, so this milestone is about test wiring, not enabling it |
| `spine` | The end-state demo, extended with the A-track |

The A-track has **no** agent-final milestone. It arrives from sox parity and is the one
genuinely new body of work — which is consistent with `GOAL.md`'s end-state containing the
interactive payoff (item 8) and nothing about unattended operation.

**Demo disposition.** O-3 retains `dispatch-completion/demo/DEMO.md` as the dispatch
milestone's acceptance document, and its `SCOPE.md:33` excludes everything under
`entrypoint/agent-mcp` and `packages/agent/**` — where F1–F3 and most of the A-track live.
So it should be left intact and a platform-level demo authored above it, covering the
A-track's unattended and recovery beats, which no existing demo exercises.

### I — Interactive (Claude Code / opencode replacement)

**I1 · Provider portability** (D-G 1/2/3). Acceptance is `GOAL.md` end-state item 8.
**I2 · Interactive surface** — streaming renderer over the existing SSE/event bus
(`--follow`), a session-bound REPL, HITL and permission prompts surfaced. Needs a spec
before it needs a plan.

### O — Optimization (gated, possibly never)

**O1** emit `cache_control`; measure. **O2** revisit packing only if O1 shows headroom —
`RECONCILIATION.md` already gates the algorithm cascade on ≥3 real cycles showing >15%
savings, and that gate should hold. D-G(4) reversal belongs here if anywhere.

### Not on this path

Policy enforcement (O-1: on hold) · retrieval (D-A: sox owns it) · multi-recipient agent
messaging (no ruling, not required) · a TUI (a line-oriented REPL meets the goal).

---

## 7. Plan-corpus ideas with no backlog representation

| Idea | Where it lives |
|---|---|
| D-G(2) session-held provider binding; `task ?? session ?? agent ?? global` | `GOAL.md` D-G |
| D-G(3) soft swap — history re-rendered into a new provider's format | `GOAL.md` D-G |
| D-D seam plan — deletion of `agent-runner.ts`'s mirrored types | `GOAL.md` D-D |
| The five unauthored agent-final milestones | `GOAL.md` milestone table |
| Context-conditional composition, policy inheritance by category, component-level A/B experiments | `superseded/agent-registry/USAGE.md` (illustrative, never built) |
| Fork-join parallel execution over shared cached content | `docs/ideas/fork-join.md` — status header claims a worktree and branch that do not exist |
| Sentinel-Fanout cache pre-warming | `superseded/dispatch-optimizer/SCOPE.md` |
| Multi-recipient agent interrupts | `docs/ideas/agent-interrupts.md` |
| In-process tool plugins | `docs/ideas/tool-plugins.md` |
| Hook layers + auth for the HTTP transport | `docs/agent-mcp/hook-architecture-and-auth-spec.md` |
| Every S-row in the sox comparison | `docs/dispatcher/FEATURE_COMPARISON_SOX.md` §3 |

**Backlog reliability.** Nine of nine sampled open items described code that had since
changed. Reprioritising is therefore a **verification** task before it is a ranking task,
and should be run as a fan-out. Separately, `plan-index.json` has 13 of 22 unresolvable
directory paths and omits six active plans — do not use it to locate anything.

---

## 8. Decisions owed to the owner

1. **Does D-G(4) stand?** Ordered-fallback routing is ratified; "cross provider
   *optimized*" implies price/latency selection, which D-G(4) deferred. Decides whether
   the O-track exists.
2. **Where does the interactive surface live** — a sixth agent-final milestone, or its own
   plan?
3. **F1 shape confirmed?** §5.6 recommends (b); (a) is viable if ATTACH stabilizes.
4. **Do the R-track removals ship as their own cleanup**, or fold into F1?

---

## 9. Risks

- **The corpus lies.** Nine of nine sampled items were stale. Every milestone should begin
  by driving its own claims rather than reading about them.
- **The unauthenticated second API surface is on by default.** `/v1/models`,
  `/v1/chat/completions`, `/tasks/:id/stream` are served on every stdio instance with no
  auth and are not part of the 16-tool MCP surface (S15). Not "if you expose it" — now.
- **Autonomy amplifies correctness bugs.** Behaviour that is tolerable when a human
  occasionally claims a ticket is not tolerable when a daemon spawns workers off it — which
  is why F1's claim-semantics ruling has to precede the A-track rather than follow it.
- **The only record of what the system did is in an unlocked file.** §5.5 ✔ — the observed
  half of dispatch's state (`tokens_actual`, `guard_output`, turns, `attempt_count`) cannot
  be recomputed, and agent-mcp does not retain it because dispatch fires ephemeral tasks
  with no persisted context. `dag.json` is written by atomic rename with a fixed temp name
  and no lock, so two concurrent cycles silently destroy observations. **This is a live
  data-loss risk today, not a future one**, and it worsens the moment anything runs more
  than one cycle at a time — which is precisely what A1 enables.
- **I2 could be the wrong investment.** Most worth re-deciding after F0–F3 and the A-track
  land, when there is something real to drive.
- **Three-link dependency chain.** sox store → backlog → dispatch scheduling, if F1(b)
  ships. Pin deliberately.
- **BL-373 becomes load-bearing.** The stale `-tshm` sidecar currently wedges *queries*.
  Under F1 it would wedge *runs*.
- **Cross-file crash atomicity is assumed, not proven** — if any integrity-critical state
  ends up in an attached store rather than the main file (§5.6). The mitigation is the (c)
  split; the alternative is a kill-mid-commit harness.
- **Registry config drift** (S7). Five agent packages share one `registry.db` resolved
  through a three-legacy-env-name precedence chain, plus a project/global scope switch —
  two env-var sets can materialize two different registry DBs, and `ADHD_ENV_SCOPE=project`
  moves `registry.db` but not `agents.db`. A daemon inheriting a different environment
  than the CLI that configured it will silently operate on a different registry.

---

## 10. Success criteria

### 10.1 The problem with normal metrics

N=1. Adoption, NPS, retention cohorts are meaningless. Measurement must be **behavioural
and substitution-based**, and the goal states the test: *"eliminate my need for opencode,
claude cli etc."* If the owner still reaches for Claude Code for real work, this failed —
regardless of how many milestones went green.

### 10.2 North Star — unforced substitution share

Fraction of real coding sessions starting in dispatch rather than Claude Code/opencode.
Countable: Claude Code writes transcripts under `~/.claude/projects/`, opencode keeps its
own store, dispatch has `sessions` rows. The load-bearing word is **unforced** — usage
requiring self-discipline is failure reported as success.

### 10.3 The sharpest number — fallback rate

A dispatch session ending unfinished, followed within ~20 minutes by a Claude Code session
on the same repo. Derivable from timestamps and working directory across both stores.
Clustering defection events by what was being attempted yields an empirical I2 spec rather
than a guessed one.

### 10.4 Parity — measured against sox, which actually runs

sox is a better benchmark than a spec because everything in it is proven. Three tests:

- **Unattended duration.** How long can a plan run without human intervention? sox runs
  continuously; dispatch today runs one cycle. This is the headline parity number.
- **Recovery.** Kill the supervisor mid-run: does it come back, re-derive state, and
  resume without losing or duplicating work? (A3/A5.)
- **S-row closure.** S1, S2, S3, S5, S11 each have a binary "has an equivalent" test.

### 10.5 Layer gates — binary

| Gate | Test |
|---|---|
| F0 | A dispatched agent edits a file; the diff is on disk |
| F1 | Two plans race one task; exactly one wins, by constraint |
| F2 | A task suspends on HITL, survives a restart, resumes |
| F3 | Mirrored wire types deleted; dispatch imports the client |
| A1 | `run --to-terminal` drives a plan to done without per-cycle invocation |
| A4 | A deliberately-stuck task is detected and escalated without human notice |
| I1 | `GOAL.md` end-state item 8 |
| I2 | First-token latency strictly less than total wall-clock |

### 10.6 The comparison bar

**Time to first token** on an interactive turn, versus Claude Code on the same prompt. And
**interruption cost** — whether a task can be steered mid-flight without losing state.
Claude Code: yes. Dispatch today: structurally no. After F2: yes. This is the capability
most likely to decide substitution, because it is felt daily.

### 10.7 Economics — baseline before claims

First measurement is a baseline, not a validation: confirm the cache hit rate is zero,
emit `cache_control`, measure what that alone buys. Instrumentation exists (`task_usage`,
`task_events`, `usage_query`), so cost-per-completed-task by provider mix is derivable
without building telemetry. `docs/agent-mcp/study/code-tasking/` — five models graded on
seven real code-fix scenarios through live MCP — is the natural basis for the *quality*
half of any routing decision. Cost-aware routing without a quality signal routes to the
cheapest wrong answer.

### 10.8 Kill criteria

- **After F0–F3 + A-track, before I2.** If fallback rate has not moved, the interactive
  surface is not the fix — keep Claude Code for the interactive lane and let dispatch own
  the batch lane it is already good at.
- **If planning does not beat ad-hoc prompting** on real work, "intelligent swarm" is
  decoration.
- **If parity stalls below unattended-duration parity with sox**, the honest conclusion is
  that sox is the workflow system and adhd is its execution substrate — a smaller, still
  valuable claim.

---

## 11. Positioning

### 11.1 The reframe

**Not another agent CLI. The substrate underneath one.**

Pitching a Claude Code alternative invites comparison on interactive polish against
well-funded teams — a losing fight, and §6 already names it a non-goal. The defensible
frame is that incumbents ship a *client* and this ships a *platform*: planning, execution,
provider binding, cost enforcement, and prompt composition as separable, inspectable parts.

### 11.2 Who it is for

| Audience | Pain | What lands |
|---|---|---|
| The owner (primary) | Agent work runs inside someone else's client; every capability gated on a vendor roadmap | Control of the loop; durable plans; provider neutrality |
| Developers at the ceiling of vendor clients | Want hooks, permission models, cost caps, providers their client won't expose | "Own the loop" |
| People building agent products | Need a runtime and a planner, not a chat UI to strip out | Composable published packages |

### 11.3 The claims — each with its proof obligation

**1 · Plans that outlive the session.** A durable, inspectable, re-runnable work graph;
vendor plan modes evaporate. *Proof:* author, execute a wave, kill the process, resume.
*Ships:* today for batch; fully after F1.

**2 · Unattended execution that recovers.** *Proof:* §10.4's recovery test. *Ships:* after
A3/A5. **This is the claim sox parity actually buys**, and no vendor client makes it.

**3 · Provider-neutral by construction.** Provider identity lives in the session and swaps
mid-conversation. *Proof:* `GOAL.md` item 8. *Ships:* after I1. Today's honest, smaller
claim is "per-unit provider assignment, statically authored."

**4 · Prompts as versioned software.** Components, compositions, context-conditional
selection, content-hashed caching. **Most transferable asset in the repo; already built.**
*Ships:* today as a library claim — the A/B tooling is illustrative and must not be claimed.

**5 · Cost is a primitive, not a bill.** Caps by task/session/agent/global with
cache-class-aware accounting, **deployed and enforcing today** ✔ (`context ≤128k` block,
`cost ≤$0.30` per task block, `inputTokens ≤500k`/24h global warning). *Proof:* trip a cap
and show the block in the usage ledger. *Ships:* now, with one honest qualifier — it is
enabled by operator config rather than by a shipped default, so the claim is "configurable
and in use here," not "on out of the box."

### 11.4 What must not be claimed

- **No cost-savings numbers.** The 5.8× and 72–92% projections rest on caching that is
  never requested (§5.8).
- **No "intelligent routing."** D-G(4) defers it.
- **Not production-ready.** Self-assessed *"experimental, research-grade"*; the HTTP
  transport has no auth.
- **No Claude Code replacement claim** until §10.2 supports it.
- **No advertising unreachable capabilities.** HITL, chat gateway, and SSE all work and are
  unreachable from dispatch until F2. The marketing catalog already flags seven
  capabilities "Unverified (No Test)."

**Standing rule: no receipt, no claim.** `.catalog/capabilities.json` carries `verify`
commands and `verified_output` per entry — that is the gate, and it can be mechanical.

### 11.5 Sequencing

- **Today:** the composition registry and apigen as libraries — real, tested, published,
  independently useful regardless of how the dispatcher lands.
- **After F1/F2:** durable plans with human-in-the-loop steering.
- **After the A-track:** unattended execution that recovers — the strongest differentiator
  and the one worth a launch.
- **After §10.7:** anything about cost.

**The value proposition is not shippable until the A-track, and that is fine.** Advertising
the platform story now spends credibility on capabilities that are built but unreachable,
and credibility spent early is not recoverable.

### 11.6 Where it lives

`docs/marketing/.catalog/` holds a 44-entry capability ledger, and `doc-evangelist`'s remit
is deriving features from verified inventory into README copy and launch posts. Positioning
work should drive that pipeline rather than hand-writing claims — it is the only path that
enforces §11.4's receipt rule mechanically.
