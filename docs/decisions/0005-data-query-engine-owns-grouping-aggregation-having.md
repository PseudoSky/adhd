# ADR-0005 — The data-query-engine owns grouping, aggregation, and HAVING

**Status:** PROPOSED (2026-10-02). **Draft for owner approval — do not treat as settled.**
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** SPEC `49a62647-5a50-461a-b004-461b9b6bd66f`; plan `3a6f7f34-55ec-43da-a0c3-b82670902099` (stage S3, `48319772-6ab7-454e-b74b-31410e1b6c83`); the open group-by/aggregation items `a672f3ae-373a-44d9-a395-df7a0b62ad8a`, `b383acce-0d81-4424-bd1a-4e1871d687db` / `88fe8643`, `0d6cff76-4b25-4c13-bfd5-cb1dd0b2f806`.
**Grounding:** SPEC `49a62647` (AC-1…AC-15 and PERF-0…PERF-3, with an implemented, green test run at stage S3); windowed-aggregate design `1065364e-0c61-4911-9250-0445d30611f1` and worked example `98a0a7d0-b992-4552-b950-8847b53eb8b6`; the rejection `d2d72095-b65a-4c17-afb2-d46deb3abfa7` whose three grounds this ADR answers; implementation in `packages/data/data-query-engine` (`src/lib/expressions.ts`, `aggregate.ts`, `query.ts`, `parser.ts`).

## TL;DR for the next agent

**The engine now owns grouping, aggregation, and post-aggregation filtering.** Grouping/aggregation attach as first-class top-level fields on `QueryExpression` — `group_by`, `aggregate`, `having`, `window`, `output`, `top_n` — **not** as `_`-prefixed keys inside `where` (the parser whitelists exactly `['_and','_or','_not']`, so a `_`-key would be a silent no-op; the engine now *throws* on an unknown operator instead).

**The phase order is normative and the wrong order is unrepresentable:** `window` resolution → `where` (per row) → `group_by` → `aggregate` (the window scopes the rows fed into the fold) → `having` (over the grouped record) → `top_n` → `output` → the legacy tail (`order_by` → `distinct_on` → `offset` → `limit`). `where` is typed over the raw row; `having` is typed over grouped fields and validated at compile time. An aggregate under `where` **throws**.

## Context

The owner asked for group-by in the engine and the capability was never built, because `dashboard ADR-0002` explicitly *rejected* moving grouping/aggregation into the engine on the factual ground that "the engine has no groupBy/aggregation surface" — so the dashboard built a parallel consumer-side implementation (`groupCells` / `buildLevel` in `agent-dashboard/src/lib/aggregate.ts`).

`dashboard ADR-0002` D2/D5 require the opposite once the capability exists: every filtering capability is engine grammar, never a parallel implementation, and no consumer hand-predicates. That makes the consumer-side implementation exactly the parallel path D2/D5 exist to forbid. `adhd ADR-0002` ("correct the source, never work around") requires the fix to live in the engine. This ADR is the decision request `adhd ADR-0002` D4 requires for new engine behavior, and it is paired with `dashboard ADR-0004`, which supersedes `dashboard ADR-0002`'s grouping scope.

The rejected `_having`-as-sugar design (`d2d72095`) failed on three grounds, each answered here: (a) it claimed the evaluator was untouched while the parser drops unknown `_` keys — this design owns the evaluator and *throws*; (b) it gave WHERE and HAVING one tree with no phase order — this design pins the phase order and makes the wrong order a compile error; (c) it contradicted `dashboard ADR-0002` — this design reconciles it via `dashboard ADR-0004`.

## Decision

### D1 — Expression shape: first-class fields, not reserved keys

`QueryExpression` gains `group_by`, `aggregate`, `having`, `window`, `output`, `top_n`, siblings of `where`/`order_by`/…; the legacy fields are byte-for-byte unchanged.

```
GroupKey        = string | { _bucket: { field: string; seconds: number; offset?: number } }
GroupByExpression = GroupKey[] | { _rollup: GroupKey[] } | { _cube: GroupKey[] }
AggregateFunction = { _sum: f } | { _count: true | f } | { _min: f } | { _max: f }
                  | { _avg: f } | { _ratio_of_sums: { num, den } }
                  | { _distinct_count: f } | { _quantile: { field, q } }
AggregateExpression = { [outputField: string]: AggregateFunction }
HavingExpression = { _and?; _or?; _not?; [field]: NumberOperator | StringOperator | … }
WindowSpec = { field: string; period: string | [string, number] }
```

### D2 — Phase machine: ordered, and the wrong order is unrepresentable

One slot per phase, sequenced by distinct single-valued typed fields:

`SCOPE → WHERE (per row) → GROUP → AGGREGATE (per group) → HAVING (per group) → TOP_N → OUTPUT → order_by → distinct_on → offset → limit`.

`where` is typed over the raw row; `having` is typed over the grouped record (group keys + aggregate outputs), and field names are validated at compile time. A group predicate in `where` is a compile-time throw; a raw-row name in `having` is a validation error naming the unknown field.

### D3 — Closed algebraic aggregate vocabulary; no user transforms

Aggregates are the closed set in D1 (distributive/holistic), mergeable for rollup/cube and top-N `_other`. Arbitrary JavaScript reducer/transform callbacks are **rejected**: a row-stream transform is not a keyed group-fold, cannot express merge/rollup, and would make the expression non-serializable and non-cacheable, breaking the seam's round-trip. (This supersedes `b383acce`'s "via transforms" vehicle for core.)

### D4 — Window composition: the same `_period` resolver, a different phase

`window.period` accepts the same value form as the `_period` operator (`string | [string, anchorMs]`) and resolves through the same `resolveIsoPeriod`. The window **scopes the aggregate**, never row emission: with `output:'rows'` a surviving group emits all its post-`where` rows, including rows whose own timestamp is outside the window. A group with zero in-window rows is **absent** (no identity element is invented).

### D5 — Closed output and row semantics

`output` is `'groups' | 'rows'` (default `'groups'`). `_rollup`/`_cube` emit grouping sets with a `_grouping` marker; `top_n` ranks the final grouped rows (never raw events) and, with `other:true`, emits one `_other` row equal to the merge of the dropped tail. `_bucket` is `floor((t - offset)/seconds*1000)*seconds*1000 + offset`. Empty-window aggregates are absent; `where` compiles to the existing per-row evaluator unchanged.

## Consequences

- The dashboard's parallel `groupCells`/`buildLevel` becomes the forbidden parallel implementation; it migrates onto the engine via the seam (`dashboard ADR-0004`).
- A new engine behavior carries a new public surface — a semantic-version concern for `@adhd/data-query-engine` (minor, additive).
- The engine gains an execution-phase boundary; this is deliberate and is what makes the wrong order unrepresentable.
- `_quantile` is non-algebraic and is computed exactly by sorting per group (O(Σ n_g log n_g)); a mergeable sketch is a documented follow-up.

## Alternatives considered

- **(B) Fit the capability inside `dashboard ADR-0002` without superseding.** **REJECTED** — ADR-0002 does not merely omit grouping; it decides it consumer-side. The capability cannot fit within it as written.
- **(C) Leave grouping consumer-side.** **REJECTED** — it is the parallel implementation ADR-0002 D2/D5 forbid once an engine capability exists, and it leaves `_period`/grammar duplicated.
- **A bespoke `_having`-in-`where` sugar.** **REJECTED** (already, `d2d72095`).

## What does NOT change

- The legacy pipeline when `group_by`/`aggregate` are absent runs byte-for-byte; no dirty-flag or behavior change.
- No `select`/projection, no joins/subqueries, no per-row window functions (LAG/LEAD/rank), no top-N-per-group inside the engine, no materialization.
- `adhd ADR-0001` (stores), `adhd ADR-0002` (correct the source — the governing argument *for* this), `adhd ADR-0003` (CJS-only), `adhd ADR-0004` (MCP flat payload) — all untouched.
- `order_by`/`distinct_on`/`offset`/`limit` semantics — unchanged.

## References

- SPEC `49a62647-5a50-461a-b004-461b9b6bd66f` (AC-1…AC-15, PERF-0…PERF-3).
- Design `1065364e-0c61-4911-9250-0445d30611f1`; worked example `98a0a7d0-b992-4552-b950-8847b53eb8b6`; rejection `d2d72095-b65a-4c17-afb2-d46deb3abfa7`.
- Implementation: `packages/data/data-query-engine/src/lib/{expressions,aggregate,query,parser,errors}.ts`.
- `dashboard ADR-0002` (`agent-dashboard/docs/decisions/0002-all-data-handling-through-query-engine.md:49,53`) and `dashboard ADR-0004` (this reconciliation).
