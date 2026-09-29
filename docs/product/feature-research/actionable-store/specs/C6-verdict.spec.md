# C6 — Verdict: derived actionability with reasons; claim refuses live blockers

**Ticket:** `291263ea-3bc9-41e2-a156-6fef72b88f22` · priority HIGH ·
component `9a7bf578` (backlog). **Design:** `actionable-store/DESIGN.md` §2
Primitive 4 (incl. "Bounded derivation"), §5 AC5/AC9/AC10, §7 condition 2;
`CONCEPTUAL_TEST.md` §D.4. **Depends on:** C3 (evidence), C4 (obligations).
**Enables:** AC5/AC9/AC10.

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 1 (structural reasons only: `BlockedBy`, `ClaimStale`, `ReferenceUnresolved`) / 2 (full, incl. obligation/evidence reasons) · **Dependencies:** **none for the Wave-1 structural half**; the full verdict needs C3+C4 (non-terminal). The ticket body's unconditional "Depends on C4 and C3" is stale w.r.t. the Wave-1 split — a delta. · **Evidence requirement:** `verdict.spec.ts` + `claim.gate.spec.ts` + `verdict-list-bound.e2e.ts` (default-running, reports N-item list-path p95 and FAILS if the list reaches rung ≥3) with the AC1–AC7 negative controls.

> **Research note.** The prior art for the derived-condition shape (Kubernetes
> `Conditions{type,status:True|False|Unknown,reason,message,observedGeneration}`,
> Argo CD two-axis, GitHub `mergeable`+`mergeStateStatus`, systemd
> Condition-vs-Assert severity split) is already folded into `DESIGN.md` §2
> Primitive 4. No new dependency. The bounded ladder is the design's own
> N-item-page bound; this spec makes it measurable, not asserted.

## Summary

Add a **Verdict** — derived on read, never stored — computed by a cheap-first
ladder with an explicit per-read budget. A `Condition` says whether a *named*
condition **holds** (`{type:'Blocked',status:True}` = IS blocked);
**`actionable` is tri-state (`true | false | 'unknown'`), not a boolean**: it is
`false` **iff** a `severity:'block'` condition is `True`; it is `'unknown'` iff a
`severity:'block'` condition is `Unknown` (and `Unknown` never renders as `true`
either). `claim` evaluates the verdict and fails loudly on a live blocker,
naming it; `force:true` records the named blocker. List views derive **rungs 1–2
only**; rungs 3–5 run per item on demand. On budget exhaustion a condition is
`Unknown`; where the list cannot afford the rung it reports `'unknown'`, never
`true`. This requires the one new cross-cutting quantity the design defines — a
monotonic `revision` counter on the issue node — so a stale verdict is
detectable.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| backlog | `entrypoint/backlog/src/query/verdict-core.ts` | create (pure) | 0 | 320 |
| backlog | `entrypoint/backlog/src/query/verdict.ts` | create (graph adapter) | 0 | 700 |
| backlog | `entrypoint/backlog/src/write/revision.ts` | create (pure) | 0 | 120 |
| backlog | `entrypoint/backlog/src/write/gate.ts` | modify (add `evaluateVerdictTx` for claim) | 200 | 260 |
| backlog | `entrypoint/backlog/src/write/claim.ts` | modify | 280 | 220 |
| backlog | `entrypoint/backlog/src/write/update.ts` | modify | 200 | 40 |
| backlog | `entrypoint/backlog/src/write/transition.ts` | modify | 120 | 40 |
| backlog | `entrypoint/backlog/src/write/relate.ts` | modify | 120 | 60 |
| backlog | `entrypoint/backlog/src/write/create-issue.ts` | modify | 120 | 30 |
| backlog | `entrypoint/backlog/src/query/types.ts` | modify | 0 | 120 |
| backlog | `entrypoint/backlog/src/query/card.ts` | modify | 120 | 120 |
| backlog | `entrypoint/backlog/src/query/query.ts` | modify (list path rung budget) | 260 | 120 |
| backlog | `entrypoint/backlog/src/write/errors.ts` | modify | 120 | 120 |
| backlog | `entrypoint/backlog/src/api.ts` | modify | 120 | 60 |
| backlog | `entrypoint/backlog/src/query/verdict.spec.ts` | create | 0 | 800 |
| backlog | `entrypoint/backlog/src/write/claim.gate.spec.ts` | create | 0 | 400 |
| backlog | `entrypoint/backlog/src/query/verdict-list-bound.e2e.ts` | create | 0 | 320 |

**Foundation dependency.** Uses C3's `attests`, C4's `has_obligation`. No new
catalog rows. `tx.ts`/`catalog.ts`/`audit.ts` stay frozen.

## Interface changes

### `entrypoint/backlog/src/write/revision.ts` (NEW, pure)

```typescript
/** The monotonic revision of an issue's content — 0 for a never-mutated issue.
 *  One name, one quantity (DESIGN §2 Primitive 1: subject.revision and
 *  source_revision are the SAME counter). */
export function readRevision(meta: Record<string, unknown> | undefined): number;
/** readRevision(meta) + 1. */
export function nextRevision(meta: Record<string, unknown> | undefined): number;
```

**Bumped on every mutating write** (`DESIGN §2` Primitive 4): `create-issue`
seeds `revision: 0`; `update` (touch **and** supersede — the new node carries
`nextRevision`), `transition`, `claim` (every writing branch), `relate` (source
issue), `move`, and `obligate`/`unobligate` all set `meta.revision =
nextRevision(priorMeta)`. `attest`/`recheck` do **not** bump (they never touch
the subject). `verify` (`get`/`query`) never writes.

### `entrypoint/backlog/src/query/types.ts` (MODIFY)

```typescript
export type IConditionType = 'Blocked' | 'Obligation' | 'Evidence' | 'Claim' | 'Reference' | 'Budget';
export type IConditionStatus = 'True' | 'False' | 'Unknown';
export type IConditionSeverity = 'block' | 'warn';
export type IVerdictReasonCode =
  | 'BlockedBy' | 'MissingObligation' | 'EvidenceUnverified' | 'EvidenceStale'
  | 'ClaimStale' | 'ReferenceUnresolved' | 'Unknown'
  | `${string}/${string}`;   // governed extension namespace

/** TRI-STATE (DESIGN §2 Primitive 4) — never a bare boolean. `unknown` is never
 *  a green light: a caller that handles only booleans must be told, and the list
 *  path must report `unknown` rather than `true` where it cannot afford the rung. */
export type IActionable = boolean | 'unknown';

export interface ICondition {
  type: IConditionType;
  /** Whether the NAMED condition HOLDS: True on a Blocked condition = IS blocked. */
  status: IConditionStatus;
  severity: IConditionSeverity;
  code: IVerdictReasonCode;
  message?: string;
  /** The thing to fix (blocker uid / attestation uid / obligation uid). */
  subject?: string;
}

export interface IVerdict {
  /** false iff a block-severity condition is True; 'unknown' iff any block-severity
   *  condition is Unknown; otherwise true. */
  actionable: IActionable;
  evaluated_at: string;
  revision: number;
  /** Ordered block-severity first, then warn. */
  conditions: ICondition[];
}

// Canonical pseudo-field union (one declaration, one owner): C4 owns it.
// 'verdict' is added here; C2 adds blocksOut/dependents/partOf; C9 adds 'similar'.
export interface IIssueCard { /* … */ verdict?: IVerdict; }
```

### `entrypoint/backlog/src/query/verdict-core.ts` (NEW, pure — no I/O)

```typescript
/** The ONE rule for actionability (DESIGN §2 Primitive 4). */
export function computeActionable(conditions: readonly ICondition[]): IActionable;
// 'unknown' iff any block-severity condition is 'Unknown';
// false iff any block-severity condition is 'True'; else true.
// 'Unknown' is NEVER treated as false OR as true.

/** Stable ordering: all 'block' before all 'warn'; within a band, by code then subject. */
export function orderConditions(conditions: readonly ICondition[]): ICondition[];
```

### `entrypoint/backlog/src/query/verdict.ts` (NEW, graph adapter)

```typescript
export interface IDeriveVerdictOptions {
  /** Highest ladder rung this call is allowed to run. Default 2 (the list
   *  bound). 5 = full re-resolve. A budget stop yields an `Unknown` condition. */
  maxRung?: 1 | 2 | 3 | 4 | 5;
  /** The instant used for staleness maths; defaults to nowISO(). */
  at?: string;
  /** Staleness threshold (minutes); defaults to 30 (project_policy default). */
  claimStaleAfterMin?: number;
  /** Test instrumentation: invoked with each rung actually evaluated. */
  onRung?: (rung: number) => void;
}

/** Derive the verdict for a live issue. NEVER writes. */
export async function deriveVerdict(
  graph: GraphBackend,
  issue: NodeRecord,
  opts?: IDeriveVerdictOptions
): Promise<IVerdict>;
```

**The ladder (DESIGN §2, mandatory):**

| Rung | What runs | Produces |
|---|---|---|
| 1 | relation state — incoming live `blocks` (indexed in-degree) | `{type:'Blocked', code:'BlockedBy', subject:<blockerUid>}` for each non-terminal blocker; `status:True` |
| 2 | obligation presence & shape; predicate evaluation of each obligation whose `applies_to.to` matches the item's terminal transition (they predict the C5 gate) against in-store attestations/edges + claim staleness | `Obligation`/`Evidence`/`Claim` conditions (`EvidenceUnverified` for 0 verified of a required kind; `ClaimStale`; `MissingObligation` **warn** when zero obligations exist) |
| 3 | anchor existence at HEAD (`git cat-file -e`) | `EvidenceStale` when an anchor is absent at HEAD |
| 4 | changed-since-filing (`git log --since`) | `EvidenceStale` when the anchor changed since `asserted_at` |
| 5 | full anchor re-resolve (`digest` match) | `EvidenceUnverified` on digest mismatch |

Rungs 3–5 are reached **only** when `maxRung ≥ n`; on any budget stop the
corresponding condition is `{status:'Unknown', severity:'block', code:'Unknown'}`
— which by `computeActionable` yields `actionable:'unknown'` (neither a green
light nor a block).

### `entrypoint/backlog/src/write/gate.ts` (MODIFY — add the tx-scoped rungs 1–2)

```typescript
/** Derive the verdict INSIDE the caller's open tx, through rungs 1–2 only
 *  (claim is a precondition, never a full anchor re-resolve). */
export async function evaluateVerdictTx(
  tx: AdapterTransaction,
  issueRow: ITxNodeRow,
  input: { at: string; claimStaleAfterMin: number }
): Promise<IVerdict>;
```

Reuses C4's `evaluatePredicate` with a tx-scoped `IPredicateResolver` and C6's
`orderConditions`/`computeActionable`. `ClaimStale` uses `claim-lease.ts`'s
`isClaimStale` + the project's `claimStaleAfterMin` (resolved via the existing
2-hop project walk).

### `entrypoint/backlog/src/write/claim.ts` (MODIFY)

```typescript
// BEFORE: claim has no blocker precondition (in claim.ts).
// AFTER: immediately after `resolveLiveIssueTx` and the terminal check
//        (the `action:'claim'` head of claim.ts), and ONLY for action:'claim':
const policy = await resolveIssueProjectPolicyTx(tx, row.rowid);
const verdict = await evaluateVerdictTx(tx, row, { at: now, claimStaleAfterMin: policy.claimStaleAfterMin });
const blocking = verdict.conditions.filter(c => c.severity === 'block' && c.status === 'True');
if (blocking.length > 0 && !force) throw new PreconditionRefusedError(blocking[0]);
// force: record the named blocker in the audit note and proceed.
```

### `entrypoint/backlog/src/query/card.ts` + `query/query.ts` (MODIFY)

- `assembleIssueCard` gains a `want('verdict')` branch (wrapped in a try/catch
  that degrades an unexpected derivation failure to an `Unknown` condition, never
  a card-wide throw).
- `queryReady`/`queryList` (and the other list views) pass `maxRung:2` and
  attach `verdict` when requested; **the list path must never evaluate rungs
  3–5** (AC6).
- `get` (single item) defaults its `verdict` derivation to `maxRung:3`; a caller
  may raise it via a new optional input field `deriveThrough?: 1|2|3|4|5` on
  `IIssueGetByUidInput` (default 2 for list, 3 for `get`).

### `entrypoint/backlog/src/write/errors.ts` + `api.ts` (ADD)

```typescript
/** claim refused by a block-severity verdict condition (ADR-0004: the refusal
 *  is object-shaped, carried in error.details.refusal). */
export class PreconditionRefusedError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly refusal: ICondition) { /* message from refusal */ }
}
// api.ts: map to 'precondition_failed'; attach details.refusal = the ICondition.
```

**`outputSchema` (adhd ADR-0004).** `get`/`query` return
`IOutcomeEnvelope<IIssueGetResult | IIssueQueryResult>` (unions) → no
`outputSchema`; the flat `content` carries the envelope. `IVerdict`/`ICondition`
are objects nested in `data[...].verdict`, so they are valid object schemas
where a transport narrows to an object arm.

## Behavioral changes

- **`deriveVerdict`** — never writes; never mutates; a pure function of store
  state + time. `revision` in the verdict is `readRevision(issue.metadata)`.
- **`claim`** — for `action:'claim'` only (`release`/`renew` stay ungated: they
  are cleanup). On a live blocker → `PreconditionRefusedError`, item **not**
  claimed (no touch, no audit). `force:true` → proceeds and the audit `note`
  records `"force-claimed despite <code> <subject>"`.
- **`ClaimStale`** — an item whose `claimedBy`/`claimedAt` is older than the
  threshold surfaces `{type:'Claim', status:True, severity:'warn',
  code:'ClaimStale'}` (warn, so `IN_PROGRESS` no longer conflates "live" with
  "abandoned" — it is reported, not blocking — AC9).
- **revision bumps** — `update`/`transition`/`claim`/`relate`/`move`/`create`
  set `meta.revision`; this is the ONLY change to those verbs beyond C5's gate.
- **Default behavior unchanged** — a card that does not request `verdict` is
  byte-for-byte unchanged; `MissingObligation` is warn-only, so an unblocked,
  obligation-free item stays `actionable:true` (AC7/AC10).

## Independent segments

### Segment A — revision.ts + bump sites

- **Files:** new `write/revision.ts`; `create-issue.ts`, `update.ts`,
  `transition.ts`, `claim.ts`, `relate.ts`, `move.ts`.
- **Dependencies:** none. **Read tokens:** ~400 (each verb's metadata-touch
  site only: `update`, `transition`, `claim`, `relate`). **Output:** ~280.
- **Required context:** read each verb's `newMetadata` construction block ONLY.

### Segment B — verdict-core + types

- **Files:** `query/verdict-core.ts`, `query/types.ts`.
- **Dependencies:** none. **Read tokens:** ~120. **Output:** ~380.

### Segment C — verdict.ts (graph ladder)

- **Files:** `query/verdict.ts`.
- **Dependencies:** B, C3, C4. **Read tokens:** ~300 (`card.ts`'s
  `resolveBlockers`/`resolveStatusesFor` batch pattern). **Output:** ~700.

### Segment D — gate.ts tx adapter

- **Files:** `write/gate.ts` (extend).
- **Dependencies:** C (types), C5's `IPredicateResolver`. **Read tokens:** ~200.
  **Output:** ~260.

### Segment E — claim.ts gate

- **Files:** `write/claim.ts`.
- **Dependencies:** D, A. **Read tokens:** ~280. **Output:** ~220.

### Segment F — read surface

- **Files:** `query/card.ts`, `query/query.ts`, `api.ts`, `errors.ts`.
- **Dependencies:** B, C. **Read tokens:** ~500. **Output:** ~300.

### Segment G — tests

- **Files:** `verdict.spec.ts`, `claim.gate.spec.ts`,
  `verdict-list-bound.e2e.ts`.
- **Dependencies:** all. **Read tokens:** ~200. **Output:** ~1 500.

## Execution strategies

### Segment C

1. Rung 1 FIRST and unconditional. Only descend when `maxRung` permits; call
   `opts.onRung?.(rung)` as each rung actually runs (the AC6 instrument).
2. Batch status reads exactly as `card.ts`'s `resolveStatusesFor` does (one
   `getEdges({rel:'has_status'})`, then one `getNodesByIds`) — never N round trips.
3. Rungs 3–5 import `anchor-check.ts`; do NOT run them when `maxRung < n`.
4. `orderConditions` + `computeActionable` from `verdict-core.ts` — never
   re-implement the boolean rule locally.

### Segment E

1. Read the `action:'claim'` head of `claim.ts` ONLY.
2. Insert the verdict gate after the terminal-status check, before the
   `claimedBy === undefined` branch.
3. `force` is the existing `input.force`; reuse it. On force, append the named
   blocker to the audit `note` in every branch that writes.
4. Do NOT gate `release`/`renew`.

## Test cases

- **AC1 — `claim` refuses a live blocker, naming it.**
  Item blocked by a non-terminal issue → `claim` throws
  `PreconditionRefusedError` with `details.refusal = {code:'BlockedBy',
  subject:<blocker uid>}`; the item remains unclaimed.
  *Negative control:* remove the gate → `claim` succeeds → red.

- **AC2 — `claim` on an unblocked item succeeds.**
  *Negative control:* make the gate always throw → red.

- **AC3 — force-claim records the named blocker.**
  `force:true` succeeds; `get {fields:['auditTrail']}` shows an audit `note`
  naming `BlockedBy` + the blocker uid.
  *Negative control:* drop the blocker from the note → red.

- **AC4 — verdict is derived, not stored.**
  Non-terminal blocker → `Blocked`/`True`/`actionable:false`. Transition the
  blocker to terminal → the dependent's verdict is `actionable:true` **without
  any write to the dependent**; assert the dependent's `meta.revision` is
  unchanged across the two derivations.
  *Negative control:* cache the verdict on the dependent (write `meta`) →
  `revision` changes → red.

- **AC5 — every condition carries a stable `code`; `Blocked/True` ⇔
  `actionable:false`; `Unknown` ⇒ `actionable:'unknown'` (never `true`).**
  Assert the correlation, that `subject` is present whenever one exists, and
  that a rung-budget stop yields `'unknown'` rather than a green light.
  *Negative control:* emit an unknown code string → schema/assertion → red; or
  default `'unknown'` to `true` → red.

- **AC6 — the N-item list bound is measured, not asserted.**
  `verdict-list-bound.e2e.ts` (default-running): build N = 200 named items,
  run `query {view:'ready', fields:['verdict']}` with an `onRung` counter,
  assert `maxRungObserved <= 2` and report the p95 (bound generous). FAIL if
  any list call reaches rung ≥3.
  *Negative control:* set the list path's `maxRung` to 3 → a rung-3 evaluation
  is observed → red. Trust the runner's exit code, not stdout.

- **AC7 — `ClaimStale` and the honest floor.**
  A claim older than threshold surfaces `ClaimStale` (warn); an item with no
  obligation and no blocker is `actionable:true`; `MissingObligation` is `warn`
  and never flips `actionable`.
  *Negative control:* make `MissingObligation` `severity:'block'` → the floor
  item becomes non-actionable → red.

### UX acceptance

- End user runs `backlog claim --input '{"uid":"…","by":"dispatcher:1","action":"claim"}'`
  on a blocked item → `{ok:false, error:{code:'precondition_failed',
  details:{refusal:{code:'BlockedBy',subject:'…'}}}}`, exit 1, not claimed.
- End user runs `backlog query --input '{"view":"ready","fields":["uid","verdict"]}'`
  → each card carries a verdict with a stable code + subject for every
  non-actionable row ("zero actionable" is never a dead end).
- End user runs `backlog get --input '{"uid":"…","fields":["verdict"]}'` → the
  verdict's `revision` matches the item's current revision.

## Blast radius

> **Tooling note.** `gitnexus` is unavailable in this agent's tool set;
> read-derived. Run `gx impact claim`, `gx impact assembleIssueCard`,
> `gx impact queryReady` first if available.

- **`claim`** — mounted on all four transports; a false block would refuse
  legitimate work. **HIGH** attention: the gate is scoped to `action:'claim'`
  and is bypassable by `force`, but `force` also overrides a live lease — the
  spec must not silently conflate the two (the audit `note` names which reason
  fired).
- **`IIssuePseudoField` + derived MCP `oneOf` schema** — adding `'verdict'`
  widens the accepted `fields` set; the wire schema is derived from this union
  (`query-output-codec.spec.ts`, `server.mcp.e2e.ts`). **MEDIUM**.
- **`revision` bump across 6 verbs** — the widest cross-cutting change in this
  spec. Each bump is a one-line metadata addition at an existing touch site; a
  missed site means a stale verdict is undetectable for that verb. **MEDIUM**;
  covered by AC4 and a per-verb assertion.
- **`queryReady`/`queryList`** — the `maxRung:2` budget is the AC6 regression
  guard; a future edit that raises it must go red. **MEDIUM**.
- **`deriveVerdict`** — new; consumed by `claim` (via `evaluateVerdictTx`) and
  the read surface. No existing caller.

## Deliberately NOT changed

- No stored `ready`/`done` status (design §3 — a materialised status recreates
  the drift).
- No CEL, no `timeout` (design §7 cond 4).
- No new catalog rows; no edit to frozen `tx.ts`/`catalog.ts`/`audit.ts`.
- `claim`'s `force` semantics are reused, not duplicated, and never blanket.
