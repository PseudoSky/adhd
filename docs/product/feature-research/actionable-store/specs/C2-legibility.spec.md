# C2 — Structural legibility & dependent-aware order

> **Ticket:** `ac911229-4530-4406-a43a-fbfe97fa3824` (HIGH) · component `9a7bf578`
> **Design:** `../DESIGN.md` §5 AC2 · **Conceptual test:** `../CONCEPTUAL_TEST.md` §C (the contradiction), §B.2, §D.9
> **ADRs read:** ADR-0001 (store atomicity), ADR-0002 (correct the source), ADR-0003 (CJS), ADR-0004 (flat payload).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 1 (kind-scope half; the dependent-weight half may be cut to Wave 3 per DESIGN §4) · **Dependencies:** none — C2 does **not** depend on C1 (`resolveUidPrefix` is not needed to widen `related`/`order`; the ticket body's "Depends on C1" is stale and corrected by a delta) · **Evidence requirement:** `nx test backlog` green on the real-store seeded graph, with the AC1–AC6 negative controls (each must go RED) — exit-code keyed, not stdout.

## Summary

Make every live relation legible and make `view:"order"` reflect unblock-worth. Three moves: (1) the `related` projection exposes `relates_to` + `part_of` + `blocks` with a rel tag; (2) `queryOrder` stops force-scoping to `kind:'issue'` and orders over every member kind the filter selects; (3) add **outbound `blocks` + a transitive-dependent count** to the card, and make that count a deterministic second sort key inside the Kahn order. The `part_of` cardinality rule already exists in code — it is documented and asserted here, not invented.

## Premise corrections (read before implementing)

1. **The ticket's line citations are stale by construction.** The hardcoded kind filter lives inside `queryOrder` (in `entrypoint/backlog/src/query/query.ts`) as `nodeFilter.kind = 'issue'`; the queue is a plain FIFO `queue.shift()`. Cited by **symbol** — line numbers rot on every edit (three independent reviewers caught them drifting).
2. **The 08102d9a/260d6b34 contradiction is resolved by source:** `queryOrder` **is** a real Kahn sort over `blocks` returning `{ok:true,order}` / `{ok:false,cycle}`; the defect is purely the `nodeFilter.kind = 'issue'` assignment. So AC2 is **kind-scope**, not "ordering does not work". Record this resolution in the ticket before coding (the ticket already instructs this as "first task").
3. **`part_of` cardinality is documented in code already.** `EDGE_KIND_TABLE` (in `write/catalog.ts`) declares `part_of` `issue → issue`, `n:1`; the generic `checkMultiplicityTx` gate therefore already throws `SingleValuedRelationConflictError` (in `write/errors.ts`) naming the pre-existing target. AC6 is therefore **document + assert**, not implement. The only real gap is prose.
4. **`resolveBlockers` already exists** (in `card.ts`) — it returns the non-terminal *incoming* blockers. What is missing is the *outbound* `blocks` set and the dependent count. Do not conflate them.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | src/query/types.ts | modify | 70 | 90 |
| entrypoint/backlog | src/query/card.ts | modify | 200 | 300 |
| entrypoint/backlog | src/query/query.ts | modify | 220 | 320 |
| entrypoint/backlog | src/query/views/stats.ts | modify | 80 | 80 |
| entrypoint/backlog | docs/…/DATA_MODEL.md (or CONTRACT.md) | modify | 60 | 80 |

No new files. No write-layer change (`part_of` multiplicity is already enforced).

## Interface changes

### src/query/types.ts — related rel tag + two new pseudo fields

```typescript
// AFTER
export interface IIssueRef {
  uid: string;
  title: string;
  status: string;
  /** Which live relation produced this ref. ADDITIVE — existing consumers reading uid/title/status are unaffected.
   *  Widened to include the reviewed relations so `related` can surface them:
   *  `similar_to` (C9's reviewed similarity link) and the reserved `duplicate_of`. */
  rel?: 'relates_to' | 'part_of' | 'blocks' | 'blocked_by' | 'similar_to' | 'duplicate_of';
}

export type IIssuePseudoField =
  | 'body' | 'citations' | 'notes' | 'auditTrail' | 'blockers' | 'related'
  | 'blocksOut'      // NEW: issues THIS one blocks (outbound `blocks`), live only
  | 'dependents'     // NEW: transitive count (number of nodes that reach this one via `blocks`)
  | 'partOf'         // NEW: the single parent this item is `part_of` (or null)
  | '_score' | '_vector';

export interface IIssueCard {
  // ...existing...
  /** Outbound `blocks` — issues that cannot start until this one is terminal. */
  blocksOut?: IIssueRef[];
  /**
   * Transitive dependent count: how many nodes reach THIS node via `blocks`
   * (inclusive of direct dependents). Deterministic, scope-bounded.
   */
  dependents?: number;
  /** The `part_of` parent, if any (n:1 — at most one). */
  partOf?: IIssueRef | null;
}
```
Add the three names to `ISSUE_PSEUDO_FIELDS` (`types.ts:79-88`) so `assertKnownIssueFields` accepts them. **`related` keeps its name and gains rels** — the migration note's consumer audit applies.

### src/query/card.ts — relation projections

```typescript
// AFTER — resolveRelated extended (rel tag), plus two new resolvers
export async function resolveRelated(graph, issueId, outgoing?): Promise<IIssueRef[]>;  // now unions relates_to + part_of(out+in) + blocks(out+in)
export async function resolveBlocksOut(graph, issueId): Promise<IIssueRef[]>;           // outbound blocks, live targets only
export async function resolveDependents(graph, issueId, scope?: Set<number>): Promise<number>; // transitive, cycle-safe BFS over outgoing blocks
export async function resolvePartOf(graph, issueId, outgoing?): Promise<IIssueRef | null>;
```
`assembleIssueCard` (`card.ts:269`) wires `blocksOut`/`dependents`/`partOf` behind `want(...)` flags exactly like `blockers`/`related`. **Scope rule:** on a list page, `dependents` is computed within the page's candidate id set (passed via `IAssembleIssueCardOptions.scope`) so N-item pages stay bounded; on a single `get`, scope is unbounded but cycle-safe.

### src/query/query.ts — order scoped to every member kind, deterministic tiebreak

```typescript
// BEFORE (queryOrder in query.ts): nodeFilter.kind = 'issue'; queue FIFO (queue.shift())
// AFTER:
async function queryOrder(handle, input): Promise<ITopoOrderResult>
```
Base node filter **derives from the filter exactly as `queryList` does** (`resolveEdgeScopedFilterIds` in `query.ts`), and **omits `kind:'issue'` when a filter is present** — every live, non-superseded node in the candidate set participates. `blocks` edges are considered when both endpoints are in-set (unchanged).

**Deterministic tiebreak.** Replace the FIFO `queue.shift()` with a priority queue ordered by:
1. **transitive outbound dependent count, descending** (how many nodes reach this one via `blocks`, within scope — computed once per node by reverse-BFS over the in-set `blocks` graph);
2. **priority rank ascending** (`priority.meta.rank`; missing rank sorts last — same convention as `sortByPriorityRank` in `query.ts`);
3. **uid ascending** (final deterministic total order).

## Behavioral changes

### `get {fields:["related"]}` (AC1)
- **Change:** `resolveRelated` now returns `relates_to`, `part_of` (both directions collapsed to the parent), and `blocks` (both directions, tagged `blocks`/`blocked_by`), deduped by uid, each carrying `rel`.
- **Backwards compat:** a card that previously returned only `relates_to` now returns more rows. Consumers keying on count must be audited (ticket migration note). **Do not remove `blockers`** — it stays the non-terminal incoming subset.

### `view:"order"` (AC2)
- **Change:** drop the unconditional `kind:'issue'`; scope by the resolved filter candidate set. Every scoped member id appears **exactly once** (dedup by uid; the `queryNodes` result is already unique by node).
- **Unfiltered order** still needs a kind to bound the store; keep `kind:'issue'` only when **no** `filter.plan`/`filter.project`/`filter.component`/`filter.kind` is present, and document that fallback.

### `blocksOut` + `dependents` (AC3)
- **Change:** new card fields, opt-in pseudo fields. `dependents` is a count; `blocksOut` is a typed list.

### Cycle (AC5)
- **Unchanged:** `order.length !== issues.length` → `{ok:false, cycle:[...]}` (the `queryOrder` cycle arm). A regression test must keep this green.

### `part_of` second write (AC6)
- **Change:** none in code. A second `part_of` on the same source throws `SingleValuedRelationConflictError` (via `EDGE_KIND_TABLE` `n:1` + `checkMultiplicityTx`) naming the existing target. **Document** the cardinality beside the relation vocabulary, and assert the typed error.

## Data / migration steps

- **None.** No writes, no schema change. `related`'s widening is a read-shape change only; no backfill.
- Update the relation-vocabulary prose (`docs/…/DATA_MODEL.md` or `write/CONTRACT.md`) to state `part_of` is `n:1` (one parent), the error on a second write, and the order tiebreak rule.

## Test list (each AC → a test, with its negative control)

| AC | Test | Negative control (must go RED) |
|----|------|-------------------------------|
| AC1 | `get {fields:["related"]}` on an item with a live `part_of` **and** a live `blocks` returns both, each with a `rel` tag | A test asserting `related` is empty when a `part_of` edge exists must fail |
| AC2 | `view:"order" {filter:{plan:<umbrella>}}` includes non-`issue`-kind scoped members; every scoped id appears exactly once | Re-insert the `nodeFilter.kind = 'issue'` assignment in `queryOrder` → non-issue members vanish → must go RED |
| AC3 | An item with outbound `blocks` returns `blocksOut` non-empty and a numeric `dependents` | A card that omits both, or returns `dependents:0` for a node with dependents, must fail |
| AC4 | Same graph, two runs → identical sequence. Two nodes equal in-degree: the one with more transitive dependents comes first; **swap the weights, assert the order flips** | A FIFO `queue.shift()` in `queryOrder` must fail the swap assertion |
| AC5 | A cyclic `blocks` set returns `{ok:false, cycle:[...]}` naming all members | A build that returns `{ok:true}` on a cycle must fail |
| AC6 | A second `part_of` write throws `SingleValuedRelationConflictError` naming the existing parent; the docs assert it | A build silently accepting a second parent, or throwing a different/untyped error, must fail |

Determinism is proven with two sequential runs over one seeded store — no timing.

## Blast radius (gitnexus)

- `resolveRelated` — caller: `assembleIssueCard` (in `card.ts`); its consumers are every `get`/`query` card with `fields:["related"]`. Widening the result is **additive rows**, not a signature change.
- `assembleIssueCard` / `assembleIssueCards` — callers: `query/get.ts`, `query/query.ts` (list/ready/stale), `views/semantic.ts`, and the six write verbs that embed card-shaped outcomes (update/transition/claim/relate/move/delete). New fields are opt-in; the default card is byte-for-byte unchanged.
- `queryOrder` — mounted via the `query {view:"order"}` dispatch in `api.ts`; sole caller. Widening the scope changes the returned `order` array — any consumer that assumed `kind:'issue'` must be audited (design flags this).
- `partOfRollup` (in `views/stats.ts`) — already transitive; **no change needed**, but its doc comment is the precedent for the `dependents` BFS (cycle-safe, counted once).
- `IIssuePseudoField` — a closed union guarded by `isKnownIssueField` (in `types.ts`); adding names is safe; removing any would break `assertKnownIssueFields`.

## Independent segments (execution order)

### Segment 1 — Types + card projections (files: `query/types.ts`, `query/card.ts`)
- Deps: none. Read: `types.ts:51-190`, `card.ts:182-353` (~230 tok). Out ~350 tok.
- Add `rel` to `IIssueRef`; add 3 pseudo fields; add resolvers + card wiring.

### Segment 2 — Order kind-scope + tiebreak (file: `query/query.ts`)
- Deps: none functionally, but reads Segment 1's types for the priority key. Read: `query.ts:409-460` (base-filter precedent), `:769-899` (~220 tok). Out ~330 tok.
- Derive the node filter from `resolveEdgeScopedFilterIds`; add the priority-queue comparator + transitive-dependent-count pass.

### Segment 3 — Docs + AC6 assertion (files: `write/CONTRACT.md` / `DATA_MODEL.md`, test files)
- Deps: Segments 1-2. Read ~60 tok. Out ~120 tok.

## Documentation

- Relation vocabulary: `part_of` is `n:1`, second write throws `SingleValuedRelationConflictError`.
- `view:"order"` scope + tiebreak (dependents desc → priority rank asc → uid asc).
- `related` now carries `rel`; `blocksOut`/`dependents`/`partOf` are opt-in pseudo fields.
