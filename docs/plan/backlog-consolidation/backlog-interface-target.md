# Target @adhd/backlog public interface (end-state; not shipped)

**Status:** PROPOSED (2026-10-04). **NOT ACCEPTED.** This is a *target/end-state* interface drafted from the design corpus; it records the surface the corpus intends, not the surface that ships today. Every breaking delta below is marked `OWNER SIGN-OFF REQUIRED` and is inert until the owner approves it and a superseding ADR of `adhd ADR-0006` is authored at ship time.
**Owner:** pseudosky.
**Supersedes:** nothing. This ADR does **not** supersede `adhd ADR-0006`; adhd ADR-0006 remains the current-state record and is left unedited. This is its companion *target* record.
**Drives:** reconciliation item T1 (`tmp/backlog-consolidation/reconciliation-plan.md` §5, Bucket E); the three structural blockers B1 `34b69c69`, B2 (no item), B3 (no item); the design corpus C1 `73d0b9c6`, C2 `ac911229`, C3 `38631ad4`, C4 `1c53784d`, C5 `b076742d`, C6 `291263ea`, C7 `395cfcad`, C8 `4a12472e`, C9 `cf97c613`, C10 `b009396b`, FOUNDATION `69632883`; adoption `e54bd58b`.
**Grounding:** `adhd ADR-0006` (current-state freeze, Status PROPOSED — the baseline every delta is measured against); `tmp/backlog-consolidation/reconciliation-plan.md` §5 (end-state interface plan), §8.1 (design/adoption remodelers), §8.4 (blocker remodel verdicts), §9.3 (corpus→problem map); the six C-item bodies read live via `adhd-backlog get` (their literal verb/field/enum/edge names are quoted in the mapping table). Where this ADR and a shipped `--help` schema disagree, the shipped surface wins and this document is the stale artifact to correct (`adhd ADR-0002`).

## TL;DR for the next agent

`adhd ADR-0006` freezes **what ships today** (29 verbs, ten error codes, a closed six-member `rel` union). This ADR states the **target end-state** the design corpus intends — the surface to build toward, not the surface to assume is live. Nothing here is implemented: every delta is a *specification target*, and the ADR is **PROPOSED, not ACCEPTED**. The default regime is **additive-first** (`adhd ADR-0006` D6): new verbs, optional inputs, response fields, typed error codes, and *internal* node/edge kinds are permitted; a **breaking** change — a new member in the closed public `rel` union, a widened existing response field, a closed kind catalog, or a new precondition on an existing verb — is an owner decision gated behind `OWNER SIGN-OFF REQUIRED` and a superseding ADR of 0006. The one trap: do **not** implement any `REMODELED-BY` cluster or blocker verb (`reconciliation-plan.md` §8) until this target is approved — the plan defers that work precisely so it is not discarded.

## Status

PROPOSED (2026-10-04). **Not accepted, not authoritative, not shipped.** This file is a draft produced by Bucket E of the reconciliation plan (`tmp/backlog-consolidation/reconciliation-plan.md` §5). Per the ADR catalog rule (`docs/decisions/README.md` "Propose before write"), it may not become ACCEPTED without the owner's explicit approval, and it must not be edited into an ACCEPTED record autonomously. The owner sign-off it requires is **two-part**: (1) approval of the target surface as a whole, and (2) for each row flagged `OWNER SIGN-OFF REQUIRED`, explicit authorization of that specific break — because the whole point of the reconciliation is to avoid shipping a remodel that a later design item discards.

## Current vs target

`adhd ADR-0006` is a **descriptive freeze of the current shipped surface**: 29 verbs plus the `batch action` mount, a two-arm outcome envelope, ten documented error codes, `"${agentName}:${instanceId}"` as the mandatory `by` identity, and a **CLOSED** six-member `rel` union `{relates_to, supersedes, blocks, duplicate_of, part_of, similar_to}` — with three recorded *absences* (no spec-fragment reader, no citation-by-path enumeration, no issue-level absorb/merge and no `consolidated_into` pointer). This ADR is the **target surface**: the interface the design corpus (C1–C10 + FOUNDATION, plus the `e54bd58b` adoption layer) intends to reach. They diverge in four places: (a) the target **adds capabilities** the current freeze records as absent (the B1/B2/B3 reader/merge paths, new verbs such as `link-duplicate`, a readable `kind` registry); (b) the target **widens existing response shapes** (an exhaustive `related`, completeness/`score_kind` meta, derived `Verdict`/`Condition` types); (c) the target **amends the vocabulary** (node kinds `attestation`/`obligation`/`SPEC`, internal edges `attests`/`has_obligation`/`satisfies`, a validating `kind` catalog); and (d) it considers — and, on the plan's recommendation, mostly **declines** — touching the closed `rel` union. Where the target would *break* a frozen element rather than extend it, this ADR does not assert the break: it flags it `OWNER SIGN-OFF REQUIRED` and names the superseding-ADR path. adhd ADR-0006 stays the current-state record; this ADR never edits it.

## Context

The reconciliation plan (`reconciliation-plan.md` §5, §7) established that the design corpus is the **target intent** but no durable artifact records it: adhd ADR-0006 is current-state-only and explicitly changes no behavior. Bucket D's blocker verdicts and Bucket E's target authoring exist to close that gap. The plan's remodel map (§8.1) shows each C-item is a **remodeler**: C1 owns identity/merge, C2 owns the relation projection and order, C3 owns evidence anchoring, C4 owns the obligation core, C5 the closure gate, C6 the derived verdict, C7 honest envelopes, C8 the closed/readable primitives, C9 cross-project dedupe, C10 work-product citizenship, and FOUNDATION the node/edge vocabulary C3/C4/C5 are written against. §8.5 orders the gates: **FOUNDATION `69632883` → Bucket E (this ADR) → C1/C8/C9/C3/C10/C2**. What is **not** established: none of these deltas is implemented; the C-item bodies were authored before portions shipped (e.g. `attest`, `recheck`, `obligate`, `unobligate`, `merge-project`, `rm-project`, `lookup` are *already* in adhd ADR-0006's 29), so several "new verb" statements in the corpus are really *shape* additions to verbs that already exist — the mapping table below states which is which. The graph is the source of truth; this file is a projection.

## Decision — target deltas per axis

Measured against `adhd ADR-0006`. `additive` = permitted under adhd ADR-0006 D6 with no owner sign-off; `breaking` = requires explicit owner sign-off **and** a superseding ADR of 0006 at ship time.

### D1 — Verb surface

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D1 verb surface | 29 verbs + `batch action`; `attest`, `recheck`, `obligate`, `unobligate`, `merge-project`, `rm-project`, `lookup` **already shipped** | add `link-duplicate` (net-new); give the shipped `attest`/`obligate` their first-class `anchor`/predicate inputs; add the B1/B2/B3 reader+merge paths (below) | C9; C3; C4; B1/B2/B3 | additive |
| D1b registry / views | `get` returns items; `report` exists | `get {registry:"kind"}` (or a `kind` view) returning every catalog term; `report` gains grouped rollup; `part-of-rollup {count_only:true}` + cursor mode | C8; C7 | additive |
| D1c work-product verbs | none | no new verb: `SPEC` items are read through `get`/`query` like any item, plus `revision` + anchor digest | C10 | additive |

### D2 — Envelope + error codes

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D2 envelope | two arms (`ok:true|false`); unwrapped `invalid_argument` on stderr | add derived read types `Verdict {actionable, evaluated_at, revision, conditions[]}` and `Condition {type, status, severity, code, message?, subject?}`; every view carries completeness meta `total`/`returned`/`limit`/`offset?`/`truncated?`/`has_more`; derived scores carry `score_kind` (`rrf|bm25|cosine|rank`); closure refusal carries typed `{code, required_kind}` | C6; C7; C5 | additive (existing arms and fields preserved) |
| D2b error codes | ten documented codes, each with a fixed exit code | the ten remain; **new typed error arms** are documented extensions (C3/C4/C5/FOUNDATION `write/errors.ts`), and C1 rebases `AmbiguousReferenceError`; `ambiguous_reference` is already one of the ten | C1; C5; FOUNDATION | additive |

### D3 — Identity lifecycle, joined entities, cross-project dedupe

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D3a identity/merge | uid-prefix resolution exists (`ambiguous_reference` on ambiguity); **no issue-level canonical/merge/retire**; project-level `merge-project`/`rm-project` exist | one canonical node per real thing; ambiguous prefix **returns the candidate set**; a merge writes a **one-hop `Redirect` row** and **soft-retires** the duplicate (no hard delete); resolution follows the `SUPERSEDES` chain (`logical id = chain head`) | C1; B3 | **breaking** — changes resolution behavior across every uid-taking verb; `OWNER SIGN-OFF REQUIRED` |
| D3b joined entities | issues are the write target; projects/components/locations are separate catalogs | issues are the **root record**; projects, components and citations are **joined entities**; 1:1 container correction | adoption `e54bd58b` | additive (model clarification; no verb removed) |
| D3c cross-project dedupe | dedupe is project-scoped only; `duplicate_of` is n:1 | dedupe scope mode `same-project` (default) \| `multi-project` \| `store-wide`; candidate duplicate **clusters** read view (provenance per candidate); `link-duplicate {sourceUid, targetUid, by, reason}`; `duplicates` pseudo-field; filter dimension `duplicateOf`/`hasDuplicates`; **never auto-links** | C9 | additive (default unchanged) |
| D3d work-product identity | specs/plans/reports are prose, not items | `SPEC` items are store citizens, `part_of` a work item; exports anchored `{locator, digest}` (sha256); `get`/`query` return the item(s) + `revision` + anchor digest; check states `verified | drifted | gone`; the file is an export, never the source | C10 | additive |

### D4 — Naming + rel union

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D4a naming | kebab CLI, snake_case MCP, scoped `@adhd/backlog` | unchanged; new verbs follow the same three schemes | C8 | additive |
| D4b public `rel` union | CLOSED `{relates_to, supersedes, blocks, duplicate_of, part_of, similar_to}`; `part_of` single-valued (n:1), `supersedes`/`duplicate_of` n:1, rest n:m | **reuse `duplicate_of`** as the consolidated-into pointer (recommended); adding a new public member `consolidated_into` would **open the closed union** | B3; C9 | adding `consolidated_into` is **breaking**; `OWNER SIGN-OFF REQUIRED`. Recommended resolution: do **not** add it |
| D4c internal edge kinds | none | add **internal** edge kinds `attests`, `has_obligation`, `satisfies` — **NOT** mounted on the public `relate` enum | FOUNDATION | additive (does not touch the closed public union) |
| D4d `part_of` | single-valued; second parent behavior unspecified | second `part_of` returns a **typed error naming the existing parent** | C2 | additive (new typed error) |
| D4e `related` content | partial — **excludes** `supersedes`/`duplicate_of`; `auditTrail` is the only full read path | resolve the C1-contradiction: either **widen `related` to every live relation type** (C2-amendment) or **declare the enumerated three authoritative** and delete the stale comment | C2; contradiction #1 (C2 items 6fb30481 vs 77310a60) | widening an existing response field is **behavior-visible** → `OWNER SIGN-OFF REQUIRED` on the wide variant |

### D5 — Node-kind / edge-kind vocabulary

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D5a node kinds | 13 node kinds; **unknown kind mints** (per cluster 11) | add `attestation`, `obligation` (13 → 15), and `SPEC` (→ 16), admitted through C8's promotion gate | FOUNDATION; C10 | additive |
| D5b catalogs | kind/priority mint silently; catalog not machine-readable | **generated, readable `kind` catalog** (identity, type, scope, lifecycle, replacement pointer); five-part promotion gate; governed extension namespace; **machine-readable verb surface** ("no advertised verb is absent") | C8 | **closing the kind catalog** (mint → reject) is **breaking**; `OWNER SIGN-OFF REQUIRED` on the close |
| D5c vocabulary cleanup | `kind:EPIC` live; `bug`/`BUG` split; `undefined`/`MEDIUM` present | retire `kind:EPIC` (with a migration note); reconcile `kind:"bug"`/`"BUG"`; remove `undefined`/`MEDIUM` | C8 | **breaking data/vocabulary migration**; `OWNER SIGN-OFF REQUIRED` |

### D6 — Read surface (C2/C7/C9/C10 reads)

| axis | current (adhd ADR-0006) | target | source | additive / breaking |
|---|---|---|---|---|
| D6a structural legibility | `order` view scoped to `kind:'issue'`; no outbound `blocks`/dependent count; plan children not listable | `view:"order"` scopes to every member kind the filter selects; outbound `blocks` + a dependent count in the projection vocabulary; plan children listable; cycle returns `{ok:false, cycle:[…]}` | C2 | additive |
| D6b honest envelopes | no completeness/truncation distinction | every view returns a completeness flag consistent with existing `meta` keys (`total`/`returned`/`limit`/`truncated`/`has_more`); `part-of-rollup {count_only:true}` returns counts without inlining uids | C7 | additive |
| D6c evidence reads | `add-citation`/`remove-citation`; per-issue citation field | `attest {subject:{id,revision}, claim:{kind,body}, anchor:{locator,digest}, by}`; anchor grammar `path:line | URL+digest | query+hash | registry-ref`; states `unverified|verified|stale|unknown` (`refuted` deliberately excluded); `existsAtHead(path)`/`changedSinceFiling(path)`; `citationAllowedExternalRoots` gains the skill install root | C3 | additive |
| D6d obligation reads | none | `obligate {uid, applies_to:{from?,to}, requirement, on_fail:block|warn, override?:{actors}, by}`; predicate core `evidence{kind,min?}`, `blockers_terminal()`, `relation{type,direction}`, `all_of`, `any_of`, `not`; an item with no obligation is unaffected | C4 | additive |
| D6e closure gate | terminal transitions have no obligation gate | terminal transition evaluates obligations; refusal is typed with `code` + `required_kind`; a commit ref alone does **not** satisfy `published-artifact` | C5 | **behavior-visible** — changes `transition`/terminal success semantics; `OWNER SIGN-OFF REQUIRED` |
| D6f derived verdict | `claim` has no blocker precondition | `claim` evaluates the verdict and **fails loudly on a `block`-severity condition** (force-claim records the blocker); reason core `BlockedBy`, `MissingObligation`, `EvidenceUnverified`, `EvidenceStale`, `ClaimStale`, `ReferenceUnresolved`, `Unknown`; verdict is derived on read, never stored | C6 | **behavior-visible** — adds a `claim` precondition; `OWNER SIGN-OFF REQUIRED` |

## Design-corpus mapping (C1–C10 + FOUNDATION)

Every design item mapped to the target-interface delta it implies. "Already shipped" marks a verb the corpus calls "new" that is in adhd ADR-0006's frozen 29 — for those, the target delta is the *shape*, not the verb.

| item | target interface delta it implies | additive / breaking |
|---|---|---|
| C1 `73d0b9c6` | canonical-node resolution: unique uid prefix across all uid verbs, ambiguous → candidate set; one-hop `Redirect`; soft-retire; `SUPERSEDES` chain head = logical id; `merge-project`/`rm-project` already shipped | breaking (resolution behavior) |
| C2 `ac911229` | exhaustive `related` projection (**resolves contradiction #1 (C2 items 6fb30481 vs 77310a60)**); `view:"order"` kind-scoped; outbound `blocks` + dependent count; typed error naming the existing parent on a second `part_of` | additive; `related` widening sign-off |
| C3 `38631ad4` | `attest` already shipped → target adds the `{subject,claim,anchor}` shape + anchor grammar; `recheck` already shipped; states `unverified|verified|stale|unknown`; `existsAtHead`/`changedSinceFiling`; external-root allowlist | additive |
| C4 `1c53784d` | `obligate`/`unobligate` already shipped → target adds `applies_to`/`requirement`/`on_fail:block|warn`/`override` and the closed predicate core | additive |
| C5 `b076742d` | terminal-transition closure gate; typed refusal `{code, required_kind}`; `published-artifact` / live-system proof | behavior-visible; sign-off |
| C6 `291263ea` | `Verdict`/`Condition` derived read types; reason core enum; `claim` blocker precondition + `ClaimStale` | behavior-visible; sign-off |
| C7 `395cfcad` | completeness meta on every view; `score_kind` (`rrf|bm25|cosine|rank`); `part-of-rollup {count_only}`; `get {lastN}` auditTrail bound; `report` grouped rollup | additive |
| C8 `4a12472e` | `get {registry:"kind"}` readable/generated catalog; promotion gate; extension namespace; machine-readable verb surface; retire `EPIC`; reconcile `bug`/`BUG`; remove `undefined`/`MEDIUM` | additive (registry) / breaking (close + vocab cleanup) |
| C9 `cf97c613` | dedupe scope modes; candidate-cluster read view; `link-duplicate`; `duplicates` field; `duplicateOf`/`hasDuplicates` filter; `duplicate_of` n:1; issue-level canonical/redirect (generalizes C1) | additive |
| C10 `b009396b` | `SPEC` node kind; spec `part_of` work item; anchored `{locator,digest}` export; read `verified|drifted|gone`; file is export never source | additive |
| FOUNDATION `69632883` | node kinds `attestation`+`obligation` (13→15); internal edges `attests`/`has_obligation`/`satisfies`; typed error arms in `write/errors.ts`; files `store/vocabulary-guard.ts`, `write/tx.ts`, `write/catalog.ts`, `write/errors.ts` | additive (internal vocabulary) |
| adoption `e54bd58b` | issues are the root record; projects/components/citations are joined entities; 1:1 container correction | additive (model clarification) |

## Classification — additive-first vs breaking

**Additive (permitted under adhd ADR-0006 D6; no sign-off):** new verb `link-duplicate`; the B1 `get` optional field and B2 `query` projection (see blockers); the optional issue-level `merge` verb *addition*; new **optional** inputs on existing verbs; new response fields (`Verdict`, `Condition`, completeness meta, `score_kind`, `required_kind`); new typed error codes as documented extensions; new **internal** node/edge kinds (`attestation`, `obligation`, `SPEC`, `attests`, `has_obligation`, `satisfies`); `kind` registry reads; the joined-entity model clarification.

**Breaking — `OWNER SIGN-OFF REQUIRED` for each, each naming the superseding-ADR rule:**

1. **New public `rel` member `consolidated_into`** (D4b) — opens the CLOSED union. *Recommended: do not add; reuse `duplicate_of`.* Sign-off only if the owner rejects the reuse.
2. **Widening `related` to every live relation** (D4e/D6a) — behavior-visible response-shape change resolving contradiction #1 (C2 items 6fb30481 vs 77310a60). Sign-off on the wide variant; the narrow variant (enumerated three authoritative + delete stale comment) needs no sign-off.
3. **Closing the `kind` catalog** (D5b) — unknown kinds currently mint; a validating registry rejects them. Sign-off on the close.
4. **Vocabulary migration** (D5c) — retire `kind:EPIC`, reconcile `bug`/`BUG`, remove `undefined`/`MEDIUM`. Sign-off.
5. **`claim` block-severity precondition** (D6f) — changes an existing verb's success semantics. Sign-off.
6. **Terminal-transition closure gate** (D6e) — changes `transition`/terminal success semantics. Sign-off.
7. **Canonical identity resolution** (D3a) — changes uid-prefix/merge behavior across every uid-taking verb. Sign-off.

**Superseding-ADR rule (applies to every item above):** per `adhd ADR-0006` D6 and `docs/decisions/README.md` "Editing an existing ADR", a decision-changing update to the frozen current surface is a **new** ADR that `Supersedes: adhd ADR-0006`, proposed together with adhd ADR-0006's updated Status line and written only after owner approval. This ADR does **not** itself supersede 0006; it is the target record. When any breaking target item is actually implemented, that ship is what triggers the superseding ADR. `adhd ADR-0002` governs throughout: correct the source, never work around.

## What does NOT change

- **This ADR changes no behavior and no code.** It is a target specification; every delta is inert until approved and implemented. Bucket E is a *decision*, not an execution (`reconciliation-plan.md` §2 Bucket E, §8.2).
- **`adhd ADR-0006` is not edited and not superseded by this file.** adhd ADR-0006 stays the current-state record. Its filed defect `73d3b97d` (D5 invents an `update` status; "nine" codes vs the ten with `ambiguous_reference`) is repaired in Bucket C by a non-decision correction or a superseding ADR — **not here**.
- **The current 29-verb surface, the ten error codes, the one-`--input` calling convention, the `by` identity rule, and the three naming schemes** are untouched by the target except as explicitly listed above.
- **The store substrate and concurrency contract** (`adhd ADR-0001`, `sox ADR-0012`) — out of scope; this ADR is transport-facing interface only.
- **`SPEC.md` and `SKILL.md`** — cited, not rewritten; where more specific they remain authoritative detail.
- **No implementation is authorized by this ADR.** The `REMODELED-BY` clusters (8/9/28/40→C1; 11/20/35→C8; 13→C3; 17→C9) and the blocker verbs remain **deferred** per `reconciliation-plan.md` §8 until this target is approved.

## Structural blockers (B1–B3)

Each blocker gets a target resolution and its current status. All three are **unshipped**; all three are `REMODELED-BY` a C-item (plan §8.4) and must not be implemented before that gate lands.

| blocker | target resolution | current status | gate |
|---|---|---|---|
| **B1** — no spec-revision-fragment read path (`34b69c69`) | *Recommended:* an additive `get` optional input field returning the revision fragment (smallest surface); alternative: an additive `spec-get` verb. Both are permitted under adhd ADR-0006 D6; no owner sign-off required for the **addition**. | **unshipped.** Today `get fields:["spec"]` returns the pointer only; `spec-check` compares a token; `spec-append` writes. Related defect `983f5971` (spec-append CAS vs get/spec-check report different heads) is not fixed by the addition. | REMODELED-BY C10 `b009396b` (owns SPEC items + anchored exports) |
| **B2** — no citation-by-path enumeration (no dedicated item) | *Recommended:* an additive `query` filter/projection (e.g. `byCitationPath`) returning which items cite a path; alternative: an additive `citations` read verb. Additive; no sign-off. | **unshipped.** Today citations are reachable only per-issue (`citations` field on `get`) and mutated by `add-citation`/`remove-citation`; a "which issues cite this file?" read has no verb. Also enables the citation-presence/count filter the corpus wants. | REMODELED-BY C3 `38631ad4` (also C8) |
| **B3** — no issue-level absorb/merge verb and no `consolidated_into` pointer | *Recommended:* reuse `duplicate_of` (already frozen, n:1) as the consolidated-into pointer **now**; schedule an additive issue-level `merge`/`absorb` verb that preserves addressability (a redirect row, never a destructive body-merge). A **new public rel member `consolidated_into` is breaking** (closed union) → `OWNER SIGN-OFF REQUIRED`; recommendation: do not add it. | **unshipped.** Today project-level `merge-project` exists; issues have no absorb/merge and no pointer; Phase 3 used `duplicate_of` (4 live edges) as the only pointer. The verb *addition* is permitted; the destructive **semantics** require owner sign-off (cluster 9, addressability). | REMODELED-BY C1 `73d0b9c6` (also C9 `cf97c613`) |

## Consequences

- **The target surface has a durable home.** A reviewer can diff an intended surface change against this ADR the way a current change is diffed against adhd ADR-0006. Until this ADR is ACCEPTED, it binds nothing.
- **Additive-first is preserved as the default regime.** Only seven named items break the current surface; each carries `OWNER SIGN-OFF REQUIRED` and the superseding-ADR path, so no silent remodel can ship.
- **The gates stand.** `reconciliation-plan.md` §8.5 sequences FOUNDATION → this ADR → C1/C8/C9/C3/C10/C2; the `REMODELED-BY` clusters and B1–B3 stay deferred until their gate lands and this target is approved.
- **The three blocker resolutions are the smallest surfaces that close them.** Each is additive; none requires opening the closed `rel` union.
- **Obligation carried forward:** the `ambitious-artifact` boundary is explicit — this ADR specifies a target, not a schedule; implementation is a separate, gated program.

## Alternatives considered

- **Extend adhd ADR-0006 to cover the target as well (one ADR, current + target).** **REJECTED.** adhd ADR-0006 is a descriptive freeze of what ships; folding future intent into it would blur "recorded the surface" with "intend to build," and a target change to it would look like a correction of shipped fact. Two records — current (0006) and target (0007) — keep each falsifiable on its own terms.
- **Write the target as an ACCEPTED ADR in one pass.** **REJECTED.** The ADR catalog forbids autonomous ACCEPTED records; the plan (§5) requires a blind review and explicit owner approval, especially because seven deltas are breaking.
- **Add `consolidated_into` as a new closed-union rel member (the "obvious" fix for B3).** **REJECTED** by the plan's recommendation (§7): the union is frozen CLOSED, so adding a member is a contract change requiring owner sign-off; reusing the already-frozen `duplicate_of` n:1 closes the pointer gap with zero new surface.
- **Close the `kind` catalog as part of C8 without flagging the mint-behavior change.** **REJECTED.** Unknown kind currently *mints*; a validating registry *rejects* — a behavior-visible break that must be tagged `OWNER SIGN-OFF REQUIRED`, not slipped in as "readability."

## References

- `adhd ADR-0006` `docs/decisions/0006-backlog-public-interface-freeze.md` — the current-state baseline this ADR measures against; left unedited.
- `adhd ADR-0002` — correct the source, never work around.
- `adhd ADR-0004` — MCP tool output is the flat payload on `content`; the outcome envelope here is the tool's own return, not a wrapper.
- `tmp/backlog-consolidation/reconciliation-plan.md` §5 (end-state interface plan), §7 (blocker handling), §8.1 (remodelers), §8.4 (blocker verdicts), §8.5 (gate order), §9.3 (corpus→problem map).
- Design corpus: C1 `73d0b9c6`, C2 `ac911229`, C3 `38631ad4`, C4 `1c53784d`, C5 `b076742d`, C6 `291263ea`, C7 `395cfcad`, C8 `4a12472e`, C9 `cf97c613`, C10 `b009396b`, FOUNDATION `69632883`; adoption `e54bd58b`.
- Blockers: B1 `34b69c69`; B2 (no item); B3 (no item). Filed-not-scheduled defects referenced: defect `77310a60`, defect `73d3b97d`.
