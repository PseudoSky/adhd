# REMEDIATION-STRATEGY — dispatching the failures `QA-STRATEGY.md` surfaces

**Status:** TARGET dispatch strategy (spec artifact). Writes no product code, no graph, ships no behavior.
**Owner:** qa (strategy); execution belongs to the dispatcher / `dispatch-*` playbooks.
**Authored:** 2026-10-05. **Baseline HEAD:** `7adea3995eb5afbcd0bead3dc49c409fc9e4669b`.
**Inputs:** [`QA-STRATEGY.md`](./QA-STRATEGY.md) (the verification plan), `SPEC-SET.md`,
`CLI-HIERARCHY.md`, `docs/decisions/0006-*` + `0007-*`, and the measured baseline in
`QA-STRATEGY.md` §5.
**Normative rules this strategy obeys (not restated — cited):** `dispatch-triage` (root-cause with
`debug` first; `architect-decision` when the decision is technical; implement through
`dispatch-direct`; merge on the change's own gates; resolve on merge; review from `main`),
`definition-of-ready`, `dispatch-priority`, `dispatch-contract`, `backlog-usage`, and
[`AGENTS.md`](../../../AGENTS.md) (accountability, evidence gates, parallel-process invariant
ADR-0012).

---

## 1. Failure taxonomy → route table

A "failure" is whatever `QA-STRATEGY.md` surfaces. Classify it by its **evidence shape** first —
the shape selects the route, not the symptom's title.

| # | Failure class | Evidence shape (must be present) | Route | Authority / rule |
|---|---------------|----------------------------------|-------|------------------|
| F1 | **Deterministic red test** | a command that exits non-zero with a failing test name + error | `dispatch-triage` → `debug` root-cause (evidence, **never** the dispatcher's guess) → `architect-decision` if the fix is a technical/contract decision → `dispatch-direct` to implement | `dispatch-triage` |
| F2 | **Negative-control red (downgrade)** | the control prints the degraded path (e.g. "driver-level chaos instead of a clean CAS rejection") while the lane is green | treat as a **real defect F1**; do **not** accept "the lane is green" as health | evidence gates; `AGENTS.md` §7 bullet 3 |
| F3 | **Absent surface** | `rg -F` = 0 matches for the target verb/symbol (e.g. `reservations`, `timeline`, `state-revision`) | not a bug — a **workstream**; bucket by spec and gate on dependencies; do not file as a defect | `definition-of-ready` (`needs-spec` if the done-state isn't writable) |
| F4 | **Unbound AC / no test** | an AC with no `ac-traceability.json` entry | **coverage gap** → route to the QA harness wave (W0), not to an implementation executor | `QA-STRATEGY.md` §6 |
| F5 | **Contract/exit-code divergence** | both transports return different envelopes/codes for the same failure, or the wrong exit | `dispatch-direct` on the contract matrix; blocked until both transports are driven | `ADR-0006` D2 |
| F6 | **Flake** | a test that passes and fails without a code change | `debug` determinism-first (remove clock/network/shared state/sleep); a retry is recorded with a tracking item and a fix date, never silent | repo strategy "Gates"; `AGENTS.md` §7 |
| F7 | **Cross-repo failure** | the reproducer's evidence is under `sox-ecosystem/`, an installed copy, or an external dependency | **route to the owning repo** — do not dispatch the fix here (§3) | `execution-order.md` §4 (rule 17) |
| F8 | **Unproven `VERIFIED` corpus claim** | a design item (C1–C10) marked `VERIFIED` with `citations: 0` / no readable test | **re-verify** at HEAD: read the source the claim names; if absent → F3; if present but untested → F4 | `QA-STRATEGY.md` §1 C-F; `AGENTS.md` "verify against HEAD" |
| F9 | **Verdict conflict / ambiguous classification** | two artifacts disagree (e.g. an audit says ALREADY-SHIPPED, mapping says deferred) | `architect-decision` to pick the falsifiable reading, then re-run the check | `definition-of-ready`; `dispatch-priority` escalation ladder |

**Root-cause discipline.** No failure is filed to the backlog, marked fixed, or surfaced to the owner
as fact until triage has **evidence** (`dispatch-triage`). A fix with no test that was red before it
is not fixed. An item is only "complete" once the fix is **verified by running something** — not when
the code is believed written.

**The three-layer verification the plan mandates** (`reconciliation-plan.md` §4; `SUMMARY.md` R-9):
L1 graph read-back (`adhd-backlog get`/`query`/`batch action`), L2 artifact assertions
(`rg`/`wc`/`git`), L3 independent re-derivation (a store-wide scan, as `bucket-f-verification.md`
did). A route's executor must produce the layer its claim requires.

---

## 2. Bucketing — one done-state, one cohesive write-scope

**Bucket definition (all three must hold):**
1. **One observable done-state** — a binary assertion written as an action a consumer takes
   (`dispatch-contract` brief shape), not a list of files touched.
2. **One cohesive write-scope** — the files one executor can own without colliding with another
   in-flight bucket.
3. **File cohesion is absolute** — **every change to a file lives in the same bucket**. A file is
   never split across concurrent buckets. This is why the concurrency-sensitive `write/*.ts` files
   (`claim.ts`, `claim-lease.ts`, `tx.ts`) and the query path are separate buckets even when their
   symptoms look related.

**Wave sequence** is ordered by consequence-to-objective via the `dispatch-priority` ladder:

| Priority | Meaning | Buckets |
|----------|---------|---------|
| **P0** | run-blocker: blocks the objective or breaks `main` / a shipped artifact | W0 harness; W1 S07 concurrency (measured F2) |
| **P1** | objective-critical; unblocks ≥2 buckets | S02 identity (gated), S03 reads, S04 attestation, S08 artifacts |
| **P2** | in-scope normal | S06 vocab/config, S09 lifecycle, S11/S12 new verbs |
| **P3** | deferrable (files only) | dispositions, doc closes |

Buckets are **dispatched in priority order**, and a bucket that touches a file another open bucket
owns waits — file cohesion beats priority.

**Batching and owner pause (the plan's standing constraint):**
- Fan out **≤4 dispatches** at a time (`SUMMARY.md` R-9; `reconciliation-plan.md` §4).
- **Pause and ask the owner when the run passes 10 dispatches**, or at any P0→P1 boundary, or when a
  bucket needs a decision the dispatcher cannot make (a breaking-delta ship-time sign-off, a
  cross-repo classification). Reaching the user is the last resort — first escalate to the roster
  (`architect`, `architect-decision`, `researcher`, the owning specialist) per `dispatch-priority`.
- A wave does not start until the previous wave's gates are green (review-from-`main`, §5).

---

## 3. Cross-repo failures — route to the owning repo, do not dispatch here

`execution-order.md` §4 flags **21 units** whose evidence rests outside the `adhd` repo root. A
failure is **F7** when its reproducer's `file:line` lives in `sox-ecosystem/`, an installed/extension
copy, or an external dependency (`@adhd/sox-graph-store`, `@adhd/sox-store-adapter`, `sox memory-core`,
`agent-dashboard`, `claude-agents`, `scratch/agent-schema`).

**Rule:** confirm and fix in the **owning repo**; only the **consumer assertion** in `adhd` is
in-scope here. File the item against the owning repo via `backlog-usage`; do **not** dispatch a fix
into a tree this repo does not own. If the fix cannot be made there, the `adhd` consumer test is
marked `blocked-on <owning-repo-item>` with that citation — never silently skipped.

Known cross-repo buckets from the audit (`cluster-ship-audit.md`): S06 AC7/8, S07 AC8/9/10, S09
AC5/6/7, S10 AC5/6/7/11/13/14/15. S08 AC5 (`packages/apigen/*`) is in-repo but its contract spans
generated hosts.

---

## 4. The first remediation wave

**Baseline verdict (measured, `QA-STRATEGY.md` §5):** `nx test backlog` **exit 0**,
`nx run backlog:verify-dist-load` **exit 0**, `nx run backlog:e2e` **exit 0**. The lanes are **not
red**, so no failure-remediation wave is *forced* by a red lane. Therefore **W0 runs first** — the
verification harness itself — because the failures cannot be routed until they are visible, and the
measured baseline shows the green is thin (266 `todo`, 35 skipped files, no AC→test binding, MCP host
path never driven).

### W0 — Client verification harness (P0, executor class: **qa**)

**Goal:** the `QA-STRATEGY.md` matrix runs and produces evidence, so every subsequent failure has a
home.
**Observable done-state (binary):**
1. A **contract matrix** drives every shipped verb on **both** transports (built-CLI process and
   built-MCP-server-over-stdio) and asserts the same envelope/exit for the same failure.
2. The **MCP host path** is driven: spawn the **unmodified** `dist/index.js serve --transport mcp`,
   `initialize` → `tools/list` → `tools/call`, and assert the flat `content` payload (ADR-0004). No
   direct-import shortcut.
3. `docs/plan/backlog-consolidation/ac-traceability.json` is **generated** from the real suite;
   every testable AC binds to a named test; every unbound AC is recorded `unreachable` with a
   measured reason (`rg -F` count).
4. The **negative controls** for S07 are re-run and their measured output captured verbatim.
**Scope (files owned this wave):** new test files under `entrypoint/backlog/src/**` (contract matrix,
MCP-host e2e), `docs/plan/backlog-consolidation/ac-traceability.json`, and the traceability generator.
**Evidence:** the commands, exit codes, pass/fail/skip counts, and the captured negative-control lines.

### W1 — S07 concurrency: a claim race must reject cleanly (P0, executor class: **backend**)

This is the **first remediation bucket**, justified by a **measured F2** in the baseline: the e2e
negative controls show a claim race surfacing as `Write I/O failure … Database snapshot is stale`
and `winners=1 losers=0 unexpected=1` — **driver-level chaos, not the typed `E_CLAIM_HELD`/`conflict`**
the contract requires, and concurrent writers hitting snapshot-stale. The suite is green only because
the controls assert *visibility*, not *clean typed rejection*.
**Route:** F1/F2 → `debug` root-cause at HEAD (is it the in-repo `write/{claim,claim-lease,tx}.ts`
path, or the out-of-repo `@adhd/sox-graph-store`/`sox-store-adapter` seam? — ADR-0012, parallel-process)
→ `architect-decision` if it is a substrate contract issue → implement.
**Observable done-state:** two processes racing one claim yield **exactly one** winner; the loser
receives a **typed** `E_CLAIM_HELD` (never an unclassified driver error); a fresh reopen shows the
winner's state and no silent loss. Proven with latches/barriers, **never wall-clock**.
**Scope:** `entrypoint/backlog/src/write/{claim,claim-lease,tx}.ts`, `store/graph-backlog-store.ts`,
FTS rebuild; the external seam if root-cause lands there (→ F7 cross-repo).
**Evidence:** the latch counts before/after; the typed rejection observed by the losing process.
**Execute the ACs: S07 AC1/AC2/AC4** (and re-check S11 R1 once W0's harness exists).

### The rest of the sequence (failure-driven, not spec-order)

| Wave | Bucket | Executor | Evidence gate |
|------|--------|----------|---------------|
| W2 | S03 reads complete (desc order, completeness meta, order scoping, joins) | typescript | contract matrix; the D3 red→green control |
| W3 | S04 attestation + B1 `get state` / B2 `list citation --path` | backend | anchored attestation → `stale`; fragment read returns the payload |
| W4 | S08 shipped-artifact integrity | devops + typescript | stale `dist/` fails the manifest backstop (negative control) |
| W5 | S02 canonical identity + citation-existence (breaking, **gated**) | backend | **owner ship-time sign-off / superseding ADR first** (`execution-order.md` R3) |
| W6 | S11 timeline/reservations + S12 state-revision (additive, ungated) | backend | reopen persistence; same-tx CAS with latches |
| W7 | S06/S09/S10 + cross-repo routing | doc-steward + backend | drift gates; cross-repo items filed, not fixed here |

---

## 5. The loop — how a wave's verification feeds back

1. **Implement** in the owning bucket via `dispatch-direct`, merge **on the change's own gates**
   (the `QA-STRATEGY.md` §4 gates — not on a reviewer's report).
2. **Review from `main`.** The review reads the merged tree at the **per-ticket pinned sha**, never
   the tip of an in-flight branch, so review and implementation cannot converge on a stale view.
3. **Re-run the matrix from `main`.** The `test` + `e2e` + `verify-dist-load` gates run on `main`;
   the AC traceability is regenerated and diffed against the pre-merge file. A merged change that
   un-binds an AC or drops a negative control **fails** the gate.
4. **Resolve on verified merge.** The spec item is transitioned with a citation recording what
   changed, why, and the commit reference (`backlog-usage`) — an item is resolved only after the fix
   is **verified by running**, never when it is believed written.
5. **A failure re-enters** at §1 by its evidence shape. A new failure from a merged fix re-enters at
   **P0** (it is a regression caused by the change), with the same evidence bar; "pre-existing" is
   not a classification this strategy accepts (`AGENTS.md` accountability).
6. **The loop closes on the owner's release gate.** A release is blocked until every relevant AC is
   green or `unreachable-with-reason`; an override carries a recorded, named exception and the risk
   it accepts.

---

## Provenance

- **Schema version 1** (2026-10-05): initial failure-remediation dispatch strategy, authored at HEAD
  `7adea399`, paired with `QA-STRATEGY.md` (same baseline). Derives its buckets from
  `execution-order.md`'s wave structure but **re-orders by failure evidence** (the measured S07
  negative-control signal is the first remediation bucket, ahead of the audit's W1 S08) and routes
  per the repo's own `dispatch-*` playbooks.
- No secrets, no machine-local absolute paths, no gate the suite cannot enforce, and no clause whose
  trust root is this file.
