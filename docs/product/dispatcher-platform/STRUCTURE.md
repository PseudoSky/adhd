# Structure — as a delta on what exists

**Status:** ANALYSIS. Companion to [`ROADMAP.md`](./ROADMAP.md) and
[`GOAL.md`](./GOAL.md). Supersedes the greenfield "new shape" sketched in conversation,
which invented a parallel vocabulary for packages that already ship.

---

## 1. Why this is a delta, not a design

An earlier synthesis proposed `domain / contracts / app / kernel / ext / hosts` as a new
package layering. That was drawn greenfield and was wrong on its own terms: **the repo's
existing tier vocabulary already is that layering**, and twelve published packages already
occupy it.

| Invented layer | Already shipping as |
|---|---|
| `domain` types | `agent-base-types`, `dispatch-base-spec` |
| `domain/prompt` | `agent-store-prompts` |
| `domain/session`, `execution` | `agent-store-runtime` (sessions, messages, tasks, task_events) |
| `contracts/provider` | `agent-core-provider` |
| `contracts` policy | `agent-core-policy` |
| `kernel/budget` | `agent-plugin-budget` |
| `kernel/loop` | `agent-engine-orchestrator`, `dispatch-orchestrator` |
| `app` compile | `agent-engine-compiler` |
| `ext/*` | `agent-plugin-sanitize`, `agent-generator-plugin` |

`base → core → store → engine → plugin` maps onto domain → contracts → persistence →
orchestration → optional extension. **No new vocabulary is needed and none should be
introduced.** All twelve agent packages are publishable (`private: false`), so they are a
consumable family, not internal detail — the substitutability quality factor applies to them
individually.

The useful question is therefore not "how should packages be arranged" but **"which existing
package enforces each invariant, and what is the smallest change that makes it true?"**

## 2. Where state actually lives today

| Store | Path | Holds | Owner |
|---|---|---|---|
| `registry.db` | `~/.adhd/agent-registry/production/data/` ✔ | prompts, tools, policy, provider, compiler tables | resolved by `agent-core-env` for the whole registry family |
| `agents.db` | `~/.adhd/agent-mcp/` ✔ | `sessions`, `messages`, `tasks`, `task_events`, `experiment_assignments` ✔ | `agent-store-runtime` + the `agents` table stranded in the host |
| `backlog.db` | `~/.adhd/backlog/production/data/` ✔ | work items, dependencies, claims | `entrypoint/backlog` |
| `dag.json` | in-repo, per plan | plan definition **and** the execution/observation record | `dispatch-*` |

Four locations, three engines, one of them a lock-free JSON file. **I2 (a claim and its
execution record must commit together) currently spans `backlog.db` and `dag.json`** — two
stores, no shared transaction, one of them not even a database.

## 3. Invariants mapped to existing owners

| # | Invariant | Owner today | Delta required |
|---|---|---|---|
| **I1** | A task is claimed by at most one plan | `backlog` `claim.ts` — CAS lease exists ✔ | **Plan-scope the claim.** Needs a ruling on SPEC.md §5.3, whose renew path is specified as "no contention check, ever" ✔ |
| **I2** | Claim + execution record commit together | **nobody** — split across `backlog.db` and `dag.json` | **The one real structural move.** The observation record leaves `dag.json` for backlog's store |
| **I3** | Observations append-only, never lost | **nobody** — `dag.json` is rewritten wholesale, last-writer-wins | Falls out of I2 if the new home is append-only |
| **I4** | A spend cannot exceed a cap | `agent-plugin-budget` — real, deployed, enforcing ✔ | Two gaps: it loads via operator config not by default, and caps are evaluated around calls rather than as `reserve → commit/release` |
| **I5** | A task needing a session cannot run without one | `agent-store-runtime` owns sessions ✔; `dispatch-base-spec` cannot express the requirement | `DispatchUnit` gains session semantics; `agent-runner.fire()` stops sending `{agent_name, prompt}` only ✔ |
| **I6** | A guard verdict gates progression | `dispatch-orchestrator` — guard execution, correction injection, dry-run default | None structural |
| **I7** | Tool grants survive composition → runtime | `agent-store-tools` + `agent-engine-compiler` produce them; `agent-engine-orchestrator` drops them | `toResolveResult` returns `{content, id}` only ✔ — widen the carrier |

**Five of seven already have an owner.** Two need work that is a change of *semantics*, not
of structure (I1, I4). One needs a widened return type (I7). One needs a field (I5). **Only
I2 moves data between packages.**

## 3b. The dispatch family, measured

| Package | LOC (src, non-spec) | In-repo importers | Role |
|---|---|---|---|
| `dispatch-orchestrator` | 2233 ✔ | 19 | cycles, `agent-runner`, persistence |
| `dispatch-core-optimizer` | 1885 ✔ | 19 | packing, eligibility, cost model |
| `dispatch-base-spec` | 1522 ✔ | 38 | `types.ts`, `validate.ts`, `migrate.ts` — the widest-imported package in the family |
| `dispatch-core-client` | 175 ✔ | 10 | `DagClient` — reads/writes the plan file |
| `dispatch-serializer-json` | 91 ✔ | 7 | dag.json serialization |
| `dispatch-base-types` | **4** ✔ | **0** ✔ | **an unfilled generator stub** |

`dispatch-base-types` is a scaffold that was never populated — its entire source is a
function returning its own name — and it is **published to npm** at 0.1.0 with zero
importers anywhere. It should be deprecated and unpublished, not carried. (Already noted as
an orphan-delete target in the plan corpus; the deferral has been dangling because it
pointed at a plan directory that moved.)

### How the deltas land here

**D1 forces a type split in `dispatch-base-spec`.** `types.ts` currently defines both halves
of `dag.json` in one place: plan *definition* (`MilestoneDag`, `OperationDag`, `providers`,
`effort_max_tokens`) and the *observation record* (`OperationSnapshot`'s `attempt_count` /
`guard_result` / `guard_output` / `tokens_actual`, and `DispatchLogEntry.turns`/`.results`)
✔. Under D1 those separate: definition types stay file-shaped and authored upstream;
observation types become a store schema. With 38 importers this is the highest-blast-radius
change in the plan, and it is a type-level split rather than a behavioural one — which makes
it mechanical, but wide.

**`dispatch-serializer-json` and `dispatch-core-client` shrink, and may not survive.** Both
exist to move `dag.json` in and out of memory. If the observation half moves to a store and
the definition half becomes a read-mostly input produced upstream (ruling D-E), then 266 LOC
across two packages is serving a file that is no longer written during execution. **Open
question, not a conclusion:** whether they collapse into one read path or remain as the
definition-side reader. Decide during D1 rather than assuming either.

**`dispatch-orchestrator` loses code under D-D.** The ratified seam plan deletes the
hand-mirrored wire types (`agent-runner.ts:19-102`) and the `toAgentMcpProviderConfig`
translation shim (`:231-278`) ✔ once dispatch depends on the agent client in-process. D2
lands in the same file — `fire()` currently sends `{agent_name, prompt}` only ✔. **Both
changes touch `agent-runner.ts`; sequence them together rather than twice.**

**`dispatch-core-optimizer` is untouched structurally**, but its inputs are wrong: the cost
model's sentinel multipliers assume a ~90% cache-hit rate the system never requests. That is
a data fix (D4-adjacent), not a package change — the packer is fine, its arithmetic is fed
a fiction.

## 4. The four deltas, in dependency order

**D1 · The observation record leaves `dag.json`.**
Plan *definition* stays a file — authored upstream (ruling D-E puts authoring in sox's
`workflow:plan-builder`, not here), reviewable in a diff, and already what `--dag-path`
consumes. Execution *state and observations* move into backlog's store, as a scheduling
capability slot on the plugin host that `PLUGIN_ARCHITECTURE.md` §2.1 already types and
whose §2.2 says slots are added "when a real second consumer exists."
Satisfies I2 and I3. Blocked on the I1 ruling.

**D2 · Sessions become expressible in dispatch.**
`DispatchUnit` carries session requirement; `ensureAgent`/`fire` stop firing ephemeral.
Satisfies I5, and unlocks HITL, chat injection, streaming, and D-G(2) provider binding —
all four already built.

**D3 · Tool grants stop being discarded.**
Widen `toResolveResult` past `{content, id}`. Satisfies I7.
Smallest change on the list; unblocks the "intelligent" half of the swarm claim.

**D4 · Budget becomes a precondition, not a deployment choice.**
Default-load the plugin, and move caps to `reserve → commit/release` so a cap blocks before
spend rather than after. Satisfies I4.

## 5. What does not change

- **No new tier vocabulary.** `base/core/store/engine/plugin` stays.
- **No package merges.** Three hosts, ~20 published libraries, unchanged identities.
  `@adhd/backlog` keeps its npm surface and MCP tools; `agent-mcp` stays a standalone server.
- **No new "app layer" package.** D-D already ratifies `createAgentEngineClient()` as the
  single orchestration home; that ruling is the app layer.
- **Policy stays on hold** (O-1).
- **Retrieval stays out** (D-A).

## 6. What this reframes

The five critiqued structures were answers to a question this repo has already answered. The
tier convention is the layering; the twelve packages are the implementation; the rulings in
`agent-final/GOAL.md` already name the orchestration seam.

**The remaining work is four deltas, one of which moves data and three of which change
semantics inside packages that already exist.** That is a materially smaller and more
tractable proposition than any of the five structures — and it is the honest one, because it
starts from what is on disk rather than from a diagram.

The open decision is unchanged and is now sharper: **I1's plan-scoped claim semantics**,
because D1 is blocked on it and everything else follows D1.
