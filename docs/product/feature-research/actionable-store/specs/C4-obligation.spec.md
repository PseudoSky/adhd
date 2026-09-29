# C4 — Obligation: declared, typed requirements on an item (closed predicate core)

**Ticket:** `1c53784d-4d9e-4f85-b0f3-5199a8f7ea79` · priority HIGH ·
component `9a7bf578` (backlog). **Design:** `actionable-store/DESIGN.md` §2
Primitive 3, §5 AC4, §7 conditions 4 & 6. **Depends on:** C3 (evidence).
**Blocks:** C5, C6.

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 2 · **Dependencies:** C3 (non-terminal; also the shared C3 Segment-A foundation amendment) · **Evidence requirement:** `obligation.spec.ts` + `card.obligations.spec.ts` (real store) with the AC1–AC6 negative controls; the additive-floor test must prove an obligation-free item still works. Runs default.

> **Research note.** The prior-art basis for the "named predicate, scoped to a
> transition, evaluated at transition time, fail-closed, returning a reason
> set" shape (Jira/GitHub/GitLab/Argo/Harness/CodePipeline gates) is already
> folded into `DESIGN.md` §2 Primitive 3. No new dependency; the predicate
> grammar is ~80 lines of pure TypeScript. **CEL is deliberately out of v1**
> (design §7 condition 4 — zero consumers, below the ≥2-consumers bar of
> Invariant 6); **no `timeout` field** (design Primitive 3, drop-not-undefine).

## Summary

Add an **Obligation** — a declared, typed requirement attached to an issue —
and two verbs, `obligate` (declare) and `unobligate` (retire). The predicate
vocabulary is a **closed core** in code (`evidence{kind,min?}`,
`blockers_terminal()`, `relation{type,direction}`, `all_of`, `any_of`, `not`),
validated recursively at write time and evaluated later by C5 (at a transition)
and C6 (on read). Obligations are data on the item (a separate node keyed to
it); nothing is stored as a status. `evidence.min` counts **distinct verified**
attestations; `unverified` never counts. An item with no obligation is
unaffected — the honest floor (`actionable:true` for an unblocked,
obligation-free item) is preserved and asserted.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| backlog | `entrypoint/backlog/src/write/obligation.ts` | create | 0 | 850 |
| backlog | `entrypoint/backlog/src/write/errors.ts` | modify | 120 | 160 |
| backlog | `entrypoint/backlog/src/write/catalog.ts` | modify (foundation — shared with C3) | 0 | 0 |
| backlog | `entrypoint/backlog/src/query/types.ts` | modify | 200 | 160 |
| backlog | `entrypoint/backlog/src/query/card.ts` | modify | 200 | 180 |
| backlog | `entrypoint/backlog/src/api.ts` | modify | 120 | 120 |
| backlog | `entrypoint/backlog/src/index.ts` | modify | 40 | 20 |
| backlog | `entrypoint/backlog/src/write/obligation.spec.ts` | create | 0 | 750 |
| backlog | `entrypoint/backlog/src/query/card.obligations.spec.ts` | create | 0 | 220 |

**Foundation dependency.** This spec uses the shared `has_obligation` row and
the `obligation` node kind specced in **C3 Segment A** (append to
`EDGE_KIND_TABLE`; add `'obligation'` to `RECOGNIZED_NODE_KINDS`). If C3 has
not landed, C4 Segment A must issue the same foundation request. `tx.ts`,
`catalog.ts`, `errors.ts`, `audit.ts` are frozen by `write/CONTRACT.md` — the
catalog/vocabulary rows are a **request to the foundation owner**, not a
unilateral edit.

## Interface changes

### `entrypoint/backlog/src/write/obligation.ts` (NEW)

```typescript
export type IObligationSeverity = 'block' | 'warn';
export type IRelationDirection = 'in' | 'out';

/** The CLOSED predicate core (design Primitive 3). No CEL, no dynamic leaf,
 *  no timeout. Validated recursively by `assertValidPredicate`. */
export type IPredicate =
  | { op: 'evidence'; kind: string; min?: number }
  | { op: 'blockers_terminal' }
  | { op: 'relation'; type: string; direction: IRelationDirection }
  | { op: 'all_of'; of: IPredicate[] }
  | { op: 'any_of'; of: IPredicate[] }
  | { op: 'not'; of: IPredicate };

export interface IObligationAppliesTo {
  /** Absent ⇒ applies to any from-status. */
  from?: string;
  /**
   * REQUIRED (DESIGN §2 Primitive 3, after the red-team fix — an earlier draft
   * left `to` optional, a silent dual with no error and no wrong answer
   * surfaced). Scopes a TRANSITION into that status: a concrete status name, or
   * '*' for "any terminal transition". Evaluated by the C5 gate at the
   * transition, and surfaced by the C6 verdict as a *prediction* of that gate.
   * There is NO separate "actionability-only" (`to`-absent) obligation class.
   */
  to: string;
}

export interface IObligationOverride { actors: string[] }

export interface IObligateInput {
  uid: string;
  applies_to: IObligationAppliesTo;
  requirement: IPredicate;
  on_fail: IObligationSeverity;
  override?: IObligationOverride;
  by: string;
}
export interface IObligateOutcome { uid: string; obligationUid: string }

export interface IUnobligateInput { obligationUid: string; by: string }
export interface IUnobligateOutcome { obligationUid: string; invalidated: true }

export async function obligate(handle: IWriteStoreHandle, input: IObligateInput): Promise<IObligateOutcome>;
export async function unobligate(handle: IWriteStoreHandle, input: IUnobligateInput): Promise<IUnobligateOutcome>;

/** Recursive validator over the closed core — throws InvalidPredicateError on
 *  an unknown `op`, a missing/ill-typed leaf, or `evidence.min < 1`. */
export function assertValidPredicate(pred: unknown): asserts pred is IPredicate;

/**
 * Pure evaluator — the ONE implementation of the grammar's semantics, shared
 * by the C5 write gate (tx-backed resolver) and the C6 verdict (graph-backed
 * resolver). NOT re-implemented per caller (adhd ADR-0002).
 */
export interface IPredicateResolver {
  countVerifiedAttestations(kind: string): Promise<number>;
  blockersAllTerminal(): Promise<boolean>;
  relationExists(type: string, direction: IRelationDirection): Promise<boolean>;
}
export async function evaluatePredicate(pred: IPredicate, resolver: IPredicateResolver): Promise<boolean>;
```

**Leaf semantics (fixed here, consumed by C5/C6):**

- `evidence{kind, min?}` → resolved count of **distinct attestations of
  `claim.kind === kind` whose `check.state === 'verified'`** ≥ `min ?? 1`.
  `unverified`/`stale`/`unknown` **do not count** (AC2).
- `blockers_terminal()` → every incoming LIVE `blocks` edge's source issue is
  terminal iff its `has_status` target has `status.terminal === true`
  (`query/card.ts`'s `isStatusTerminal`). A missing status is non-terminal
  (fail-closed).
- `relation{type,direction}` → a live edge of `type` exists with the subject as
  `dst` (`direction:'in'`) or `src` (`direction:'out'`).
- `all_of` → every; `any_of` → at least one; `not` → boolean negation. An empty
  `all_of` is `true`; an empty `any_of` is `false` (documented, asserted).

**Node storage** — `kind:'obligation'`, `name: <requirement op>` (e.g.
`evidence`), `content: canonicalJSONStringify(requirement)`, `metadata`:

```jsonc
{
  "applies_to":  { "to": "RESOLVED" },              // `to` required; '*' = any terminal transition
  "requirement": { "op": "evidence", "kind": "published-artifact", "min": 1 },
  "on_fail":     "block",
  "override":    { "actors": ["dispatcher:1"] }     // optional
}
```

**Edge** — `has_obligation` (`issue → obligation`, `1:n`) via `writeEdgeTx`
after `resolveEdgeKindTx(tx,'has_obligation')`.

### `entrypoint/backlog/src/write/errors.ts` (ADD)

```typescript
/** An invalid predicate (unknown op, malformed leaf, min<1, non-array of). E_VALIDATION. */
export class InvalidPredicateError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly detail: string) { /* … */ }
}

/** `unobligate` named a uid that is not a live `obligation` node. E_VALIDATION → item_not_found. */
export class ObligationNotFoundError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly uid: string) { /* … */ }
}
```

### `entrypoint/backlog/src/query/types.ts` (MODIFY)

```typescript
// BEFORE
export type IIssuePseudoField =
  | 'body' | 'citations' | 'notes' | 'auditTrail' | 'blockers' | 'related' | '_score' | '_vector';

// AFTER (add 'obligations'; C6 adds 'verdict'; C2 adds blocksOut/dependents/partOf; C9 adds 'similar')
// CANONICAL FINAL UNION (one declaration, one owner — do not let two specs diverge):
//   'body' | 'citations' | 'notes' | 'auditTrail' | 'blockers' | 'related'
//   | 'blocksOut' | 'dependents' | 'partOf' | 'obligations' | 'verdict' | 'similar'
//   | '_score' | '_vector'
export type IIssuePseudoField =
  | 'body' | 'citations' | 'notes' | 'auditTrail' | 'blockers' | 'related'
  | 'obligations' | 'verdict' | '_score' | '_vector';

export interface IObligationView {
  uid: string;
  applies_to: IObligationAppliesTo;
  requirement: IPredicate;
  on_fail: IObligationSeverity;
  override?: IObligationOverride;
}

export interface IIssueCard {
  /* …existing… */
  obligations?: IObligationView[];
  // verdict?: IVerdict;   // added by C6
}
```

Also append `'obligations'` (and later `'verdict'`) to
`ISSUE_PSEUDO_FIELDS` so `assertKnownIssueFields` accepts them.

### `entrypoint/backlog/src/query/card.ts` (MODIFY)

```typescript
// add, beside resolveBlockers/resolveRelated:
export async function resolveObligations(
  graph: GraphBackend,
  issueId: number,
  outgoing?: EdgeRecord[]
): Promise<IObligationView[]>;

// in assembleIssueCard:
const needsObligations = want('obligations');
// add to the `outgoing`-fetch condition and:
if (needsObligations && outgoing) card.obligations = await resolveObligations(graph, issue.id, outgoing);
```

### `entrypoint/backlog/src/api.ts` (MODIFY)

```typescript
export async function obligate(ctx: BacklogCtx, input: IObligateInput): Promise<IOutcomeEnvelope<IObligateOutcome>>;
export async function unobligate(ctx: BacklogCtx, input: IUnobligateInput): Promise<IOutcomeEnvelope<IUnobligateOutcome>>;
// both route through writeHandle(ctx, { needsSemantic: false })
```

**`outputSchema` (adhd ADR-0004).** `IOutcomeEnvelope<T>` is a union, so no
`outputSchema`/`structuredContent` is emitted; the flat payload rides
`content`. `IObligateOutcome`/`IUnobligateOutcome` are object-shaped and are
valid `outputSchema` roots if a transport narrows to the object arm.

## Behavioral changes

### `write/obligation.ts` — `obligate()`

- **Change:** new verb. One `executeWriteTransaction` (BEGIN IMMEDIATE; adhd
  ADR-0001/0012 — **atomicity is the store's job**; no temp-file/rename/flock).
- `assertNonBlank('uid'|'by')`, `assertNotBareRoleLiteral('by', …)`,
  `assertValidPredicate(requirement)`, `on_fail` ∈ `{'block','warn'}`.
- `resolveLiveIssueTx(tx, uid)`; write the `obligation` node; resolve
  `has_obligation`; write the edge; `writeAudit(action:'obligated')`.
- **No subject mutation** beyond the edge; nothing is stored on the issue.
- **Default behavior unchanged** — no existing verb touched.

### `write/obligation.ts` — `unobligate()`

- One `executeWriteTransaction`. Resolve `obligationUid` → live `obligation`
  node (else `ObligationNotFoundError`).
- Soft-invalidate: `UPDATE node SET t_invalid = ?, meta = <merged
  invalidatedAt/invalidatedReason> WHERE rowid = ?` (the `delete.ts`/`rmLocation`
  shape), and `invalidateEdgeTx` the owning `has_obligation` edge.
- `writeAudit(action:'unobligated')`. Never hard-delete.

### `write/obligation.ts` — `evaluatePredicate()`

- Pure recursive walk. Only `evidence`/`blockers_terminal`/`relation` reach the
  resolver. Documented short-circuits: `all_of` empty ⇒ `true`, `any_of` empty ⇒
  `false`, `not` of an empty `any_of` ⇒ `true`.
- **Fail-closed:** a resolver error propagates (the gate refuses); it is never
  coerced to `true`.

### `query/card.ts` — obligations projection

- `resolveObligations` reads `has_obligation` targets from the already-fetched
  `outgoing` edges (one batched `getNodesByIds`), maps each node's metadata to
  `IObligationView`. Never evaluates predicates on the read path (that is C5/C6).

## Independent segments

### Segment A — foundation request (shared with C3)

- **Files:** `write/catalog.ts` (row `has_obligation`), `store/vocabulary-guard.ts`
  (`'obligation'`). If C3 landed, skip. **Read tokens:** 0. **Output:** 0–40.

### Segment B — obligation.ts core

- **Files:** new `write/obligation.ts`.
- **Dependencies:** A. **Read tokens:** ~150 (pattern from `catalog.ts`'s
  `upsertProjectTx`). **Output:** ~820.
- **Required context:** `catalog.ts`'s `upsertProject` (node+edge+audit skeleton).

### Segment C — errors

- **Files:** `write/errors.ts`.
- **Dependencies:** none. **Read tokens:** 120. **Output:** 160.

### Segment D — read projection

- **Files:** `query/types.ts`, `query/card.ts`.
- **Dependencies:** B (needs `IObligationView` types — declare them in
  `query/types.ts` and import `IPredicate`/`IObligationAppliesTo` from
  `write/obligation.ts`, or move the pure predicate types to a shared
  `write/predicate-types.ts` to keep `query/**` free of `write/**` value
  imports; the types are `import type`-only so no runtime cycle).
- **Read tokens:** ~400. **Output:** ~340.
- **Required context:** `query/types.ts` (`IIssuePseudoField`, `IIssueCard`);
  `query/card.ts`'s `assembleIssueCard` wiring.

### Segment E — mount

- **Files:** `api.ts`, `index.ts`.
- **Dependencies:** B, C. **Read tokens:** ~120. **Output:** ~120.

### Segment F — tests

- **Files:** `obligation.spec.ts`, `card.obligations.spec.ts`.
- **Dependencies:** all. **Read tokens:** ~180. **Output:** ~950.

## Execution strategies

### Segment B

1. Read `catalog.ts`'s `upsertProject` ONLY — copy the
   transaction/node/edge/audit skeleton; do not read the whole file.
2. Implement the validator FIRST: a recursive `assertValidPredicate` that
   rejects an unknown `op`, a non-array `of`, a blank `kind`, and `min < 1`.
3. Implement `evaluatePredicate` as a pure async walk over
   `IPredicateResolver` — it must contain NO SQL and NO store import.
4. `obligate`: `assertValidPredicate` runs BEFORE opening the transaction
   (validation failures never hold the write lock).

### Segment D

1. Add `'obligations'` to `IIssuePseudoField` + `ISSUE_PSEUDO_FIELDS` in
   `query/types.ts`.
2. Add `IObligationView` + `IIssueCard.obligations`.
3. Add `resolveObligations` to `card.ts` and wire the `want('obligations')`
   branch — including adding `needsObligations` to the `outgoing`-fetch guard
   in `assembleIssueCard` so the edge list is actually fetched.
4. Do NOT evaluate any predicate here.

## Test cases

- **AC1 — one obligation of each core predicate kind; `get` returns them;
  `unobligate` removes one.**
  `obligation.spec.ts`: `obligate` with each of the 6 `op`s; `get
  {fields:['obligations']}` returns all; `unobligate` one → it is gone from the
  next `get`, and its node is `t_invalid`.
  *Negative control:* remove the `'obligations'` pseudo-field from the
  projection → `get` omits them → red.

- **AC2 — `evidence{kind:"X",min:2}` counting.**
  One `verified` attestation of kind X → unsatisfied; add a second → satisfied;
  an `unverified` attestation does not count.
  *Negative control:* make `countVerifiedAttestations` count every attestation
  regardless of `check.state` → the "1 verified + 1 unverified = min 2" case
  passes → red.

- **AC3 — boolean composition.**
  A two-leaf tree over `all_of`/`any_of`/`not` across all four leaf-value
  combinations, plus the `not(all_of)`/`not(any_of)` duals.
  *Negative control:* swap `any_of`/`all_of` semantics → the all-false `all_of`
  case flips → red.

- **AC4 — `blockers_terminal()` both directions, no write to the dependent.**
  Dependent with a non-terminal blocker → unsatisfied; transition the blocker to
  terminal → satisfied. Assert the dependent's node is untouched.
  *Negative control:* treat a missing status as terminal → unsatisfied case
  passes → red.

- **AC5 — `warn` vs `block` severity (asserted at the C6 layer).**
  `on_fail:'warn'` obligation unsatisfied ⇒ item stays `actionable:true`;
  `on_fail:'block'` ⇒ `actionable:false`. (Runs once C6 lands; C4 asserts the
  stored `on_fail` is returned verbatim by `get`.)

- **AC6 — additive floor.**
  An unblocked, obligation-free item is `actionable:true`; `obligate` is never
  required for any existing verb to function — run the full create→transition
  path with zero obligations.
  *Negative control:* make the C5 gate throw when an item has no obligation →
  the no-obligation path fails → red.

### UX acceptance

- End user runs `backlog obligate --input '{"uid":"…","applies_to":{"to":"RESOLVED"},
  "requirement":{"op":"evidence","kind":"published-artifact","min":1},
  "on_fail":"block","by":"dispatcher:1"}'` → `{ok:true,data:{obligationUid}}`.
- End user runs `backlog get --input '{"uid":"…","fields":["uid","obligations"]}'`
  → the obligation is visible.
- End user runs `backlog obligate --input '{…,"requirement":{"op":"cel","expr":"…"}}'`
  → `invalid_argument` naming the unknown `op` (CEL is out of v1).

## Blast radius

> **Tooling note.** `gitnexus` is not available in this agent's tool set;
> blast radius is read directly from source. Run `gx impact` on
> `assembleIssueCard`, `assertKnownIssueFields`, `EDGE_KIND_TABLE` before
> editing if available.

- `IIssuePseudoField` widening — **the widest change.** `assertKnownIssueFields`
  is used by `get`/`query` and every card assembler; the wire schema is derived
  from this union, so `query-output-codec.spec.ts` and the MCP `oneOf` output
  schema are in scope. **MEDIUM**; additive (a new accepted value), but the
  derived schema must be re-checked.
- `assembleIssueCard` — used by `get`, `query`, and every write verb's outcome
  (they embed card-shaped fields). Additive branch; **MEDIUM** because a
  mis-wired `outgoing`-fetch guard would make `obligations` silently empty.
- `EDGE_KIND_TABLE` / `resolveEdgeKindTx` — **LOW** (append-only).
- `evaluatePredicate` — new pure function; consumed by C5/C6. No existing
  caller.

## Deliberately NOT changed

- No CEL, no per-project gate config, no `timeout` (design §3, §7 cond 4).
- No stored "ready"/"done" status (design §3).
- `tx.ts`/`catalog.ts`/`errors.ts`/`audit.ts` remain frozen; catalog/errors
  changes are foundation requests.
