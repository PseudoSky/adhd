# README — How to consume this dispatch plan

**Plan:** `backlog-interface-v2-dispatch` (the READY `@adhd/backlog` interface-v2 redesign corpus → work orders)
**Corpus:** `docs/spec/backlog/INTERFACE_v2.md`, `docs/spec/backlog/GRAPH_MODEL_v2.md`, `docs/spec/backlog/PLUGIN_ARCHITECTURE.md`, `entrypoint/backlog/RAG-SPEC.md`
**Main deliverable:** [`DISPATCH.md`](./DISPATCH.md) — 45 work orders across 7 epics (4 F + 7 G1 + 10 A + 4 B + 5 G2 + 13 C + 2 D), wave structure, AC traceability, DoD tests, risk register, mandatory code-review gate.

This README is for the orchestrator (`dispatcher` / `dispatch-project-orchestrator`). It tells you how to turn `DISPATCH.md` into executed work without re-reading the four spec files.

---

## 1. What the plan is

A **dispatch plan**, not a design and not a ticket corpus. The design is complete and reviewed (READY-WITH-FIXES, all fixes applied). Your job is to drive the 45 work orders through the repo's implementers in the pinned wave order, verifying gates between waves. **Every work order requires a code review before acceptance** (`dispatch-project-reviewer-flash`, §4.5 of DISPATCH.md) — tests green is not done; review-clean is done.

**Do not re-design.** If a work order hits a contradiction with a spec, treat it as a planning blocker (cite spec file + section) and return to the operator — never redesign in place.

---

## 2. Work-order shape (every entry in DISPATCH.md §1)

Each work order carries:

- **ID + epic** (`F-01`, `G1-05`, `A-07`, `B-03`, `G2-02`, `C-01`, `D-01`)
- **Files touched** — exact paths, already spot-checked against the live tree
- **What to implement** — 2-4 sentences citing the exact spec section/AC
- **Acceptance check** — the AC/behavior it must satisfy, including named negative controls
- **Implementer tier** — `flash` (single-file/well-specified) vs `deepseek` (multi-file/interface) vs `test` (test agent) vs `orchestrator` (gate runs)
- **Dependencies** — the work orders that must land first
- **Token budget** — read/output estimate

A work order is **self-contained**: an implementer needs the order text + the cited spec section; they never need to read the whole corpus.

---

## 3. Wave progression

| Wave | Content | Test gate | Review gate |
|---|---|---|---|
| **W0** | EPIC-F (F-01..F-04) + D-01 + F-03 upstream | `nx build backlog`, `nx test backlog`, `verify-dist-load`, parity gate baseline green | every F-01/F-02 diff reviewed (adapter surface, async churn, F-03 upstream contract) |
| **W1** | G-part-1 ∥ A (two parallel tracks, 17 orders) | PLUGIN_ARCH §9 + GRAPH_MODEL §8 suites green; parity green (allowance documented) | every G1/A diff reviewed (RPC/socket hygiene, migration blast radius, BUG-1/BUG-2 negative controls) |
| **W2** | EPIC-B (B-01..B-04) | query.spec.ts negative controls green; parity green | every B diff reviewed (pagination push-down, offset ordering, total semantics, dateRange predicate) |
| **W3** | EPIC-G-part-2 (G2-01..G2-05) | RAG-SPEC §8 suite green; parity green | every G2 diff reviewed (SAME_AS invariant, confirm-gate, traversal transitivity, backfill bounds) |
| **W4** | EPIC-C (C-01..C-13) | AC-0..AC-31 through real seams; SKILL.md ships first; `verify-dist-load`; C-13 demo passes | every C diff reviewed in batches (C-01..C-05, C-06..C-09, C-10..C-12, C-13), per §2 "Review focus" |
| **W5** | D-02 final parity + release | parity green (only documented allowance); `nx affected -t test`; `gitnexus_detect_changes` clean | full-corpus review pass: every AC traceable to a green real-seam test, all findings closed, docs/changelog reviewed |

**The review gate is not optional.** Per DISPATCH.md §4.5: a work order is DONE only when its `dispatch-project-reviewer-flash` pass is clean (seven axes: spec conformance, platform isolation, test teeth, lint, dependency purity, gitnexus blast radius, working-tree hygiene). Findings loop back to the same order (not a new one); a finding that disputes the spec is escalated to the operator as a planning blocker — never re-designed by review.

### Rules

1. **Never advance a wave on a red gate.** Gate failure = verify, don't re-dispatch (see §5).
2. **W1 is two parallel tracks** — G-part-1 and A touch disjoint files except `query.ts` (G1-05 is additive and ordered after A-04). Dispatch them as `parallel()` tracks.
3. **Within a wave, honor order dependencies** (e.g. F-02 after F-01; G1-05 after G1-03/G1-04 + A-04; C-10 after C-01..C-09; C-12 closes the implementation surface, C-13 the demo after it).
4. **C-10 (SKILL.md migration) must ship the 6-tool surface FIRST** — it is the only documented surface; leaving it last strands every agent mid-window on stale flat names (INTERFACE §7.9). Order C-10 immediately after the surface exists (C-09) and before C-12.

---

## 4. Dispatch mechanics

- **Flash vs deepseek routing:** use `dispatch-project-implementer-flash` for flash-tier orders (single-file, well-specified, self-contained) and `dispatch-project-implementer-deepseek` for deepseek-tier orders (multi-file, interface churn, SQL/migration/algorithm work). Use the `test` subagent for the DoD test orders (test files only). Upstream orders F-03/G1-06 dispatch into the **sox-ecosystem repo** (`/Users/nix/dev/ai/sox-ecosystem/`) — they are parallel work, never blocking backlog-side fallbacks (see risk R1/R5 in DISPATCH.md §5).
- **Subagent-depth caveat (R4):** implementer dispatches may be depth-limited until opencode restart. Every order is written to be **self-contained** — never have an implementer dispatch sub-subagents. If an order's text isn't self-contained, expand it before dispatch rather than spawning.
- **Tests are default-running** (AGENTS §7): real Turso + real fastembed under `tmp/backlog/<test>/`, removed on teardown. No env-gated "live" suites — the only allowed gate is a paid external service, which none of this plan touches.
- **Review routing (mandatory, §4.5 of DISPATCH.md):** after an implementer reports an order done, dispatch `dispatch-project-reviewer-flash` with the order text + diff + test output BEFORE marking the order's AC satisfied. Findings loop back to the same order; the order is done only when review is clean. Run review dispatches in parallel with the next independent order's implementation (same-file pairs serialize: F-01→F-02, A-04→B-02, C dependencies).
- **Never `--skip-nx-cache`**, never hand-edit BACKLOG.md, never `git add -A` when committing an implementer's work — stage explicit paths.

---

## 5. Resumability (how you know where you are)

The plan is resumable in the resumable-plan sense: **each wave's completion state is checkable from state, not from subagent reports.**

- **Wave rollup check:** a wave is complete when (a) every work order in it reports `childrenClosed` (its own sub-tasks done, where any) and (b) the wave's gate is verified. Track per-order closed state and per-wave gate state in your ledger (e.g. `state.json` / the operator's chosen materialization).
- **Gate false ⇒ verify, don't re-dispatch.** Example: W4 has 13 work orders; all 13 report closed but the AC suite fails AC-16. The wave is NOT done. Do not re-dispatch all 13 — trace the failing AC to its work orders (see the AC matrix in DISPATCH.md §3: AC-16 → C-02) and re-issue only C-02 (or the specific failing sub-assertion within it).
- **Idempotent re-entry:** every work order cites its acceptance check, so a resumed order can be re-run against the gate without re-reading the corpus.
- **Mid-epic interruption:** if a session dies mid-wave, re-verify the wave gate from the previous checkpoint, then continue from the first un-closed work order. Never re-run a completed wave's orders "to be safe" — that is exactly the verify-don't-redispatch trap.

---

## 6. The one sequencing dependency you must not break

**EPIC-A owns `store/query.ts` first; EPIC-B and EPIC-G build on its output; EPIC-C is LAST.**

Concretely: A-04 (dimensional routing in query.ts) must land before B-02/B-03 (query correctness) and before G1-05's additive query.ts exports. C-01 (the 6-verb consolidation, re-issued TASK-003) must not start until A-09, B-03, and G2-05 have landed. Breaking this — e.g. dispatching B-02 before A-04, or drafting C-01 against the pre-A model — invalidates the collision matrix and produces a surface that fails AC-0/AC-6/AC-27. The wave order (W0→W5) is the enforcement; keep it.

---

## 7. Materialization

This is a dispatch plan, not ticket bodies. The operator decides how to materialize: direct dispatch per work order, backlog-tool tickets (one per work order, citing the DISPATCH.md section + spec sections), or a dag.json/state.json. When materializing, carry forward each order's **dependencies** as the DAG edges and each wave's **gate** as the state-transition guard.
