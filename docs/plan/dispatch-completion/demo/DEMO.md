# 🎬 dispatch-completion — Live Demo & Acceptance Script

> Author a plan once, and let a token-cost optimizer decide *who runs what, together, for the fewest tokens* — then drive it to done, safely, from one command.

**What this is.** A presentation-grade walkthrough of the `@adhd/dispatch-*` subsystem that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the dispatcher's product the way a brand-new user would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means for the **dispatch-completion** plan: the beats that run green today are the already-shipped core; the beats tagged ⟦U#⟧ are the *remaining* work this plan delivers — if it's demonstrated here, it must work; if it must work, it's demonstrated here.

**The objective, in one paragraph.** The dispatch subsystem turns a `dag.json` plan into token-optimal parallel agent dispatch: `snapshot()` derives eligibility/waves/cost, `optimize()` packs eligible milestones into the cheapest `DispatchUnit[]`, and the orchestrator dispatches work to a real agent, guards it, and records the result. Two load-bearing defects — real tool-call execution being a `skipped` stub, and the packages being unshippable under a name/import mismatch — are being fixed **directly** against `packages/dispatch/*` (BUG-DISPATCH-EXEC-001, BUG-DISPATCH-PUBLISH-001) and are **out of this plan's scope**; dispatch-completion builds on them as landed preconditions (Phase 0 confirms). **What dispatch-completion owns is everything that remains to take the subsystem from "core works" to "complete + hardened":** close the correctness edges (a complete milestone must stop reading "eligible"; a mid-cycle runner failure must be recorded not thrown; a `DispatchUnit` must declare its `execution_mode`; snapshots must survive a JSON round-trip; causal replan must rewire downstream deps), light up the deferred feature track the architecture always intended (file/blast-radius **enrichment plugins**, a **SQLite** storage adapter, the remaining **MCP dag-authoring tools**, an npx-invocable **CLI**, and a data-gated **algorithm cascade** held until real cycles justify it), and clear the remaining `DEBT-DISPATCH-*` cluster — all without rebuilding one line of the shipped, tested code, and without touching agent-mcp.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (command) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts (IDs, timestamps) shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies (traceability). |
| 📎 **Source** | What grounds this step — spec section, file, or run it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value/interface guessed because it isn't built/specified yet. Logged in `UNRESOLVED.md` beside this file. These are the acceptance targets for the *remaining* work. |
| ⚠️ **Edge** / 🛟 **Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- Shell prompt is `$`; all commands run from the repo root (`/Users/nix/dev/node/adhd`) unless noted.
- This script uses one alias for the dispatcher CLI. Define it once, at the top of your session:
  ```bash
  alias dispatch='npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/bin/cli.ts'
  ```
  Every `dispatch …` command below expands to that. (Making `dispatch` a real `npx @adhd/dispatch-cli` binary is itself a demo beat — Act 6.)
- The canonical plan file for the whole script is `docs/plan/dispatch-completion/demo/fixtures/sample-plan.dag.json` (defined in §2.2). We refer to it as `$PLAN`:
  ```bash
  PLAN=docs/plan/dispatch-completion/demo/fixtures/sample-plan.dag.json
  ```
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess (not yet built); each is listed in `UNRESOLVED.md` — confirm them before treating that step as authoritative.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Priya runs a platform team. Every day her agents chew through a backlog of plan milestones, and every day she hand-tunes *which* milestones to batch together and *which* model tier to send them to — guessing at the token math, over-packing prompts until quality craters at the context-window cliff, or under-packing and paying the per-call base cost ten times over. She has a `dag.json` for every plan already. What she wants is for the machine to read that plan and tell her: *here is the cheapest correct next wave, dispatch it.* She opens the dispatcher for the first time.

> **The promise we'll prove in the next ~10 minutes:** hand the dispatcher a plan `dag.json` and it will validate it, compute the eligible wave, pack it into the token-optimal set of agent dispatches, run a cycle to done through real agents, and never lie to you about what's eligible or silently swallow a failure — all from one command, over a storage backend you choose.

🔗 **Proves (framing):** REQ-001 · CAP-001, CAP-002, CAP-003, CAP-006, CAP-007
📎 **Source:** SCOPE.md §1 Outcomes; docs/plan/dispatch-optimizer/README.md (value prop, cost model)

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Priya
Priya is a dispatch lead. Her goal for this session: take one real 3-milestone plan (`scaffold → implement → verify`), see exactly what the optimizer sees, dispatch the first wave without spending a cent, and satisfy herself the system is honest about eligibility and failure before she ever points it at a paid model. The stakes: at her fan-out, a wrong packing decision or a swallowed dispatch failure is real money and a corrupted plan.

### 2.2 The Canonical Demo Dataset
The single source of data truth for this script is a real, valid plan dag committed beside this file: `docs/plan/dispatch-completion/demo/fixtures/sample-plan.dag.json`. It is a `schema_version: 4` plan with a three-milestone chain, each with one operation and a cheap always-passing guard (`node -e "process.exit(0)"`):

| Milestone | depends_on | operation | model | guard |
|---|---|---|---|---|
| `scaffold` | — | `scaffold.1` (generative) | Sonnet | passes |
| `implement` | `scaffold` | `implement.1` | Sonnet | passes |
| `verify` (terminal) | `implement` | `verify.1` | Sonnet | passes |

Provider `Sonnet` is a `claudecli` config; `optimization.b_per_tier`/`context_window_per_tier` are empty (the optimizer falls back to cold-start defaults). Every later beat refers back to this file as `$PLAN`.

### 2.3 Prerequisites
- Node.js ≥ 20 and the repo's workspace deps installed (`npm ci` at repo root) — the monorepo already vendors `tsx`, `commander`, and the `@adhd/dispatch-*` packages.
- No network, no API key, no running server. Every default beat is offline and free.
- **Landed preconditions (NOT this plan's scope):** real tool-call execution (**BUG-DISPATCH-EXEC-001**) and package-name↔import conformance to the repo standard (**BUG-DISPATCH-PUBLISH-001**) are fixed directly against `packages/dispatch/*` by separate code-fix executors. This demo builds on them as given — it does not re-verify or re-plan them. Phase 0 triage confirms they landed before the remaining work starts.

### 2.4 Cold Start — From Nothing to a Running Dispatcher
🎬 **Scene.** Priya builds the dispatch stack and confirms the CLI is alive.

▶️ **Do**
```bash
PLAN=docs/plan/dispatch-completion/demo/fixtures/sample-plan.dag.json
alias dispatch='npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/bin/cli.ts'
npx nx run-many -t build -p dispatch-base-spec,dispatch-core-client,dispatch-serializer-json,dispatch-core-optimizer,dispatch-orchestrator
dispatch --help
```

👀 **Expect** — the build reports success for all five projects, then `--help` prints the command list:
```
Usage: dispatch-cli [options] [command]
...
Commands:
  validate    validate a plan dag.json ...
  snapshot    compute a fresh DagSnapshot ...
  optimize    compute the next batch of DispatchUnits ...
  eligible    list milestone slugs eligible for dispatch right now
  status      per-milestone { status, loggedOperationIds, tokensEstimated, tokensActual }
  run         run exactly one ... scheduling cycle
  calibrate   ... measure baseline per-tier token cost ("B")
```

✅ **Verify**
- [ ] `nx run-many … build …` exits 0 for all five dispatch projects.
- [ ] `dispatch --help` exits 0 and lists all seven commands: `validate snapshot optimize eligible status run calibrate`.

🔗 **Proves:** REQ-001 · CAP-012 (partial — invoked via tsx today; npx binary is Act 6)
📎 **Source:** entrypoint/dispatch-cli/bin/cli.ts (command definitions); entrypoint/dispatch-cli/src/test/cli-smoke.spec.ts (spawn convention)

---

## 3 · The Journey

### Act 1 — Is this plan even sane?
Priya's first instinct with any plan file is to check it's structurally valid before she trusts a scheduler with it.

#### 1.1 · Validate a real plan   (happy)
🎬 **Scene.** She points the validator at her plan.

▶️ **Do**
```bash
dispatch validate --dag-path "$PLAN"
```

👀 **Expect**
```json
{"valid":true,"errors":[]}
```

✅ **Verify**
- [ ] Output is exactly `{"valid":true,"errors":[]}` and exit code is 0.

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** Grounded — captured live 2026-07-15 from `dispatch validate --dag-path $PLAN` against @adhd/dispatch-spec `validateDagJson`.

#### 1.2 · A garbage provider is caught   ⚠️ (edge)
🎬 **Scene.** Priya fat-fingers a provider value the enum shouldn't accept. Today the validator does not enforce the provider enum (a `'teammate'`/typo passes 25/25 spec tests) — dispatch-completion makes validation reject it while still accepting the real providers `claudecli` and `teammate`.

▶️ **Do**
```bash
# a copy of $PLAN whose dispatch_log records provider "not-a-provider"
dispatch validate --dag-path /tmp/dispatch-demo/bad-provider.dag.json
```

👀 **Expect**
```json
{"valid":false,"errors":[{"path":"dispatch_log[0].provider","message":"invalid provider 'not-a-provider'"}]}
```

✅ **Verify**
- [ ] A dag whose log entry uses an unknown provider validates `false` with a provider-path error.
- [ ] The same dag with provider `claudecli` **or** `teammate` validates `true` (no false positives).

🔗 **Proves:** REQ-013 · CAP-001
📎 **Source:** ⟦U1⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-019: extend `DispatchLogEntry.provider` union + enforce in `validate.ts`; unbuilt today).

### Act 2 — See the plan the optimizer sees
The dispatcher's superpower is a derived view of the plan. Priya inspects it before dispatching anything.

#### 2.1 · Who's eligible right now?   (happy)
🎬 **Scene.** On a fresh plan, only the root milestone can run.

▶️ **Do**
```bash
dispatch eligible --dag-path "$PLAN"
```

👀 **Expect**
```json
["scaffold"]
```

✅ **Verify**
- [ ] Output is exactly `["scaffold"]` — `implement` and `verify` are gated behind their dependencies.

🔗 **Proves:** REQ-001 · CAP-004
📎 **Source:** Grounded — captured live from `dispatch eligible --dag-path $PLAN` (DagClient.getEligibleMilestones).

#### 2.2 · The full derived snapshot   (happy)
🎬 **Scene.** She looks at the whole derived view: per-milestone eligibility, status, and the cost block.

▶️ **Do**
```bash
dispatch snapshot --dag-path "$PLAN"
```

👀 **Expect** — a JSON snapshot whose `milestones` map reads (volatile cost numbers elided as ⟨…⟩):
```
milestones.scaffold  = { eligible: true,  status: "pending", ... }
milestones.implement = { eligible: false, status: "pending", ... }
milestones.verify    = { eligible: false, status: "pending", ... }
optimization = { tokens_naive: ⟨n⟩, b_per_tier: {…}, b_eff_per_tier: {…}, context_window_per_tier: {…}, ... }
```

✅ **Verify**
- [ ] `milestones.scaffold.eligible === true`; `milestones.implement.eligible === false`; `milestones.verify.eligible === false`.
- [ ] `optimization.tokens_naive` is a finite number (present — DEBT-DISPATCH-010 already shipped).
- [ ] `optimization.context_window_per_tier` survives `JSON.parse(JSON.stringify(snapshot))` with every value a finite number, never `null`.

🔗 **Proves:** REQ-001, REQ-004 · CAP-002
📎 **Source:** Grounded for eligibility/`tokens_naive` (captured live). The Infinity-safe round-trip assertion is ⟦U2⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-014, unbuilt).

#### 2.3 · Per-milestone status report   (happy)
🎬 **Scene.** A flat status table for her dashboard.

▶️ **Do**
```bash
dispatch status --dag-path "$PLAN"
```

👀 **Expect**
```json
{"scaffold":{"status":"pending","loggedOperationIds":[],"tokensEstimated":3325,"tokensActual":null},"implement":{"status":"pending","loggedOperationIds":[],"tokensEstimated":3325,"tokensActual":null},"verify":{"status":"pending","loggedOperationIds":[],"tokensEstimated":3325,"tokensActual":null}}
```

✅ **Verify**
- [ ] All three milestones report `status: "pending"`, `loggedOperationIds: []`, `tokensActual: null`.
- [ ] `tokensEstimated` is a positive integer (⟨3325⟩ with the cold-start defaults for this fixture).

🔗 **Proves:** REQ-001 · CAP-005
📎 **Source:** Grounded — captured live from `dispatch status --dag-path $PLAN`.

### Act 3 — Pack the cheapest next wave
This is the reason the subsystem exists.

#### 3.1 · Optimize into DispatchUnits   (happy)
🎬 **Scene.** Priya asks the optimizer for the next wave.

▶️ **Do**
```bash
dispatch optimize --dag-path "$PLAN"
```

👀 **Expect** — an array of one `DispatchUnit` packing the only eligible milestone:
```
[ { milestones: ["scaffold"], execution_mode: "generative", prompt: ⟨string⟩, tokens_est: ⟨n⟩, ... } ]
```

✅ **Verify**
- [ ] Exactly one unit is returned and it packs `scaffold` (`units.some(u => u.milestones.includes("scaffold"))` is true). *(Grounded: live output is `[["scaffold"]]`.)*
- [ ] Every returned unit has a non-null `execution_mode` of `"generative"`, `"tool-call"`, or `"guard-only"`.

🔗 **Proves:** REQ-001, REQ-003 · CAP-003
📎 **Source:** Grounded for the packing (captured live: `[["scaffold"]]`). The `execution_mode` field is ⟦U3⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-005 BL-102 / `ExecutionMode`, unbuilt).

#### 3.2 · Enrichment sharpens the packing   (happy)
🎬 **Scene.** Two milestones that edit the *same* source file are cheaper to run together (shared bytes cache). Priya turns on the IO enrichment plugin and the overlap the optimizer sees stops being zero.

▶️ **Do**
```bash
dispatch optimize --dag-path "$PLAN" --enrich io,gitnexus
```

👀 **Expect** — the snapshot feeding the optimizer now carries real signal:
```
pairwise_overlap[scaffold][implement] = ⟨bytes > 0 when they share a file⟩
operations[*].blast_radius            = ⟨non-null for high-fan-in symbols⟩
```

✅ **Verify**
- [ ] With `--enrich io`, `pairwise_overlap` is non-zero for two milestones that share a source file (zero without it).
- [ ] With `--enrich gitnexus`, a high-fan-in op carries a non-null `blast_radius`.
- [ ] With `--enrich` omitted, `optimize` still returns valid `DispatchUnit[]` (plugins are optional; optimizer stays pure).

🔗 **Proves:** REQ-010 · CAP-009
📎 **Source:** ⟦U4⟧ inferred — see UNRESOLVED.md (`@adhd/dispatch-plugin-io` + `-plugin-gitnexus` and the `--enrich` flag are unbuilt; the injection seam `IOptimizerDeps` exists).

### Act 4 — Dispatch a cycle, spend nothing
🎬 **Scene.** Priya fires the first wave in dry-run: the exact same orchestrator code path a paid run takes, but through a `MockAgentRunner` — no network, no cost.

#### 4.1 · Run one cycle (dry-run)   (happy)
▶️ **Do**
```bash
mkdir -p /tmp/dispatch-demo && cp "$PLAN" /tmp/dispatch-demo/run.dag.json
dispatch run --dag-path /tmp/dispatch-demo/run.dag.json
```

👀 **Expect**
```
{ dispatched: [ { milestones: ["scaffold"], ... } ], injectedMilestones: [], persisted: true, terminal: false, terminalReason: null }
```

✅ **Verify**
- [ ] `persisted === true` and `dispatched` contains a unit with `milestones` including `"scaffold"`. *(Grounded: live keys `[dispatched, injectedMilestones, persisted, terminal, terminalReason]`.)*
- [ ] Re-running `dispatch eligible --dag-path /tmp/dispatch-demo/run.dag.json` now returns `["implement"]` — the completed `scaffold` is no longer eligible.

🔗 **Proves:** REQ-001, REQ-005 · CAP-006
📎 **Source:** Grounded — captured live from `dispatch run` (dry-run, MockAgentRunner) + `eligible` advance.

#### 4.2 · A complete milestone stops reading "eligible" everywhere   ⚠️ (edge)
🎬 **Scene.** The subtle correctness edge. `eligible` (the DagClient) already excludes complete milestones — but the *snapshot's* `eligible` field must agree, or any consumer reading `snapshot.milestones[x].eligible` as "still needs work" is wrong forever. Priya checks both agree on the post-run dag.

▶️ **Do**
```bash
dispatch snapshot --dag-path /tmp/dispatch-demo/run.dag.json
```

👀 **Expect**
```
milestones.scaffold.eligible  = false   # complete → not eligible
milestones.implement.eligible = true    # its dependency is now done
```

✅ **Verify**
- [ ] `milestones.scaffold.eligible === false` on the post-run dag (a *complete* milestone reports not-eligible).
- [ ] `milestones.implement.eligible === true`.

🔗 **Proves:** REQ-005 · CAP-002
📎 **Source:** ⟦U5⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-013: promote own-completion into the spec's D-07 `eligible` definition; today the snapshot field never flips to false).

#### 4.3 · A mid-cycle runner failure is recorded, not thrown   🛟 (recovery)
🎬 **Scene.** The moment that earns Priya's trust. If a dispatched agent's transport dies mid-fire, the orchestrator must record a `failed` entry and keep going — not throw and leave a silent forensic hole.

▶️ **Do**
```bash
# inject a runner that rejects on fire() for one unit (test harness / --runner-fault flag)
dispatch run --dag-path /tmp/dispatch-demo/run.dag.json --runner-fault fire
```

👀 **Expect**
```
{ dispatched: [ { milestones: ["implement"], status: "failed", note: "⟨error message⟩" } ], persisted: true, terminal: false }
```

✅ **Verify**
- [ ] The cycle exits 0 (no uncaught rejection) and `persisted === true`.
- [ ] The `dispatch_log` gains exactly one entry with `status: "failed"` and a non-empty error note.
- [ ] Any unit dispatched *before* the failure in the same cycle remains persisted (no rollback).

🔗 **Proves:** REQ-006 · CAP-006
📎 **Source:** ⟦U6⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-015: per-unit error boundary in `orchestrateCycle`; the `--runner-fault` test seam is a demo affordance, unbuilt).

---

## 4 · The Climax — Drive the whole plan to terminal, recovering from a bad milestone

🎬 **Scene.** The payoff. Priya stops babysitting cycles and tells the dispatcher: *take this plan to done.* It loops — dispatch the eligible wave (real tool-call execution already landed via BUG-DISPATCH-EXEC-001; see prerequisites §2.3), poll, guard, record, advance — until terminal `verify` completes. Along the way one milestone's guard fails; the orchestrator injects a correction and — this is the dispatch-completion win — **rewires the downstream milestone's `depends_on` onto the correction** so the resumed run reaches terminal instead of dead-ending at `no-eligible-work`.

▶️ **Do**
```bash
cp "$PLAN" /tmp/dispatch-demo/full.dag.json
dispatch run --dag-path /tmp/dispatch-demo/full.dag.json --to-terminal
```
👀 **Expect**
```
{ terminal: true, terminalReason: "all-complete", cyclesRun: ⟨3⟩,
  injectedMilestones: [ ⟨"implement-correction"⟩ ] }   # present only if a guard failed
```
✅ **Verify**
- [ ] The run ends `terminal === true`, `terminalReason === "all-complete"`; `dispatch status …/full.dag.json` shows every milestone `complete`.
- [ ] When a guard failure injects a correction, the downstream milestone's `depends_on` is rewired onto the correction and the resumed run still reaches terminal (not `no-eligible-work`).

🔗 **Proves:** REQ-011 · CAP-007
📎 **Source:** Grounded for `terminal/terminalReason` shape (live `run --no-dry-run` on an all-complete dag returned `terminal:true, terminalReason:"all-complete"`). The `--to-terminal` loop flag + causal-replan rewiring are ⟦U7⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-020, this plan's scope).

---

### 4.live · The live gate — a REAL model completes a REAL cycle   🛟 (mandatory live proof)
🎬 **Scene.** Everything so far ran offline against `MockAgentRunner`. Now Priya flips off dry-run and proves the dispatcher end-to-end against a real model — the bar this repo's "Live testing is mandatory" policy sets. The real path: `dispatch run … --no-dry-run` → real `AgentMcpRunner` → `npx -y @adhd/agent-mcp` → deepseek-chat → a real completion persisted.
▶️ **Do**
```bash
# structural (default, unflagged, no paid call): real agent-mcp spawn + MCP handshake
npx --yes nx test dispatch-cli
# paid live (the one legitimate env-gate): drives run --no-dry-run against deepseek
export DEEPSEEK_API_KEY=…            # provisioned per the plan's deepseek-api-key human-blocker
AGENT_MCP_LIVE=1 npx --yes nx test dispatch-cli
```
👀 **Expect** — unflagged: the real-e2e structural test spawns agent-mcp and completes an `initialize` + `tools/list` handshake, green, no cost. Flagged: the live scenario dispatches through deepseek and records a completed cycle.
✅ **Verify**
- [ ] The default-running structural test (real agent-mcp subprocess spawn + MCP stdio `initialize`+`tools/list` handshake) passes **unflagged** — no paid call, no mock of the thing under test; fails loudly if the agent-mcp artifact/`python3` prereq is missing.
- [ ] With `AGENT_MCP_LIVE=1`: the persisted `dispatch_log` has a completed result with a real model call (`tokens > 0`) and a new **deepseek** task is recorded in agent-mcp usage — driven through the REAL `AgentMcpRunner`, never a mock.
- [ ] **Negative control:** the same scenario forced onto `MockAgentRunner` records no deepseek task → the live assertion goes red.
🔗 **Proves:** REQ-017 · CAP-016
📎 **Source:** `entrypoint/dispatch-cli/src/test/integration/real-e2e.ts` (the live scenario a separate executor is finalizing); CLAUDE.md "Live testing is mandatory" (the single paid-model gate). Human prerequisite: the plan's `deepseek-api-key` blocker (`AGENT_MCP_LIVE=1`).

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ A bad model tier fails fast, before any paid runner is built
▶️ **Do**
```bash
dispatch calibrate --model-tier NotATier
```
👀 **Expect** — stderr `calibrate: unknown modelTier 'NotATier' — expected one of Haiku, Sonnet, Opus`, exit code 1.
✅ **Verify**
- [ ] Exit code is 1 and stderr contains `unknown modelTier 'NotATier'`. *(Grounded: captured live.)*
- [ ] No `AgentMcpRunner` is constructed on the reject path (a factory spy is never called).
🔗 **Proves:** REQ-015 · CAP-011
📎 **Source:** Grounded for the message + exit (live); the lazy-factory guarantee is ⟦U8⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-024).

#### 5.2 · ⚠️ A missing dag file errors consistently across commands
▶️ **Do**
```bash
for c in validate snapshot status run; do dispatch $c --dag-path /tmp/dispatch-demo/does-not-exist.json; done
```
👀 **Expect** — every command returns the same shaped error naming the missing path (e.g. `dag file not found: /tmp/dispatch-demo/does-not-exist.json`).
✅ **Verify**
- [ ] All four commands report the missing file with the offending path included, consistently (today only `validate` does this gracefully).
🔗 **Proves:** REQ-009 · CAP-001, CAP-002, CAP-005, CAP-006
📎 **Source:** ⟦U9⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-025: shared missing-file guard; today `snapshot`/`status`/`run` surface a generic pathless error).

#### 5.3 · ⚠️ Authoring a cycle through the MCP tools is rejected
▶️ **Do**
```bash
# via @adhd/dispatch-tools MCP surface (host-style call), add a dependency that closes a cycle
dispatch tools milestone-add --dag-path "$PLAN" --slug loop --depends-on verify --and-make verify-depend-on loop
```
👀 **Expect** — a structured referential-integrity error; the dag on disk is unchanged.
✅ **Verify**
- [ ] The cycle-forming edit is rejected with a structured error and the dag file is byte-identical afterward.
- [ ] A *valid* `milestone-add` authored via the tools yields a dag that `dispatch validate` passes (no orphans/cycles).
🔗 **Proves:** REQ-007 · CAP-008
📎 **Source:** ⟦U10⟧ inferred — see UNRESOLVED.md (`@adhd/dispatch-tools` MCP tools wrapping DagClient are unbuilt; `dag.milestone_add` is the intended surface).

#### 5.4 · ⚠️ An op-level guard actually runs
▶️ **Do**
```bash
# a dag whose op carries type:"automated", action:"guard" with NO milestone-level duplicate
dispatch run --dag-path /tmp/dispatch-demo/op-guard.dag.json
```
👀 **Expect** — the op's guard command executes and its result lands in `dispatch_log` (not silently `skipped`).
✅ **Verify**
- [ ] An op-level `type:"automated"`/`action:"guard"` with no milestone duplicate produces a real guard result in the log.
🔗 **Proves:** REQ-014 · CAP-006
📎 **Source:** ⟦U11⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-016: route op-level guards through the guard seam).

---

## 6 · Portability & Distribution

#### 6.1 · The SQLite storage adapter round-trips a plan identically to JSON   (happy)
🎬 **Scene.** Priya wants her plans in a database, not loose files. She points the dispatcher at a SQLite-backed serializer and the reloaded plan is identical.
▶️ **Do**
```bash
dispatch snapshot --dag-path "$PLAN" --serializer sqlite:/tmp/dispatch-demo/plans.db
```
👀 **Expect** — the snapshot is identical to the JSON-backed run in §2.2; the plan reloaded from SQLite equals the plan reloaded from JSON (normalized form).
✅ **Verify**
- [ ] A dag written then read via `@adhd/dispatch-serializer-sqlite` equals the same dag written then read via the JSON serializer (adapter parity).
🔗 **Proves:** REQ-008 · CAP-010
📎 **Source:** ⟦U12⟧ inferred — see UNRESOLVED.md (`@adhd/dispatch-serializer-sqlite` + the `--serializer` flag are unbuilt; the `IDagSerializer` contract exists).

#### 6.2 · The dispatcher runs as a real npx binary   (happy)
🎬 **Scene.** Priya drops the tsx alias and installs the real thing.
▶️ **Do**
```bash
npx @adhd/dispatch-cli status --dag-path "$PLAN"
```
👀 **Expect** — the same per-milestone status JSON as §2.3, from a resolved `bin`.
✅ **Verify**
- [ ] `npx @adhd/dispatch-cli status …` resolves the `bin`, runs, and prints the status table (exit 0) from a fresh install.
🔗 **Proves:** REQ-009 · CAP-012
📎 **Source:** ⟦U13⟧ inferred — see UNRESOLVED.md (DEBT-DISPATCH-022: add `bin` field + esbuild `build-bin`; today the CLI runs only via `tsx bin/cli.ts`).

#### 6.3 · The whole subsystem is green, and the cache proves it   (happy)
🎬 **Scene.** The release gate.
▶️ **Do**
```bash
npx nx run-many -t test,build -p dispatch-base-spec,dispatch-core-client,dispatch-serializer-json,dispatch-serializer-sqlite,dispatch-core-optimizer,dispatch-orchestrator,dispatch-plugin-io,dispatch-plugin-gitnexus,dispatch-tools,dispatch-cli
npx nx run-many -t test,build -p dispatch-base-spec,dispatch-core-client,dispatch-serializer-json,dispatch-serializer-sqlite,dispatch-core-optimizer,dispatch-orchestrator,dispatch-plugin-io,dispatch-plugin-gitnexus,dispatch-tools,dispatch-cli
```
👀 **Expect** — first run: all 10 projects green; second run: `Nx read the output from the cache instead of running the command`.
✅ **Verify**
- [ ] First invocation exits 0 across all ten dispatch projects (test + build).
- [ ] Second invocation is a proven nx cache hit (no `--skip-nx-cache` used anywhere).
🔗 **Proves:** REQ-001, REQ-012 · CAP-013
📎 **Source:** SCOPE.md O1; CLAUDE.md §5 (nx cache). The four new projects (`serializer-sqlite`, `plugin-io`, `plugin-gitnexus`, `dispatch-tools`) are ⟦U14⟧ inferred — see UNRESOLVED.md (unbuilt). The algorithm cascade behind `dispatch-core-optimizer` is data-gated (⟦U15⟧, REQ-012).

---

## 7 · Teardown — Back to Zero

🎬 **Scene.** Priya cleans up. Nothing this script created should survive it.

▶️ **Do**
```bash
rm -rf /tmp/dispatch-demo
git -C /Users/nix/dev/node/adhd status --porcelain -- docs/plan/dispatch-completion/demo/fixtures/sample-plan.dag.json
```

👀 **Expect** — `/tmp/dispatch-demo` is gone; the committed fixture is unmodified (empty `git status` line for it).

✅ **Verify**
- [ ] `/tmp/dispatch-demo` no longer exists.
- [ ] The canonical fixture `sample-plan.dag.json` is unchanged (no residue; the demo never mutates the committed plan — every mutating beat copies it into `/tmp/dispatch-demo` first).

🔗 **Proves:** REQ-001 · (hygiene)
📎 **Source:** CLAUDE.md "Test/ephemeral artifacts — one central, always-cleaned location".

---

## 8 · Coverage & Traceability Matrix

### 8.1 Requirements → Beats
| Req ID | Requirement (short) | Proven by beat(s) | Paths (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | All shipped+new dispatch projects build+test green | 2.4, 1.1, 2.1, 2.2, 2.3, 3.1, 4.1, 6.3, 7 | H | ☐ |
| REQ-003 | DispatchUnit carries non-null `execution_mode` | 3.1 | H | ☐ |
| REQ-004 | Snapshot JSON round-trips without Infinity→null | 2.2 | E | ☐ |
| REQ-005 | A complete milestone reports `eligible:false` | 4.1, 4.2 | H/E | ☐ |
| REQ-006 | Runner/persist failure recorded, not thrown | 4.3 | R | ☐ |
| REQ-007 | dispatch-tools author a valid dag; cycles rejected | 5.3 | H/E | ☐ |
| REQ-008 | SQLite serializer reload == JSON serializer reload | 6.1 | H | ☐ |
| REQ-009 | npx-invocable + consistent missing-file behavior | 5.2, 6.2 | H/E | ☐ |
| REQ-010 | IO/gitnexus plugins enrich; optimizer pure w/ null deps | 3.2 | H | ☐ |
| REQ-011 | Causal replan rewires downstream; resume hits terminal | §4 climax | R | ☐ |
| REQ-012 | optimizer-algorithms data-gated (held unless >15%/≥3) | 6.3 | H | ☐ |
| REQ-013 | provider enum extended + enforced by validation | 1.2 | E | ☐ |
| REQ-014 | op-level guard routing executes op guards | 5.4 | E | ☐ |
| REQ-015 | calibrate rejects bad tier before building runner | 5.1 | E | ☐ |
| REQ-017 | **LIVE** — dispatcher completes a real cycle against deepseek end-to-end | 4.live | R | ☐ |

### 8.2 Capabilities → Beats
| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Validate a dag | 1.1, 1.2, 5.2 | ☐ |
| CAP-002 | Snapshot (eligibility/status/cost) | 2.2, 4.2, 5.2 | ☐ |
| CAP-003 | Optimize (greedy pack into DispatchUnits) | 3.1 | ☐ |
| CAP-004 | List eligible milestones | 2.1, 4.1 | ☐ |
| CAP-005 | Per-milestone status report | 2.3, 5.2 | ☐ |
| CAP-006 | Run one orchestration cycle (dispatch+persist) | 4.1, 4.3, 5.2, 5.4 | ☐ |
| CAP-007 | Drive a plan to terminal through real agents | §4 climax | ☐ |
| CAP-008 | Author a dag through MCP tools | 5.3 | ☐ |
| CAP-009 | Enrich snapshot (file sizes / blast radius) | 3.2 | ☐ |
| CAP-010 | Persist/load via storage adapter (JSON + SQLite) | 6.1 | ☐ |
| CAP-011 | Calibrate per-tier base cost | 5.1 | ☐ |
| CAP-012 | npx CLI distribution | 2.4, 6.2 | ☐ |
| CAP-013 | Algorithm cascade selection (data-gated) | 6.3 | ☐ |
| CAP-016 | Live end-to-end dispatch against a real model (deepseek) | 4.live | ☐ |

### 8.3 Unresolved Interfaces & Gaps
15 unresolved interface stubs (⟦U1⟧–⟦U15⟧), all corresponding to *remaining* dispatch-completion work; full list in `UNRESOLVED.md`. Highest impact to confirm first: **⟦U3⟧** (`execution_mode` field on DispatchUnit), **⟦U10⟧** (`@adhd/dispatch-tools` surface), **⟦U12⟧** (`--serializer sqlite:`), **⟦U7⟧** (causal-replan `--to-terminal`), **⟦U4⟧** (enrichment `--enrich` plugins). The two former headline gaps (tool-call execution, publish/name conformance) are **out of scope** — landed directly via BUG-DISPATCH-EXEC-001 / BUG-DISPATCH-PUBLISH-001 (see §2.3). Scope decisions are all resolved — no open dispatcher questions remain.

---

## 9 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §8 is proven. One unchecked binary assertion = FAIL until resolved. Beats grounded live today (1.1, 2.1, 2.2 eligibility, 2.3, 3.1 packing, 4.1, 5.1 message) should pass as-is; ⟦U#⟧-tagged assertions pass only once the corresponding dispatch-completion work lands.
