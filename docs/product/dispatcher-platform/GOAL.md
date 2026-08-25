# Dispatcher Platform — Goal

**Status:** Framing document. Sets the problem, the objective, and the bar.
The path to get there is [`ROADMAP.md`](./ROADMAP.md), alongside this file.

> **Not to be confused with** [`docs/plan/agent-final/GOAL.md`](../../plan/agent-final/GOAL.md),
> which holds the *ratified engineering rulings* (D-A…D-G, O-1…O-3) for the agent and
> dispatch subsystems. That document governs. This one explains what we are trying to
> build and why.

---

## 1. Problem Statement

Today all agent work runs inside somebody else's client. Claude Code and opencode decide
what tools exist, which providers are reachable, what happens when a task needs a human,
and what a run costs. Every one of those is gated on a vendor's roadmap, and none of them
can be changed from here.

At the same time, this repo already contains most of the machinery to not need them:
`backlog` tracks work, `agent-mcp` runs agents, and `dispatch` plans and schedules. The
parts are real and largely built.

**They do not form a system.** They are three projects that share a repository and almost
nothing else. Work does not flow between them programmatically — the loop from "here is a
task" to "an agent did it" to "the task is done" closes only because a human runs commands
in the right order.

There is also a working counter-example in the same house: **sox**, a fully-automatic
workflow system already in production use. It has less raw capability than this stack and
does something this stack cannot — it runs unattended, recovers from its own failures, and
keeps going without supervision.

So the problem is not missing features. **It is that the features are disconnected, and
that nothing runs unattended.**

## 2. Current State

Measured against sox across 41 features, this stack covers **39 of them**. Coverage is not
the gap.

**What works today:** durable plan graphs, prompt composition, agent compilation, dispatch's
whole execution cluster (packing, eligibility, guards, dry-run, cost accounting), budget
caps that actually block, and per-unit provider dispatch that genuinely reaches non-Claude
providers.

**What is built but cannot be reached:** human-in-the-loop suspend/resume, chat injection,
and live output streaming all work — and none are reachable from `dispatch`, because it
fires session-less tasks and those features need a session. Prompt composition produces tool
grants that the runtime discards.

**What does not exist:** anything that runs unattended. No supervisor, no heartbeat, no
self-healing, no crash recovery, no stuck-work backstop, no replay. `dispatch run` executes
exactly one cycle; the multi-cycle loop is written but nothing calls it.

**What is quietly unsafe:** the only durable record of what the system actually did —
guard output, real token counts, attempt history — lives in a JSON file written without a
lock. Two concurrent cycles silently destroy it, and that data cannot be regenerated.

## 3. Objective

**One interactive CLI, backed by an agent swarm that runs unattended, on a substrate we
own.**

Concretely, three things must become true:

1. **It replaces the vendor clients.** Real coding sessions start here, unforced, because
   it is better for the work — not out of discipline.
2. **It reaches sox parity.** It runs unattended, recovers from its own failures, and does
   not need a human between cycles.
3. **It is provider-neutral.** The same agent completes work through different providers,
   swaps mid-conversation without losing context, and fails over when one dies.

sox is the benchmark rather than a specification, because everything in it is already
proven in use. The headline measure is simple: **how long can it run without a human?**

---

## 4. Capabilities

The ten things this platform is for. Status is honest as of writing.

| # | Capability | What it means | Status |
|---|---|---|---|
| 1 | **Plans that outlive the session** | A plan is a durable, inspectable, re-runnable artifact — diffable and reviewable like code, not a chat mode that evaporates | Real |
| 2 | **Unattended execution that recovers** | Take a plan to done without supervision; survive crashes, restarts, and stuck work | Not built |
| 3 | **Provider neutrality** | Route by fit and cost; swap providers mid-session; survive an outage or a price change | Static today |
| 4 | **Prompts as versioned software** | Reusable components, context-conditional composition, content-hashed caching — prompt engineering as artifacts, not strings | Built; output discarded at runtime |
| 5 | **Cost as an enforced primitive** | Caps by task, session, agent, and global that block rather than warn | Deployed and enforcing |
| 6 | **Cost-aware planning** | Work packed to the context window, routed by tier, against calibrated real overhead | Real; running on optimistic inputs |
| 7 | **Human-in-the-loop steering** | The system asks, waits durably, and resumes — and a human can redirect mid-flight | Shipped; unreachable from dispatch |
| 8 | **Structural work exclusivity** | Two plans cannot claim the same task, enforced by the store rather than by convention | Target |
| 9 | **Evidence-gated execution** | Guards verify outcomes, failures inject corrections, dry-run is the default — trust the check, not the model | Dispatch's strongest area |
| 10 | **One definition, many transports** | A single operation surface served as CLI, MCP, and HTTP without rewriting it three times | Real |

**The shape of the gap.** Capabilities 1, 4, 6, 9, and 10 are real today. Of the five that
are not, four are *connection* problems rather than construction problems — 7 is built but
unreachable, 4's output is thrown away at a boundary, 3 is half-wired, 8 needs a constraint
on data that already exists. Only 2 is genuinely new work.

## 5. Quality Factors

The five axes every design decision gets judged on. Each earned its place by something that
actually went wrong.

### 5.1 Verifiability
Every claim resolves to a runnable receipt. No receipt, no claim.

*Why:* a nine-item sample of open backlog entries found nine describing code that had since
changed, and three false claims reached the roadmap itself before being caught. Documents
decay silently; only executable evidence does not.

### 5.2 Recoverability
Nothing irreplaceable sits anywhere it can be lost.

*Why:* the sole record of what the system did — guard output, real token counts, attempt
history — is written to an unlocked file with last-writer-wins semantics, and cannot be
recomputed from anything else.

### 5.3 Structural enforcement over convention
The store refuses invalid states. Code is not trusted to remember.

*Why:* the recurring pattern across this stack is data that is *recorded* and honored by
nothing — assignments no scheduler reads, policies rendered as advisory prose, an
integration loop that closes only because a human runs the right command next.

### 5.4 Substitutability
Providers, transports, and backends are seams, not assumptions. Nothing load-bearing should
be replaceable only by rewrite.

*Why:* this is the entire premise. Vendor clients are being replaced precisely because they
cannot be changed from here — a replacement that hardcodes its own assumptions has moved
the lock-in rather than removed it.

### 5.5 Cost-boundedness
Every execution path has a cap that bites, and estimates that can actually be met.

*Why:* the planner's cost model assumes a 90% cache-hit rate while the system never requests
caching — so packing decisions are optimized against a number that cannot occur.

### The tension worth naming

**5.3 and 5.4 pull against each other.** Structural enforcement wants one store with real
constraints across everything. Substitutability wants seams you can swap independently.
Every storage and boundary decision in `ROADMAP.md` is a bet on where that line falls, and
it is the first thing to re-examine if implementation turns painful.
