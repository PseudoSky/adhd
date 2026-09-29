# SOX REQUIREMENTS — what the substrate must provide

> **Contract status.** This is a **requirements document**, not a negotiation. The work-item plane (adhd `entrypoint/backlog`) is the **consumer**; the substrate plane (`sox-ecosystem` — `libs/memory-core`, the `@adhd/sox-*` store packages, the install/ownership layer, the sox ADR catalog) is the **provider**. Everything below is written as a requirement with an interface and acceptance criteria, on the assumption that **it is all achievable**. Where a current state is known it is recorded, not used as a gate.
>
> **Why this exists.** The first draft of this proposal expressed the substrate needs as "decision requests" whose status could not be confirmed on one machine. That framing was wrong: an unmet substrate requirement is still a requirement. Each item below states *what the work-item plane cannot do without it*, so the sox side can build to it directly.

## 0. The contract

| | Work-item plane (adhd/backlog) | Substrate plane (sox-ecosystem) |
|---|---|---|
| Owns | issues, plans, citations, relations, verbs, views, the MCP/CLI surface | the graph store, memory-core, the hybrid-search backend, install/ownership, the ADR catalog |
| Provides | the contract primitives (`reference`, `attestation`, `obligation`, `verdict`) | the storage, resolution, verification and lifecycle machinery those primitives stand on |
| Never | reaches into the store's internals; duplicates store logic (adhd ADR-0002) | encodes a work-item methodology; defines what "ready" or "done" means |

**Direction of dependency:** the work-item plane consumes; the substrate provides. A requirement here is satisfied by an interface the substrate exposes, never by the work-item plane working around its absence.

---

## SR-1 · Registry must accept the new node kinds and edges

**Need.** Four of the contract primitives cannot exist without somewhere to store them. Attestations and obligations are **new graph node kinds**, not fields on an issue; the three edges that connect them are internal relations the public `relate` verb must not expose.

**Required interface.**
- `RECOGNIZED_NODE_KINDS` accepts `attestation` and `obligation`, with a migration for stores written before them.
- The edge registry accepts `attests` (issue→attestation, 1:n), `has_obligation` (issue→obligation, 1:n), `satisfies` (obligation→attestation, n:m).
- The public relation enum (`relates_to | supersedes | blocks | duplicate_of | part_of | similar_to`) is **not** extended by the three internal edges — `attests`/`has_obligation`/`satisfies` are written through the internal edge-write path only. (`similar_to` is the one deliberate **public** addition; it is written through the existing `relate` verb by C9, not through an internal path.) `duplicate_of` is **reserved** for the reviewed judgement that two items are actually the same — C9 does not repurpose it.
- The vocabulary guard refuses a store containing an unknown kind rather than silently coining one.

**Acceptance.** A store containing an `attestation` node passes `store-check`; a store containing an unrecognised kind fails it by name; `relate` rejects `attests` as an invalid relation.

**Consumed by** C3 (`38631ad4`), C4 (`1c53784d`), C5 (`b076742d`). **Current state:** the registries are frozen behind `write/CONTRACT.md`.

---

## SR-2 · A monotonic `revision` on every node

**Need.** The verdict must be able to say "the answer you are reading is computed from a revision that is no longer current". Without a monotonic counter there is no way to detect staleness, and body edits currently churn identity instead of bumping a revision.

**Required interface.** Every mutating write to a node increments `node.meta.revision`. The value is readable on any card and on any derived read. A read that computed against revision *n* is detectably stale when the node is at *n+1*.

**Acceptance.** Two edits to one item advance `revision` by exactly two; a verdict stamped at *n* is reported stale after a write that raises the node to *n+1*; closing a child changes a parent's derived rollup **with no write to the parent**.

**Consumed by** C6 (`291263ea`), C3 (`38631ad4`).

---

## SR-3 · Predicate filters, counts, and supersession exclusion on the read path

**Need.** The verdict ladder and the coverage query both need to ask the store questions it currently cannot answer: "give me nodes matching a metadata predicate", "how many match", and "exclude superseded rows" — as store-side operations, not client-side joins.

**Required interface.**
- Metadata predicate filters (match on `meta.*` values, not just ids/kinds).
- A count operation that returns a **match count distinct from the corpus count**, with an exactness relation (`eq` for exact, `gte` when capped).
- Supersession exclusion as a first-class filter, applied before limits.

**Acceptance.** A count scoped to a plan equals an independent recomputation; a count that is capped reports `gte` rather than pretending to be exact; a superseded node never appears in a filtered read.

**Consumed by** C7 (`395cfcad`), C6, and the coverage query (`ca1096f8`). **Current state:** `filter.semantic`'s total is documented as the whole corpus — a defect (`bbeb0f57`).

---

## SR-4 · Per-channel retrieval scores, with provenance

**Need.** Every semantic read must be able to say **which** scoring regime produced a number. Today a rank-fused score is exposed without provenance and is easily read as a similarity — the precise failure the read-envelope invariant exists to prevent.

**Required interface.** The hybrid-search backend returns, per result, the contributing channel scores (text/BM25 and vector) **separately**, plus the fused value and the fusion method. A consumer can label `_score_kind` from the response without inferring it.

**Acceptance.** A fused result exposes both channel contributions and the method; the aggregate reports the method's range so a caller cannot mistake a rank-derived value for a similarity; a backend that returns only a fused scalar fails the contract.

**Consumed by** C7 (`395cfcad`), and the knowledge layer's coverage-aware retrieval.

---

## SR-5 · A first-class `REFUTES` relation

**Need.** A mechanically-verified anchor can prove a claim present, matching, stale or absent — it cannot prove a claim *contradicted*. That judgement needs its own relation so a refutation is recorded, attributed and reversible rather than expressed as an unverifiable prose verdict.

**Required interface.** `REFUTES` is a linkable relation between an attestation (or obligation) and a node, carrying the checker's identity and a reason. Recording a refutation never deletes the refuted claim.

**Dependency (state it where it is used).** `REFUTES` is **blocked on the sox `ADR-0010 D3` operator-invoked offline migration** before it is writable on an existing store: the live store's schema CHECK rejects a new rel until that migration runs. Fresh stores get it from new DDL. Until then the knowledge layer must report `unknown` rather than a wrong verdict — this is the one requirement here that has a **non-terminal upstream dependency**, not merely build work.

**Acceptance.** A refutation is queryable as an edge; the refuted node still exists; the refutation names its checker.

**Consumed by** C3/C4; the knowledge layer's tiered verdict.

---

## SR-6 · A documented per-node compare-and-swap

**Need.** The gate is a read-modify-write. Under the parallel-process invariant it must be provably correct without depending on an advisory lock. That requires a documented atomic primitive at the node level.

**Required interface.** A node-level CAS comparing on `revision`, returning success or the current revision on failure, with its atomicity guarantee stated in the store's own docs (not inferred by consumers).

**Acceptance.** Two concurrent CAS attempts on one node yield exactly one success; the loser observes the winner's revision; no intermediate state is readable.

**Consumed by** C5 (`b076742d`), C6.

---

## SR-7 · `memory_claim_upsert` and a memory-side claim

**Need.** The knowledge layer must be able to claim a node for processing and update it in one atomic operation; today it cannot, so concurrent knowledge writers race.

**Required interface.** A claim-upsert operation: claim a node for a caller, or update it if already held by that caller, atomically.

**Acceptance.** Two callers racing for one node → one claim; the same caller re-claiming is idempotent; a distinct caller is refused with a typed conflict.

**Consumed by** D-C (`c35319fa`).

---

## SR-8 · Verify-after-write on every batch path

**Need.** A batch write currently returns success while silently dropping structured fields. A success envelope that does not imply persistence is the single most damaging class of defect in this estate — it is the same failure as closing on a commit ref, one layer down.

**Required interface.** Every batch write reads back each supplied structured field before returning success. If any field is absent, the call **fails** and names the field; it never returns success with a partial record.

**Acceptance.** A batch write with `topic`/`tags`/`importance`/`summary` round-trips every field on a fresh process; an injected drop produces a failure, not a success; the negative-control test — the current silent-drop path — goes red.

**Consumed by** D-A (`4503046c`), D-C. **Provider-only, not satisfiable from adhd:** the write path is `libs/memory-core`'s `memory_write_batch`; D-A's adhd-side AC that names it **cannot close that AC** — it is a cross-repo provider requirement (adhd ADR-0002 D4), and the adhd-side test can only run where `libs/memory-core` is present. **Current state:** the drop is a filed defect (`8dff910a`).

---

## SR-9 · Observable `recluster`

**Need.** The knowledge layer must know when a reorganisation has completed, not merely that it was enqueued. A fire-and-forget job that reports "enqueued" is a claim without a check.

**Required interface.** A recluster exposes a job handle with an observable terminal state and a result, or runs inline within a bounded budget. "Enqueued" is never the final answer.

**Acceptance.** A recluster reports completion with the resulting partition; a caller can poll or await it; a failed pass is distinguishable from a pending one.

**Consumed by** D-C (`c35319fa`).

---

## SR-10 · Atomic, parallel-safe ownership publish

**Need.** Install writes a shared ownership index. A fixed temp path means two concurrent installs corrupt it, and the read path then silently returns an empty index — losing every owned record while reporting success.

**Required interface.**
- Publish through a **unique** per-process temp name (`O_EXCL`) on the same filesystem, then a single `rename`.
- Correctness comes from the rename, **never** from an advisory lock; a lock may bound duplicate work only.
- The ownership entry is written **after** the effect succeeds, never before.
- A parse failure is a **loud, typed error**, never an empty index.

**Acceptance.** Two concurrent installs → both records present and the file parses; an uncooperative concurrent writer cannot corrupt the result; an injected crash between effect and marker leaves the artifact untracked-and-repairable, never tracked-and-absent; a malformed index raises rather than returning `{owned: []}`.

**Consumed by** D-B (`48d7dcea`). **Current state:** the fixed temp path is a filed defect (`5a39db0e`) at **two** sites, not one — `writeOwnershipAtomic` (`ownership.ts`) **and** `writeLockfileAtomic` (`install.ts`).

---

## SR-11 · A drift gate with an explicit verdict

**Need.** Nothing today detects a deployed copy that has diverged from its source, a declared target that is missing, or a foreign file at a managed path. Silent drift is how a fix ships and never runs.

**Required interface.** A **read-only** detect pass that resolves each owned artifact's locator and recomputes its **content hash**, emitting one of `still-valid | drifted | gone | foreign`, scoped by ownership. Remediation is a **separate** deliberate act. Content hashes only — never mtime or size.

**Acceptance.** A same-size, same-mtime edited file is reported `drifted`; a missing declared target is `gone`; an untracked file at a managed path is `foreign`; the detect pass mutates nothing.

**Consumed by** D-B, and the fleet's host-copy problem (`7a4a0813`).

---

## SR-12 · Bounded retention with a roots model

**Need.** Scratch, snapshots and deployed generations accumulate without limit because nothing models what is still referenced. The alternative — an unbounded pile — is not neutral; it is a slow failure.

**Required interface.** A roots model (live generations, lock entries, running processes) plus an age and/or size policy; soft-delete into a trash namespace with a grace window before physical deletion; a dry-run that prints what would go. **Never auto-clean what has no roots model.**

**Acceptance.** A referenced artifact is never deleted; an unreferenced one is reclaimed after the policy window; a dry run mutates nothing; deleting a referenced artifact fails a test.

**Consumed by** D-B; the retention ADR (sox ADR-0014). **Current state:** ADR-0014 is proposed/design-only with a measured accumulation.

---

## SR-13 · Replayable, drift-verifiable history

**Need.** The work-item plane treats the graph as truth with a non-authoritative audit trail. That means a store that has drifted cannot be reconstructed and verified — you cannot ask "does the store match its own event history, and if not, name the divergence". The fleet-level consequence is that a corrupted or half-applied state has no repair path.

**Required interface.** An authoritative append-only event history plus a reconstruct-and-verify pass that diffs derived state against the store and exits non-zero on drift, with a dry-run that writes nothing.

**Acceptance.** Reconstruct on a clean store exits 0; an injected divergence exits non-zero and names it; `--dry-run` writes nothing; a repair restores agreement.

**Consumed by** the substrate-plane decision (not a work-item primitive). **Current state:** the fleet's `state` tool has this; the backlog store does not.

---

## SR-14 · Canonical cross-store identity

**Need.** One repository can exist as two project rows, splitting its work so a scoped query sees half of it — and no verb can merge or retire the surplus. The work-item plane can build the verbs; the **data reconciliation** is store-side.

**Required interface.** Canonical project identity resolvable by a stable key; a merge that re-points items, writes a one-hop redirect, and soft-retires the duplicate; **retired ids never reused**; a retire operation for a surplus row.

**Acceptance.** After reconciliation, a query scoped to the canonical row returns the union; an old reference resolves through the redirect in one hop; the retired id is never returned by a list view and never reused.

**Consumed by** C1 (`73d0b9c6`), C9 (`cf97c613`). **Current state:** duplicate rows observed; no merge/retire verb.

---

## SR-15 · Server readiness, config resolution and watchdog

**Need.** A configured server that is silently absent, or a cold start that exceeds the client's own deadline, presents as "the tools do not exist". The fleet cannot distinguish a missing server from a broken one, and neither can a user.

**Required interface.**
- **starting / live / ready** as distinct states; readiness exercises the **serving path**, not a socket; a **watchdog** catches a hung-but-alive process (a frozen loop is invisible to a liveness ping).
- Config resolution with a stated total precedence; **absolute paths only**; an **unknown key is a hard error** (the `environment` vs `env` silent no-op produced an empty store).
- A load-time check that the configured server path **exists, is executable, and matches the installed artifact's identity**.
- Client resilience: retry with full jitter, a bounded budget, and a circuit breaker around connect/handshake, so a cold start gets a grace window instead of one hard deadline.

**Acceptance.** A misconfigured key fails loudly at load; a configured path that no longer exists refuses to start and names the resolved path; a hung-but-alive process is reported and restarted; a cold start beyond the old deadline succeeds; a mid-session drop recovers without a silent hang.

**Consumed by** D-A (`4503046c`). **Current state:** the transport failures are filed (`433e940a`, `2742c0be`, `6619af05`, `2d89e154`).

---

## SR-16 · Installed-artifact reconciliation

**Need.** The lockfile and the installed set disagree, and nothing notices — a declared agent target can be missing, and an extension-less stub can be globally dispatchable. An installed artifact with no owner and no reconciliation is unaccountable.

**Required interface.** A reconciliation that reports, per extension: installed / missing / drifted / foreign, against the lockfile and the host directories; plus the lockfile↔installed set difference in both directions.

**Acceptance.** A lock missing an installed agent is reported; a declared target that is absent is reported; a stub with no extension is flagged; the reconciliation is read-only.

**Consumed by** D-B. **Current state:** filed (`fb627585`, `7a4a0813`).

---

## 17. What this changes about the proposal

`PROPOSAL.md` §3.3 previously framed the substrate half as decision requests whose status could not be confirmed. That framing is superseded: **the needs are documented above as requirements, and are assumed achievable.** The work-item plane's twelve tickets stand unchanged; the substrate requirements above are what they consume. Nothing in this document is blocked on confirmation — it is blocked only on being built.
