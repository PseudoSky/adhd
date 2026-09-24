# Scoping — first-class notes / addendums on an existing issue

**Status:** SCOPING ONLY — no code, no schema change, no mount. Awaiting a decision on the
ranked questions in §10 before any spec is written.
**Package:** `@adhd/backlog` (`entrypoint/backlog`)
**Author:** product (`product:notes-addendum-scoping`), 2026-09-23
**Tracking:** FEAT item `caeaeca2-d1b2-4e33-b71c-67f80a6e9caf`
(`relates_to` the open gap `fce03d93-4163-4b4b-b817-9e8ded40dad3`; the identity-churn
defect it exists to avoid is `bf97b4ed-b0ae-4f2e-9704-190d0f22db6a`).
**Verdict carried from `architect-decision` (one-shot):** `APPROVED_WITH_CONDITIONS` —
no ADR forbids the shape; ADR-0010 opens `kind`/`rel` precisely so consumer vocabulary is
legal, ADR-0012 admits a pure-INSERT append, and the repo **lacks** the ADR this feature
presupposes (issue-uid identity stability). Conditions listed in §10.

---

## 1. Problem statement

An issue's body is the only place its content lives, and the only way to change it is
`update`. A `body` change does not edit in place — it **supersedes**: it mints a successor
node with a **new `uid`** and joins the two with a `SUPERSEDES` edge
(`SKILL.md:270-292`; `README.md:178-188`; implementation `src/write/update.ts`, the
supersede branch plus `carryForwardResidualEdgesTx` at `src/write/update.ts:549-583`).

Three consequences, all observed live rather than inferred:

1. **Every persisted reference to the old uid silently stops resolving.** `get <old-uid>`
   returns `conflict`, naming the successor. This was reproduced first-hand during scoping:
   enriching an item minted a successor uid and the original address became a redirect
   (`get` → `conflict / superseded by a body edit`).
2. **Evidence, triage findings, and corrections cannot be attached without churning
   identity.** So they are either lost or they displace the item's original framing — the
   item becomes "the new text with the old text gone".
3. **Partially-superseded claims have nowhere to live.** The item is either the old (wrong)
   text or the new text with the old text deleted.

**The friction is already one of this package's documented failure modes.** The open triage
item `bf97b4ed-b0ae-4f2e-9704-190d0f22db6a` establishes that supersede is keyed on the
_presence_ of the `body` key, not on the body changing; that write verbs' stale-uid error
omits the successor uid; and that **no read surface enumerates superseded rows**. The
docs-consistency item `0f1f4a9c-1395-472f-8fe4-db85ee89e3c3` records that `SKILL.md:14`
invites consumers to persist the uid as _the_ identity while `SKILL.md:245-246` retires it
on any body edit, and that the recovery path (`successorUid`, chain re-resolution) is
documented nowhere in the skill.

**The capability cost is measured, not rhetorical.** Two independent PKG-11 dispatches
(2026-09-03; memory episodes `01M1MG8TQESKGZH07HQNSAHP2Y`, `01M1MG5A595MCG3DED9X640PEH`)
completed real work but **could not append their findings to their own items** — no note
tool existed in their toolset — so they asked the orchestrator to append the notes by hand.
They never landed. This is the same failure the repo's own global disclosure policy
(`AGENTS.md` / `~/.claude/AGENTS.md`: _"Never leave a dangling thread when tying it off
takes five more minutes"_) exists to prevent.

**And an accepted ADR already assumes the missing verb exists.** sox-ecosystem
**ADR-0011** (ACCEPTED 2026-08-06), §"What changes" item 2, rules that notes and citations
on `BL-*` items move to the tool calls **`backlog_append_note`** / `backlog_add_citation`.
Neither verb exists in the 1.0.0 surface. ADR-0011's ruled Stage-1 migration path is
therefore unexecutable as written.

## 2. What already exists — this is a MOUNT gap, not a model gap

The critical finding of this scoping pass: **the model is already there and already
correct.** A note is already a first-class node kind with a dedicated edge, already read
into the issue card, and already carried across a supersede. What is missing is exactly one
mounted write verb.

| Layer         | State today                                                                   | Evidence                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node kind     | `note` is a recognized kind (`kind='note'`)                                   | `src/store/vocabulary-guard.ts:63-77` (`RECOGNIZED_NODE_KINDS`, `'note'` at `:73`)                                                                          |
| Node shape    | `meta: { author, text, at }`, `content` = the text                            | `DATA_MODEL.md:169-170`; `SPEC.md:236`                                                                                                                      |
| Edge          | `has_note: issue → note (1:n)`, registered with multiplicity                  | `DATA_MODEL.md:208`; `SPEC.md:254`; `src/write/catalog.ts:347-354`                                                                                          |
| Read          | resolved into the card as `IIssueNote[]`, opt-in                              | `src/query/types.ts:127-132` (`IIssueNote`), `:54`/`:82` (`'notes'` pseudo field), `:184`; `src/query/card.ts:133-149` (`resolveNotes`), `:282`, `:338-339` |
| Read surface  | `get --input '{"uid":…,"fields":["notes"]}'` already returns them             | `SKILL.md:250` (field vocabulary)                                                                                                                           |
| Survivability | a supersede carries `has_note` forward to the successor                       | `src/write/update.ts:549-583` (`carryForwardResidualEdgesTx`, both directions)                                                                              |
| Write         | **the only path in the codebase** is `create`'s duplicate-gate comment branch | `src/write/create-issue.ts:752-784`                                                                                                                         |
| Mounted verbs | none of the 17 verbs writes a note                                            | `src/server.ts:189-207` (`BACKLOG_VERBS`); `SKILL.md:29-53`                                                                                                 |

Two consequences of that table drive the whole scope:

- **The mount is the deliverable.** `api.ts`'s own header states the rule: _"The exported
  surface of this file IS the mounted surface … Adding an exported function here widens the
  tool surface an agent must hold in its head"_ (`src/api.ts:1-13`). So this feature is a
  deliberate, costed widening of a surface the package has been _shrinking_ (the pre-1.0.0
  37-tool surface was consolidated; `TASK-003`). §9 justifies the widening.
- **Do not invent a parallel model.** A second way to hold commentary (an inline field, a
  body convention) would fragment the read path that already works.

## 3. User stories

| #    | As…                                                   | I want…                                                | So that…                                                                               |
| ---- | ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| US-1 | an agent that just triaged an item                    | to append my findings to it                            | the evidence lives on the item, and the item keeps the uid everyone already references |
| US-2 | an agent filing a partial correction                  | to state the correction without deleting the original  | a reader can see both the original claim and why it is wrong                           |
| US-3 | an orchestrator whose worker finished                 | to attach the worker's completion evidence to the item | the closure has an auditable addendum rather than a rewritten body                     |
| US-4 | an observer whose item is **claimed by someone else** | to attach evidence anyway                              | the evidence stream is not blocked by a working lease (see §6, INV-6)                  |
| US-5 | an operator auditing an item                          | to read its notes in order, with author and timestamp  | I can reconstruct what was asserted, by whom, and when                                 |
| US-6 | a consumer searching for a phrase                     | to find the item whose **note** contains it            | evidence is not a write-only grave                                                     |
| US-7 | a reader arriving after a body edit                   | to still see pre-edit notes                            | a supersede does not orphan the evidence trail                                         |
| US-8 | an agent working from the ADR-0011 migration          | to call the verb that ADR names                        | the accepted ADR's ruled path is executable                                            |

Non-user: US-8 is a _conformance_ need, not a persona. It is listed because it fixes a
documented contradiction, not because an agent feels it.

## 4. Proposed surface (exact names)

**One new mounted write verb.** Recommended name, verbatim from the tool name ADR-0011
already rules on:

| Mount          | Name                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| CLI            | `adhd-backlog append-note --input '<IAppendNoteInput json>'`                             |
| MCP            | `backlog_append_note`                                                                    |
| HTTP           | generated from the same descriptor (no per-transport work)                               |
| Library export | `appendNote(ctx, input)` (`src/api.ts`, re-exported for library-only use via `index.ts`) |
| `batch`        | `backlog/append-note` — free, since `batch action` covers every mounted op               |

**Why `append-note` and not `note`.** (a) ADR-0011 names `backlog_append_note`; matching it
restores a ruled contract instead of contradicting it. (b) The verb is _append_-only by
construction (§6), and the name should say so. (c) `note` alone collides conceptually with
`transition`'s existing `note` field (`src/write/transition.ts`; `SKILL.md:75`), which is a
different thing entirely (the rationale of a status change, stored on a `transition` node).
Conformance condition C5 from the architect verdict requires this reconciliation.

Proposed input:

```ts
interface IAppendNoteInput {
  uid: string; // the issue to append to (resolve-only, must be LIVE)
  by: string; // actor, `${agentName}:${instanceId}` (mutating-verb convention)
  text: string; // the note body (required, non-blank)
  kind?: string; // note classifier — see §10 Q6; CLOSED vocabulary, never minting
  citations?: ICitationInput[]; // { file, lines?, context?, symbol? } — see §7
  clientRequestId?: string; // optional idempotency key — see §10 Q4
}
```

Returns `{ uid, noteUid, appendedAt }` where `uid` is the **unchanged** issue uid.

**Explicitly NOT proposed:** a `notes` _read_ verb. `get`'s existing
`fields:["notes"]` projection (`SKILL.md:250`) already returns them, and a second read
surface would be a second thing to keep in sync. The read gap that _does_ need work is
search reachability (§7), which is not solved by another read verb.

## 5. Semantics and invariants

**INV-1 — Append never changes the issue's identity.** No new `issue` node, no `SUPERSEDES`
edge, no uid change. This is the entire point of the feature and the reason it is not a
`body` edit.

**INV-2 — Append is a pure INSERT.** Exactly one `note` node and exactly one `has_note`
edge. It must not read-modify-write the issue row, its `has_status` / `has_kind` /
`has_priority` / `authored_by` edges, or its claim. This is the ADR-0012-safe shape (the
multiprocess-write invariant admits pure INSERT; it is the read-modify-write corners that
need busy-timeout and retry) and is architect-verdict condition C1.

**INV-3 — The target must be live.** Resolving a superseded or deleted uid must `conflict`
and name the successor — never write an orphan `has_note` edge against a non-live node.
Reuse the read path's existing chain-head resolver (`src/query/resolve.ts:96-123`,
`currentUidOf`) rather than inventing a second one. (Condition C2.)

**INV-4 — A note is immutable once written.** No in-place edit. A correction is a further
note. If retraction is ever needed it is a bi-temporal soft-invalidate of the note node
(the mechanism `delete` already uses for issues), never a physical removal and never a
metadata rewrite. See §10 Q2.

**INV-5 — A note carries its own provenance.** `author`, `text`, `at` are already in the
node metadata contract (`DATA_MODEL.md:169-170`) and are already surfaced by `IIssueNote`
(`src/query/types.ts:127-132`). `by` is required and blank-rejected before any write, like
every other mutating verb (`SKILL.md:194-197`).

**INV-6 — Append is not gated by the working claim.** A claim is a lease on _moving the
item_ (it guards `transition`); evidence is additive and non-destructive. If append were
claim-guarded, US-4 would fail and the exact PKG-11 blockage would recur whenever another
agent held the lease. This is a deliberate divergence and is ranked in §10 (Q3).

**INV-7 — Append does not change status, priority, kind, or assignee.** If a note should
move the item, that is `transition`; if it should reprioritise it, that is `update`. A note
that silently transitions would be the `update`-partially-applies-a-transition defect class
again (see `328c600a-33c0-4c28-b435-80d5ac9460d7`).

**INV-8 — Notes are append-ordered by their own timestamp.** Ordering across processes is
**not** FIFO (ADR-0012 §1, architect condition C3), so note sequence must be derived from
each note's `at`, not from insertion order. Note that `resolveNotes` today does **not** sort
(contrast `resolveAuditTrail`, which sorts by `at` at `src/query/card.ts:173`) — so current
order is incidental. §10 Q1.

**INV-9 — Retry safety is explicit, not assumed.** ADR-0012's retry model re-runs a failed
transaction, so a transient failure can double-insert a note. Append-only semantics make a
duplicate benign, but benign-by-accident must be stated and tested; `clientRequestId`
(after `memory_write`'s `client_request_id` precedent) is the optional hardening. §10 Q4.

**INV-10 — No body text is ever rewritten by an append.** A correction is a note _about_
the original; the original text remains byte-identical. This preserves the
"both the original and why it is wrong" property that US-2 exists for — the property a body
edit destroys.

## 6. How this composes with supersession, search, and embedding

### 6.1 Supersession

- A note **never** supersedes the _item_. Note → item is additive only. Body edits remain
  the only supersede path (`update`), unchanged.
- A note **can** record that it supersedes a _prior note_ (`supersedesNoteUid`, note→note).
  That is cheap, addressable, and churns nothing.
- A note **cannot yet** supersede a specific _claim inside a body_, because claims are not
  addressable today: the body is an opaque `content` string on the issue node
  (`DATA_MODEL.md:151-152`). Two honest options:
  - **(a) v1 — additive only.** A `kind:'correction'` note states the correction in prose
    and cites `file:line`. Consumers must read all notes to know. Weak, but unimpeachable
    and shippable now.
  - **(b) v2 — addressable claims.** Give body sections stable anchors (content-hash
    anchors, or `has_claim` child nodes) so a note can carry a precise
    `supersedesClaim` pointer. This is a **data-model change** and belongs in an ADR, not in
    a product decision. Recommend v1 ships, v2 is scoped separately (§10 Q7).
- Notes already survive a body-edit supersede: `carryForwardResidualEdgesTx` re-points
  `has_note` from the superseded node to its successor, in both directions
  (`src/write/update.ts:549-583`). **That behaviour has no acceptance criterion of its own
  today** — AC-4 below makes it observable.

### 6.2 Search — today a note is invisible, and that is the biggest product risk

This is the sharpest finding of the pass. A note written today is reachable **only** by
`get <uid> fields:["notes"]`. It is invisible to both search channels:

- **Keyword (`filter.grep`) is blind to notes.** `query`'s base filter is
  `{ kind: 'issue', isSuperseded: false, … }` (`src/query/query.ts:443-451`), and that same
  filter is passed into `graph.searchNodes(grep, { filter: baseFilter })`
  (`src/query/query.ts:479-484`). Note nodes are filtered out before the FTS match. Even
  the card's own documentation scopes `grep` to "title+body"
  (`src/query/types.ts:217`).
- **Semantic search is blind to notes.** The vector filter is the same `kind:'issue'`
  base filter (`src/query/query.ts:494-503`), and no code path embeds a `note` node at all:
  the embedding unit is `${title}\n${body}` of the _issue_
  (`src/write/embedding-observer.ts:86`), and the one existing note-write path explicitly
  schedules **no** embed — `embeddedIssue` "stays `undefined` on every branch that writes
  no issue node … `'comment'` (writes only a `note`)" (`src/write/create-issue.ts:731-739`).

So **the note layer is a write-only grave for discovery purposes.** The task framing is
right: _a note that is invisible to search may be worse than no note_, because it creates
the false confidence that evidence was captured where it can be found. Two consequences for
the spec:

- **Minimum acceptable v1:** make note text reachable by **keyword** search — a note hit
  must map back to its owning issue, so the user still gets an _item_ back. This is a
  scoping decision with a real cost (it widens the grep filter's semantics beyond
  "title+body") and is ranked first in §10.
- **Embedding a note is a bigger architectural call** than it looks: the embedded unit
  would have to be re-decided (the note itself? a re-embed of the owning issue? a
  sidecar vector?). It is an ADR/architecture-decision item, not a product call (§11).
  Until it lands, the honest behaviour is to **report the limitation**, never to imply a
  note is semantically searchable when it is not — the same rule the package already
  applies to an unwired vector space (`rag_not_configured`, `README.md:345-355`).

### 6.3 What append must **not** touch on the issue

`updatedAt` / status / priority: status and priority are settled by INV-7 (never). The
issue's `updatedAt` (`t_valid`) is a genuine open question, ranked in §10 Q5: touching it
makes a newly-evidenced item surface in `sort:'updated'` scans (good for triage visibility)
but makes `updatedAt` mean "anything happened" rather than "the item's own fields changed"
(noisier, and it is a write to the issue row, brushing against INV-2). Note that
`view:'stale'` keys on `claimedAt`, not `updatedAt` (`src/query/types.ts:302-303`), so a
note cannot be used to game staleness either way.

## 7. Citations on notes

The tracker's evidence model treats a citation as a first-class content-addressed node,
`has_citation: issue → citation`, with `sha` re-verified against the file
(`DATA_MODEL.md:172-178`; `SKILL.md:539-560`). A note that carries evidence should be able
to carry citations too — otherwise the evidence ends up as unverifiable prose inside the
note text, which is strictly worse than the pin it replaces.

Two shapes, unresolved (§10 Q8):

- **(a) Reuse `has_citation` from the issue.** Zero new vocabulary, zero new edge kinds;
  cost: a note's citation is indistinguishable from the item's own, and the read path
  attributes it to the item.
- **(b) A new edge `has_note_citation: note → citation`.** Correct attribution; cost: a new
  edge kind in the type policy, i.e. a vocabulary widening — ADR-0010 makes this _legal_,
  but it must be a deliberate, registered addition (`src/write/catalog.ts:347-354` is the
  registration site), not an accident.

Either way the `sha` verification gate and its `unverified` sentinel semantics
(`SKILL.md:549-560`) apply unchanged. This is a smaller decision than it looks and should
not hold up v1.

## 8. Non-goals

The word "note" invites scope creep into a social product. Explicitly **out of scope**:

- **Comments, threads, replies, reactions, mentions, notifications.** A note has no parent
  note, no reply-to, no thread, and no delivery. If a threaded-conversation product is ever
  wanted, it is a different feature with a different data model — it does not grow out of
  this by adding fields.
- **Chat / conversation.** The tracker is a record, not a channel.
- **Editing the item body through a note.** That is `update`, and a note that wanted to
  become the body would reintroduce the supersede churn this feature exists to avoid.
- **Replacing `transition`'s `note`.** A transition's note is the _rationale of a status
  change_ and lives on a `transition` node (`SPEC.md:238`); an addendum is not a transition
  and must not create one.
- **Note-level ACLs / permissions, per-note visibility.**
- **Real-time notification/subscription.**
- **A `notes` read verb** (§4): the projection already exists.
- **Note-level edit history / versioning** — INV-4 makes notes immutable, so there is no
  history to version.
- **Claim-gating** (§6 INV-6) and **status/priority effects** (INV-7) are non-goals by
  construction, not oversights.

## 9. Acceptance criteria

Written as observable DoF clauses — each names a real entrypoint and an outcome a verifier
can drive without reading implementation internals. Per `AGENTS.md` §7, the proof that the
_mount_ exists must be a wire-level test against the **real built `dist/index.js`**, because
an in-process assertion resolves to source and skips the mount — the exact defect class
`src/stats-surface.wire.spec.ts:8-21` was written to catch.

- **AC-1 (append works, on every mount).** `append-note` with a live `uid`, `by`, and
  non-blank `text` exits `0` with `{ok:true, data:{uid:<same uid>, noteUid:<new uid>}}`.
  Proven through the built bin as a child process (CLI), and the same descriptor is present
  in MCP `tools/list` — never an in-process call only.
- **AC-2 (identity invariance — the load-bearing one).** After AC-1: `data.uid` is
  byte-identical to the input `uid`; `get` on that uid still resolves (no `conflict`); no
  `SUPERSEDES` edge was created; and the item's `has_status`/`has_kind`/`has_priority`
  edges are unchanged.
- **AC-3 (read back).** `get --input '{"uid":…,"fields":["notes"]}'` includes the new note
  carrying `author == by`, the exact `text`, and an `at` timestamp.
- **AC-4 (survives a body-edit supersede).** Append a note, then `update` the `body` to mint
  a successor; `get <successor> fields:["notes"]` still returns the note, and the
  `has_note` edge now originates at the successor. (Today this behaviour is real but
  unasserted — this clause makes it observable.)
- **AC-5 (invariance under others' state).** Append succeeds on an item claimed by a
  different `by` (INV-6); status, priority, kind, and assignee are unchanged afterwards
  (INV-7); and a note does **not** require or consume a claim.
- **AC-6 (liveness guard).** `append-note` on a superseded uid returns `conflict` naming the
  successor, and on a deleted uid returns `item_not_found`; in neither case is a `has_note`
  edge written (INV-3). Assert the negative by reading the note count back.
- **AC-7 (validation).** Missing/blank `by` and missing/blank `text` each return
  `invalid_argument` (exit 2) **before** any write — assert no node was created.
- **AC-8 (order).** Two appends then a read return both notes in `at` order, with ties
  broken deterministically (§10 Q1 — this clause cannot be written until that is decided).
- **AC-9 (search reachability — the clause that makes it worth having).** A keyword query
  containing a token that occurs **only** in a note returns the **owning issue** in
  `data.items` (§10 Q1 decides the exact shape). This AC is _conditional on_ the Q1 decision
  and must not ship as "note text is searchable" in docs until it passes at the wire.
- **AC-10 (audit consistency).** The append emits exactly one audit row for the write, with
  a named action (consistent with `SPEC.md`'s one-audit-node-per-state-change contract and
  `DATA_MODEL.md:188-195`). **Observation to settle first:** the existing note-write path
  does not appear to call `writeAudit` at all — the `writeAudit` call in
  `src/write/create-issue.ts` is at `:968` (the main create path), while the
  `duplicateAction:'comment'` branch returns at `:779-783` without one. If that is right,
  the existing path already violates the contract and the fix belongs with this work.
  (§10 Q9.)
- **AC-11 (teeth / negative control).** Removing the `export` on the new verb from
  `src/api.ts` turns AC-1 red on the wire test. _(This is not hypothetical: during this
  scoping pass an un-reverted negative control on `priorityMatrix` in `src/api.ts` left the
  verb unmounted and the suite red — see the session disclosure. A surface AC without a
  demonstrated red state proves nothing.)_
- **AC-12 (`batch` composition).** `batch action` with `operation:"backlog/append-note"`
  over two uids attaches a note to each and returns two `fulfilled` arms. (Expected free
  from the mount; assert it rather than assuming it.)
- **AC-13 (no churn under repeat).** Appending twice — and a retried call with the same
  `clientRequestId` if Q4 adopts one — never mints a new issue uid, and every note remains
  individually addressable by its own `noteUid`.

## 10. Ranked design questions to settle before a spec

Ordered by how much the answer changes the spec. Q1–Q5 are blocking.

1. **Search reachability of note text (BLOCKING — the make-or-break).** Do `filter.grep`
   (and later `semantic`) see note text, and in what shape? Options: unify to an
   issue-returning union (a note hit maps to its owning issue); a separate note-view; or
   concede and document the limitation. **A note no search can find is worse than no note**
   (§6.2). Decides AC-9 and essentially the feature's value proposition. _Product call, with
   an architecture read on the query-layer cost._
2. **Ordering and bounds (BLOCKING).** `resolveNotes` currently does not sort
   (`src/query/card.ts:133-149`) while `resolveAuditTrail` does (`:173`). Define: ordering
   key and tie-break; and whether a note list is bounded/paginated (an item with hundreds of
   notes must not silently blow up every `get`). Decides AC-8.
3. **Claim interaction (BLOCKING).** Confirm INV-6: append bypasses the working lease.
   Recommended yes — evidence is additive, and a claim-gated append reproduces the PKG-11
   blockage. This is a policy decision with a multi-agent safety dimension; if anyone argues
   for gating, it is an ADR item, not a product call.
4. **Retry / duplicate semantics (BLOCKING).** Document that append is at-least-once
   (ADR-0012 re-runs a failed transaction) and a retried append may duplicate; adopt
   `clientRequestId` idempotency or explicitly accept duplicates. Decides AC-13.
5. **`updatedAt` semantics (BLOCKING).** Does an append touch the issue's `t_valid`?
   Recommended: **yes**, and settle it deliberately — otherwise newly-evidenced items are
   invisible to `sort:'updated'` sweeps, which is how triage evidence gets lost in practice.
   But it is a write to the issue row, so it must be a stated choice (architect C1 says
   "no issue-row touch"; if `updatedAt` is touched, that condition needs an explicit,
   recorded exception rather than a silent drift).
6. **Note classifier (`kind?`) vocabulary.** A `noteKind` discriminator
   (`evidence`/`correction`/`triage`/`commentary`) is what lets a consumer tell "this
   corrects the body" from "this adds evidence" — without it, addendums cannot be consumed
   programmatically. **It must be a CLOSED vocabulary with unknown values rejected**, _not_
   an auto-minting open catalog: the tracker already has an open-status pitfall where an
   unresolved NAME silently mints a new status and a typo becomes a real one
   (`SKILL.md:309-322`). A note-kind typo minting a kind would be the same defect.
7. **Claim-level supersession (v1 vs v2).** Ship additive-only (INV-10, §6.1(a)), or scope
   addressable body claims so a note can supersede a specific claim (§6.1(b))? **The v2 path
   is an ADR, not a product call** — it changes the item's data model.
8. **Citations on notes.** Reuse `has_citation` from the issue, or register a new
   `note → citation` edge with correct attribution (§7)? Small; do not block v1 on it, but
   decide before the spec hardens the note read shape.
9. **Audit row.** Confirm whether the existing note path emits an audit row (it appears not
   to, §AC-10) and, if not, whether this feature fixes it or files it. Decides AC-10 and
   whether an existing defect is riding along.
10. **Note text shape / size.** The one existing note path stores
    `` `${title}\n\n${body}` `` (`src/write/create-issue.ts:759`) — i.e. existing notes in the
    store are title+body blobs, while `IIssueNote` has only a `text` field. Decide whether
    `append-note` accepts a title, and set a max length (an unbounded note is a small DoS on
    every future `get`).
11. **Verb name — `append-note` vs `note`.** Recommended `append-note` (§4), matching
    ADR-0011. If someone prefers `note`, ADR-0011's assumption must be corrected in the same
    change (architect condition C5).
12. **`supersedesNoteUid` on v1?** Cheap (note→note, churns nothing) but adds a field and a
    referential check. Nice-to-have; can wait.

## 11. What needs an ADR or an architecture decision, not a product call

1. **The missing identity-stability ADR (REQUIRED — blocks the spec).** The repo has **no
   in-repo ADR catalog at all** (`entrypoint/backlog/docs/decisions/` does not exist), and
   none of the sox-ecosystem ADRs (0009/0011/0012/0015) defines issue-uid stability. Item
   `0f1f4a9c` records the resulting contradiction as _"documented but not decided"_, and the
   triage item `bf97b4ed` (finding A4) states the ADR is absent. **This feature's entire
   rationale is "append so you don't churn the uid" — which presupposes a decision that uid
   stability is a property worth protecting.** That decision does not exist yet. Writing it
   is architect-verdict condition C6. Scope-wise: the note feature may be _specified_ before
   that ADR lands, but it should not _ship_ before it, because it would otherwise be
   optimizing against an unrecorded contract.
2. **Vector/embedding coverage policy for non-issue nodes.** Deciding whether a `note`
   participates in the vector space — and if so, whether the embedded unit is the note, the
   owning issue (re-embed), or a sidecar — is a schema + embedding-funnel decision
   (`src/write/embedding-observer.ts:86`, the issue-keyed funnel), not a product call. §6.2.
   Also decides whether ADR-0010-style vocabulary governance applies to a note's vector
   identity.
3. **Query-layer semantics if grep/search is widened to note text.** Whether `filter.grep`
   unioning note hits changes the meaning of the `grep` filter, the `total`/pagination
   contract, and the ranked-search primitives (`src/query/query.ts:468-565`) needs an
   architecture read before a spec commits to AC-9's shape.
4. **Claim-vs-evidence policy (only if gating is proposed).** If anyone argues append should
   respect the lease, that is a multi-agent concurrency policy decision (ADR-0012 territory),
   not a product preference.

Non-ADR product calls (mine to make, listed so the split is explicit): the verb name (§4),
the note-kind vocabulary and its closed-ness (§10 Q6), non-goals (§8), the note text shape
and size (§10 Q10), ordering key (§10 Q2), whether `updatedAt` is touched (§10 Q5), and
whether `supersedesNoteUid` lands in v1 (§10 Q12).

## 12. Minimum surface — "usable" vs "worth having"

**Minimum that is _usable_:** one mounted write verb (`append-note`). The read path already
works (`SKILL.md:250`), the node/edge vocabulary already exists, and the carry-forward across
supersede already works.

**Minimum that is _worth having_ — the four clauses without which this is a toy:**

1. **Append does not churn the uid** (INV-1, AC-2). Without it, the verb is a body edit with
   a nicer name.
2. **Notes survive a later body-edit supersede** (AC-4). Without it, the first body edit
   orphans the evidence trail — the exact failure the transfer mechanism already prevents but
   nothing asserts.
3. **Append is not blocked by a foreign claim** (INV-6, AC-5). Without it, the PKG-11
   blockage recurs whenever another agent holds the lease.
4. **Note text is findable by search** (AC-9). Without it, evidence is written into a grave
   (§6.2).

Clauses 1–3 are cheap and already nearly true. Clause 4 is the one with real cost and the
one that decides whether this feature changes behaviour or just adds a verb.

**Surface cost, stated honestly:** this takes the mounted surface from **17 → 18 verbs**
(`src/server.ts:189-207`), against a package whose recent direction has been consolidation.
`src/api.ts:1-13` explicitly warns that every export here is a cost an agent pays in
attention. The justification is that it _removes_ a much larger cost: the alternative to a
note verb is a body-edit supersede, which breaks every persisted reference and is already
the subject of an open identity defect.

## 13. Evidence index

Read directly during this pass (all paths relative to `entrypoint/backlog/`):

- `skill/SKILL.md:14-20` (uid identity claim), `:29-53` (the 17-verb surface), `:194-197`
  (`by` required), `:250` (field vocabulary incl. `notes`), `:270-292` (body supersede +
  conflict), `:309-322` (the open-`toStatus` mint pitfall), `:539-560` (citations + `sha`).
- `README.md:110-115` (concurrency), `:178-188` (§7 supersede-safe history),
  `:190-223` (command surface), `:345-355` (embedding optional / `rag_not_configured`).
- `src/api.ts:1-13` (the mounted-surface rule), `:478-490` (`priorityMatrix`, and the
  negative-control comment that was live during this pass), `:562-568` (`update`).
- `src/server.ts:189-207` (`BACKLOG_VERBS`), `:855-885` (BUG-BACKLOG-003, the _properly_
  handled negative-control residue).
- `src/query/types.ts:51-59`, `:63-97` (field vocabulary), `:127-132` (`IIssueNote`),
  `:184` (`notes` on the card), `:217` (`grep` = title+body), `:302-303` (`stale` keyed on
  `claimedAt`).
- `src/query/card.ts:133-149` (`resolveNotes`, unsorted), `:152-174` (`resolveAuditTrail`,
  sorted), `:282`/`:338-339` (projection wiring).
- `src/query/query.ts:443-451` (base filter `kind:'issue'`), `:468-513` (grep/semantic route
  and the ranked primitives).
- `src/write/create-issue.ts:731-739` (no embed on the comment path), `:752-784` (the only
  note-write path; `:759` text shape; no `writeAudit`), `:968` (`writeAudit`, main path).
- `src/write/update.ts:549-583` (`carryForwardResidualEdgesTx` — notes survive supersede).
- `src/write/catalog.ts:347-354` (`has_note` registration).
- `src/write/embedding-observer.ts:86` (embedded unit = `${title}\n${body}`).
- `src/store/vocabulary-guard.ts:63-77` (`'note'` is a recognized node kind).
- `DATA_MODEL.md:151-152` (issue body), `:162-178` (§4 note node),
  `:188-195` (audit node contract), `:198-219` (§5 `has_note`).
- `SPEC.md:233-239` (event/evidence nodes), `:254` (`has_note`), `:2898` (AC-19 —
  `duplicateAction:'comment'` attaches a note).
- `src/stats-surface.wire.spec.ts:8-21` (why a mount defect needs a wire-level test).
- ADR catalog (`~/dev/ai/sox-ecosystem/docs/decisions/`): **0010** (open `kind`/`rel` typing
  — permissive), **0011** (ACCEPTED; §"What changes" item 2 names `backlog_append_note`),
  **0012** (multiprocess write invariant; §1 no cross-process FIFO), **0015** (PROPOSED,
  never accepted). In-repo `docs/decisions/` **does not exist**.

Graph/dossier evidence (read via the `adhd-backlog` CLI, read-only unless noted):

- `bf97b4ed-b0ae-4f2e-9704-190d0f22db6a` — OPEN, `in_progress` — the uid-churn triage item
  (A1–A4; A4 = no identity ADR).
- `0f1f4a9c-1395-472f-8fe4-db85ee89e3c3` — OPEN — the identity-docs contradiction.
- `fce03d93-4163-4b4b-b817-9e8ded40dad3` — OPEN — the already-filed "no note-append path" gap
  this feature closes.
- `caeaeca2-d1b2-4e33-b71c-67f80a6e9caf` — the FEAT item for this scope (created during this
  pass; `relates_to` `fce03d93`).
- Memory episodes `01M1MG8TQESKGZH07HQNSAHP2Y`, `01M1MG5A595MCG3DED9X640PEH` (PKG-11
  dispatches blocked from appending notes).
