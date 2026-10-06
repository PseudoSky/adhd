# ADR-0009 — Adopt the v2 `queryModel` grammar (self-similar, position-typed) as the engine's grouping grammar

**Status:** ACCEPTED (2026-10-06; owner approval 2026-10-06, owner pseudosky — "accept").
**Owner:** pseudosky.
**Supersedes:** adhd ADR-0005 — the **grammar surface only** (D1, D2, D4, D5). ADR-0005's ownership decision and its D3 (closed aggregate vocabulary; no user transforms) stand in force.
**Drives:** adoption of the shipped `queryModel` namespace as the engine's forward grouping/aggregation grammar; the promotion of that namespace from `export * as queryModel` to the package's primary surface; the design doc `tmp/data-query-engine/model.md` (its §9.1 "Adopt this as ADR-0009 superseding ADR-0005?"). The original capability items settled under adhd ADR-0005 are re-affirmed, not reopened.
**Grounding:** shipped code, exported additively under the `queryModel` namespace (`packages/data/data-query-engine/src/index.ts:7`; `src/lib/model/index.ts:1-14`). Merge `0b708e7e`, plus `f214713d`, `a661d8e5`. Approved in-session by the owner (pseudosky, 2026-10-06).

## TL;DR for the next agent

**Adopt the merged v2 grammar as the engine's grouping grammar; ADR-0005's grammar is superseded, its ownership decision is not.** One self-similar query node replaces the flat top-level fields: `group_by`/`select` hold nested `QueryExpression`s; a leaf is a query with an `aggregate`; **there is no `having`, `window`, `output`, or `top_n` key**. WHERE and post-group filtering are **one `where` tree** split by a **phase rule** — a leaf's phase is decided *by reference* (does it name a `group_by` output?), and a mixed-phase `_or`/`_not` is a **compile error** (`phase.ts`). Window is the **attribute** `_window` of a fold; the post-window filter is `qualify`; top-N is `order_by`+`limit` with `_other` as `keep:{n,other:true}`. The trap: **do not add a `having`/`window`/`top_n` key back** — the merge is the point, and the phase rule (not types) is what makes a wrong order a real error.

## Context

adhd ADR-0005 (ACCEPTED 2026-10-02) decided the engine owns grouping/aggregation/HAVING via first-class top-level fields on the then-shipped `QueryExpression`. A v2 grammar was subsequently designed and merged to `main`, additively and namespaced as `queryModel` (`src/index.ts:7`), precisely so it could be promoted "only once its ADR lands" (`types.ts:1-6`). That ADR is this one; `0009` is the next free number (`README.md:34-41`; `model.md:5`).

The design doc that supersedes ADR-0005 lives under gitignored `tmp/` and self-identifies the durability defect (`model.md:409`, caveat G1). This ADR is the durable home for the decision; the doc remains the working design.

What is **not** established: the `DataView` promotion and its constructor change are **not** decided here (they are a public-API change, `dataview.ts:213`); only the grammar's supersession is.

## Decision

### D1 — One self-similar, position-typed query node replaces the flat field set

The grammar is a single `QueryExpression` (`types.ts:116-140`) whose slots are **position-typed** (`types.ts:111-115`):

- `group_by` items are a scalar **key** (`string`/`BucketKey`), or a `QueryExpression{name, aggregate}` — a per-group computation (`types.ts:157-158`);
- `select` items are a scalar ref or a **relation-valued nested query** (`types.ts:159`);
- a subquery in a scalar position (`_in`/`_nin`) must select exactly one item (`execute.ts:130-132`).

`group_by`/`select` holding nested queries is what makes the shape self-similar (drill-down, `execute.ts:808-835`). ADR-0005's `HavingExpression`, `AggregateExpression`, `GroupByExpression`, `WindowSpec`-as-query-key, and `top_n`/`output` keys are **retired**.

### D2 — WHERE and HAVING are ONE `where` tree, separated by the phase rule

There is **no `having` key** (`types.ts:123-124`). A predicate leaf's phase is POST iff it references a `group_by` item's `name`, else PRE; top-level conjuncts split (conjunctive pushdown); every `_or`/`_not` subtree must be **phase-pure** or compilation throws `PhaseRuleError` (`phase.ts:61-143`). The rule lives in exactly one module (`phase.ts:11`). This supersedes ADR-0005 D2's representation while preserving its ordering intent.

### D3 — Window is an attribute of a fold (`_window`); `qualify` is the post-window filter

`_window`/`_filter` sit on the fold, not the query (`types.ts:35-48`); the window scopes **this fold's input** (`execute.ts:318-334`). `_window.period` reuses `resolveIsoPeriod`, same as `_period`. A window fold in `select` (broadcast) is evaluated in the **window phase**, and a filter on its output uses `qualify` — a phase the merged `where` cannot express (`types.ts:125-126`, `execute.ts:896-898, 961-971`). This supersedes ADR-0005 D4 (`window` as a query key) and answers the "broadcast-then-filter unexpressible" gap (`model.md:198-202`).

### D4 — Top-N is `order_by` + `limit`; `_other` is a `group_by` modifier, not a key

No `top_n` key. The dropped-tail rollup is `keep:{n, other:true}` on the query (`types.ts:128-134`), implemented as an accumulator **merge** of the dropped groups (`execute.ts:837-847`). `keep` with a post-group predicate is rejected (`execute.ts:926-928`). This supersedes ADR-0005 D5's `top_n`/`output` surface.

### D5 — Output identity (`name`) and input binding (`source`) are distinct; nested `select` relations

`name` is output identity only; `source` binds the input dataset (`types.ts:117-120`, `dataview.ts:260-263`). A name/field collision **within a query** is a compile error (`phase.ts:152-173`). `select`-nesting is parent-scoped; a scalar-operand subquery is top-source-global (`execute.ts:117-144`).

### D6 — The aggregate vocabulary stays closed (extends ADR-0005 D3)

Folds are `_sum/_count/_min/_max/_avg/_distinct_count/_quantile/_ratio_of_sums` (`types.ts:52-69`); arithmetic is `_add/_sub/_mul/_div/_coalesce/_round` (`types.ts:71-77`); `Expr` is `string|number|boolean|null|Fold|Arith` — **no conditional operator** (`types.ts:79`). `_quantile` **declares** `sketch:'exact'|'ddsketch'`; DDSketch is relative-error and mergeable, exact remains the default (`types.ts:50,60-67`; `execute.ts:253-301,367-380`). ADR-0005 D3's rejection of user transforms is upheld.

### D7 — Execution model: fixed phase order, rule-based planner, incremental multi-source view

The phase order is normative and held by the fixed pipeline plus runtime validation, **not** by the types: `where(pre) → group_by → aggregate → where(post) → window → qualify → order_by → distinct_on → offset → limit → select` (`execute.ts:1-7`; `execute.ts:853-975`). The planner is heuristic (index-scan vs scan) from the **PRE half only** (`plan.ts:1-9,79-121`). `DataView` is multi-source with a Z-set delta algebra and O(1)-per-group incremental maintenance **for the invertible monoid fragment only** (`dataview.ts:1-16,173-200`; `zset.ts:1-35`; `indexing.ts:1-14`).

## Consequences

- **ADR-0005's grammar surface is superseded**; `having`, `window` (query key), `output`, `top_n`, and `_nest`'s key are removed from the forward surface. Migration of any consumer using them is required (`model.md:342-357`).
- **The `queryModel` namespace is additive today.** Promotion to the package's primary surface is a semantic-version event for `@adhd/data-query-engine`, and — separately — the model `DataView`'s `[{name,data}]` constructor is a **breaking** change if/when promoted (`dataview.ts:213`, `model.md:210-213`). Promotion is **not** decided by this ADR.
- **Non-invertible folds fall back.** `_min`/`_max` and any shape outside the plain grouped monoid recompute rather than maintain (`dataview.ts:9-12,151`); `_quantile` exact is O(Σ n_g log n_g) (`execute.ts:374`).
- The design doc under gitignored `tmp/` must be treated as working notes; **this ADR is the durable record** (caveat G1, `model.md:409`).

## Alternatives considered

- **(A) Revise ADR-0005 in place.** **REJECTED** — a decision-changing update is a new ADR that supersedes (`README.md:64`); editing the text is forbidden.
- **(B) Leave the merged `queryModel` as a namespaced experiment with no ADR.** **REJECTED** — the code is on `main`, the design lives in gitignored `tmp/`, and the grammar is already exported; an undocumented second grammar is a dangling decision.
- **(C) Keep ADR-0005's grammar and drop v2.** **REJECTED** — v2 subsumes the v1 grammar (nested `select` subsumes `_nest` for aggregates; `keep` subsumes `top_n/_other`; the phase rule subsumes `having`) and is the forward surface the merged code implements.

## What does NOT change

- **ADR-0005's ownership decision stands**: the engine owns grouping/aggregation/post-group filtering; a consumer-side parallel implementation remains forbidden. This ADR supersedes only ADR-0005's grammar *shape*.
- **ADR-0005 D3 stands**: the aggregate vocabulary is closed; arbitrary JS reducer/transform callbacks remain rejected.
- The legacy pipeline when `group_by`/`aggregate` are absent is untouched. No joins/subqueries-as-set-ops, no per-row window functions (LAG/LEAD/rank), no unnest, no recursive queries, no correlated per-row subqueries (`model.md:363-379`).
- `adhd ADR-0001` (stores), `0002` (correct the source), `0003` (CJS-only), `0004` (MCP flat payload), `0006`/`0007`/`0008` — untouched.

## References

- `packages/data/data-query-engine/src/lib/model/{types,phase,execute,plan,canonical,dataview,zset,indexing}.ts` (shipped, `queryModel` namespace).
- `packages/data/data-query-engine/src/index.ts:7`; `src/lib/model/index.ts:1-14`; specs `model.spec.ts`, `model.big-o.spec.ts`, `plan.spec.ts`.
- `tmp/data-query-engine/model.md` (working design; §2.1, §2.5, §2.6, §9.1, §17).
- adhd ADR-0005 (grammar superseded in part); adhd ADR-0006/0007 (partial-supersession status-line precedent, `README.md:39`).
