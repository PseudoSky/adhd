# PROPOSAL — Actionable Store, across the estate (adhd ⇄ sox-ecosystem)

> Consolidated proposal for blind adversarial review. Sources: `DESIGN.md` + `CONCEPTUAL_TEST.md` (work-item plane), `substrate-fleet/DESIGN.md` (substrate plane), the eight architect specs under `specs/`, and the store's own ticket graph (12 core tickets under umbrella `ee299cd5`). Every claim about code carries a file:line; claims about the sox side are marked **[sox-reported]** where I did not read them myself.

## 1. Problem

The backlog tool is a notebook read as a work queue. Every item is **an assertion with no evaluable predicate**: nothing states what the work is, what done means, or whether the note is true, so a dispatcher pulls whatever is open. Five symptoms: references don't resolve; the structural graph isn't legible; no item declares a requirement; evidence can't be attached or verified; read envelopes lie about completeness.

**Correction that governs the whole proposal (owner, this session).** The estate is bigger than the backlog repo, and a proposal that does not touch **both** repos is not the full solution. There are three planes:

| Plane | Repo | Owns |
|---|---|---|
| **Work-item** | `adhd` (`entrypoint/backlog`, `@adhd/*`) | issues, plans, citations, relations, verbs, views, the MCP/CLI surface |
| **Substrate / runtime** | `sox-ecosystem` | memory-core (the graph store + memory-server), the ownership/install model, the sox ADR catalog, the store substrate |
| **Host / fleet** | `claude-agents` | the `state` routing/claim tool, agent extensions, host file-drops |

## 2. Thesis

Four general primitives + two invariants on the **work-item plane**; a **boundary contract** so the substrate plane exposes what the work-item plane requires — and nothing more.

- **Reference** — every token resolves to one canonical node or fails naming candidates.
- **Attestation** — a separate, anchored, append-only evidence record keyed to `{id, revision}`, attached without mutating the subject.
- **Obligation** — a declared typed requirement, evaluated at a transition-attempt, fail-closed.
- **Verdict** — derived on read, never stored: ordered typed conditions with stable reason codes and a subject pointer.
- Invariants: **honest envelopes**; **closed primitives / open vocabulary**.

## 3. Cross-repo architecture — who changes what

### 3.1 The boundary contract
**adhd ADR-0002 D4**: an agent may not change the other repo's design unilaterally; it raises a **decision request** in the owning repo. So every cross-plane need is expressed as a *decision request with an interface*, not as an edit. This is the mechanism that keeps the work-item plane from reaching into the substrate.

### 3.2 Work-item plane — `adhd` (delivered)
The twelve core tickets. All twelve now carry a spec (C1–C8 under `actionable-store/specs/`, C9 as `actionable-store/specs/C9-similarity.spec.md`; D-A/D-B/D-C under `substrate-fleet/specs/`):

| Ticket | Change | Repo/package |
|---|---|---|
| C1 Reference | uid-prefix resolution, `lookup` disambiguation, canonical project identity, `merge-project`/`rm-project` | `entrypoint/backlog` |
| C2 Legibility | `related` exposes all rel types; `order` drops `kind:'issue'`; outbound `blocks` + `dependents` tiebreak | `entrypoint/backlog` |
| C3 Attestation | `attest`/`recheck` verbs; `attestation` node; project-root-correct verification; always-on tool-owned citation roots | `entrypoint/backlog` (+ `write/citation-path.ts`) |
| C4 Obligation | `obligate`/`unobligate`; closed predicate core | `entrypoint/backlog` |
| C5 Closure gate | terminal transitions gated inside the existing `BEGIN IMMEDIATE` tx; `satisfies` edges; recorded override | `entrypoint/backlog` |
| C6 Verdict | derived rung-1–5 ladder; `claim` refuses live blockers; node `revision` counter | `entrypoint/backlog` |
| C7 Envelopes | `has_more`, `_score_kind`, bounded `get`/`part-of-rollup`, a derived `report` verb | `entrypoint/backlog` (+ `@adhd/sox-hybrid-search` read path) |
| C8 Vocabulary | generated kinds/catalogs views; self-describing surface; `EPIC` retirement; CLI help split | `entrypoint/backlog` + `apigen-plugin-cli-output` |
| C9 Similarity | cross-project **similar**-candidate scan + reviewed `similar_to` link via the existing `relate` verb; `duplicate_of` reserved for actual-same; issue-level canonical/redirect for the reserved path | `entrypoint/backlog` |
| D-A Service trust | starting/live/ready, watchdog, config precedence + hard-error, load-time drift check, retry+jitter+breaker, MCP era | host config + both servers (cross-plane) |
| D-B Artifact lifecycle | unique-temp atomic publish, ownership index, drift verdict, bounded retention, authoring gate, git owner | **sox-ecosystem** + `claude-agents` (design-only) |
| D-C Knowledge layer | claim/outcome split, tiered verdict, open facets, coverage-aware abstention | **sox-ecosystem** memory-core + researcher (design-only) |

### 3.3 Substrate plane — `sox-ecosystem` (the previously-missing half)

**The substrate needs are now documented as requirements, not decision requests** — see `substrate-fleet/SOX-REQUIREMENTS.md` (**SR-1…SR-16**), written as an interface contract and **assumed achievable**. What follows is the summary; that file is authoritative.

**S-1. Eight memory-core capabilities.** `171c856d` requests, from **owned source** (`libs/memory-core` — its own body corrects its title: these are *not* external-owner requests): per-channel recall scores; a first-class `REFUTES` relation; metadata predicate filters; `memory_claim_upsert`; `memory_count`; supersession exclusion; an observable `recluster`; a documented per-node CAS. **These are the prerequisite for D-C**, and `filter.semantic`'s misreporting (C7) and the outcome-gated verdict (D-C) both depend on per-channel scores and a real `count`. **[sox-reported]**

**S-2. `memory_write_batch` silent field loss.** Returns success while dropping `topic`/`tags`/`importance`/`summary`; the handler maps fields at `index.ts:2183-2198` then delegates downstream **[sox-reported]**. In scope as **D-A**; the fix is verify-after-write on the *substrate* write path — the same "success must imply persistence" rule, applied in the other repo.

**S-3. Ownership / install model.** Already decided in-house and *should not be reinvented*:
- **sox ADR-0003** — identity = `id + checksum`; `--frozen-lockfile` **fails on drift**; the checksum is the sole integrity authority **[sox-reported]**.
- **sox ADR-0004** — ownership index `ownership.json` keyed by `(extId, scope)`, with `[inv:reversible-injection]` **[sox-reported]** — this *is* the converged ownership primitive D-B needs.
- **sox ADR-0014** — retention, **PROPOSED/design-only**, with a measured ~1.4 GB of unpruned snapshots **[sox-reported]** — this is D-B's bounded-retention half, already scoped.
- The live defect: a **fixed** `.tmp` publish is the race at **two** sites — `writeOwnershipAtomic` (`ownership.ts`) **and** `writeLockfileAtomic` (`install.ts`); `readOwnership()` returns `{version:1, owned:[]}` on parse error — the silent-drop path **[sox-reported]**. (Cited by symbol: a bare line number rots on every edit.)
**D-B is therefore mostly a sox-side implementation of decisions sox has already accepted**, plus the unique-temp fix.

**S-4. Store substrate decision — replayable history.** The sox `state` tool has an authoritative NDJSON event log with `reconstruct --verify` and repair; the backlog treats the graph as truth with non-authoritative audit **[sox-reported]**. Adding replayable/drift-verifiable history to the backlog store is a **substrate decision** (an ADR in sox), not a work-item primitive. Raised, not assumed.

**S-5. Cross-store identity.** Duplicate *project* rows and any split live in the **sox store**; C1 builds the verbs but the data reconciliation is a **sox-side decision request** (adhd ADR-0002).

### 3.4 Host / fleet plane — `claude-agents`
The `state` tool's routing/claim system (per-role queues, heartbeat TTL 300 s, PID-probe reclamation, `rework_count`, `pending_review[]`) **[sox-reported]**. Verified verdict: exactly **one** capability is in scope and already answered by C6 — *claim refuses a live blocker, loudly*. Liveness reclamation, review routing, rework accounting, and schedulable queues are **refused** as dispatch methodology. The comparison doc describing them is **stale** (`SL2-01` now false: `claim.ts:397-423` throws `ClaimHeldError`; four cited anchors absent; `DEPENDS_ON` misnamed for the shipped `blocks`). Recorded on `ff9ed626`.

## 4. Interface delta (work-item plane, condensed)

**+7 verbs** (`attest`, `recheck`, `obligate`, `unobligate`, `merge-project`, `rm-project`, `report`) → 24–25 mounted. **+2 node kinds** (`attestation`, `obligation`), **+3 internal edges** (`attests`, `has_obligation`, `satisfies`) — not mounted on `relate`. The public `relate` enum is extended by exactly one reviewed relation, **`similar_to`** (C9); `duplicate_of` stays **reserved** for the reviewed actual-same judgement and is not repurposed. **+2 views** (`kinds`, `catalogs`; `get {registry:"kind"}` cannot be widened — apigen picks branches structurally). **+5 card fields** (`blocksOut`, `dependents`, `partOf`, `obligations`, `verdict`), **+`_score_kind`**, **+`has_more`**, **+`ambiguous_reference`**.
**Breaking (5):** `claim` refuses blockers · terminal `transition` can refuse · `order` includes non-issue kinds · `related` returns more rows · `get` can throw `ambiguous_reference`.
**Prerequisite:** `RECOGNIZED_NODE_KINDS` + `catalog.ts` + `errors.ts` are frozen by `write/CONTRACT.md` → **one foundation-owner request** across C3/C4/C5.

## 5. Coverage (read from the store)

Umbrella `ee299cd5`: **75 total / 73 open / 2 closed**. Split: **52 covered members**, **8 plan nodes**, **12 core tickets**, **1 uncovered work item** (`8db42169`, the handoff itself — answered by this delivery, pending owner review). Arithmetic sums exactly. Pass 1 = 8 tickets for 34 items; pass 2 = 4 tickets for 16 items + C9 (owner-requested).

## 6. Refused (and why)

- **File-level atomicity for backlog data** — the store is already atomic (ADR-0001/0012). The dynamics apply to the install/deploy layer only (§3.3 S-3).
- **Absorbing the fleet layer** — liveness reclamation, review routing, rework accounting, schedulable queues, process supervision, durable assignment.
- **Auto-merging / auto-linking similar items**; **CEL in v1**; **a stored ready/done status**; **configurable workflow engines**; **markdown regeneration**; **a new kind per process stage**.

## 7. Honest weaknesses

1. **Default-allow.** An item with no obligation and no blocker is `actionable:true` — the notebook-as-queue failure persists *by default*. The fix is social (consumer specs declare obligations), not structural.
2. **Derive-on-read cost is unmeasured** at page scale; AC5 requires a measured p95 but no measurement exists yet.
3. **The sox half is specified, not built.** `SOX-REQUIREMENTS.md` documents every substrate need as a requirement assumed achievable (SR-1…SR-16); D-B/D-C depend on substrate work that has not started (and `REFUTES` is blocked on the sox `ADR-0010 D3` offline migration); C9 now has a spec (`specs/C9-similarity.spec.md`).
4. **Two contradictions among source tickets were resolved by reading code, and one resolution (order works over issues; the defect is kind-scope) is mine, not the tickets'.**
5. **The estate is three repos, not two** — `claude-agents` holds the `state` tool and the extensions; the "sox-ecosystem & backlog" framing understates it.
