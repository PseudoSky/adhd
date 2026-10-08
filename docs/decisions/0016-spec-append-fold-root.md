# ADR-0016 — Spec revisions: `amend` vs `replace` and the fold root

**Status:** PROPOSED (not accepted; owner approval required)
**Owner:** pseudosky (approval pending).
**Supersedes:** nothing. No decision text in adhd ADR-0006 or adhd ADR-0007 is reversed (see "Compatibility"). Two non-decision status corrections are proposed separately below.
**Drives:** backlog item `a9966c3f` (spec-append has no replace mode); spec rev3 acceptance criteria P7-L-AC006..AC011 and P7-L-AC018 (`tmp/backlog-consolidation/phase7-spec-rev3.md:3371-3376,3383`).
**Number:** 0016. Suggested path: `docs/decisions/0016-spec-append-fold-root.md`. Reasoning: `git ls-tree --name-only main docs/decisions/` lists adhd ADR-0001..0009 only (no 0010 or 0011 file, no gaps). 0010 (backlog item uid stability) and 0011 (per-project post-publish target) are reserved by OD-9 as pending owner approval (`tmp/backlog-consolidation/phase7-owner-decisions.md:15,32`; `tmp/backlog-consolidation/phase7-spec-rev3.md:1693,1695`). 0012 and 0015 are already cited in AGENTS.md as ADR-0012 (parallel-process invariant) and ADR-0015 (never-accepted proposal); those citations resolve to the sox catalog (`docs/decisions/README.md`, "The two catalogs"), but the numbers are taken in readers' minds and are avoided here. 0016 was therefore chosen (decided by dispatcher per standing no-block directive, owner may overturn). Caveat: `docs/decisions/README.md` says next = max+1 and a proposal is not a reservation, so the owner may assign a different number; renumber the title and filename before commit. A repo-qualified reference is always `adhd ADR-0016`, never bare.
**Grounding:** `entrypoint/backlog/src/write/spec-revision.ts` as of commit `c2021f53` (on `main`; `git branch --contains c2021f53` lists `main`); backlog item `a9966c3f` body.

## TL;DR for the next agent

`spec-append` takes an optional typed `mode: 'amend' | 'replace'` (default `amend`). An `amend` stores a delta and keeps its fold exactly as before. A `replace` stores a whole document; the fold restarts at that revision, so the revision token is `sha256` of the new document, not of (prior fold + fragment). Both modes require the `base_revision` CAS. Chains written before this change carry no `mode` and fold as `amend`. An unknown mode is `invalid_argument`. Stored bytes equal the sum of submitted fragments. The mode is never selected by an environment variable. Trap: do not "fix" a doubled spec by sending another `amend` (it adds a third copy); send a `replace`.

## Context

- Each spec revision stores only its fragment; the document is the fold of the chain, and `revision_token` is `sha256:<hex>` of that fold, not of the delta (`entrypoint/backlog/src/write/spec-revision.ts:11-18,63,70,142-146`). Before `c2021f53` the fold was `priorFold + fragment` with no way to discard prior content (item `a9966c3f` body, "Problem"; pre-change line cited there as `spec-revision.ts:455-456`).
- The defect that triggered this: plan `833b33a7`'s spec head (revision 2, `41d0ede3`) is revision 1 followed by revision 2, because a full revised document was sent to the delta verb (`a9966c3f` body, "Concrete consequence"). Every AC id was duplicated and the token hashes a document nobody wrote.
- The fold itself is intentional (stores O(N) bytes, not O(N^2)); the gap was the absence of replace semantics (`a9966c3f` body, "Decision"; `spec-revision.ts:11-18`). The `ADHD_BACKLOG_UNSAFE_SPEC_APPEND` variable exists only as a negative control, with `snapshot` and `force` values, and is not a replace (`spec-revision.ts:175-190`).
- Rev3 of the phase-7 spec must be applied with `mode:'replace'`; applying it as an amend would put a third copy of every AC id into the fold (`phase7-spec-rev3.md:3`).
- Not established: whether any consumer outside this repo calls `spec-append`; the only in-repo caller named by the item is `entrypoint/backlog/src/api.ts:979` (`a9966c3f` body, scope line). Not verified here.

## Decision

### D1 — `mode` is an optional typed input on `spec-append`

`ISpecAppendInput.mode?: 'amend' | 'replace'`; absent means `amend` (`spec-revision.ts:88-107,469`). The set is closed: `SPEC_APPEND_MODES = ['amend','replace']` (`spec-revision.ts:88-90`). Any other value throws `InvalidArgumentError('mode', ...)`, surfaced as `invalid_argument` (`spec-revision.ts:469-475`; P7-L-AC006, `phase7-spec-rev3.md:3371`).

### D2 — Fold root: a `replace` restarts the fold at itself

A `replace` revision stores the submitted document as its fragment and records `mode: 'replace'` in its metadata (`spec-revision.ts:76-80,531`). Fold reads walk `prev_revision` backward and stop at the newest `replace`, then concatenate forward from there (`spec-revision.ts:396-403` for the write-path fold; `readSpecFold` at `spec-revision.ts:418-436` for the read path). The write path does not read the prior fold at all for a replace (`spec-revision.ts:508-512`), so `folded` equals the fragment and `revision_token = sha256(fragment)` (`spec-revision.ts:514-519`), i.e. `sha256` of the exact current document, not of prior fold + fragment (P7-L-AC007, `phase7-spec-rev3.md:3372`).

### D3 — `amend` is unchanged

An `amend` stores its fragment, computes `folded = priorFold + fragment`, and its token and stored bytes are those the pre-change build produced. The `mode` key is written only for a replace, so an amend's stored metadata shape is unchanged (`spec-revision.ts:76-79,531`; comment "Only a replace records its mode: an amend's stored shape is unchanged"). Revisions written before the change keep their uids and tokens (P7-L-AC008, P7-L-AC009, `phase7-spec-rev3.md:3373-3374`).

### D4 — Legacy chains fold as amend

A node without a `mode` key is not a replace: `isReplaceRevision` is true only for `mode === 'replace'` (`spec-revision.ts:408-410`). Every pre-existing chain therefore folds as it always did. Only a chain that contains a replace changes its fold root, and only from that revision forward.

### D5 — CAS is mandatory for both modes

`base_revision` is validated as required before the mode is resolved (`spec-revision.ts:462-464`), and a stale base is refused with the conflict error before any node is written, for both modes (`spec-revision.ts:502-504`; P7-L-AC006). A replace does not bypass the CAS.

### D6 — Storage stays O(N): stored bytes equal the sum of submitted fragments

A revision stores exactly what the caller submitted (`storedContent = input.fragment` in normal mode, `spec-revision.ts:513-516`). A replace never stores a copy of the prior fold. Replaced revisions remain in the chain, immutable and readable (history is not destroyed). Verified by P7-L-AC010 (`phase7-spec-rev3.md:3375`).

### D7 — No environment toggle selects the mode

`mode` is a typed input field only. `rg process.env spec-revision.ts` must find only the existing negative-control variable (P7-L-AC011, `phase7-spec-rev3.md:3376`; `spec-revision.ts:185`).

## Consequences

- **Tokens change only for chains that contain a replace.** Any consumer comparing a stored token across the replace boundary (`spec-check`) sees `stale` for the pre-replace token and `fresh` for the new one (P7-L-AC007). Staleness semantics are unchanged (`a9966c3f` body, scope: `query/spec-staleness.ts`).
- **Any new reader of the fold must apply the same root rule.** The fold exists in two code paths (`foldChainTx`, `readSpecFold`: `spec-revision.ts:396-403,418-436`). A third path that ignores `mode` yields a wrong document. P7-L-AC007's negative control (a fold that ignores `mode`) guards this.
- **`spec-revision.reconcile.ts` does NOT honor the fold root.** It is a one-shot, idempotent, dry-run-first reconciliation (`spec-revision.reconcile.ts:1-13`) that discovers live SPEC items (`:122-140`), groups them by `part_of` parent, orders each group by `tCreated`, and computes tokens with a pure-append fold: `prevFold = prevFold + s.content` then `sha256:` of it (`:200-205`). It never reads `mode`, and it compares the computed token to the stored `revision_token` to decide `needsStamp` (`:206-210`). For a legacy (no `mode`) chain this is identical to D4. If a revision with `mode:'replace'` were ever among the discovered children, the reconcile fold would compute a token that differs from the stored replace token, mark it `needsStamp`, and (when applied) overwrite its `revision_token` (`:285`) and the parent's `spec_revision_token` (`:305`). Whether replace revisions minted by `appendSpecRevision` carry a `part_of` edge to their ticket, and so can be discovered by reconcile, is not verified (HYPOTHESIS: they do not, because chains are linked by `prev_revision`). Required follow-up, owner decision: either make reconcile skip nodes that carry `mode` or stop its fold at a replace, or record that reconcile is retired once the 12 legacy SPEC items are stamped. This ADR does not change reconcile.
- **The already-doubled chain of plan `833b33a7` is repaired by appending a `replace`, not by editing history.** Revisions 1 and 2 keep their uids and tokens (P7-L-AC008). Production application needs owner approval, `--allow-production-write` and a verified backup (`phase7-spec-rev3.md:3373`).
- **Applied spec head must have unique AC ids.** After applying rev3, `specAcIds` must report `duplicates:[]` and the head sha256 must equal that of the rev3 file (P7-L-AC018, `phase7-spec-rev3.md:3383`).
- **Docs obligation.** `entrypoint/backlog/skill/SKILL.md` section 5 defines `fragment` as a delta (`a9966c3f` citation 3, `SKILL.md:831-862`) and must document both modes; `write/CONTRACT.md` likewise (`a9966c3f` body, scope).
- **Fold-reading history is cheap but not free.** Replace bounds the fold walk (it stops at the newest replace), which shortens reads on long chains. HYPOTHESIS: no measurement was taken.

## Alternatives considered

- **A separate verb (`spec-replace`).** REJECTED (proposed). ADR-0006 freezes 29 verbs and prefers additive fields; ADR-0007 B1 already chose an optional field over a new verb for the analogous reader (`docs/decisions/0007-backlog-target-public-interface.md:70`). A new verb duplicates CAS, validation and pointer logic.
- **Delete and recreate the spec (new SPEC issue or new chain).** REJECTED. Every recreation mints a new uid so citations go stale; whole-body-per-revision costs O(N^2) storage, which `spec-revision.ts:11-18` forbids (`a9966c3f` body, "Rejected B").
- **Environment flag selecting replace.** REJECTED. Ambient process state changes durable fold semantics invisibly to the caller and to other concurrent processes (the repo requires multi-process-safe behavior, `AGENTS.md` parallel-process hard rule). A typed input is recorded in the revision metadata and visible in the call (D7). `ADHD_BACKLOG_UNSAFE_SPEC_APPEND` is a test negative control, not a precedent (`spec-revision.ts:175-190`).
- **Replace stores the full fold plus a pointer (snapshot every revision).** REJECTED. Violates the O(N) bound (D6); this is the `snapshot` negative control (`spec-revision.ts:513-516`).
- **Mutate or compact earlier revisions on replace.** REJECTED. Revisions are immutable and the replace must leave uids and tokens of earlier revisions unchanged (P7-L-AC008).
- **Hash prior fold + fragment for a replace token.** REJECTED. That is the doubled-document hash; the token would not equal `sha256` of the readable document (P7-L-AC007).

## Compatibility with adhd ADR-0006 D6

ADR-0006 D6 permits adding an optional input field and new response fields without superseding the ADR (`docs/decisions/0006-backlog-public-interface-freeze.md:84`). `mode` is an optional input; omitting it reproduces prior behavior byte for byte (D3, D4), and no required input, return field, error code or the one-`--input` calling convention changes (`0006:85`). The only new error condition, an unknown mode, reuses the existing `invalid_argument` code. This ADR therefore records the decision rather than gaining permission through D6; no owner sign-off for a breaking change is needed on this axis.

## What it supersedes

Nothing. Two non-decision corrections are proposed (each needs owner approval before any edit, per `docs/decisions/README.md` "Editing an existing ADR"):
1. ADR-0006's Consequences line stating there is no verb to read a SPEC-revision fragment back (`0006:91`) becomes stale once the reader `34b69c69` ships. This ADR does not ship the reader.
2. ADR-0007 row B1 status "unshipped" (`0007:70`) becomes "shipped" once `34b69c69` ships. Also the reader's spelling (`get state`) is owned by ADR-0007, not here.

## What does NOT change

- The revision chain remains the single versioning mechanism; `amend` semantics, the `SUPERSEDES`/pointer model, CAS errors and the `sha256:<hex>` token encoding (`spec-revision.ts:142-146`) are untouched.
- This ADR does not add the document reader, history, diff or AC-existence reads (items `34b69c69` and others); it only fixes the fold root they must honor.
- This ADR does not decide the stdin input route (item `6bf426c2`), which would change the one-`--input` convention reserved by `0006:85` and needs its own superseding ADR (`a9966c3f` body, "ADR implications" (3)).

## Open questions for the owner

1. **Number.** 0016 is chosen because 0010 and 0011 are reserved by OD-9 and 0012 and 0015 are cited in AGENTS.md; the owner may instead assign 0010 and renumber the others.
2. **`ADHD_BACKLOG_UNSAFE_SPEC_APPEND` (decided by dispatcher per standing no-block directive, owner may overturn).** The variable stays documented-unsafe and unchanged: a negative-control switch with values `normal`, `snapshot`, `force`, where `force` skips the `base_revision` CAS (`spec-revision.ts:175-190,502`). D5 and D7 are about supported behaviour; this variable is not a supported path and is not a mode selector.
3. **Replace as the root revision (`base_revision:''`) (decided by dispatcher per standing no-block directive, owner may overturn): it should be rejected with `invalid_argument` until the owner says otherwise.** Current code ALLOWS it: when no spec exists `currentRevision` is undefined, `currentUid` is `''` (`spec-revision.ts:493-494`), the CAS passes for `base_revision:''` (`spec-revision.ts:502`), and the replace branch yields an empty prior fold (`spec-revision.ts:508-512`), so a root replace is accepted today and is indistinguishable from a root amend except for the `mode` key. Implementing the rejection is a follow-up code change plus a test, not part of commit `c2021f53`. The item notes a replace root makes '' vs base document moot (`a9966c3f` body, "Relates: 203f161b"); that is the argument the owner may weigh for allowing it.
4. **Record `mode` for amend too? OPEN CONFLICT; the decision text stays "an amend stores no `mode` key" pending the owner.** The dispatcher's direction was to record it. P7-L-AC009 (`phase7-spec-rev3.md:3374`) and the committed test `a9966c3f AC4` (a golden token) require `spec-append` without `mode` to be byte-for-byte as before: stored content, token, outcome shape. Consequences of each option: (a) recording `mode:'amend'` changes the stored metadata of every new amend (`spec-revision.ts:76-79,531`), contradicts P7-L-AC009's wording and breaks the golden-token / legacy-fold-equality assertion unless that test and AC are rewritten, and creates two representations of an amend (legacy without the key, new with it) that every reader must treat as equal; it would make metadata self-describing. (b) Not recording keeps P7-L-AC009 and the golden fixture green and needs no reader change (D4: absent key means amend). Choosing (a) requires an owner-approved change to P7-L-AC009 and the test first.
5. **Reconcile path.** `spec-revision.reconcile.ts` uses a pure-append fold and ignores `mode` (see Consequences); choose the follow-up there.
6. **Production repair of `833b33a7`.** Authorize (or not) the replace on the production store; this ADR does not grant it.

## References

- Backlog item `a9966c3f` (title, body, Decision, "ADR implications" (2): "next free number at write time").
- Implementation commit `c2021f53` ("feat(backlog): spec-append mode amend|replace (a9966c3f, P7-L-AC006..AC011, AC018)"); `entrypoint/backlog/src/write/spec-revision.ts` and `entrypoint/backlog/src/write/spec-revision.p7.spec.ts`.
- `tmp/backlog-consolidation/phase7-spec-rev3.md:3,3371-3376,3383`; `tmp/backlog-consolidation/phase7-owner-decisions.md:15,32`.
- adhd ADR-0006 D6 (`docs/decisions/0006-backlog-public-interface-freeze.md:82-85,91`); adhd ADR-0007 B1 (`docs/decisions/0007-backlog-target-public-interface.md:70`).
- `docs/decisions/TEMPLATE.md`, `docs/decisions/README.md`.

## Proposed README index row

Exact row text for the `docs/decisions/README.md` Index table (not edited by this draft):

`| [0016](./0016-spec-append-fold-root.md) | Spec revisions: `amend` vs `replace` and the fold root | PROPOSED |`
