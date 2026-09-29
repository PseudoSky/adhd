# C5 — Closure gate: terminal transitions require satisfied obligations + verified evidence

**Ticket:** `b076742d-664d-467c-990d-2e11d82b4f45` · priority HIGH ·
component `9a7bf578` (backlog). **Design:** `actionable-store/DESIGN.md` §2
Primitive 3 ("Surface"), §5 AC4, §7 condition 3; `CONCEPTUAL_TEST.md` §D.5/D.10.
**Depends on:** C3 (verified attestations), C4 (obligations). **Blocks:** none
(C6 shares the gate's reason codes).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 2 · **Dependencies:** C3 and C4 (both non-terminal) + the shared C3 Segment-A foundation amendment · **Evidence requirement:** `gate.spec.ts` + `transition.gate.spec.ts` + `cross-process-gate-safety.e2e.ts` (two REAL processes, file-signal latch, exit-code keyed) with the AC1–AC6 negative controls. No sleeps; runs default.

> **Research note.** No new dependency. `git merge-base --is-ancestor` /
> `git branch --contains` are shelled locally, exactly as C3's anchor ladder
> does; the transaction contract (`BEGIN IMMEDIATE` + `busy_timeout` + bounded
> BUSY-only retry) is the store's existing `executeWriteTransaction`
> (`write/tx.ts`) — re-used verbatim.

## Summary

Make a **terminal transition fail-closed**: before any write commits, evaluate
the item's transition-scoped obligations against C4's predicate core and refuse
with a typed reason if a `block`-severity obligation is unsatisfied. Evidence
counts only when an attestation's `check.state === 'verified'`; a bare commit
ref never satisfies an obligation requiring a `published-artifact`. The gate is
a **read-modify-write and runs inside the store's existing `BEGIN IMMEDIATE`
transaction** — atomicity is the store's job (adhd ADR-0001 + ADR-0012); **no
temp-file+rename, no flock, no file-atomic pattern** is proposed for backlog
data. On success the closure records which attestation satisfied which
obligation (`satisfies` edges + `transition.meta.satisfied_by`). An explicit
override is only honoured for listed actors and always records a named reason.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| backlog | `entrypoint/backlog/src/write/gate.ts` | create | 0 | 800 |
| backlog | `entrypoint/backlog/src/write/anchor-check.ts` | modify (add `commit:` + default-branch check) | 200 | 160 |
| backlog | `entrypoint/backlog/src/write/transition.ts` | modify | 300 | 260 |
| backlog | `entrypoint/backlog/src/write/errors.ts` | modify | 200 | 260 |
| backlog | `entrypoint/backlog/src/api.ts` | modify | 120 | 120 |
| backlog | `entrypoint/backlog/src/write/gate.spec.ts` | create | 0 | 700 |
| backlog | `entrypoint/backlog/src/write/transition.gate.spec.ts` | create | 0 | 500 |
| backlog | `entrypoint/backlog/src/write/cross-process-gate-safety.e2e.ts` | create | 0 | 450 |

**Foundation dependency.** Uses C4's `has_obligation`, C3's `attests`, and the
new `satisfies` row (specced in **C3 Segment A**). If not yet landed, this
segment issues the same foundation request per `write/CONTRACT.md`.

## Interface changes

### `entrypoint/backlog/src/write/gate.ts` (NEW)

```typescript
export type IGateReasonCode =
  | 'EvidenceUnverified' | 'EvidenceStale' | 'BlockedBy' | 'MissingObligation'
  | 'ClaimStale' | 'ReferenceUnresolved' | 'Unknown';

/** The object-shaped refusal payload (adhd ADR-0004 — carried in
 *  `error.details.refusal`, never as a `{result}` envelope). */
export interface IGateRefusal {
  code: IGateReasonCode;
  message: string;
  /** The obligation that refused, when the refusal is obligation-scoped. */
  obligationUid?: string;
  /** The thing to fix — blocker uid / attestation uid. */
  subject?: string;
  /** For EvidenceUnverified: the `claim.kind` the obligation required. */
  required_kind?: string;
  /** The mechanical check that produced the refusal (e.g. 'default_branch_ancestor'). */
  performed_check?: string;
}

export interface IGateEvaluation {
  satisfied: boolean;
  refusals: IGateRefusal[];
  /** Pairs recorded as `satisfies` edges on success. */
  satisfiedBy: Array<{ obligationUid: string; attestationUid: string }>;
  /** Obligations whose on_fail is 'warn' and predicate false — recorded, never refusing. */
  warnings: IGateRefusal[];
}

/**
 * Evaluate the transition-scoped obligations of `issueRowId` for a transition
 * `from → to` INSIDE the caller's open `tx`. Never writes. `effectiveActor`
 * enables the listed-actor override.
 */
export async function evaluateTransitionGateTx(
  tx: AdapterTransaction,
  input: {
    issueRowid: number;
    fromStatus: string;
    toStatus: string;
    effectiveActor: string;
    at: string;
  }
): Promise<IGateEvaluation>;
```

**Resolver wiring.** `evaluateTransitionGateTx` implements C4's
`IPredicateResolver` against `tx` (tx-scoped SQL, never the bare adapter — the
`write/tx.ts` hand-composed rule), then calls C4's `evaluatePredicate`. The
resolver:

- `countVerifiedAttestations(kind)` — `SELECT COUNT(DISTINCT a.uid) …` joining
  live `attests` edges from the issue to `attestation` nodes where
  `json_extract(meta,'$.claim.kind') = ?` AND
  `json_extract(meta,'$.check.state') = 'verified'`.
- `blockersAllTerminal()` — incoming live `blocks` edges to the issue; for each
  source, its live `has_status` target's `meta.terminal`. Missing ⇒ non-terminal.
- `relationExists(type, direction)` — live edge of `type` with the issue as
  `dst` (`in`) or `src` (`out`).

**`satisfies` edges** — after a successful gate, for each
`{obligationUid, attestationUid}` in `satisfiedBy`, write
`resolveEdgeKindTx(tx,'satisfies')` + `writeEdgeTx(obligation → attestation)`
and stamp `transition.meta.satisfied_by = satisfiedBy`.

### `entrypoint/backlog/src/write/anchor-check.ts` (MODIFY)

```typescript
// extend the anchor grammar (C3 defined path|url|query|registry):
export type AnchorLocatorKind = 'path' | 'url' | 'query' | 'registry' | 'commit';

/** `commit:<sha>` — is <sha> an ancestor of the repo's default branch?
 *  Shells `git merge-base --is-ancestor <sha> <default>`. Returns
 *  {onDefaultBranch:false, performed:'default_branch_ancestor'} when the repo
 *  or the branch cannot be resolved (fail-closed, never a silent pass). */
export async function isShaOnDefaultBranch(
  repoRoot: string, sha: string, defaultBranch?: string
): Promise<{ onDefaultBranch: boolean; performed: string }>;
```

### `entrypoint/backlog/src/write/transition.ts` (MODIFY)

```typescript
// BEFORE
export interface ITransitionInput {
  uid: string; by: string; toStatus: string; note?: string;
  citations?: ICitationInput[]; gitContext?: string;
}

// AFTER (add one optional field)
export interface ITransitionInput {
  uid: string; by: string; toStatus: string; note?: string;
  citations?: ICitationInput[]; gitContext?: string;
  /** A recorded override of a refusing obligation. Honoured ONLY when the
   *  caller is in the refusing obligation's `override.actors`; a reason is
   *  ALWAYS required and is recorded on the audit row. */
  override?: { reason: string };
}
```

### `entrypoint/backlog/src/write/errors.ts` (ADD)

```typescript
/** A terminal transition was refused because a block-severity obligation is
 *  unsatisfied. E_VALIDATION → envelope `precondition_failed`, with the
 *  structured IGateRefusal in `error.details.refusal`. */
export class ObligationUnsatisfiedError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly refusal: IGateRefusal) { /* message from refusal */ }
}

/** A claimed override is not permitted for this actor, or carries no reason. */
export class OverrideNotPermittedError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly obligationUid: string, public readonly actor: string) { /* … */ }
}
```

### `entrypoint/backlog/src/api.ts` (MODIFY) — mapping + refusal details

```typescript
const ERROR_CLASS_TO_ENVELOPE_CODE = [
  /* …existing… */
  [ObligationUnsatisfiedError, 'precondition_failed'],
  [OverrideNotPermittedError, 'precondition_failed'],
];
// In toEnvelope(): when err is ObligationUnsatisfiedError, attach
//   details.refusal = err.refusal        (object-shaped; ADR-0004)
// so the failure arm is `{ok:false, error:{code:'precondition_failed',
//   message, details:{refusal:{code:'EvidenceUnverified',
//   required_kind:'published-artifact', …}}}}`.
```

**`outputSchema` (adhd ADR-0004).** `transition` still returns
`IOutcomeEnvelope<ITransitionOutcome>` (a union) → no `outputSchema`; the flat
`content` payload carries the envelope. The refusal payload
`IGateRefusal` is object-shaped and appears under `error.details.refusal`.

## Behavioral changes

### `write/gate.ts`

- **Placement:** `evaluateTransitionGateTx` is called from INSIDE `transition`'s
  `executeWriteTransaction` callback, **after** `toStatusFullRow`/terminality is
  known and **before** the first write. It reads the same `tx` the write uses,
  so the read-modify-write is atomic: two concurrent terminal transitions
  serialize through the `BEGIN IMMEDIATE` RESERVED lock (adhd ADR-0001 D3).
- **Scope:** only obligations where `applies_to.to` matches (`'*'` or the
  resolved terminal status name) and `applies_to.from` matches (absent or the
  current status). There is **no `to`-absent obligation class** — DESIGN §2
  Primitive 3 makes `to` REQUIRED, so every obligation names the transition it
  guards; C6's verdict surfaces the same obligations as a *prediction* of this
  gate (not a second, actionability-only scope).
- **Severity:** `on_fail:'warn'` never sets `satisfied:false`; it is returned in
  `warnings` and recorded.
- **Reason derivation:** the failing leaf determines `code`:
  `evidence` leaf → `EvidenceUnverified` (0 verified) or `EvidenceStale` (a
  verified-looking anchor is stale); `blockers_terminal` → `BlockedBy`;
  `relation` → `ReferenceUnresolved`; a budget/resolve failure → `Unknown`.
  `required_kind` is the evidence leaf's `kind`.
- **Commit-ref rule:** an obligation `evidence{kind:'published-artifact'}`
  counts only attestations whose `claim.kind === 'published-artifact'`. A
  `commit:<sha>` anchor's attestation has `claim.kind:'commit'`, so it does not
  count — and if a `published-artifact` pin is asserted via a `commit:` anchor,
  the resulting refusal carries `required_kind:'published-artifact'` and
  `performed_check:'default_branch_ancestor'`.
- **Override:** a refusing obligation with `override.actors` containing
  `effectiveActor` AND a non-blank `input.override.reason` is skipped (recorded
  as satisfied-by-override); a non-listed actor or a blank reason throws
  `OverrideNotPermittedError`.

### `write/transition.ts`

- **Change:** when `toTerminal`, call `evaluateTransitionGateTx`; on
  `!satisfied` throw `ObligationUnsatisfiedError(firstRefusal)` **before any
  write**. The throw rolls the transaction back, so `get` on re-read shows the
  status unchanged (AC1).
- On success: write the `satisfies` edges + stamp
  `transition.meta.satisfied_by` in the SAME transaction; audit `note`
  incorporates any override reason (`override: <reason>`).
- **Scope:** change only the terminal path. Non-terminal transitions are
  ungated (design: gated verbs are `transition` any status change — the *gate*
  is over obligations, whose `applies_to.to` is terminal-scoped; a non-terminal
  transition with no matching obligation is a no-op gate).
- **Preserve** every existing check (`NoteRequiredError`,
  `CitationRequiredError`, `ClaimHeldError`) — the gate is additive and runs
  after them.

### `write/anchor-check.ts`

- Add `commit:` parsing and `isShaOnDefaultBranch`. Fail-closed on an
  unresolvable repo/branch. Never on the list path (only evaluated inside a
  terminal transition / an explicit verdict rung 3+).

## Independent segments

### Segment A — anchor-check extension

- **Files:** `write/anchor-check.ts`.
- **Dependencies:** C3 Segment B. **Read tokens:** ~120. **Output:** ~160.

### Segment B — gate.ts

- **Files:** new `write/gate.ts`.
- **Dependencies:** A, C3, C4. **Read tokens:** ~250 (`transition.ts`'s tx-scoped
  SQL patterns + C4's `evaluatePredicate`). **Output:** ~780.

### Segment C — errors + envelope mapping

- **Files:** `write/errors.ts`, `api.ts`.
- **Dependencies:** B (types). **Read tokens:** ~320. **Output:** ~380.

### Segment D — transition wiring

- **Files:** `write/transition.ts`.
- **Dependencies:** B, C. **Read tokens:** ~300. **Output:** ~260.

### Segment E — tests + concurrency e2e

- **Files:** `gate.spec.ts`, `transition.gate.spec.ts`,
  `cross-process-gate-safety.e2e.ts`.
- **Dependencies:** all. **Read tokens:** ~200. **Output:** ~1 500.
- **Required context:** `write/claim.e2e.ts` and
  `write/cross-process-write-safety.e2e.ts` for the real-process/latch harness.

## Execution strategies

### Segment B

1. Read the tx-scoped SQL patterns in `transition.ts` and C4's
   `evaluatePredicate` signature ONLY.
2. All SQL is hand-composed against `tx` (`tx.executeGet`/`executeAll`) — never
   `graph.*` (which reads committed state outside this tx; `write/tx.ts`
   header).
3. `evaluateTransitionGateTx` returns data — it NEVER throws for an unsatisfied
   predicate (the caller decides). It throws only on a genuine graph-invariant
   violation.
4. Do NOT write anything; `satisfies` edges are written by `transition` after
   the gate passes.

### Segment D

1. Locate the `toTerminal` computation in `transition.ts`.
2. Insert the gate call immediately after the existing `NoteRequiredError` /
   `CitationRequiredError` checks and before the sha computation.
3. On refusal: `throw new ObligationUnsatisfiedError(evaluation.refusals[0])`.
4. After the successful status/edge writes, write `satisfies` edges + stamp
   `satisfied_by` into `newIssueMetadata` before the `touch` UPDATE.
5. NEVER restructure the rest of the function.

## Test cases

- **AC1 — unsatisfied obligation refuses; status unchanged on re-read.**
  `transition.gate.spec.ts`: item with `obligate {evidence{kind:'published-artifact'}}`,
  `transition {toStatus:'RESOLVED', citations:[{file:'x',lines:'1'}]}` →
  throws `ObligationUnsatisfiedError`; re-`get` shows the original status.
  *Negative control:* delete the gate call → the transition succeeds and the
  test (expecting a throw) goes red.

- **AC2 — a satisfied `verified` attestation allows retry; closure names the
  pairing.**
  Add a verified attestation of the required kind → retry succeeds; assert a
  `satisfies` edge exists obligation→attestation and
  `transition.meta.satisfied_by` names both uids.
  *Negative control:* write the `satisfies` edge only in memory (never persist)
  → the assertion fails → red.

- **AC3 — a commit ref does NOT satisfy `published-artifact`.**
  Attestation with `claim.kind:'commit'`, anchor `commit:<sha>` → transition
  refused with `code:'EvidenceUnverified'`, `required_kind:'published-artifact'`.
  *Negative control:* make the evidence leaf ignore `claim.kind` → the commit
  attestation satisfies → red.

- **AC4 — a sha not on the default branch is denied.**
  `isShaOnDefaultBranch` returns false-for-a-side-branch → refusal reason names
  `performed_check:'default_branch_ancestor'`.
  *Negative control:* pass `defaultBranch:undefined` and let it fail-open → red.

- **AC5 — concurrency: exactly one success, no lost update.**
  `cross-process-gate-safety.e2e.ts`: two REAL processes (adhd ADR-0001 D5),
  each its own adapter connection, barrier-released to attempt the terminal
  transition simultaneously. Assert exactly one `ok:true`, one refusal, and a
  consistent re-read (one `has_transition`, one terminal status); **no sleep** —
  a filesystem latch/barrier. Assert no raw `SQLITE_BUSY` reaches the caller.
  *Negative control:* run the harness with `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`
  (the existing test-only switch) → both succeed / torn state → red. Trust the
  runner's exit code, not stdout.

- **AC6 — override.**
  Non-listed actor + reason → `OverrideNotPermittedError`; listed actor without
  a reason → refused; listed actor with a reason → succeeds and the reason is
  in the audit row.
  *Negative control:* honour the override for any actor → the non-listed case
  passes → red.

### UX acceptance

- End user closes an item missing its required artifact → `{ok:false,
  error:{code:'precondition_failed', details:{refusal:{code:'EvidenceUnverified',
  required_kind:'published-artifact'}}}}`, exit 1, status unchanged.
- End user attaches the artifact (`attest`), retries → success; `get
  {fields:['auditTrail']}` shows which attestation closed it.

## Blast radius

> **Tooling note.** `gitnexus` is unavailable in this agent's tool set; this is
> read-derived. If `gx` is present, run `gx impact transition` /
> `gx impact evaluatePredicate` first.

- `transition` — mounted on all four transports; the gate adds a read-only
  evaluation inside its existing transaction. **MEDIUM**: a bug that throws on
  the non-terminal path would regress every status change; the gate is scoped
  to `toTerminal`.
- `write/tx.ts` `executeWriteTransaction` — **unchanged.** This is the
  load-bearing point: the gate inherits `BEGIN IMMEDIATE` + `busy_timeout` +
  bounded BUSY-only retry for free, which is why AC1/AC5 hold without any new
  locking.
- `errors.ts` / `api.ts` `toEnvelope` — additive classes + `details.refusal`.
  **LOW**, but the envelope `code` union stays closed (refusal reason codes live
  under `details`, never as a top-level `code`).
- `anchor-check.ts` — extended, shared with C3/C6. **LOW**.
- `write/cross-process-write-safety.e2e.ts` pattern — reused, not modified.

## Deliberately NOT changed

- `tx.ts` / `catalog.ts` / `audit.ts` (frozen). No file-atomic or flock pattern
  is introduced — **the store's transaction is the concurrency mechanism**.
- `update`/`relate`/`delete` remain ungated (design Primitive 3: gated verbs are
  exactly `transition` and `claim`).
- No obligation `timeout`, no CEL (design §7 cond 4).
