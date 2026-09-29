# C10 — Work products are store citizens: a spec is a revision of its ticket

> **Ticket:** `b009396b-5c05-4ed1-9f6a-f7d5bb7e0497` (HIGH) · component `9a7bf578` (backlog)
> **Design:** `../DESIGN.md` §12, §2 Primitive 2 · **Depends on:** C1 (logical-id resolution), C3 (attestation — anchors + the annotation record shape, **widened by C10**) · **Blocks:** the DoR criterion 5 of every other ticket (a spec must be queryable in the store)
> **ADRs read:** ADR-0001 (store atomicity — the store owns atomicity; no temp-file/lock tricks), ADR-0002 (correct the source), ADR-0003 (CJS publish), ADR-0004 (flat MCP `content`, no `{result}` envelope), ADR-0012 (parallel-process enabled — the binding invariant, superseding ADR-0007).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 2 (lands immediately after C3; it consumes C3's attestation record and anchor digest).
- **Dependencies — none of which exist in this build yet; C10 is gated on them.** C10 **calls** C1's `resolveLogicalIssue` (normalise a ticket uid through the `SUPERSEDES` chain) and C3's `attest` (which C10 widens — see the C3 amendment below). Neither symbol exists at HEAD. Until **C1 is terminal and C3 is terminal** this spec is **not Ready and must not be implemented** — do not scaffold `appendSpecRevision`/`annotate` against a stub of either. The pointer path additionally needs the substrate **in-place CAS write** (SR-2 monotonic `revision` + SR-6 per-node CAS) in `tx.ts`; until that lands, the **shipped fallback is the existing `part_of` edge plus the derived `prev_revision` chain head** (Migration step 3, and §"Where the research model does not fit") — C10 never calls an unimplemented symbol on the shipped path.
- **Evidence requirement:** `spec-revision.spec.ts` + `spec-staleness.spec.ts` (real store, real verbs) with the AC1–AC9 negative controls, each of which must go RED; **AC3's negative control — a default-to-fresh implementation — is the head-line proof**. No LLM; runs default; exit-code keyed, not stdout.

> **Research note.** The model below is the **converged result** of the store-citizen research: *two ids + one pointer*, immutable revision objects, an append-only fragment log folded into a document, annotation kept out of the body, and staleness by token → content-hash → ancestry. It is **not re-derived here**; this spec encodes it. The prior draft (a `SPEC` item `part_of` its work item, an independent artifact) is **superseded** by this file.

## Summary

A work product — a spec, a plan, a research finding, a review verdict — is **a revision of its ticket**, never an independent artifact and never inline in the ticket's body. Identity is **two ids + one pointer**: the work item's stable **logical id** (resolved through the `SUPERSEDES` chain, so a body edit that churns the raw uid does not orphan the spec), an immutable **revision object** (`kind: SPEC`) per edit, and a single mutable pointer `meta.spec_revision` on the work item that names the current revision. Editing a spec **appends** a new revision — a new linked record — and advances the pointer; no prior revision is rewritten and the work item's uid is untouched. Each revision stores **only the fragment appended at that edit**; the document is the **fold** over the chain. Every read of the work item exposes the current **revision token** (the revision's `sha256:<hex>`), and a reader holding an older token is told it is **stale** — an **absent token is stale, never fresh**. Review commentary is a separate **annotation** record keyed to the exact revision, never in the body. The `SPEC` revisions already in the store (discovered by `query`, never a fixed count) are reconciled as the **current-revision objects** of their tickets (one current revision per ticket), not siblings.

## Model (the authoritative shape)

| Element | Concrete form |
|---|---|
| **Stable logical id** | the work item's logical id — resolved through C1's `resolveLogicalIssue` over the `SUPERSEDES` chain; identity is never the content, and a body edit that churns the raw uid does not orphan the spec (AC9). |
| **Revision object** | a `kind: SPEC` node; immutable — an edit mints a NEW node, never updates one. |
| **Revision body — fragment, not snapshot** | the revision node's `content` column holds **only the fragment** appended at that revision (`''` on the migration's base revision). The **document is the fold** of the chain's `content` values (seq 1 … N). No revision stores a full snapshot: a chain of N edits costs **O(N)** fragments, never O(N²) snapshots. |
| **Pointer** | `meta.spec_revision` on the work item → the current revision's uid (the *intent*). CAS-guarded when the SR-2/SR-6 write path exists; crossed against the derived chain head on every read. |
| **Append-only log** | each revision's `meta.prev_revision` names its predecessor; `meta.spec_of` names the ticket it belongs to. |
| **Revision token** | `meta.revision_token = 'sha256:<hex>'` of the **folded document** at this revision (not of the delta) — the O(1)-comparable staleness key. **ONE canonical encoding everywhere: `sha256:<hex>`** (never bare hex, never a raw uid). |
| **`spec_of` + its index** | `meta.spec_of` stores the ticket's logical id (**the head resolved at append time**). Read re-anchors by collecting the ticket's `SUPERSEDES`-chain uid set and matching `spec_of` against **any** member, ordered by `meta.revision_seq` desc — a bounded lookup backed by a functional index on `json_extract(meta,'$.spec_of')` created by the migration (see AC7/AC9). |
| **Anchor (export)** | `meta.anchor = {locator, digest}` — the long-form file is an **export**, never the source (Primitive 2). |
| **Annotation** | an `attestation` record whose `subject` is the **revision** (`{id: <revision uid>, token: <sha256:<hex>>}`); never in the revision body. |

**Anti-patterns this avoids, explicitly:** identity churn (the work item's uid never changes on a spec edit); lost history (append-only — no revision is updated or deleted); **forged currentness** (a writable "current" marker never compared — here the pointer is CAS-guarded *and* crossed against the derived chain head, and every read exposes the token); **snapshot bloat** (each revision stores its fragment, never the whole document — the fold is derived); unbounded body growth (the work item body never grows — content lives in revisions); edit wars (a stale `base_revision` is refused).

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| entrypoint/backlog | `src/write/spec-revision.ts` | create | 0 | 520 |
| entrypoint/backlog | `src/query/spec-staleness.ts` | create | 0 | 260 |
| entrypoint/backlog | `src/write/spec-annotation.ts` | create | 0 | 120 |
| entrypoint/backlog | `src/write/spec-revision.migrate.ts` | create (one-shot, reviewed, `--dry-run`) | 0 | 260 |
| entrypoint/backlog | `src/store/vocabulary-guard.ts` | modify (foundation — adds `SPEC`) | 60 | 20 |
| entrypoint/backlog | `src/store/vocabulary-drift.spec.ts` | modify (foundation — the pin: 13→14, both-ways, parser) | 80 | 40 |
| entrypoint/backlog | `src/write/tx.ts` | modify (foundation — adds `SPEC` to the discriminator line + the in-place pointer CAS) | 240 | 160 |
| entrypoint/backlog | `src/write/errors.ts` | modify (foundation — `SpecRevisionConflictError`) | 120 | 40 |
| entrypoint/backlog | `src/query/card.ts` | modify | 220 | 180 |
| entrypoint/backlog | `src/api.ts` | modify (mounts + `ERROR_CLASS_TO_ENVELOPE_CODE` row) | 180 | 120 |
| entrypoint/backlog | `src/index.ts` | modify | 60 | 30 |
| entrypoint/backlog | `src/server.ts` | modify (`BACKLOG_VERBS` 18→20) | 30 | 20 |
| entrypoint/backlog | `src/server.verbs.e2e.ts` | modify (`toBe(18)`→`toBe(20)` + doc) | 60 | 20 |
| entrypoint/backlog | `src/server.verbs.spec.ts` | modify (stub inventory — 2 new todos; no numeric pin) | 30 | 20 |
| entrypoint/backlog | `src/api.surface.e2e.ts` | modify (`EXPECTED` += `spec-append`/`spec-check`) | 120 | 40 |
| entrypoint/backlog | `src/write/spec-revision.spec.ts` | create | 0 | 620 |
| entrypoint/backlog | `src/query/spec-staleness.spec.ts` | create | 0 | 340 |

**Foundation gate (CONTRACT.md).** `write/tx.ts`, `write/catalog.ts`, `write/errors.ts` and `write/audit.ts` are declared READ-ONLY to downstream agents. This spec **requests** three amendments through the foundation owner (a request, never a unilateral edit): (a) add `'SPEC'` to `store/vocabulary-guard.ts`'s `RECOGNIZED_NODE_KINDS` — **widening recognition**, because `SPEC` is already live in the store today and is simply unrecognized by this build; (b) add the in-place metadata **CAS** write described below (`updateNodeMetaTx`); (c) add `SpecRevisionConflictError` to `write/errors.ts` **and** its explicit row to `api.ts`'s `ERROR_CLASS_TO_ENVELOPE_CODE` (see Interface changes).

**The vocabulary pin moves in lockstep — the exact updates, named.** `store/vocabulary-drift.spec.ts` reads the kind list out of `write/tx.ts`'s `IWriteNodeTxInput.kind` "entity-type discriminator" doc line and asserts set equality with `RECOGNIZED_NODE_KINDS` **both ways**, so touching one side without the other is red. Adding `SPEC` therefore updates, together: (1) `RECOGNIZED_NODE_KINDS` gains `'SPEC'` (size 13 → 14); (2) the `write/tx.ts` discriminator line gains `` `SPEC` ``; (3) the pin's assertions move with them — `expect(documented).toHaveLength(13)` → `14`, `expect(RECOGNIZED_NODE_KINDS.size).toBe(13)` → `14`, and the both-ways `expect(new Set(documented)).toEqual(new Set(RECOGNIZED_NODE_KINDS))` holds **only if the pin's backtick matcher is widened from `` `([a-z_]+)` `` to `` `([A-Za-z_]+)` ``** so the uppercase `SPEC` literal is parsed (the current matcher silently drops `SPEC`, leaving `documented` at 13 against a set of 14 — a red pin, not a silent pass).

**No new edge kind is introduced** — the ticket↔spec link stays `meta` (`spec_of` / `spec_revision`) plus the existing `part_of` edge; the relation enum is unchanged. `SPEC` is added to the **recognized node vocabulary** (13 → 14): a widening of recognition for a kind already live, **not** the minting of a new artifact type.

## Interface changes

### `entrypoint/backlog/src/write/spec-revision.ts` (NEW)

```typescript
export interface ISpecAnchor { locator: string; digest: string }

/**
 * Immutable revision object metadata (node `kind:'SPEC'`). The node's `content`
 * column holds the FRAGMENT appended at this revision (the delta; `''` only on
 * the migration's base revision, whose document is the existing SPEC body). No
 * revision stores a full snapshot: the document is the fold over the chain's
 * `content` values, and `revision_token` is the hash of that FOLD.
 */
export interface ISpecRevisionMeta {
  spec_of: string;              // the ticket's logical id (head resolved at append) — see Model
  revision_seq: number;         // 1,2,3… monotonic within the spec
  revision_token: string;       // 'sha256:<hex>' of the FOLDED document at this revision
  prev_revision: string | null; // predecessor revision uid (null for the base revision)
  anchor: ISpecAnchor;          // the long-form file export (Primitive 2)
  appended_by: string;
  appended_at: string;
}

export interface ISpecAppendInput {
  uid: string;              // the ticket's logical id — any uid on its SUPERSEDES chain is resolved forward
  fragment: string;         // the delta appended at this revision (becomes the node's `content`)
  anchor?: ISpecAnchor;     // the file export for this revision
  base_revision: string;    // REQUIRED CAS token — the revision uid the caller read
  by: string;
}
export interface ISpecAppendOutcome {
  uid: string;              // UNCHANGED — cross-checked by AC1
  spec_revision: string;    // the NEW revision uid
  spec_revision_token: string;  // 'sha256:<hex>'
  revision_seq: number;
}

/**
 * Append a revision. One BEGIN IMMEDIATE transaction (ADR-0001 + ADR-0012 — no
 * temp-file/rename/flock; atomicity is the store's job):
 *  1. resolve `uid` → logical head (C1 `resolveLogicalIssue`; input may be any SUPERSEDES-chain uid — AC9);
 *  2. read the current pointer `meta.spec_revision`; if ≠ `base_revision` →
 *     SpecRevisionConflictError (stale base — no write; AC6, envelope `precondition_failed`);
 *  3. writeNodeTx(kind:'SPEC', content:<fragment>, meta:ISpecRevisionMeta) — a NEW node (AC1/AC8);
 *  4. update the work item's `meta.spec_revision` in place via the CAS helper
 *     below, bumping `meta.revision` (SR-2) — the uid is preserved (AC1);
 *  5. writeAudit(action:'spec-appended').
 * NEVER UPDATE or DELETE a revision node (AC1/AC8).
 */
export async function appendSpecRevision(handle: IWriteStoreHandle, input: ISpecAppendInput): Promise<ISpecAppendOutcome>;

/** Current revision + its token for a work item (undefined if it has no spec). */
export interface ISpecPointer { revision_uid: string; revision_token: string; revision_seq: number }
export async function readSpecPointer(graph: GraphBackend, uid: string): Promise<ISpecPointer | undefined>;
```

### `entrypoint/backlog/src/write/errors.ts` — ADD

```typescript
/** `base_revision` no longer matches the current pointer — a concurrent edit
 *  won. E_VALIDATION, mapped EXPLICITLY to `precondition_failed` in api.ts's
 *  ERROR_CLASS_TO_ENVELOPE_CODE (see below) — the E_VALIDATION fallthrough would
 *  otherwise return `validation`, which AC6 must not ship with. No write runs. */
export class SpecRevisionConflictError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly expected: string, public readonly actual: string) { /* … */ }
}
```

### `entrypoint/backlog/src/api.ts` — `ERROR_CLASS_TO_ENVELOPE_CODE` (MODIFY)

Add ONE explicit row. `toEnvelope` walks the table top-down (first match wins; `BacklogWriteError` is deliberately absent as the bucket fallback), so the new class must be listed before any base:

```typescript
// api.ts — ERROR_CLASS_TO_ENVELOPE_CODE, alongside the other refused-write preconditions:
[IssueTerminalError, 'precondition_failed'],
[CitationRequiredError, 'precondition_failed'],
[NoteRequiredError, 'precondition_failed'],
[CitationUnverifiableError, 'precondition_failed'],
[SpecRevisionConflictError, 'precondition_failed'],   // C10 — AC6
```

**Why `precondition_failed`, not `conflict` (the AC6 code).** A stale `base_revision` is **not** resource contention — no other actor holds the node; the *caller's own* read is out of date and must be re-read before retrying. That is the same class as the existing refusing-write preconditions (`IssueTerminalError`, `CitationUnverifiableError`), which all map to `precondition_failed`. `conflict` is reserved for a resource another actor holds (`ClaimHeldError`, `SingleValuedRelationConflictError`); `StaleSupersedeError` (uid churn) maps there for historical reasons. C10 chooses `precondition_failed` and **AC6 asserts it**. Without this row the fallthrough (`WRITE_CODE_TO_ENVELOPE_CODE[E_VALIDATION] = 'validation'`) would return `validation`.

### `entrypoint/backlog/src/write/tx.ts` — FOUNDATION REQUEST (the in-place pointer CAS)

```typescript
/**
 * Update a LIVE node's `meta` in place inside `tx`, CAS-guarded on the node's
 * `meta.revision` counter (SR-2/SR-6). Preserves `uid`. Returns the new
 * revision number, or null on CAS failure. This is the ONLY write path that
 * mutates a node without superseding it, and it exists solely for the spec
 * pointer (and the SR-2 monotonic counter it bumps).
 */
export async function updateNodeMetaTx(
  tx: AdapterTransaction, uid: string, patch: Record<string, unknown>, expectedRevision: number
): Promise<number | null>;
```

### `entrypoint/backlog/src/query/spec-staleness.ts` (NEW)

```typescript
export type SpecFreshness = 'fresh' | 'stale' | 'unknown';
export interface ISpecCheckInput { uid: string; token?: string }
export interface ISpecCheckOutcome {
  current_revision: string;
  current_token: string;         // 'sha256:<hex>' — always this encoding
  state: SpecFreshness;          // 'fresh' | 'stale' | 'unknown' — NO 'drifted'
  method: 'token' | 'content_hash' | 'ancestry' | 'none';
  reason?: string;   // 'no-token-supplied' | 'older-token' | 'revision-drift' | 'non-git-root'
}

/**
 * Staleness compare, exposed on every read that can supply a token.
 * Ladder (cheap-first):
 *  1. TOKEN — `token === current_token` → fresh; differs → stale. Default rung.
 *  2. CONTENT HASH — recompute sha256 of the CURRENT FOLD; a match proves the frozen state.
 *  3. ANCESTRY — git merge-base of the anchored file's recorded commit vs HEAD;
 *     a non-git root or an unanchored revision degrades to `unknown`.
 * ABSENT token → state 'stale', method 'none', reason 'no-token-supplied' —
 * NEVER 'fresh', and never method 'token' (there was no token to compare) (AC3).
 * `unknown` is never fresh.
 */
export async function checkSpecStaleness(graph: GraphBackend, input: ISpecCheckInput): Promise<ISpecCheckOutcome>;
```

### `entrypoint/backlog/src/write/spec-annotation.ts` (NEW — thin, reuses Primitive 2)

```typescript
/**
 * The annotation I/O, DEFINED HERE (it was previously unnamed). An annotation
 * is a `kind:'attestation'` record keyed to the EXACT revision object:
 *   subject = { id: <revision uid>, token: <revision token, 'sha256:<hex>'> },
 *   anchor  = { locator: 'revision:<revision uid>', digest: <revision token> }.
 * It is never written into the revision body (AC4); because the revision is
 * immutable, a comment on revision n can never drift onto revision n+1.
 */
export interface IAnnotateInput {
  subject: { id: string; token: string };  // the revision uid + its 'sha256:<hex>' token
  comment: string;
  anchor?: ISpecAnchor;                    // defaults to the revision anchor above
  by: string;
}
export interface IAnnotateOutcome {
  annotationUid: string;                   // the created `attestation` node uid
  subject: { id: string; token: string };  // echoed, revision-keyed
  check: IAttestCheck;                     // C3's shape — unchanged
}
export async function annotate(handle: IWriteStoreHandle, input: IAnnotateInput): Promise<IAnnotateOutcome>;
```

**C3 amendment (state the dependency at its use; the widening is OWNED by C3).** `annotate` delegates to C3's `attest`; it does not re-implement one. C3's `attest` currently resolves an `issue`-kind subject and types `subject.revision` as `number`. Annotation of a revision needs two **widenings**, not a new mechanism: (a) `subject.id` may name a `SPEC` node (its SUPERSEDES normalisation is a no-op for an unchained node); (b) `subject.revision` accepts an **opaque `sha256:<hex>` token string** as well as a counter. This is a contract widening **owned by the C3 spec** — a reciprocal note is added there (`C3-attestation.spec.md`). C10 does not widen C3 unilaterally.

### `entrypoint/backlog/src/query/card.ts` — expose the pointer on every read

```typescript
// AFTER — the issue card gains (never the spec body inline):
export interface IIssueSpecProjection {
  spec_revision: string;         // revision uid (the pointer's target)
  spec_revision_token: string;   // 'sha256:<hex>' — the token a reader holds and compares
  revision_seq: number;
  freshness?: SpecFreshness;     // present only when the caller supplied a token
}
// card.spec?: IIssueSpecProjection   — absent when the item has no spec
```

### `entrypoint/backlog/src/api.ts` (MODIFY — mount)

```typescript
export async function specAppend(ctx: BacklogCtx, input: ISpecAppendInput): Promise<IOutcomeEnvelope<ISpecAppendOutcome>>;
export async function specCheck(ctx: BacklogCtx, input: ISpecCheckInput): Promise<IOutcomeEnvelope<ISpecCheckOutcome>>;
// Mount names `spec-append` / `spec-check`; both added to server.ts's BACKLOG_VERBS
// so extraction and the transports cannot drift. BACKLOG_VERBS is HAND-PINNED,
// not derived — cli.ts's argv parser cannot be projected from the descriptors like
// the other three transports — then checked both ways against the live surface
// (server.verbs.e2e.ts). Flat `content` payload (ADR-0004).
```

**Surface-count updates (the verbs are pinned in three places, all moving together).** `server.ts`'s `BACKLOG_VERBS` 18 → 20; `server.verbs.e2e.ts`'s `expect(BACKLOG_VERBS.length).toBe(18)` → `20` (its `MOUNT_OP_*` counts derive from `surface.length` and need no change); `api.surface.e2e.ts`'s longhand `EXPECTED` gains `backlog/spec-append` and `backlog/spec-check` (its `toHaveLength(EXPECTED.length)` then tracks); `server.verbs.spec.ts`'s stub inventory gains the two `it.todo` rows.

## Behavioral changes

### `write/spec-revision.ts` — `appendSpecRevision()`

- **Change:** new verb; one `executeWriteTransaction` under BEGIN IMMEDIATE (ADR-0001/0012).
- **New revision is a new node storing the FRAGMENT:** `writeNodeTx(kind:'SPEC', content:<fragment>, meta:ISpecRevisionMeta)`. The document is derived by folding the chain — never snapshotted (AC8). It is never an update to a prior revision.
- **Pointer advance is in-place:** `updateNodeMetaTx(workItemUid, {spec_revision:<newUid>, spec_revision_token:<token>}, expectedRevision)` — the work item's `uid` is preserved; only its `meta` changes and `meta.revision` bumps (SR-2). This is the **one** place the pointer moves.
- **CAS first:** if `base_revision` ≠ the current pointer → `SpecRevisionConflictError` (envelope `precondition_failed`), no node written (AC6).
- **Never touches a revision node** after creation (AC1/AC8).

### `query/spec-staleness.ts` — `checkSpecStaleness()`

- **Change:** pure read; the ladder above.
- **Absent token is not a bypass:** no token → `stale` with `method:'none'`, reason `no-token-supplied` (AC3).
- **Pointer/chain cross-check (forged-currentness guard):** `readSpecPointer` returns `meta.spec_revision`; the module independently derives the chain head by the **indexed `spec_of` lookup** — collect the ticket's `SUPERSEDES`-chain uid set, select the live `SPEC` node whose `meta.spec_of` is in that set with the max `meta.revision_seq`, backed by the functional index on `json_extract(meta,'$.spec_of')`. If the pointer disagrees with that head, the state is `stale` for every caller (reason `revision-drift`) and the divergence is reported — the pointer is never silently trusted (AC7).

### `get` / `query` — every read exposes the pointer

- **Change:** `assembleIssueCard` (in `query/card.ts`) gains `card.spec` (token + uid + seq) when the item has a spec; when the caller supplied a token, `freshness` is included. The card **never** carries the revision body.
- **Scope:** additive field; existing card keys unchanged.

### `write/spec-annotation.ts` — `annotate()`

- **Change:** delegates to C3's `attest`; the revision body is never modified (AC4).

## Data / migration steps — the existing SPEC revisions

The live `kind:'SPEC'` items (discovered by `query {filter:{kind:"SPEC"}}`, never a hardcoded list) are reconciled **in place** (no re-key — DESIGN §6) as the **current-revision objects** of their tickets. One reviewed, idempotent, `--dry-run`-first script `spec-revision.migrate.ts`:

1. Create the bounded lookup index (idempotent): `CREATE INDEX IF NOT EXISTS spec_of_seq ON node (json_extract(meta,'$.spec_of'), json_extract(meta,'$.revision_seq'))`. Without it the AC7/AC9 lookups degrade to a scan (still correct, unbounded).
2. For each SPEC node `S` with `part_of` parent `W`: stamp `S.meta` with `{spec_of: <logical id of W via C1 resolveLogicalIssue>, revision_seq: 1, prev_revision: null, revision_token: 'sha256:<fold = S.content>', anchor: {locator:<its spec file path>, digest:<its existing digest>}}`, and set the node's `content` to the base document (its fragment is the base — see Model).
3. Set `W.meta.spec_revision = S.uid` (the pointer) via `updateNodeMetaTx` where the SR-2/SR-6 write path exists; until it does, the pointer is **not** written and the head is derived from the `part_of` link + the `prev_revision` chain. **`W` is not superseded — its uid is unchanged.**
4. **Keep the `part_of` edge** (`W → S`). It is the **shipped structural link** between a ticket and its spec, and it is what makes "one current revision per ticket" checkable before the pointer write path lands. A spec revision is **not** counted as an independent work child: the rollup's `part_of` child-count is a **derived view over `kind:'issue'` children only** (the same kind-scope fix C2 specifies for `queryOrder`), so a `SPEC` child is excluded from the count while the edge remains for linkage. *(The pointer is the intent; the edge + derived chain head is the shipped realization. Retiring the edge was rejected as removing the only shipped link in favour of an unshipped write path.)*

**Assertion (AC5):** over the **discovered set** (every ticket with a live `SPEC` in scope, never a fixed count), the pointer-or-derived-head resolves to exactly one live `SPEC` node, and that node is the unique head of a `prev_revision` chain (`prev_revision: null` at its base, no live successor). No ticket carries two current revisions.

## Independent segments

### Segment A — foundation amendments (must land first)
- **Files:** `store/vocabulary-guard.ts` (`'SPEC'`), `store/vocabulary-drift.spec.ts` (pin: size 13→14, both-ways, parser widening), `write/tx.ts` (`'SPEC'` on the discriminator line + `updateNodeMetaTx`), `write/errors.ts` (`SpecRevisionConflictError`).
- **Dependencies:** none. **Blocks** B–E. **Read tokens:** ~400. **Output tokens:** ~260.
- **Required context:** read `RECOGNIZED_NODE_KINDS` (`vocabulary-guard.ts`), the pin (`vocabulary-drift.spec.ts`), and `tx.ts`'s node-write helpers ONLY. Hand to the foundation owner per CONTRACT.md.

### Segment B — `spec-revision.ts` + `spec-staleness.ts`
- **Files:** both new. **Dependencies:** A. **Read tokens:** ~200 (mirror `transition.ts`'s transaction skeleton). **Output tokens:** ~780.

### Segment C — card projection
- **Files:** `query/card.ts`. **Dependencies:** B. **Read tokens:** ~220. **Output tokens:** ~180.

### Segment D — annotation + api mount + surface pins
- **Files:** `write/spec-annotation.ts`, `api.ts`, `index.ts`, `server.ts`, `server.verbs.e2e.ts`, `server.verbs.spec.ts`, `api.surface.e2e.ts`. **Dependencies:** A (and C3's widening). **Read tokens:** ~350. **Output tokens:** ~420.

### Segment E — migration + tests
- **Files:** `spec-revision.migrate.ts`, `spec-revision.spec.ts`, `spec-staleness.spec.ts`. **Dependencies:** all. **Read tokens:** ~200. **Output tokens:** ~1260.

## Test cases (AC → test, with a negative control)

| AC | Test (real store, real verbs — no mocks) | Negative control (must go RED) |
|----|------------------------------------------|-------------------------------|
| **AC1** Append without uid change, no prior revision rewritten | `get` item → capture `uid` + `spec_revision`; `spec-append` → re-`get`: `uid` byte-identical, `spec_revision` advanced to a NEW uid; `get` the prior revision → its original `content` and token are intact. | A build that implements append by superseding the work item, or by updating the prior revision node in place, must fail. |
| **AC2** Token exposed on read; an older token → stale | `get` exposes `spec_revision_token`; `spec-check` with the pre-append token → `state:'stale'`. | A build that returns `fresh` for a differing token must fail. |
| **AC3** **Absent token → stale, never fresh** | `spec-check {uid}` with **no** `token` → `state:'stale'`, `method:'none'`, `reason:'no-token-supplied'`. | **Head-line control:** a default-to-fresh implementation (`token ?? current` → `fresh`) must fail this test. |
| **AC4** Annotation never enters the revision body | `annotate` revision `r`; re-read `r` → `content` byte-identical; the annotation exists as a separate `attestation` whose `subject.id === r`. | A build that appends the comment to the revision body, or keys it to the work item instead of the revision, must fail. |
| **AC5** Discovered specs are revisions; one current revision per ticket | Over the **discovered** set (every ticket with a live `SPEC`, no fixed count): the pointer-or-derived-head → exactly one live `SPEC`, unique `prev_revision`-chain head; no ticket has two. | A build that leaves the SPECs as `part_of` siblings unlinked to a head, or lets two revisions both read current, must fail. |
| **AC6** CAS: a stale `base_revision` is refused, no write, code `precondition_failed` | Append with `base_revision` = the pre-append uid → envelope `error.code === 'precondition_failed'`; revision count and pointer unchanged. | A build that appends anyway (last-writer-wins), or that maps the class to the `E_VALIDATION` fallthrough code `validation`, must fail. |
| **AC7** Pointer/chain divergence → `stale`, never trusted | Inject `meta.spec_revision` pointing at a non-head revision; `spec-check` → `state:'stale'`/`reason:'revision-drift'` for every caller. | A build that trusts `meta.spec_revision` without the indexed chain cross-check must fail. |
| **AC8** Work-item body never grows; revision is a **fragment**, document is the fold | After N appends, `W.content` is unchanged; revision `seq:N`'s stored node `content` is its **own fragment only**, and `fold(revisions 1..N)` reconstituted from the chain equals `revision_token`'s hashed document. | A build that writes the spec into `W.content`, **or that snapshots the full document into each revision (O(N²))** — detectable because revision N's `content` would contain fragment 1's text — must fail. |
| **AC9** A body-edit of the ticket does not orphan its spec | `spec-append` rev 1 on ticket A; `update {body}` on A → live uid B; re-`get` B (or A) → `spec_revision` still resolves to the same revision, and `spec-check` still reports a `state`/`method`. (`spec_of` = head-at-append; read re-anchors over the ticket's SUPERSEDES-chain uid set.) | A build that stores/matches `spec_of` as a **raw uid by exact equality** (no SUPERSEDES re-anchor) loses the spec after the edit → red. |

**UX acceptance.** `adhd-backlog backlog spec-append --input '{"uid":"b076742d-…","fragment":"## AC1 …","base_revision":"⟨rev-0⟩","by":"architect:axl-1"}'` → `{ok:true,data:{uid:"b076742d-…",spec_revision:"⟨rev-1⟩",spec_revision_token:"sha256:…",revision_seq:2}}`. `adhd-backlog backlog spec-check --input '{"uid":"b076742d-…"}'` (no token) → `{state:"stale",method:"none",reason:"no-token-supplied"}`.

## Blast radius

- `RECOGNIZED_NODE_KINDS` — read by the open/write/query guards; adding `'SPEC'` can only *widen* recognition (the kind is already live). **LOW.**
- `store/vocabulary-drift.spec.ts` — the fail-closed pin; the kind, the `tx.ts` discriminator line, and the pin's size/both-ways assertions plus its backtick matcher must move in one commit or the pin is red. **LOW** (test-only), but **must not be split** from the `RECOGNIZED_NODE_KINDS` edit.
- `updateNodeMetaTx` (`tx.ts`, foundation) — the **only** in-place node mutation path; reached solely by `appendSpecRevision` and the migration. It must preserve uid and bump `meta.revision`. **MEDIUM** — it is the seam the whole model rests on; it must be CAS-guarded, and no other verb may adopt it without a new decision. This is genuine, declared debt: the shipped fallback (pointerless, edge + derived head) is specified so C10 is not blocked on it.
- `assembleIssueCard` (`card.ts`) — callers: `get` + the card paths of `query`. `card.spec` is an additive optional field. **LOW.**
- `attest` (C3) — widened (subject kind + opaque token revision); the existing issue-subject path is unchanged. **LOW** (additive branch, owned by C3).
- `BACKLOG_VERBS` / `server.ts` — two new verbs added to the **hand-pinned** list (18→20), matched by `server.verbs.e2e.ts`'s `toBe(20)` and `api.surface.e2e.ts`'s `EXPECTED`. **LOW.**
- `ERROR_CLASS_TO_ENVELOPE_CODE` / `api.ts` — one added row before the bases; every existing mapping is untouched. **LOW.**

> **Tooling note.** Run `gx impact appendSpecRevision`, `gx impact updateNodeMetaTx` and `gx impact assembleIssueCard` before editing, and reconcile. The `sr-2`/`sr-6` substrate interfaces this spec consumes are **required** (SR-2, SR-6 of `substrate-fleet/SOX-REQUIREMENTS.md`), not observable in this repo; they are named as a hard dependency in the DoR, not a footnote.

## Deliberately NOT changed

- **No markdown regeneration** (sox ADR-0009 → ADR-0011): the file is an export, never the source (AC7's boundary). A store→file rewrite job is refused by design.
- **No new edge kind and no new relation** — the ticket↔spec link stays `meta` (`spec_of`, `spec_revision`) plus the existing `part_of` edge; the relation enum is unchanged. `SPEC` enters the **recognized node vocabulary** (13→14) because it is already live — recognition widened, not a new artifact type minted.
- The `update` supersede mechanism — append never calls it; the body-edit case is handled by read-time re-anchoring through `SUPERSEDES` (AC9).
- **`ITEM_NODE_KIND` stays `'issue'`** — a `SPEC` is a revision object, not dispatchable work; it is reached by pointer/edge, never listed as an open item.

## Where the research model does not fit the shipped tool (stated plainly, not forced)

1. **The on-record mutable pointer has no shipped write path.** The shipped `update` supersedes the node and mints a new uid; there is **no in-place metadata write** today (that is precisely why C3 chose a *sibling* attestation record). The model's "single mutable pointer on the record" therefore requires `updateNodeMetaTx` — a CAS write whose substrate interfaces are **SR-2 (monotonic `revision`)** and **SR-6 (per-node CAS)**, both *required-sox*, not shipped, and named as a **hard dependency in the DoR**. Until they land, the semantics are preserved by a **derived fallback over the shipped mechanism**: the ticket↔spec link is the **`part_of` edge** (kept, Migration step 4), the current revision is the head of the `prev_revision` chain, and the pointer is reported `stale`/`revision-drift` when it diverges from that head (AC7). The design specifies `meta.spec_revision` as intent and the edge + chain head as the shipped-tool realization — it does not pretend the in-place write already exists.
2. **Ancestry staleness needs git.** The third rung (git merge-base) degrades to `unknown` when there is no git root or the anchored artifact is a `registry:`/`url:` ref — never to `fresh`. The token and content-hash rungs still work. Same ladder discipline as C3's `anchor-check`.
3. **The stable logical id must be chain-normalised, not a raw uid.** If a ticket's own body is edited today its uid churns (defect `5b555754`). `spec_of` stores the ticket's logical id (the head resolved at append time via C1's `resolveLogicalIssue`), and the read path re-anchors by matching against the ticket's `SUPERSEDES`-chain uid set (bounded by the `spec_of` index) — so a spec survives a ticket body-edit, mirroring C3's `subject.id`. Storing/matching a raw uid by exact equality would silently orphan the spec on the first body edit (AC9).
