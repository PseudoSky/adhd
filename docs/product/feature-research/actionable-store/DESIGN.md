# DESIGN — Actionable Store (working title; vocabulary provisional)

> **Scope.** This design resolves the 34 items of **two of the umbrella's eight member plans**: `cf64c988-1bd9-4618-a369-d4a30d5649c9` (14 items — how work is filed, judged, closed) and `1e61f827-7054-46e0-90d7-70f224acbb01` (20 items — the addresses / tool surface). The umbrella `ee299cd5-016a-4778-a66f-ed8220e9e84d` holds **8 member plans**, and its descendant count is **not stable** — it grows as tickets are filed under it. Every count in this document is therefore a **dated snapshot, re-read rather than restated**: `part-of-rollup` read 71/69/2 when this paragraph was written and is higher now that this plan's own core tickets are descendants. The members of the other six plans are out of scope *of this design* by the brief, not by an assumption the umbrella was empty; they are covered by the pass-2 design (`docs/product/feature-research/substrate-fleet/DESIGN.md`). No item's own terminology is treated as confirmed product vocabulary.
>
> **Review status:** blind-reviewed by `review` (3 findings filed: `9c857576`, `a781368e`, `97ddf63a`), blind-reviewed by `researcher` (4 high-severity defects + 8 design gaps, all folded in below), and gated by `architect-decision` → **APPROVED_WITH_CONDITIONS** (5 conditions, folded in as §7).

## 0. Legend (C-codes used in §4 and the ticket map)

| Code | Primitive / invariant | Absorbs (member-plan uids) |
|---|---|---|
| C1 | Reference — canonical identity & resolution | e2446b18, 7f211864, 3b5eaf0b, 1b13913a, 17f083fe, 861f221c |
| C2 | Structural legibility & dependent-aware order | fc52d398, 260d6b34, 08102d9a, dd2eee5f |
| C3 | Attestation — anchored, verifiable, non-churning evidence | 5b555754, 05f16e2a, 78c96213, a3a9a4f9 |
| C4 | Obligation — declared requirements on an item | decda240, e5a790a7, 8232cc9d |
| C5 | Closure gate — terminal transitions require satisfied obligations | 4fc3704e, 0abc01ed |
| C6 | Verdict — derived actionability with reasons; claim enforcement | 416971f9, b2e9b451 |
| C7 | Honest envelope & store observability | f3a055bb, 2ff739f7, 93eac07b, bbeb0f57, 015aab9b |
| C8 | Closed primitives / open vocabulary / self-describing surface | 6bfdda8a, 2d1f8d3a, a7d3990a, f6ea94ee, a635d70c |

3 of the 34 are **not product features** (see §8).

## 1. Problem

The store keeps issues, plans and citations and queries them well. It offers nothing between *an agent filed a note* and *a dispatcher acts on it*. Nothing states what the work is, what done means, or whether the note is true. A consumer pulls whatever is open. **The tool is used as a notebook and read as a work queue.**

Five questions a work queue must answer, and why this store cannot (premises corrected against shipped code, 2026-09-26):

| Question | Current blocker |
|---|---|
| **What is this work?** | `part_of` parentage is not surfaced on an item card and no view lists a plan's children; `view:"order"` is a correct Kahn sort over `blocks` **but hard-scoped to `kind:'issue'`** — the `kind: 'issue'` node filter inside `queryOrder` in `entrypoint/backlog/src/query/query.ts` (cited by **symbol, not line**: line-number anchors rot on every edit, which is the same failure the attestation design exists to fix, and three independent reviewers caught these anchors drifting) — so non-issue members are silently absent; references do not resolve (no short-uid, `lookup` searches the location namespace only, duplicate project rows, `kind` catalog unreadable). |
| **What does done mean?** | No item declares a requirement; terminal transitions accept any citation, including a bare commit ref for an unreleased package. |
| **Is the note true?** | Evidence cannot be attached to an existing item without superseding its uid; cannot cite external roots; verification probes the wrong project root so honest sibling-repo citations are falsely refuted. |
| **May I work it, and in what order?** | A recorded blocker does not stop a claim; nothing exposes or weighs what an item unblocks (no outbound `blocks`, no dependent count). |
| **Can I trust the answer?** | Several views return no `meta` at all, a truncated page looks complete, and a rank-derived score is exposed untagged beside a corpus-wide total. The omission is *deliberate* — the `query` view-dispatch comment in `entrypoint/backlog/src/query/query.ts` says adding a `meta` would mean "inventing a number this module cannot stand behind" — so the fix is to make the number stand-behind-able (a labelled count, or omission), never to bolt on a fabricated one. |

Root cause, in one line: **every item is an assertion with no evaluable predicate.** The store has no notion of a claim that can be checked, so nothing between filing and doing is expressible.

## 2. Thesis

Add **four general primitives** and enforce **two invariants**. None names a workflow stage. All are justified by a consumer who has never heard of this project's process.

**The guarantee's floor, stated up front.** An item with no declared obligation and no live blocker is `actionable: true`. The design therefore does **not** fix the notebook-read-as-queue failure by itself — it makes it *fixable*, and the fix is applied wherever a consumer declares an obligation. The forcing function is the consumer specs (product / dispatcher / backlog-operator requiring an obligation on any item intended for execution), **not** a tool default and **not** a config switch. The floor is asserted by a test (AC10), not assumed.

### Primitive 1 — Reference
Any token a consumer uses (short uid prefix, project name/repo URL, component or location path) resolves to **exactly one** canonical node, or fails loudly **naming the candidates**. Canonical identity is an immutable id minted at creation; every human-chosen name is a mutable attribute beside it. Duplicate rows merge **into** a survivor with a one-hop redirect row, never hard-deleted; retired ids are never reused. Candidate surfacing is advisory — merge is reviewed, never automatic (over-merge is the documented dominant failure); reversal rate is monitored.
*Basis: Git unique-prefix abbreviation (ambiguity → error, never guess); Jira key never-reused + moved-key redirect; Kubernetes name (reusable) vs UID (never reused); npm immutable `name@version`.*

Shape: `Id { opaque, immutable }`; `Ref { input → Id | Ambiguous[candidates] | NotFound }`; `Redirect { fromId|fromName → toId }`.

**Identity survives supersession, not only merge.** A body edit today mints a new uid and links the old node by `SUPERSEDES` (the supersede path in `entrypoint/backlog/src/write/update.ts`). An attestation's `subject.id` is the **logical** id — the head of the `SUPERSEDES` chain — so evidence attached before a body edit still resolves after it. `Redirect` covers merge; the `SUPERSEDES` chain covers in-place churn; both must resolve in one hop.

**One revision counter, one name.** `subject.revision` (Primitive 2) and `source_revision` (Primitive 4) are the *same* quantity — the node's monotonic `revision`, bumped on every mutating write. They must be named identically in the implementation (`revision`), because a check and a verdict are stale relative to the same counter, or staleness is undefined.

### Primitive 2 — Attestation
A claim about a subject, held in a **separate record keyed to the subject**, never inside it. Anchored by `locator + digest` so it cannot rot silently the way a hand-written line number does. Carries an **append-only per-claim check** (deliberately *not* named "verdict" — see Primitive 4).
*Basis: in-toto statement `{subject-by-digest, predicateType, predicate}`; git notes (`refs/notes/*`, object hash untouched); Jujutsu change-id stable across rewrites; GitHub two-axis `status × conclusion` with `stale` first-class; Wikidata deprecate-with-reason and "citation needed"; C2PA claim-vs-assertion.*

```
Attestation {
  subject:  { id, revision }         // logical id (SUPERSEDES-chain head) + content revision observed
  claim:    { kind, body, asserted_by, asserted_at }
  anchor:   { locator, digest }      // path:line + content hash | URL + digest | query + result hash | registry-ref
  check:    { state: unverified|verified|stale|unknown,
              method, checked_at, checked_by, reason }   // append-only; re-check appends
  lifecycle:{ status: proposed|active|deprecated|superseded, supersedes, part_of }
}
```
A citable-but-unverifiable evidence item yields an explicit `unverified` — never a silent absence. `attest` creates a record; `recheck` appends a new `check` to an existing record (the check is append-only, so a re-check never overwrites a prior state). **`refuted` is deliberately not in the mechanical check enum:** a mechanical anchor check can prove present/matching/stale/absent, but "the claim is contradicted" is a semantic judgement needing a checker *per claim-kind*, so it belongs to the obligation layer, which names its checker. Authenticity ≠ truth: the check covers the mechanical anchor; policy truth is the obligation's business.

### Primitive 3 — Obligation
A **declared, typed requirement** attached to an item, evaluated **at a transition-attempt**, fail-closed, returning reasons. The predicate vocabulary is a **closed core**. An expression leaf (CEL) is **explicitly deferred** from v1 (see §7 condition 4).
*Basis: Jira/GitHub/GitLab/Argo/Harness/CodePipeline gates all reduce to "a named predicate, scoped to a transition, evaluated at transition time, fail-closed, returning a reason set".*

```
Obligation { applies_to: { from?, to }, requirement: Predicate, on_fail: block|warn,
             override?: { actors: [Actor] } }
Predicate := evidence{kind, min?} | blockers_terminal() | relation{type, direction}
           | all_of([...]) | any_of([...]) | not(...)
```
**`to` is REQUIRED.** An earlier draft left `to` optional, meaning "absent = evaluated by the verdict on read, present = evaluated by the gate at transition" — a silent dual with no error and no wrong answer surfaced (red-team finding, §11). Removed: an obligation always names the transition it guards.
`evidence.min`, when present, is a count of **distinct verified attestations** of that kind required; omitted means ≥1. An override always requires a recorded reason (not a configurable boolean).
**Surface:** obligations are declared/removed by an `obligate` verb; evidence is attached by `attest`; neither exists today.
**Gated verbs are a closed set: `transition` (any status change) and `claim`.** Every other verb (`update`, `relate`, `delete`, …) is ungated. `batch` is ungated **as an outer verb only** — each inner `transition`/`claim` still evaluates its own gate, and under adhd ADR-0001's contract runs under `BEGIN IMMEDIATE` + bounded BUSY-only retry per item. `claim` is gated as an *entry* precondition because taking blocked work is the observed failure, even though a claim is a lease rather than a status transition.
**No `timeout` in v1.** The v1 predicate core evaluates synchronously at the attempt, so nothing can hang; the field is dropped rather than left undefined. A timeout returns with the first asynchronous external-check predicate.

### Primitive 4 — Verdict
The answer to *"may this proceed, and if not, why"*, **derived on read, never stored** (a stored status field is the documented drift anti-pattern). An ordered set of typed conditions, hardest block first, each with a stable machine code and a pointer to the thing to fix.
*Basis: Kubernetes Conditions `{type,status:True|False|Unknown,reason,message,observedGeneration}`; Argo CD two-axis health+sync; GitHub `mergeable` + `mergeStateStatus` (a single enum is lossy once two things can block; `null` ≠ `false`); Linear blocked-by edges; systemd Condition-vs-Assert severity split.*

```
Verdict { actionable: bool, evaluated_at, revision, conditions: [Condition] }
Condition { type, status: True|False|Unknown, severity: block|warn, code, message?, subject? }
```
**Condition semantics — every example and implementation must obey this.** `status` says whether the *named condition holds*: `{type:"Blocked", status:True}` means the item IS blocked. **`actionable` is tri-state (`true | false | unknown`), not a boolean.** `false` iff at least one condition with `severity:"block"` has `status:True`; `unknown` iff any blocking condition is `status:Unknown` (including "the check was not run at this depth"). **`unknown` is never a green light** — a caller that handles only booleans must be told, the list path must not default `unknown` to `true`, and a not-yet-run check must never render as actionable. (Red-team §11: propagating `Unknown` as `false` was wrong, but rendering it as `true` was the worse footgun — so neither default; the value is genuinely unknown and is surfaced as such.) Conditions are ordered block-severity first, then warn. The list path and the `get` path must agree: the same item must never read `actionable:true` on a list and `actionable:false` on `get` — where the list cannot afford the rung, it reports `unknown`, not `true`.
`revision` is a monotonic counter on the node, bumped on **every mutating write** (defined here because body edits currently supersede the uid and there is no existing generation counter). A verdict whose `revision` ≠ the node's current revision is stale and must be recomputed.

**Bounded derivation (mandatory).** Verdict computation runs a cheap-first ladder with an explicit per-read budget:
1. relation state (indexed `blocks` in-degree) — always;
2. obligation presence and shape — always;
3. anchor existence at HEAD (`git cat-file -e`) — cheap;
4. changed-since-filing — cheap;
5. full anchor re-resolve — **only on demand**, never on the list path.

On budget exhaustion a condition is `Unknown` (a first-class value), never a confident guess. List views derive at rungs 1–2 only; rungs 3–5 run per item on request. This is the N-item-page bound the reviewer required.

Reason codes: a small governed core (`BlockedBy`, `MissingObligation`, `EvidenceUnverified`, `EvidenceStale`, `ClaimStale`, `ReferenceUnresolved`, `Unknown`) plus `<domain>/<Code>` extensions registered in the extension namespace registry (§ Invariant 6). `ClaimStale` reuses the staleness threshold the store already has (`view:"stale"` / `project_policy.claim_stale_after_min`) — an abandoned claim is a *condition*, not a stored status, so `IN_PROGRESS` stops conflating "work is live" with "nobody touched it".

### Invariant 5 — Honest envelope
Every non-trivial read returns a completeness flag, an opaque continuation cursor, the effective page size, a **count named for what it counts** (with an exactness relation, or omitted), and a **`score_kind`** provenance tag on every derived score. A rank-derived score is ordinal and must never be labelled similarity or confidence.
*Basis: Relay `hasNextPage`; JSON:API `links`; OData `@odata.nextLink` + first-page `@odata.count`; Stripe explicit `has_more`; AIP-158 empty `next_page_token`; Elasticsearch `hits.total.relation` (`eq`/`gte`); Azure `@search.score` vs `@search.rerankerScore`.*

**Migration:** the store already emits `{total, returned, limit, offset?, truncated?}` on the list path (`query/meta-wire.e2e.ts`); consumers key on `truncated`. Invariant 5 extends that shape to every view and adds `score_kind` — it does not replace the existing keys.

### Invariant 6 — Closed primitives, open vocabulary
A word becomes a primitive only when **all five** hold: not expressible by existing primitives; demanded by ≥2 independent consumers; carries a rename-proof id; validatable by the closed grammar; discoverable on a catalog surface. **"Independent consumer" means a distinct in-repo actor that must act on the item — never prior art that solved the problem elsewhere.** The four primitives clear the bar: dispatcher (pulls and gates work), backlog-operator (files and reports), architect/product (declare and verify). The catalog of kinds, verbs, relation types and reason codes is a **generated view over the validating registry** — never a hand-maintained list — and the tool publishes a machine-readable surface so consumers stop hardcoding it.
**Extensions are governed, not free:** a namespace is registered by an owner through a registration verb; each extension declares a type and a lifecycle; extensions are discoverable on the same catalog surface; an extension may not be promoted to the core without the five-part gate. The lighter bar for an extension is an explicit decision, stated so extension sprawl cannot silently reproduce the Jira custom-field failure.
*The live `kind` catalog is the exhibit:* it holds case-duplicates (`BUG`/`bug`, `DEBT`/`debt`, …), probe junk (`ZZTEST`, `ZZPROBE`, `ZZDODPROBE`, `PROBE`), a literal `undefined`, a priority value (`MEDIUM`), and free-form one-offs. That is what an ungoverned vocabulary looks like. In-repo anti-pattern precedent: `kind: EPIC` was minted and proved unnecessary.

## 3. What is explicitly refused

- **Stored `ready`/`done` status.** Actionability is derived; a materialised status recreates the drift it was meant to cure.
- **A configurable workflow/policy engine.** It makes the core read consumer configuration and breeds sprawl. There is no dynamic leaf in v1 at all (CEL deferred) and no per-project opt-in switch.
- **Waves, tiers, turn budgets, capacity.** Ephemeral orchestration decisions; persisting them creates a stale artifact read as current.
- **Acceptance prose as structured data.** The prose stays prose; what is structured is the *evidence predicate*, not the sentence.
- **Markdown regeneration.** The projection was deleted to end split-brain (`sox ADR-0009` superseded by `sox ADR-0011`, `backlog-tool-write-destination`); rebuilding it would do so with the tool's blessing.
- **A new `kind` for a process stage.** A stage is an obligation plus a derived verdict, not a primitive.
- **File-level atomicity tricks around the backlog store.** The store is already atomic and parallel-process safe (transactions; `busy_timeout`/`BEGIN IMMEDIATE` per adhd ADR-0001; the parallel-process invariant ADR-0012). Correctness of a backlog write is the **store's** job — never a temp-file-plus-rename pattern wrapped around JSON. The *dynamics* such research surfaces (unique-temp isolation, an ownership index, detect-vs-remediate drift verdicts) belong to a **different layer** — the install/deploy layer (`ownership.json`, `extensions.lock`, host file-drops) — and are addressed there, not here.

## 4. Three architectures considered

**A — Per-item obligations (chosen).** Every item may carry obligations; gates evaluate at transition; the verdict is derived per item. Minimal surface, no hierarchy required, adoptable one field at a time.

**B — Two-axis rollup + evidence gate.** Parent/child with `childrenClosed × selfVerified`. **Not refused, but demoted:** it is one *derived view* over A (`selfVerified` = the item's own verdict), useful for plan-level progress, unnecessary as a second feature — building it separately would duplicate A's arithmetic.

**C — Configurable gate engine.** Gates as config objects bound per project. Rejected as core (every system surveyed that took this path accumulated config sprawl and drift). Reconsider only behind a real demand signal.

**The real path vs the shortcut, stated plainly.** The shortcut is to ship Primitive 4 alone — a reasons-carrying actionability query. It fixes the dispatcher's immediate pain in one ticket and needs nothing else, and `architect-decision` independently recommended exactly that minimal slice (**C1 + C7 + C6**). It is **not sufficient**: a verdict computed over references that do not resolve, evidence that cannot be attached, and obligations that cannot be declared will report reasons nobody can satisfy.

**Recommended sequence (revised after two adversarial reviews — see §11).** **Wave 1 = C1 + C2 (kind-scope half only) + C6 (structural reasons only: `BlockedBy`, `ClaimStale`, `ReferenceUnresolved`) + C7.** These need **no declaration by anyone** and work on day one against the existing 73 open items. **Wave 2 = C3 → C4 → {C5, C6 full}.** **Wave 3 = C8, C9.**

Both reviews converged on the same defect from opposite directions: *the plan shipped the social half before the structural half had proven itself.* A blind product review found no adoption metric and no owner for the forcing function; a red-team architect found that the minimal correct path required C3+C4+C5+C6 **together** (a subset yields either a no-op or a wall). The sequencing above is the fix: the structural gate (`blocks`, already enforced, needs no declaration) lands first and is observable; the evidence contract is Wave 2 and is labelled as such.

**The rung ladder is deferred with C3.** It exists solely to bound the anchor re-resolves C3 introduces; shipping it before its inputs exist is cost without a consumer.

**Consciously overridden:** `architect-decision` recommended the minimal slice Reference + Honest-envelope + **Verdict** (C1+C7+C6). This plan adds C2's kind-scope half to Wave 1 because a Verdict over records that cannot be listed in order is a reason nobody can act on. §7's "conditions folded in" refers to the architect's compliance conditions, **not** to its sequence recommendation. If schedule forces a further cut, cut C8 (and C2's dependent-weight half) — but say so in each ticket.

## 5. Acceptance criteria (the feature is done when)

1. A short uid prefix resolves to one item; an ambiguous prefix returns the candidate set; a name/repoUrl resolves to one canonical project row; a merged row redirects in one hop; an attestation attached before a body-edit supersession still resolves through the `SUPERSEDES` chain; no retired id is reused.
2. `part_of` parentage is readable on an item and a plan's members are listable; `view:"order"` returns an order over **every** member kind scoped by the filter, not only `kind:'issue'`; the outbound `blocks` set and a dependent count are exposed. **Unblock-worth is a deterministic second sort key:** within the Kahn order, ties break by *transitive outbound dependent count* (how many nodes reach this one via `blocks`), descending, then by priority, then by uid. Today's `queryOrder` queue is plain FIFO (the queue loop inside `queryOrder` in `entrypoint/backlog/src/query/query.ts`), so this key must be **added, not assumed** (per **08102d9a**).
3. An item accepts an attestation after filing without the attestation being orphaned; a citation to an allowlisted external root verifies; citations are probed against the item's own project root, so a sibling-repo path is not falsely refuted; a citable-but-unverifiable item yields `unverified`, never a silent absence.
4. An item can declare an obligation of each core predicate kind; a terminal transition without a satisfied obligation is refused with a typed reason and the status is unchanged on re-read; a commit ref alone does not satisfy an obligation requiring a published artifact.
5. The verdict is computed on read (no write changes it), carries `revision`, orders reasons by severity, and gives each a stable code + subject. **The bound is measured, not asserted:** a default-running test reports the N-item list-path p95 (with N named) and **fails if the list path evaluates beyond rungs 1–2** of the §2 ladder — deriving rungs 3–5 on a list is a regression.
6. `claim` on an item with a non-terminal blocker fails loudly and names it; a force-claim records the named blocker.
7. Every view returns a completeness flag consistent with the existing `meta` keys; a truncated page is distinguishable from a complete one; a derived score carries `score_kind`; a reported metric was computed from the store at report time (per **f3a055bb**).
8. The kind/reason/relation catalogs are readable; `get {registry:'kind'}` no longer rejects; no verb the surface advertises is absent from the tool (per **6bfdda8a**); the CLI renders namespace vs verb and the calling convention distinctly (per **a7d3990a**); a new primitive requires the five-part promotion gate; `ready`/`claim`/`EPIC` are re-expressed or retired with a migration note.
9. An abandoned claim is reported as a condition (`ClaimStale`) — `IN_PROGRESS` no longer conflates "work is live" with "nobody touched it" (per AC-condition semantics, §2 Primitive 4).
10. The honest floor is **asserted, not assumed**: an unblocked item with **no** obligations yields `actionable:true`, and a test proves the tool functions without a declaration — so the gap in §2's floor note is visible in CI rather than discovered later.

## 6. Migration of the existing population

- **Statuses:** existing `open`/`IN_PROGRESS` stay as data. No obligation is retro-required. An item with no obligations is `actionable` when its blockers are terminal. **Stated honestly:** with no obligation declared, `actionable` is true, so the notebook-read-as-queue failure persists *by default*; enforcement is structural only where someone declared an obligation, and otherwise social. Adoption is by declaring obligations, not by a config toggle.
- **Vocabulary:** the one `kind: EPIC` row (`841617b8-3d36-4e08-99b6-016fa972e9ed`, `SUPERSEDED` — read from the store; titles containing "EPIC:" are `FEAT`/`BUG`, not kind `EPIC`) and any borrowed word are **re-expressed in place** (no re-keying): an `EPIC` becomes an ordinary item that other items `part_of`, plus an obligation if a stage was intended. Retired words are deprecated on the catalog with a replacement pointer, never silently dropped.
- **Identity:** duplicate project rows are reconciled to one canonical row; surplus rows are soft-retired behind a redirect. Items are moved, not rewritten; uid prefixes resolve on both canonical and redirect rows for one hop. Where the duplicate row lives in the sox store, the fix is a sox-side decision request, not a unilateral adhd reimplementation (adhd ADR-0002).
- **Evidence:** existing prose `Citations:` lines are not auto-parsed. A one-shot backfill may *propose* attestations for them (status `proposed`, check `unverified`), reviewed before activation.
- **Search:** the ~1,188-item open population is not bulk-recalculated; rollup and verdict are computed on demand. No backfill writes are required for Wave 1.

## 7. architect-decision conditions (all folded in)

1. ✅ Bare `ADR-0011` replaced with repo-qualified references; "projection deleted / graph is sole source of truth" is cited as **sox ADR-0009 → superseded by sox ADR-0011** with its source path, per `docs/decisions/README.md`'s repo-qualified convention.
2. ✅ Derive-on-read bounded (§2 Primitive 4: cheap-first ladder + budget + `Unknown` short-circuit); list views derive at rungs 1–2 only.
3. ✅ The gate write path binds to **adhd ADR-0001**: fail-closed obligation evaluation is a read-modify-write and must run under `BEGIN IMMEDIATE` + `busy_timeout` + bounded BUSY-only retry; AC4's "status unchanged on re-read" requires it. Derive-on-read does not exempt the write path.
4. ✅ **CEL dropped from v1** (zero identified consumer, violating Invariant 6's own ≥2-consumers bar). Reintroducing it requires a **new ADR** (a dependency / expression-language decision) on a real demand signal; it does not fall under any existing `adhd ADR-0003` (which is the CommonJS-publishing decision).
5. ✅ Identity/merge semantics are **source-store semantics**: where the duplicate row lives in the sox store, the fix is a sox-side decision request, not a unilateral reimplementation in the adhd entrypoint (adhd ADR-0002).
6. ✅ **adhd ADR-0004 engaged.** New verbs (`attest`, `obligate`, `recheck`) and refusal arms return the flat MCP `content` payload — no `{ result: … }` envelope — and use object-shaped returns where `outputSchema` applies. The design adds no transport shape ADR-0004 does not already govern.

## 8. The 3 items that are not product features

| uid | Why it is not a tool feature | Disposition |
|---|---|---|
| `f338366f` | agent-manager's spec not mandating routing backlog traffic through backlog-operator — a process/agent-spec edit | Leave to agent-manager's spec owner; C7 makes the numbers cheap either way |
| `42b0dc25` | agent-manager hardcoding repo specifics into briefs — a process/agent-spec edit | Leave; its four `blocks` dependents are unblocked mechanically by C6 |
| `3ec44b8c` | product.md never mentions priority — a doc/spec edit; the tool already stores priority | Leave as a documentation fix; link to C2 (ordering) |

## 9. Risks

- **Scope creep into project management** (`6a422302`). Test: if an addition can only be explained by reference to one repo's dispatch model, it is out.
- **Verification cost.** Attestation checking is cheap-first before any agent is spent (§2 ladder).
- **Over-merge.** Candidate surfacing is advisory; merge is reviewed; reversal rate monitored.
- **Read-path cost.** Bounded by the §2 ladder; the N-item page case is explicitly not fully derived.
- **Default-allow.** Where no obligation is declared the gate does nothing (§6); the design's guarantee is only as strong as the declarations made. This is the design's central honest limitation, not a footnote.
- **Unverifiable-here citations.** The `sox ADR-0009` / `sox ADR-0011` references cannot be confirmed on this machine (`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` is absent); they are repo-qualified per `docs/decisions/README.md` and must be confirmed where that catalog is present.
- **§8's three outsourced items are not deliverables of this plan.** `42b0dc25` and `f338366f` appear in the demo as *data* (a blocking relation, a spec-silence example); no ticket here assumes their resolution.

## 10. Research incorporation — finding → design element

Six research threads were run; each ended in converged primitives. This table is the audit of where each landed, plus the four findings that required a design change **on this pass** (they were previously cited but not yet requirements).

| Thread (systems surveyed) | Converged primitive | Delivered as |
|---|---|---|
| Transition gates — Jira, GitHub rulesets, GitLab, Argo, Spinnaker, Harness/OPA, CodePipeline, SLSA, policy-bot, K8s VAP | a **named predicate scoped to a transition**, evaluated **at transition-attempt** (not creation time), fail-closed, returning a **typed reason set**, with an explicit recorded override | Primitive 3 (`Obligation`), §3 gated-verb set `{transition, claim}`, C5, §7 cond. 3 |
| Attestations — in-toto/SLSA, Sigstore, C2PA, GitHub Checks, git notes, Jujutsu, SPDX/CycloneDX, Wikidata, DOI/DataCite | a **separate record keyed to the subject** `{id, revision}`; anchor = **locator + digest**; **append-only** verdict; deprecate/supersede **with a reason**, never delete; explicit `unverified` rather than silent absence | Primitive 2, C3 |
| Computed conditions — K8s `conditions[]`, Argo health+sync, GitHub `mergeable`/`mergeStateStatus`, systemd Condition vs Assert, Temporal, Bazel, Linear blockers | **derive, never store**; an **ordered set** of typed conditions, not one scalar; a **governed reason-code vocabulary**; **revision stamp**; **uncertainty as a first-class value**; **two-severity** split | Primitive 4, `severity: block|warn`, `Unknown` semantics, C6 |
| Identity & reference resolution — Git abbrev, Jira keys, Wikidata merge, ARK/DOI/PURL, npm, K8s name-vs-UID, DNS CNAME, MDM golden record | **unique-prefix + explicit ambiguity** (never guess); **immutable surrogate id**; name is a mutable attribute; **merge-with-redirect, one hop**; ids **never reused**; candidate-surfacing advisory, **over-merge is the dominant failure** | Primitive 1, C1, C9 |
| Vocabulary boundary — K8s CRD+admission, OpenAPI `x-`, Jira schemes, Notion schema, OpenFeature status ladder | **five-part promotion gate**; catalog is a **generated view over the validating registry**, never hand-maintained | Invariant 6, C8 |
| Read envelopes — Relay, JSON:API, OData/Graph, Stripe `has_more`, AIP-158/193, Elasticsearch `total.relation`, Azure score fields | **completeness flag**; **opaque cursor**; **effective page size**; a **count labelled for what it counts** with an exactness relation; **`score_kind`** provenance | Invariant 5, C7 |

**Findings that became requirements on this pass (previously cited, not yet encoded):**

1. **Catalog read surface (vocabulary thread).** Every catalog term must expose **identity, type, schema, scope, lifecycle, and an enumeration endpoint** — C8's AC1 named only identity/type/lifecycle. **C8 AC1 is widened to all six**, and the enumeration endpoint must be machine-readable so "what the store permits" is queryable rather than assumed.
2. **Effective-vs-configured self-report (vocabulary thread).** The catalog is generated from the *same registry validation reads*, and the tool exposes a **differs-from-disk / effective-vs-configured** self-report so documented and live can both be queried. Added to Invariant 6 and C8 AC2's generated-not-hand-maintained test.
3. **Emptiness is the only regime-free signal (read-envelope thread).** A zero-result set means the same thing under every scoring regime; a non-zero `_score` value does not. Invariant 5 states this as the reason `score_kind` is mandatory rather than advisory.
4. **Portable receipt (attestation thread).** A check plus the proof that produced it should be exportable as **one bundle** (the cosign-bundle analogue: signature + cert + inclusion proof in a single artifact). **Recorded as a C3 non-goal for v1** — the append-only `check` is the prerequisite; bundling is a later slice. Stated so the omission is deliberate, not an oversight.

## 11. Adversarial reviews and dispositions

Two adversarial reviews were run after the first draft. They converged on one defect from opposite directions, and between them found three fail-open footguns.

**Blind product review → APPROVED_WITH_CONDITIONS.** Filed `c022a921` (no adoption metric; no owner for the social forcing function; AC5 unfalsifiable), `8c5970e0` (drifted file:line anchors — four load-bearing citations pointed at the wrong function at HEAD; the header said "5 conditions" while §7 lists six; two unstamped descendant counts), `4f93eb77` (no consumer-migration plan for the five breaking changes).

**Red-team architecture review, premise "the spec is too complicated for users" → "correctly scoped but wrongly sequenced".** Its opening datum is a live demonstration of C1: the twelve 8-hex ticket prefixes supplied to it **all returned `item_not_found`**. Findings: (i) a filing agent must remember a second out-of-band `obligate` call and forgetting is silent; (ii) the list path and `get` derive at different depths, so the same item can read actionable-green on a list and blocked on `get`; (iii) `Unknown` defaulting anywhere is a footgun; (iv) the minimal correct path required C3+C4+C5+C6 together; (v) ~9 new enums and ~12 concepts for the full set.

| Finding | Disposition |
|---|---|
| Wrongly sequenced — social half before structural | **ACCEPTED.** §4 revised: Wave 1 = C1 + C2(kind-scope) + C6(structural reasons) + C7, none of which needs a declaration. |
| `applies_to.to` optional was a silent dual | **ACCEPTED.** §2 P3: `to` is now required. |
| `Unknown` must not default to actionable; list/`get` must agree | **ACCEPTED.** §2 P4: `actionable` is tri-state; `unknown` is never green; the list path reports `unknown` rather than `true` where it cannot afford the rung. |
| Rung ladder before its inputs exist | **ACCEPTED.** Deferred with C3 (§4). |
| Citation drift | **ACCEPTED.** Load-bearing code references are cited by **symbol**, not line — line anchors rot on every edit, which is the exact failure the attestation design exists to fix. |
| Adopt a v1 cut of C1 + C2(kind-scope) + C6(partial) + C7 | **ACCEPTED for Wave 1, rejected as the whole plan.** Cutting C3/C4/C5 entirely removes "what does done mean" and "is the note true" — two of the three questions the brief asked for. Wave 1 makes the *floor* real; Wave 2 answers the other two. |
| Gate-on-by-default for the structural thing only | **ACCEPTED** — this is Wave 1's definition. |
| Default-allow is acceptable only if measured | **ACCEPTED as a condition.** Wave 1 needs an outcome metric (did dispatchers stop pulling blocked work?) — owned by C6, not C1. |
| Consumer-migration plan for the five breaking changes | **ACCEPTED as a condition on each breaking ticket** (`claim`, `transition`, `order`, `related`, `get`). |
| **"Kill `report` — a 7th verb for a composed count"** | **REJECTED, with evidence.** `report` exists precisely because the composition is *not* possible today: verifying umbrella coverage required a hand-rolled three-way client join, and the operator was blocked from filing the resulting skill-§9 friction (`ca1096f8`). `report` is the tool doing the join so no caller invents a number — the same rule as Invariant 5. Kept, but as a **Wave-3** verb, not Wave 1. |

## 12. Work products are store citizens: a spec is a revision of its ticket

**This section exists because the first draft of this very plan failed its own test.** The twelve specs that implement it were written as markdown files under `docs/product/feature-research/**/specs/`. The contract lived outside the graph — invisible to every query, carrying hand-maintained citations that **drifted three times** (caught independently by `review`, `architect-decision` and a red-team architect), with counts that went stale the moment work was filed under them. Submitting a spec as an **independent sibling item** did not fix that: a sibling whose body can be rewritten is still an artifact that can churn its identity and lose its history.

**The rule — two ids + one pointer (the converged research model).** Any work product a consumer must act on — a spec, a plan, a research finding, a review verdict — is a **revision of its ticket**:

1. **A stable logical id that never changes** — the work item's `uid`. Identity is never the content.
2. **Immutable revision objects, one per edit** — each a `kind: SPEC` node naming exactly one frozen state.
3. **A single mutable pointer on the record** — `meta.spec_revision` on the work item, advancing to the current revision. The record holds `(stable_id → current_revision)`; the text never lives inline.
4. **A new version is a new linked record** — never an in-place edit of an existing revision.
5. **Staleness by three rungs** — version-token compare (cheap, on every read); content hash (strong); ancestry (git merge-base). **An absent token is STALE, never fresh.**
6. **Appends are an append-only log of immutable fragments**; the document is a fold over them.
7. **Review commentary is a separate annotation layer keyed to the revision** — never in the body.
8. **Everything is referenced, not embedded.** The long-form prose is an **anchored export** (`{locator, digest}`), never the source: the store answers, the file is the projection. A store→file rewrite job is refused (`sox ADR-0009` → `sox ADR-0011`), and work living only in markdown is the same defect wearing the opposite coat.

**Anti-patterns this avoids, explicitly:** identity churn (the ticket's uid never changes on a spec edit); lost history (append-only — no revision rewritten or deleted); **forged currentness** (a writable "current" marker that is never compared — the pointer is CAS-guarded *and* crossed against the derived chain head, and every read exposes the token); unbounded body growth (the ticket body never grows); edit wars (a stale `base_revision` is refused).

**The tension resolved.** The spec belongs **to** the ticket — the ticket owns the pointer and displays its current revision — **without** the ticket's body being rewritten and **without** the spec becoming an independent artifact. The contract is what must be queried and gated; the narrative detail is what must be read; the digest closes the gap between them.

**Consequence for this plan.** The twelve specs migrated into the store (**C10**) are **not** siblings `part_of` their work items — they are the **current-revision objects** of their tickets, each ticket exposing exactly one current revision. `kind: SPEC` clears Invariant 6's five-part promotion gate: it is not expressible by existing primitives (a `PLAN` is a container, a `FEAT` is work; neither is a specification); it is demanded by ≥2 consumers (the work-item plane gates on it, the substrate plane consumes it); it carries a rename-proof id; it is core-validatable; it is discoverable on the catalog. Full contract, files and ACs: `actionable-store/specs/C10-store-citizen-documents.spec.md`.
