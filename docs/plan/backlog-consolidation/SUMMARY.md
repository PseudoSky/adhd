# Backlog Consolidation — Summary of the Spec Set

**One document, owner-facing.** It states what will change, what problems the specs solve, what the final interface and workflows look like, and how every one of today's requests is discharged. Sources: `SPEC-SET.md` (S01–S12), `spec-set-mapping.json`, `spec-coverage-proof.md`, `partial-disposition.md`, `reconciliation-plan.md`, `research-incorporation-plan.md`, the two research files, and the **single target-interface record** `backlog-interface-target.md` (**ADR-0007, ACCEPTED 2026-10-05**) with `CLI-HIERARCHY.md` (its verb-tree companion) / ADR-0006 for the current-vs-target interface. Every claim below traces to a spec AC or a named artifact (see `## Citations`).

**Committed:** the spec set is committed at `3aafd544`. **ADRs 0006/0007 were owner-approved 2026-10-05** (ADR-0006 ACCEPTED; ADR-0007 ACCEPTED and supersedes ADR-0006 in part), and the 41 non-mandated proposed ACs are folded into `SPEC-SET.md` (commit pending). It changes no shipped behavior; no spec is implemented yet.

## What changes

Twelve specs (S01–S12). Ten absorb the 49 reconciled clusters (47 absorbed, 2 deferred); S11 and S12 are owner-mandated additions, not cluster-derived.

- **S01 — Freeze & extend the node/edge vocabulary (FOUNDATION).** Admit node kinds `attestation`/`obligation` (13→15) and internal edges `attests`/`has_obligation`/`satisfies`, absent from the public `relate` enum. **additive-safe-now**; executor backend. (`SPEC-SET.md` S01 AC1–2)
- **S02 — Canonical identity, merge/redirect & duplicate linking.** One canonical node per thing; ambiguous uid → candidate set; merge writes a `Redirect` + soft-retire; cross-project dedupe never auto-links; citation verifies EXISTS not project-root membership; project-identity de-dup; SUPERSEDED reason enum + backfill; n:m issue↔component↔project joins. **breaking** (owner sign-off); backend. (`SPEC-SET.md` S02 AC1–13, C1–C4, T1–T3, S2, H45)
- **S03 — Make reads complete and honest.** Every view returns completeness meta; `direction:"desc"` works; `view:order` scopes to every member kind; the default card renders project/component sets; a read-only `collisions` view surfaces semantic clusters ∪ write-scope overlaps ∪ cycles. **additive** (wide `related` = breaking); typescript. (`SPEC-SET.md` S03 AC1–5, S4; `research-incorporation-plan.md` R1c)
- **S04 — Anchored attestation & work-product citizenship.** `attest {subject,claim,anchor}` with `verified|stale|unverified|unknown`; `SPEC` items are store citizens; fragment read path (B1); citations-as-assertions (url:/registry:/query:, never silently dropped). **additive-safe-now** (after S01); backend. (`SPEC-SET.md` S04 AC1–5, S3)
- **S05 — Obligations, derived verdict & the closure gate.** `obligate` with a closed predicate core; a terminal transition with an unsatisfied `block` obligation is refused with typed `{code, required_kind}`; `claim` fails loudly on a block condition; `verdict` derived on read; every gate has a negative control. **breaking** (gate, sign-off); backend + qa. (`SPEC-SET.md` S05 AC1–4)
- **S06 — Closed, readable vocabulary & configuration surface.** Machine-readable `kind` registry; docs regenerated from the catalog with a drift check; vocabulary cleanup; env→store resolution; correct the 1:1 container docs. **additive** (closing the catalog + vocab migration = breaking); doc-steward + backend. (`SPEC-SET.md` S06 AC1–5, S6)
- **S07 — Make writes atomic and durable.** Exactly-one-claim under concurrency; interrupted write leaves no split WAL/sidecar; idempotent FTS rebuild; no false-success; rollup counts non-terminal children; orphaned-parent signal; recoverable `part_of` direction. **additive-safe-now**; backend. (`SPEC-SET.md` S07 AC1–7, R1–R3)
- **S08 — Guarantee shipped artifacts match source.** Release-manifest backstop; default `verify-dist-load`; pinned toolchain; apigen contract/runmode/tracing gates. **additive-safe-now**; devops + typescript. (`SPEC-SET.md` S08 AC1–4)
- **S09 — Durable runtime lifecycle & truthful telemetry.** Persisted health record; recall stable across reopen; telemetry never reports success for a failure; idempotent start/stop. **additive-safe-now**; backend. (`SPEC-SET.md` S09 AC1–4)
- **S10 — Make process and tooling self-enforcing.** Dispatch grants declared; agent-spec section validation; worktree provisioning before dep-checks; repo-hygiene gate; dead-code lint. **additive-safe-now**; devops + doc-steward. (`SPEC-SET.md` S10 AC1–4)
- **S11 — Session & reservation timeline.** Persist claim/renew/release intervals; a store-wide `reservations` read; a first-class session record; an append-only op-event log; `timeline <session>` with child rollup. **additive**; backend. (`SPEC-SET.md` S11 R1–R4, S1–S4)
- **S12 — Expected-state revision.** On a terminal transition in a plan subtree, mint an immutable content-addressed state-revision node pinned by a mutable pointer + `sha256` token; payload is the canonical expected-state ledger; same-tx, non-blocking, CAS; fragment read path; verdict stays derived. **additive**; backend. (`SPEC-SET.md` S12 E1–E5)

## Problems these specs solve

The eight root problems (reconciliation-plan §9.1), the specs that address each, and the one-item-fixes-several map.

- **P-1 — The record has no identity lifecycle.** The same thing exists as several rows; visible ids cannot resolve. → **S02** (`SPEC-SET.md` S02 AC1–4). Covered (`spec-coverage-proof.md` §3d).
- **P-2 — Reads are silently lossy.** Relations omitted, FTS shadows a structured branch, sort direction ignored, windows capped with no complete-vs-truncated signal. → **S03** (AC1–4), **S11** (a session cannot answer what it holds), **S12** (expected state re-derived, never stored). (`SPEC-SET.md` S03/S11/S12)
- **P-3 — Evidence is proxy-shaped.** Citations, gates, demos and tests go green while broken; closure has no verified-evidence gate. → **S01** (substrate) + **S04** (anchored evidence) + **S05** (closure gate, derived verdict). (`SPEC-SET.md` S01/S04/S05)
- **P-4 — Vocabulary is unstructured and undocumented.** Unknown kinds mint silently; hand-copied prose drifts; the catalog is not machine-readable. → **S06** (AC1–3). The config half is only PARTIAL — the one P not fully covered (`spec-coverage-proof.md` §3d).
- **P-5 — Writes are not as atomic/durable as documented.** claim+lease, concurrent writes, lock/WAL/sidecar lifecycle, false success. → **S07** (AC1–4). (`SPEC-SET.md` S07)
- **P-6 — Shipped artifacts diverge from source.** Install/build/release/publish report success delivering stale or broken output. → **S08** (AC1–4). (`SPEC-SET.md` S08)
- **P-7 — Runtime services are unreliable.** Embedding/RAG has no durable lifecycle; telemetry is false; no persisted health record. → **S09** (AC1–4). (`SPEC-SET.md` S09)
- **P-8 — Process/tooling is not self-enforcing.** Dispatch grants, agent specs, worktree provisioning, repo hygiene, CI are un-gated. → **S10** (AC1–4). (`SPEC-SET.md` S10)

**One item fixes several:** `C1` (`73d0b9c6`) fixes clusters **8/9/28/40 + B3**; `C8` (`4a12472e`) fixes **11/20/35**; `C3` (`38631ad4`) fixes **13 + B2**; `C10` (`b009396b`) fixes **B1**; `C9` (`cf97c613`) fixes **17**; `C7` (`395cfcad`) fixes **39/22**. (`reconciliation-plan.md` §8.5; `backlog-interface-target.md` design-corpus mapping)

## Final interfaces

**Current (frozen by ADR-0006, PROPOSED):** 29 verbs + the `batch action` mount; one `--input '<json>'` per verb; a two-arm `{ok:true,data}` / `{ok:false,error}` envelope; **10 error codes** (including `ambiguous_reference`); the `by = "${agentName}:${instanceId}"` rule; a **CLOSED** six-member `rel` union `{relates_to, supersedes, blocks, duplicate_of, part_of, similar_to}`; three naming schemes (kebab CLI, snake_case MCP, scoped `@adhd/backlog`). (`docs/decisions/0006-backlog-public-interface-freeze.md` D1–D5)

**Target deltas (from `backlog-interface-target.md` — ADR-0007, ACCEPTED 2026-10-05).** Additive deltas — permitted under ADR-0006 D6 with no sign-off — are: the new `link-duplicate` verb; first-class `anchor`/predicate inputs on the shipped `attest`/`obligate`; the B1/B2/B3 reader+merge paths; `get {registry:"kind"}`; `Verdict`/`Condition` derived read types; completeness meta + `score_kind` on every view; internal node/edge kinds `attestation`/`obligation`/`SPEC` + `attests`/`has_obligation`/`satisfies`/`has_state_revision`; the joined-entity model; `collisions` view. (`backlog-interface-target.md` D1–D6, classification)

The **eight breaking items**, owner-approved 2026-10-05 and recorded in the single canonical breaking list of `docs/decisions/0007-backlog-target-public-interface.md` (**ADR-0007**, which supersedes ADR-0006 **in part**), each shipping under ADR-0007 and none yet implemented:

1. **New public `rel` member `consolidated_into`** — opens the closed union. *Recommended: do not add; reuse `duplicate_of` n:1.*
2. **Widening `related` to every live relation** (D4e) — behavior-visible response-shape change resolving contradiction C1 (`6fb30481` vs `77310a60`). The narrow variant (enumerated three authoritative + delete the stale comment) needs no sign-off.
3. **Closing the `kind` catalog** (D5b) — unknown kinds currently mint; a validating registry rejects.
4. **Vocabulary migration** (D5c) — retire `kind:EPIC`, reconcile `bug`/`BUG`, remove `undefined`/`MEDIUM`.
5. **`claim` block-severity precondition** (D6f) — changes an existing verb's success semantics.
6. **Terminal-transition closure gate** (D6e) — changes `transition`/terminal success semantics.
7. **Canonical identity resolution** (D3a) — changes uid-prefix/merge behavior across every uid-taking verb.
8. **Citation existence-vs-membership gate** (D6c) — `create` stops refusing an **existing** out-of-root locator (`050ea18f`/S02.C1); behavior-visible on an existing verb.

## Final workflows

- **Create/update collision surfacing (point-of-write).** At `create`, the existing scan fuses BM25/FTS with cosine by RRF (ranking only; raw cosine stays the gate threshold ≈ `0.8`) and supplies the previously-unpopulated `sharedStructuralSignal`; same-project cosine ≥ threshold suppresses by default, cross-project surfaces only. At `update`, a body-touching edit runs the same scan before the transaction (outside it), advisory — a `warnings[]` candidate on a still-`ok:true` envelope; citation-only edits are never scanned. A read-only `collisions` view unions semantic clusters ∪ write-scope overlaps ∪ blocks-cycles and never blocks. (`research-incorporation-plan.md` R1a/R1b/R1c; `collision-detection-strategy.md` SITE 1/2/3)
- **Identity resolution.** An ambiguous uid prefix returns the **candidate set** (`ambiguous_reference` carrying candidates), never a silent first match. A merge writes one `Redirect` row and soft-retires the source; the source uid still resolves to the chain head — no hard delete. Every uid-taking verb resolves through the SUPERSEDES/Redirect chain. (`SPEC-SET.md` S02 AC1/AC2/AC4)
- **Reservation / timeline.** Every `claim`/`renew`/`release` appends a durable interval; `query --input '{"view":"reservations",...}'` returns per active claim `{path, item uid, holder, session id, claimedAt, leaseExpiry}`, store-wide and filterable; a session node `{id, agent, started_at, ended_at, parent_session_id}` is first-class; every mutating verb appends an op event; `timeline <session>` returns ordered ops with descendant rollup; a lapsed lease is not active. (`SPEC-SET.md` S11 R1–R4, S1–S4)
- **Terminal transition closure gate.** A terminal transition with an unsatisfied `block` obligation is refused with typed `{code, required_kind}`; a commit ref alone does not satisfy `published-artifact`; `claim` refuses on a `block` condition and the `Verdict` is derived on read, never stored. (`SPEC-SET.md` S05 AC2/AC3)
- **State-revision mint on terminal transition.** A terminal transition inside a plan subtree mints an immutable, content-addressed state-revision node in the **same transaction** as the audit/transition node, advanced in place via a mutable pointer + `sha256` token; the hook is mint-or-skip (a completion is never refused); two concurrent completions of one logical fold yield one token (CAS, no lock); the payload is read back via the B1 fragment path; a non-matching token returns `stale`, never a silent `fresh`; no verdict is stored. (`SPEC-SET.md` S12 E1–E5; `completed-state-representation.md` §3)

## How every request from today is solved

| Req | Owner's ask (short) | Spec + AC ids | How it is discharged | Status |
|---|---|---|---|---|
| **R-1** | Six mandated items (`050ea18f, 46cf1086, 91a8c640, e54bd58b, 7ef53d55, 7a78312c`) must NOT be merged/hidden/deferred/folded | `050ea18f`→S02.C1–C4; `46cf1086`→S11.R1–R4; `91a8c640`→S11.S1–S4; `e54bd58b`→S02.S2 / S03.S4 / S04.S3 / S06.S6 / S02.H45; `7ef53d55`→S02.T1–T3; `7a78312c`→S07.R1–R3 | Each of the six survives verbatim as an item and is discharged by its own binary ACs (23 ACs total); none is folded/deferred. (`partial-disposition.md` §9; `spec-set-mapping.json` `specsAddedByOwnerOrder`/`ownerSetIncorporations`) | done |
| **R-2** | Compress all 49 clusters into ≤10 actual specs | S01–S10 | 47 clusters absorbed into 10 specs, 2 deferred; 10 cluster-derived + S11/S12 owner-set = **12 specs**. 49→12 map in `SPEC-SET.md` index + `spec-set-mapping.json`. | done (12, not 10 — 10 cluster-derived + 2 owner-mandated) |
| **R-3** | Researcher strategy for collisions at create/update time + resolution | R1a→S02; R1b→S02; R1c→S03; R1d→S02/S03; R1e→S02 (breaking, gated); R1f→no spec | `research-incorporation-plan.md` §1 maps every finding to a spec with a binary AC + red→green test; R1f (contradictory-acceptance-criteria heuristic) is explicitly flagged a process gap, never code. | done for detection; R1e pending owner sign-off; R1f flagged gap |
| **R-4** | Convert completion into one representation of expected state / compressed point in time | **S12** E1–E5 (R2a–R2e) | State-revision node + pointer + `sha256` token + expected-state ledger + coverage proof; same-tx, non-blocking, CAS mint on terminal transition; B1 fragment read path. (`completed-state-representation.md` §3; `SPEC-SET.md` S12) | done |
| **R-5** | The ADR on backlog interface shouldn't be an ADR | `docs/decisions/0007-backlog-target-public-interface.md` | Authored as the target record; the owner approved it 2026-10-05 and it now lives in `docs/decisions/` as **ADR-0007 (ACCEPTED 2026-10-05)**, superseding ADR-0006 **in part**. ADR-0006 remains the current-state freeze (now ACCEPTED). (`docs/decisions/0007-backlog-target-public-interface.md`; `docs/decisions/0006-backlog-public-interface-freeze.md`) | done |
| **R-6** | Prove the 10 specs fully solve all problems, especially the 4–5 large items filed today | `spec-coverage-proof.md` §1/§2; the 23 ACs | Adversarial proof: 47 COVERED / 41 PARTIAL / 7 NOT-COVERED over 95 units; **0/6 mandated fully covered before S11/S12 + the owner ACs**. S11/S12 + the 23 owner ACs are what close the mandated gap. | done (honest result: gap was real, then closed) |
| **R-7** | For partial items, decide delete or incorporate | `partial-disposition.md` §1–§10 | **incorporated — commit pending** — the disposition is 43 INCORPORATE / 0 DELETE / 0 KEEP-standalone; the six owner-set ACs + S11/S12 were committed at `3aafd544`, and the **41 non-mandated proposed ACs are now folded into `SPEC-SET.md`** as binary AC lines (cluster 15 `config-environment`'s config half → S06 AC10). |
| **R-8** | "On my set, an architect needs to solve those" / incorporate what I asked for | S11/S12 added; owner ACs in S02/S03/S04/S06/S07 | The incorporation is committed at `3aafd544`; the six owner-set items are discharged by the 23 ACs. | done (committed `3aafd544`) |
| **R-9** | Process constraints: >10-dispatch pause+ask; ≤4-dispatch fan-outs; only backlog-operator writes the graph; 3-layer verification | **S10** AC1–4; `research-incorporation-plan.md` §4 | S10 makes dispatch grants, agent-spec sections, worktree provisioning and repo hygiene self-enforcing; the incorporation plan's budget honors ≤4/cap and names the >10 pause; graph writes stay with backlog-operator. | done for the spec; enforcement pending execution |
| **R-10** | "How much content would an agent need to read…" orientation cost | `ORIENTATION.md` (`reconciliation-plan.md` §3.1); **S10** AC2 | A single ≤12 KB entrypoint (`tmp/backlog-consolidation/ORIENTATION.md`, exists) replaces the ~3.5 MB corpus read; S10 AC2 requires agent-spec sections be present/validated. | done (artifact exists); S10 enforcement pending |

## What is not yet done

- **Phase 6 EXECUTE/CLOSE has not started.** The spec set is a target; no spec here has been implemented. (`reconciliation-plan.md` header)
- **Owner actions resolved (2026-10-05):** ADR-0006 ACCEPTED; the **eight breaking target deltas** owner-approved and recorded in ADR-0007's canonical breaking list (S02 canonical identity, S05 closure gate + `claim` precondition, S03 wide-`related`, S06 kind-catalog close + vocab migration, and the `duplicate_of` reuse for B3). Implementation of every delta is still pending — no code has shipped. (`docs/decisions/0007-backlog-target-public-interface.md` §Breaking list)
- **Two former deferred clusters resolved:** `adr-0005-policy` (AMB-1 → REMODELED-BY C4 `1c53784d` + `e54bd58b`) and `project-config-surface` (AMB-3 → REMODELED-BY C4 `1c53784d`, config half → S06 AC10). All of U1–U6 and AMB-1..5 are RESOLVED (owner-approved 2026-10-05). (`docs/plan/backlog-consolidation/UNRESOLVED.md`; `reconciliation-plan.md` §8.3/§8.6)
- **Three filed-not-scheduled defects:** `77310a60` (stale `card.ts:8` comment), `73d3b97d` (ADR-0006 defect: invented `update` status / "nine" codes), `9a95be96` (`direction:"desc"` ignored) — filed, not scheduled. (`reconciliation-plan.md` §1d)
- **Detection half is shippable pre-approval; merge half is gated.** R1a/R1b/R1c/R1d can land once scheduled; R1e (issue-level merge) cannot ship first. (`research-incorporation-plan.md` §4)

## Citations

- `docs/plan/backlog-consolidation/SPEC-SET.md` — S01–S12, cluster absorption, ACs, gating, executor.
- `docs/plan/backlog-consolidation/spec-set-mapping.json` — 49→12 mapping, `specsAddedByOwnerOrder`, `ownerSetIncorporations`.
- `docs/decisions/0007-backlog-target-public-interface.md` — ADR-0007 (ACCEPTED 2026-10-05): target interface deltas + the 8-item breaking list; supersedes ADR-0006 in part.
- `docs/decisions/0006-backlog-public-interface-freeze.md` — current frozen 29 verbs, 10 codes, closed `rel` union.
- `tmp/backlog-consolidation/spec-coverage-proof.md` — 47/41/7 coverage + owner-mandate verdicts.
- `tmp/backlog-consolidation/partial-disposition.md` — 43 INCORPORATE / 0 DELETE (incorporated — commit pending); §9 owner-mandated 23 ACs; §10 per-unit incorporation status.
- `tmp/backlog-consolidation/reconciliation-plan.md` — §9 problems P-1..P-8, §8 remodel map, §3.1 ORIENTATION entrypoint, §1d defects.
- `tmp/backlog-consolidation/research-incorporation-plan.md` — R1a–R1f collision and R2a–R2e state-revision → spec/AC mapping.
- `tmp/backlog-consolidation/research/collision-detection-strategy.md` — SITE 1/2/3 collision detection + resolution ladder.
- `tmp/backlog-consolidation/research/completed-state-representation.md` — state-revision design.
- `tmp/backlog-consolidation/ORIENTATION.md` — the orientation entrypoint.
