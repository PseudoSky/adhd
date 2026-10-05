# ADR-0007 — The `@adhd/backlog` target public interface (single target-interface record)

**Status:** ACCEPTED (owner-approved 2026-10-05).
**Owner:** pseudosky.
**Supersedes:** adhd ADR-0006 — **in part**: the eight deltas on the breaking list below are approved as the target and ship under this ADR. adhd ADR-0006's frozen current-state surface otherwise stands, is otherwise unedited, and stays the record of what ships today.
**Drives:** reconciliation item T1 (`tmp/backlog-consolidation/reconciliation-plan.md` §5, Bucket E); structural blockers B1 `34b69c69`, B2 (no item), B3 (no item); design corpus C1 `73d0b9c6`, C2 `ac911229`, C3 `38631ad4`, C4 `1c53784d`, C5 `b076742d`, C6 `291263ea`, C7 `395cfcad`, C8 `4a12472e`, C9 `cf97c613`, C10 `b009396b`, FOUNDATION `69632883`; adoption `e54bd58b`; owner-mandated reads S11/S12.
**Grounding:** owner directive, verbatim: "All approved, please correct then begin." (2026-10-05) — approving (1) this record as the single target-interface record, (2) closing `73d3b97d`, (3) incorporating the 41 non-mandated proposed ACs, (4) resolving U2–U6 and AMB-1..5. Source draft: `docs/plan/backlog-consolidation/backlog-interface-target.md` (the approved target-interface record). `adhd ADR-0006` (current-state freeze, ACCEPTED 2026-10-05 — the baseline every delta is measured against); `tmp/backlog-consolidation/reconciliation-plan.md` §5 (end-state interface plan), §8.1 (design/adoption remodelers), §8.3 (cluster classification), §8.4 (blocker remodel verdicts), §9.3 (corpus→problem map). Where this record and a shipped `--help` schema disagree, the shipped surface wins and this document is the stale artifact to correct (`adhd ADR-0002`).

## TL;DR for the next agent

`adhd ADR-0006` records **what ships today** (29 verbs, ten error codes, a closed six-member `rel` union). **This ADR records the accepted target end-state** — the surface to build toward, not the surface that is live. Nothing here is implemented; the target is a specification, and implementation is a separate, gated program. The regime is **additive-first** (ADR-0006 D6): new verbs, optional inputs, response fields, typed error codes, and *internal* node/edge kinds are permitted with no further sign-off. The **eight breaking deltas** on the breaking list below are now **owner-approved as the target** and ship under this ADR; they are the only changes that touch ADR-0006's frozen surface, and ADR-0006 is **superseded in part** by them. The one trap: do **not** implement a `REMODELED-BY` cluster or a blocker verb ahead of its gate — `reconciliation-plan.md` §8.5 sequences FOUNDATION `69632883` → this record → C1/C8/C9/C3/C10/C2.

## Context

The reconciliation plan established that the design corpus is the **target intent** but no durable artifact recorded it: `adhd ADR-0006` is a descriptive freeze of the current shipped surface and explicitly changes no behavior. Bucket D's blocker verdicts and Bucket E's target authoring closed that gap; this ADR is the owner-accepted result. `adhd ADR-0006` describes a **current** surface of 29 verbs plus the `batch action` mount, a two-arm outcome envelope, ten documented error codes, `"${agentName}:${instanceId}"` as the mandatory `by` identity, and a **CLOSED** six-member `rel` union `{relates_to, supersedes, blocks, duplicate_of, part_of, similar_to}` — with three recorded *absences* (no spec-fragment reader, no citation-by-path enumeration, no issue-level absorb/merge and no `consolidated_into` pointer). This ADR records the **target surface** the design corpus intends, and which of its deltas are additive versus breaking.

What is **not** established: none of these deltas is implemented. Several corpus verbs are **already shipped** (e.g. `attest`, `recheck`, `obligate`, `unobligate`, `merge-project`, `rm-project`, `lookup` are in ADR-0006's 29), so several "new verb" statements are really *shape* additions to existing verbs — the verb surface table below states which is which. The graph is the source of truth; this file is a projection.

## Decision

Measured against `adhd ADR-0006`. **additive** = permitted under ADR-0006 D6 with no sign-off; **breaking** = a change to ADR-0006's frozen surface, owner-approved here as the target and shipping under this ADR.

### D1 — Verb surface

- Add `link-duplicate` (net-new); give the shipped `attest`/`obligate` their first-class `anchor`/predicate inputs; add the B1/B2/B3 reader+merge paths (D7). **additive.**
- `get {registry:"kind"}` (or a `kind` view) returns every catalog term; `report` gains a grouped rollup; `part-of-rollup {count_only:true}` plus cursor mode. **additive.**
- No work-product verb: `SPEC` items are read through `get`/`query` like any item, plus `revision` + anchor digest. **additive.**

### D2 — Envelope + error codes

- Add derived read types `Verdict {actionable, evaluated_at, revision, conditions[]}` and `Condition {type, status, severity, code, message?, subject?}`; every view carries completeness meta `total`/`returned`/`limit`/`offset?`/`truncated?`/`has_more`; derived scores carry `score_kind` (`rrf|bm25|cosine|rank`); closure refusal carries typed `{code, required_kind}`. Existing arms and fields are preserved. **additive.**
- The ten documented error codes remain, each with its fixed exit code. New typed error arms are documented extensions (`write/errors.ts`); C1 rebases `AmbiguousReferenceError`; `ambiguous_reference` is already one of the ten. **additive.**

### D3 — Identity lifecycle, joined entities, cross-project dedupe

- **One canonical node per real thing**; an ambiguous uid prefix **returns the candidate set**; a merge writes a **one-hop `Redirect` row** and **soft-retires** the duplicate (no hard delete); resolution follows the `SUPERSEDES` chain (`logical id = chain head`). **breaking** (changes resolution behavior across every uid-taking verb) — breaking list #7.
- Issues are the **root record**; projects, components and citations are **joined entities**; 1:1 container correction. **additive** (model clarification; no verb removed).
- Dedupe scope mode `same-project` (default) | `multi-project` | `store-wide`; candidate duplicate **clusters** read view (provenance per candidate); `link-duplicate {sourceUid, targetUid, by, reason}`; `duplicates` pseudo-field; filter dimension `duplicateOf`/`hasDuplicates`; **never auto-links**. **additive** (default unchanged).
- `SPEC` items are store citizens, `part_of` a work item; exports anchored `{locator, digest}` (sha256); `get`/`query` return the item(s) + `revision` + anchor digest; check states `verified | drifted | gone`; the file is an export, never the source. **additive.**

### D4 — Naming + rel union

- Naming is unchanged (kebab CLI, snake_case MCP, scoped `@adhd/backlog`); new verbs follow the same three schemes. **additive.**
- **Reuse `duplicate_of`** as the consolidated-into pointer (recommended and approved). Adding a new public member `consolidated_into` would **open the closed union**; it is **not** added. **breaking only if reversed** — breaking list #1.
- Add **internal** edge kinds `attests`, `has_obligation`, `satisfies` — **NOT** mounted on the public `relate` enum. **additive** (does not touch the closed public union).
- A second `part_of` returns a **typed error naming the existing parent**. **additive** (new typed error).
- Resolve the C1 contradiction: either **widen `related` to every live relation** (C2-amendment) or **declare the enumerated three authoritative** and delete the stale comment. Widening an existing response field is behavior-visible — breaking list #2.

### D5 — Node-kind / edge-kind vocabulary

- Add node kinds `attestation`, `obligation` (13 → 15), and `SPEC` (→ 16), admitted through C8's promotion gate. **additive.**
- A **generated, readable `kind` catalog** (identity, type, scope, lifecycle, replacement pointer); five-part promotion gate; governed extension namespace; **machine-readable verb surface**. **closing** the kind catalog (mint → reject) is **breaking** — breaking list #3.
- Retire `kind:EPIC` (with a migration note); reconcile `kind:"bug"`/`"BUG"`; remove `undefined`/`MEDIUM`. **breaking data/vocabulary migration** — breaking list #4.

### D6 — Read surface (C2/C7/C9/C10 reads)

- `view:"order"` scopes to every member kind the filter selects; outbound `blocks` + a dependent count in the projection vocabulary; plan children listable; cycle returns `{ok:false, cycle:[…]}`. **additive.**
- Every view returns a completeness flag consistent with existing `meta` keys; `part-of-rollup {count_only:true}` returns counts without inlining uids. **additive.**
- `attest {subject:{id,revision}, claim:{kind,body}, anchor:{locator,digest}, by}`; anchor grammar `path:line | URL+digest | query+hash | registry-ref`; states `unverified|verified|stale|unknown` (`refuted` deliberately excluded); `existsAtHead(path)`/`changedSinceFiling(path)`; `citationAllowedExternalRoots` gains the skill install root. Additive for the anchor grammar/states; **breaking** for dropping the project-root membership check — breaking list #8.
- `obligate {uid, applies_to:{from?,to}, requirement, on_fail:block|warn, override?:{actors}, by}`; predicate core `evidence{kind,min?}`, `blockers_terminal()`, `relation{type,direction}`, `all_of`, `any_of`, `not`; an item with no obligation is unaffected. **additive.**
- A terminal transition evaluates obligations; refusal is typed with `code` + `required_kind`; a commit ref alone does **not** satisfy `published-artifact`. **breaking** (changes `transition`/terminal success semantics) — breaking list #6.
- `claim` evaluates the verdict and **fails loudly on a `block`-severity condition** (force-claim records the blocker); reason core `BlockedBy`, `MissingObligation`, `EvidenceUnverified`, `EvidenceStale`, `ClaimStale`, `ReferenceUnresolved`, `Unknown`; verdict is derived on read, never stored. **breaking** — breaking list #5.

### D7 — Structural-blocker resolutions (B1–B3)

Each blocker gets the smallest surface that closes it. All three are **unshipped** and must not be implemented before their `REMODELED-BY` gate lands (`reconciliation-plan.md` §8.4). The addition is additive in every case; none requires opening the closed `rel` union.

| blocker | resolution | current status | gate |
|---|---|---|---|
| **B1** — no spec-revision-fragment read path (`34b69c69`) | An **additive `get` optional input field** returning the revision fragment (canonical spelling `get state`, below). Alternative (not chosen): an additive `spec-get` verb. Additive; no sign-off. | **unshipped.** Today `get fields:["spec"]` returns the pointer only; `spec-check` compares a token; `spec-append` writes. Related defect `983f5971` (spec-append CAS vs get/spec-check report different heads) is not fixed by the addition. | REMODELED-BY C10 `b009396b` (owns SPEC items + anchored exports) |
| **B2** — no citation-by-path enumeration (no dedicated item) | An **additive `query` filter/projection** (e.g. `byCitationPath`) returning which items cite a path. Alternative (not chosen): an additive `citations` read verb. Additive; no sign-off. | **unshipped.** Today citations are reachable only per-issue (`citations` field on `get`) and mutated by `add-citation`/`remove-citation`. | REMODELED-BY C3 `38631ad4` (also C8) |
| **B3** — no issue-level absorb/merge verb and no `consolidated_into` pointer | **Reuse `duplicate_of`** (already frozen, n:1) as the consolidated-into pointer **now**; schedule an **additive issue-level `merge`/`absorb` verb** that preserves addressability (a redirect row, never a destructive body-merge). A new public rel member `consolidated_into` is **breaking** (closed union) and is **not** added. | **unshipped.** Today project-level `merge-project` exists; issues have no absorb/merge and no pointer; Phase 3 used `duplicate_of` (4 live edges) as the only pointer. | REMODELED-BY C1 `73d0b9c6` (also C9 `cf97c613`) |

### D8 — Canonical S11/S12 public spellings (owned here)

These public spellings are owned by this ADR and realized through `docs/plan/backlog-consolidation/CLI-HIERARCHY.md`'s verb tree; the specs (`SPEC-SET.md` S11/S12) own the AC semantics only.

- **S12 (expected-state revision):** `get state` (the fragment read — the B1 additive `get` field), `list state`, and `create state` (the internal mint hook). The read returns the canonical payload + current token; a mismatched token returns `state:'stale'` (see Consequences — `stale` is a success-arm state, not an error code).
- **S11 (session & reservation timeline):** `list reservation` (the reservations view), `get session <id>` (the timeline read) + `list session`.

### Additive list (canonical)

Permitted under ADR-0006 D6; no sign-off, ships under this ADR's additive regime: the new `link-duplicate` verb; the B1 `get` optional field (D7) and B2 `query` projection (D7); the optional issue-level `merge`/`absorb` verb *addition*; new **optional** inputs on existing verbs; new response fields (`Verdict`, `Condition`, completeness meta, `score_kind`, `required_kind`); new typed error codes as documented extensions; new **internal** node/edge kinds (`attestation`, `obligation`, `SPEC`, `attests`, `has_obligation`, `satisfies`, `has_state_revision`); `kind` registry reads; the joined-entity model clarification; the `collisions` view.

### Breaking list (single canonical — owner-approved 2026-10-05)

The eight changes to ADR-0006's frozen surface. **Approved as the target**; each ships under this ADR, and ADR-0006 is **superseded in part** by them. Implementation remains deferred behind the §8.5 gate order.

1. **New public `rel` member `consolidated_into`** (D4) — opens the CLOSED union. **Not added; `duplicate_of` is reused** (B3). Sign-off would be required only to reverse that reuse.
2. **Widening `related` to every live relation** (D4/D6) — behavior-visible response-shape change resolving contradiction #1 (C2 items `6fb30481` vs `77310a60`). The narrow variant (the enumerated three are authoritative + delete the stale comment) is the default; the wide variant is approved but optional.
3. **Closing the `kind` catalog** (D5) — unknown kinds currently mint; a validating registry rejects them.
4. **Vocabulary migration** (D5) — retire `kind:EPIC`, reconcile `bug`/`BUG`, remove `undefined`/`MEDIUM`.
5. **`claim` block-severity precondition** (D6) — changes an existing verb's success semantics.
6. **Terminal-transition closure gate** (D6) — changes `transition`/terminal success semantics.
7. **Canonical identity resolution** (D3) — changes uid-prefix/merge behavior across every uid-taking verb.
8. **Citation existence-vs-membership gate** (D6; `050ea18f` / S02.C1) — `create`/`computeCitationSha` stops refusing an **existing** out-of-root / worktree-only / non-file locator (drops the `citationAllowedExternalRoots=[]` membership test; keeps the existence test). Behavior-visible on an existing verb.

### Design-corpus mapping (C1–C10 + FOUNDATION)

Every design item mapped to the target-interface delta it implies. "Already shipped" marks a verb the corpus calls "new" that is in ADR-0006's frozen 29 — for those, the target delta is the *shape*, not the verb.

| item | target interface delta it implies | additive / breaking |
|---|---|---|
| C1 `73d0b9c6` | canonical-node resolution: unique uid prefix across all uid verbs, ambiguous → candidate set; one-hop `Redirect`; soft-retire; `SUPERSEDES` chain head = logical id | breaking (#7) |
| C2 `ac911229` | exhaustive `related` projection; `view:"order"` kind-scoped; outbound `blocks` + dependent count; typed error on a second `part_of` | additive; `related` widening (#2 if wide) |
| C3 `38631ad4` | `attest` already shipped → adds the `{subject,claim,anchor}` shape + anchor grammar; `recheck` already shipped; states `unverified|verified|stale|unknown`; `existsAtHead`/`changedSinceFiling`; external-root allowlist | additive |
| C4 `1c53784d` | `obligate`/`unobligate` already shipped → adds `applies_to`/`requirement`/`on_fail`/`override` and the closed predicate core | additive |
| C5 `b076742d` | terminal-transition closure gate; typed refusal `{code, required_kind}`; `published-artifact` proof | breaking (#6) |
| C6 `291263ea` | `Verdict`/`Condition` derived read types; reason core enum; `claim` blocker precondition | breaking (#5) |
| C7 `395cfcad` | completeness meta on every view; `score_kind`; `part-of-rollup {count_only}`; `get {lastN}` auditTrail bound; `report` grouped rollup | additive |
| C8 `4a12472e` | `get {registry:"kind"}` readable catalog; promotion gate; extension namespace; machine-readable verb surface; retire `EPIC`; reconcile `bug`/`BUG`; remove `undefined`/`MEDIUM` | additive (registry) / breaking (#3, #4) |
| C9 `cf97c613` | dedupe scope modes; candidate-cluster read view; `link-duplicate`; `duplicates` field; `duplicateOf`/`hasDuplicates` filter; `duplicate_of` n:1; issue-level canonical/redirect | additive |
| C10 `b009396b` | `SPEC` node kind; spec `part_of` work item; anchored `{locator,digest}` export; read `verified|drifted|gone`; file is export never source | additive |
| FOUNDATION `69632883` | node kinds `attestation`+`obligation` (13→15); internal edges `attests`/`has_obligation`/`satisfies`; typed error arms; `store/vocabulary-guard.ts`, `write/tx.ts`, `write/catalog.ts`, `write/errors.ts` | additive (internal vocabulary) |
| adoption `e54bd58b` | issues are the root record; projects/components/citations are joined entities; 1:1 container correction | additive (model clarification) |

## Consequences

- **The target surface has a durable, accepted home.** A reviewer can diff an intended surface change against this ADR the way a current change is diffed against `adhd ADR-0006`.
- **Additive-first is preserved as the default regime.** Only the eight named deltas touch the frozen surface; they are recorded here exactly once, so no silent remodel can ship.
- **`adhd ADR-0006` is superseded in part, not deleted.** Its frozen current-state content stands. The two records stay individually falsifiable: 0006 = what ships, 0007 = the accepted target.
- **`stale` is a success-arm state, not an error code.** The S12 read returns `state:'stale'` on the `ok:true` arm (mirroring the shipped `SpecFreshness = 'fresh'|'stale'|'unknown'`); it is **not** added to ADR-0006's closed ten-code union (U6).
- **The gates stand.** `reconciliation-plan.md` §8.5 sequences FOUNDATION → this record → C1/C8/C9/C3/C10/C2; the `REMODELED-BY` clusters and B1–B3 stay deferred until their gate lands.
- **The three blocker resolutions are the smallest surfaces that close them.** Each is additive; none requires opening the closed `rel` union.
- **Obligation carried forward:** the `ambitious-artifact` boundary is explicit — this ADR specifies a target, not a schedule; implementation is a separate, gated program.

## Alternatives considered

- **Extend `adhd ADR-0006` to cover the target as well (one ADR, current + target).** **REJECTED.** Folding future intent into a descriptive freeze would blur "recorded the surface" with "intend to build". Two records — current (0006) and target (0007) — keep each falsifiable on its own terms.
- **Write the target as an ACCEPTED ADR before owner approval.** **REJECTED** at drafting time (the ADR catalog forbids autonomous ACCEPTED records); the owner has since approved it, which is why it is ACCEPTED now.
- **Add `consolidated_into` as a new closed-union rel member (the "obvious" fix for B3).** **REJECTED:** reusing the already-frozen `duplicate_of` n:1 closes the pointer gap with zero new surface.
- **Add `stale` as an eleventh error code (U6).** **REJECTED:** adding a code to the closed ten-code union is a breaking change to ADR-0006 D2 and is unnecessary; the shipped `state` precedent expresses staleness on the success arm.

## What does NOT change

- **This ADR changes no behavior and no code.** It is a target specification; every delta is inert until implemented under the §8.5 gate order.
- **`adhd ADR-0006`'s frozen current-state content is not rewritten.** Only its Status line changes (ACCEPTED; superseded in part), per the instruction.
- **The current 29-verb surface, the ten error codes, the one-`--input` calling convention, the `by` identity rule, and the three naming schemes** are untouched except as explicitly listed above.
- **The store substrate and concurrency contract** (`adhd ADR-0001`, `sox ADR-0012`) — out of scope; transport-facing interface only.
- **`SPEC.md` and `SKILL.md`** — cited, not rewritten; where more specific they remain authoritative detail.
- **No implementation is authorized by this ADR's acceptance alone.** The `REMODELED-BY` clusters (8/9/28/40→C1; 11/20/35→C8; 13→C3; 17→C9) and the blocker verbs remain **deferred** per `reconciliation-plan.md` §8.

## References

- `docs/plan/backlog-consolidation/backlog-interface-target.md` — the source draft (the approved target-interface record).
- `adhd ADR-0006` `docs/decisions/0006-backlog-public-interface-freeze.md` — the current-state baseline this target measures against; superseded in part by this ADR.
- `adhd ADR-0002` — correct the source, never work around.
- `adhd ADR-0004` — MCP tool output is the flat payload on `content`; the outcome envelope here is the tool's own return, not a wrapper.
- `tmp/backlog-consolidation/reconciliation-plan.md` §5 (end-state interface plan), §7 (blocker handling), §8.1 (remodelers), §8.3 (cluster classification), §8.4 (blocker verdicts), §8.5 (gate order), §9.3 (corpus→problem map).
- Design corpus: C1 `73d0b9c6`, C2 `ac911229`, C3 `38631ad4`, C4 `1c53784d`, C5 `b076742d`, C6 `291263ea`, C7 `395cfcad`, C8 `4a12472e`, C9 `cf97c613`, C10 `b009396b`, FOUNDATION `69632883`; adoption `e54bd58b`.
- Blockers: B1 `34b69c69`; B2 (no item); B3 (no item). Filed-not-scheduled defects referenced: `77310a60`, `73d3b97d`.
