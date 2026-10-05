# QA-STRATEGY — proving the `@adhd/backlog` client works according to the full plan

**Status:** TARGET verification strategy (spec artifact). Writes no product code, no graph, ships no behavior.
**Owner:** qa. **Authored:** 2026-10-05. **Baseline HEAD:** `7adea3995eb5afbcd0bead3dc49c409fc9e4669b`.
**Scope:** the `backlog` product across **all** its consumer surfaces: the **built CLI**
(`entrypoint/backlog/dist/index.js` spawned as a real process), the **MCP server as a host loads it**
(`.mcp.json` → `node entrypoint/backlog/dist/index.js serve --transport mcp` → `mcp__backlog__*`), and the
**library** (`entrypoint/backlog/src/api.ts` imported in-process).
**The plan this proves:** `SPEC-SET.md` S01–S12 (107 numbered AC bullets, measured), `CLI-HIERARCHY.md`
(the action-first target tree), `backlog-interface-target.md` (ADR-0007), `docs/decisions/0006-*.md`
(the frozen current surface), the 6 owner-mandate items (`050ea18f, 46cf1086, 91a8c640, e54bd58b,
7ef53d55, 7a78312c`), and the C1–C10 + FOUNDATION design corpus.

> **Strategy adoption (equivalence test).** The repository's single committed strategy document is
> [`docs/TEST-STRATEGY.md`](../../TEST-STRATEGY.md). It **already contains every required section**
> (risk map, test pyramid, test-case design, test data & fixtures, environments, automation
> architecture, gates, metrics, provenance). It is therefore **adopted as the project strategy —
> not duplicated**. This file is the **backlog-client-scoped verification plan** that *cites* it and
> adds only the plan-specific claim decomposition, matrix, per-spec binding, and baseline. The
> repo-level rules (default-running tests, the one legitimate env gate, proof standard §7 bullets
> 1–6) live in [`AGENTS.md`](../../../AGENTS.md) §7 and are not restated here.

---

## 1. Claim decomposition — what "works according to the full plan" means

The top claim decomposes into six independently testable claims. Each is falsifiable by a command,
and each names the artifact that owns its expected value. **No clause below is trusted from this
document alone** — every gate cites an external command or artifact.

| # | Claim | Owned by | Falsified when |
|---|-------|----------|----------------|
| **C-A** | The **current surface** behaves as `ADR-0006` freezes it: 29 verbs + `batch`; one `--input`; two-arm envelope; ten error codes/exit codes; `by` identity; closed six-member `rel` union; three naming schemes. | `docs/decisions/0006-*.md` | a shipped verb's envelope, code, exit, or naming differs from ADR-0006 |
| **C-B** | The **`batch` fan-out** returns each item as the same outcome envelope and preserves per-item `ok`/`error.code`. | `ADR-0006` D2/D4 | a batched item's failure is swallowed or re-shaped |
| **C-C** | The **new MCP host-loaded path** works: a *host* (not a script that reaches inside) loads the built server and its tools answer over real stdio JSON-RPC with the flat payload on `content` (ADR-0004). | `ADR-0004`, `.mcp.json` | the built server fails to list/answer, or a tool returns a transport wrapper |
| **C-D** | The **action-first hierarchy target** (`CLI-HIERARCHY.md` / `ADR-0007`): every top-level token is an action; every old verb has a mapped new form; the envelope/`rel`/`by`/ADR-0012 axes are unchanged; no alias survives. | `CLI-HIERARCHY.md` §AC1–11 | a domain noun is a first token; an old spelling survives; an envelope axis changed |
| **C-E** | Each of the **12 specs' ACs** holds at HEAD (107 numbered AC bullets; 23 owner-mandated; 41 non-mandated folded). | `SPEC-SET.md` S01–S12 | an AC is neither green nor explicitly `unreachable-by-design` |
| **C-F** | The **design corpus** (C1–C10 + FOUNDATION) is *actually* implemented — not merely marked `VERIFIED`. `73d0b9c6` carries `citations: 0`; a "VERIFIED" with no readable test evidence is **unproven**. | C1–C10 items | a corpus claim has no test whose red→green control is readable |

**What is explicitly NOT a claim here.** "The plan documents are internally consistent" is a
*docs* property, verified by the corpus gates in `tmp/backlog-consolidation/bucket-f-verification.md`
— not by this strategy. This strategy tests the **client**, not the prose.

---

## 2. Test matrix — level × surface × transport

Levels are ordered by proximity to the consumer. **Prefer the lowest level that proves the
behaviour** (repo strategy, "Test pyramid"). The rightmost column names the **real entrypoint** —
never a stand-in that reaches inside the system under test.

| Level | Surface | Transport | Real entrypoint | Proves |
|-------|---------|-----------|-----------------|--------|
| **Unit** | pure logic (envelope, codec, catalog, projections, sort, staleness) | in-process | `entrypoint/backlog/src/**/*.spec.ts` | a pure function's output; the envelope arm for a synthetic error |
| **Integration** | store + write/tx + query against a **REAL** store (temp SQLite), real queue, real migrations | in-process `api.ts` | `api.ts` imported; store under `tmp/backlog/**` | the operation end-to-end *below* the transport seam; mock only the external boundary (LLM/embed model) |
| **Contract** | the envelope/exit-code contract on **both** transports | CLI process **and** MCP stdio | `node dist/index.js <verb> --input '<json>'`; `node dist/index.js serve --transport mcp` | every verb returns exactly one of the two arms; the ten codes map to the frozen exits; malformed `--input` prints the unwrapped `invalid_argument` on **stderr** |
| **Live end-to-end (CLI)** | the **built artifact** as a consumer uses it | real process spawn | `entrypoint/backlog/dist/index.js` (already loaded by `verify-dist-load`) | the shipped `dist/` — not `src` — performs the journey; `verify-dist-load` already proves it loads |
| **Live end-to-end (MCP host)** | the **MCP server as a host loads it** | real stdio JSON-RPC to the **unmodified** built server | spawn `node dist/index.js serve --transport mcp`; `initialize` → `tools/list` → `tools/call` | tool registration, dist dependency resolution, output shape — the exact layer a direct-import script skips |
| **Cross-process** | the store under **concurrent writers** (ADR-0012) | two+ real `node dist/index.js` children, one store | latches/barriers; **no wall-clock** | exactly-one claim; no silent loss; a failed write is visible (no false-success) |
| **Regression / negative-control** | the guarded defect reintroduced | any level | a deliberately-broken variant goes **red**, then is reverted | the assertion has teeth (repo strategy, "negative controls with teeth") |

### Level assignment rules

- A new test belongs at the **lowest level that can prove the behaviour**. An envelope shape is a
  *unit/contract* test — not an e2e.
- **Live (CLI + MCP-host + cross-process) is mandatory for:** the dist artifact, the MCP host seam,
  persistence/durability, concurrency, and any breaking target delta. These cannot be proven
  in-process.
- **Mock only the external boundary** — the embedding model / paid provider. Never mock the store,
  the engine, the queue, or the server when they are the thing under test (repo strategy;
  `AGENTS.md` §7 bullet 1).

---

## 3. Per-spec test plan S01–S12

**AC count is measured** (`rg`/node over `SPEC-SET.md`: 107 numbered AC bullets). **Level** and
**Live?** state where the proof must run. **Existing candidate** names a real test file that already
exercises overlapping code — *not* proof the AC holds (the candidate binding is recorded in the
generated `ac-traceability.json`, §6; it carries no `red_sha`/`green_sha`, so it is not yet proof). **Status**
is `surface-shipped`, `surface-absent` (measured: `rg -F` = 0 matches in `src`), or `cross-repo`.

### S01 — Freeze & extend the node/edge vocabulary (5 ACs) — **surface-shipped**

Measured: `attestation`/`obligation` present in `src/store/vocabulary-guard.ts:77-78`;
`api.ts` exports `attest`/`recheck`/`obligate`/`unobligate`.

| AC | Test that proves it | Level | Live? | Existing candidate |
|----|--------------------|-------|-------|--------------------|
| 1 kinds admitted, catalog 15 | `list kind` (target) / catalog read returns 15 incl. attestation+obligation | contract | yes | `src/write/catalog.spec.ts` (12 pass) |
| 2 internal edges writable, absent from `relate` | write `attests`/`has_obligation`/`satisfies`; `relate` with `attests` → typed error | integration | yes | `src/store/vocabulary-guard.spec.ts` (**10 todo**) |
| 3 unknown-kind mint unchanged | create with unknown kind still mints | integration | no | `src/write/catalog-verbs.spec.ts` (**34 todo**) |
| 4 `nx test` + `verify-dist-load` exit 0 | the two commands | gate | yes | measured §5 |
| 5 per-kind identity (case not collapsed) | two case-variant content fields → not collapsed | integration | no | **none** |

### S02 — Canonical identity, merge/redirect, duplicate linking (16 ACs) — **surface-absent (breaking, gated)**

Canonical resolution, `Redirect`, `link-duplicate` are unshipped (`rg` = 0). Owner sign-off ≠
implementation; the target verbs are absent. Testable **only** for the shipped subset.

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 ambiguous prefix → candidate set | 8-hex-prefix collides → typed `ambiguous_reference` with candidates | contract | yes | partial — `src/query/uid-prefix.spec.ts` exists |
| 2 merge Redirect + soft-retire + resolve chain-head | `merge issue` → one Redirect; source resolves to head | integration | yes | surface-absent |
| 3 dedupe never auto-links; `duplicates` read | default `same-project`; explicit `link-duplicate` required | integration | yes | surface-absent (`link-duplicate` 0) |
| 4 every uid-taking verb resolves chain | resolution-invariant sweep across verbs | contract | yes | surface-absent |
| 5 C1 citation verifies EXISTS (breaking) | out-of-root existing locator accepted, sha recorded | integration | yes | partial — `src/write/citation-path.spec.ts` (16 pass) |
| 6 never drop/abort an unverifiable citation | persisted `unverified-with-reason` | integration | yes | partial |
| 7 `url:`/`registry:`/`query:` anchors | each recorded with an outcome | integration | no | surface-absent |
| 8 project-identity de-dup | `list project` returns each once | contract | yes | partial — `src/query/views/registry.spec.ts` (**33 todo**) |
| 9 SUPERSEDED reason enum | reasonless transition → typed error | contract | yes | surface-absent |
| 10 traversable successor (`supersedes` edge) | cascade-scan reaches successor | integration | no | partial |
| 11 backfill 15 SUPERSEDED nodes | each has reason + successor-or-none | integration | yes | surface-absent (data migration) |
| 12 joins n:m + primary owner | spanning query returns both sets + one owner | contract | yes | partial |
| 13 H45 hard rules #4/#5 | worktree-only + non-file locator accepted | integration | yes | partial |
| 14 remove/restore + production gate | `delete issue`/restore; production write needs gate | integration | yes | surface-absent |
| 15 write-verb actor mismatch | typed validation error, not bare `conflict` | contract | yes | partial |
| 16 registry single enumeration | each entity once; orphan flagged | contract | yes | partial |

### S03 — Make reads complete and honest (7 ACs) — **surface-shipped**

| AC | Test that proves it | Level | Live? | Existing candidate |
|----|--------------------|-------|-------|--------------------|
| 1 completeness meta on every view | `total/returned/limit/offset?/truncated?/has_more` | contract | yes | `src/query/c7-envelopes.spec.ts` (pass), `meta-wire.spec.ts` |
| 2 `direction:"desc"` works; `score_kind` | desc order; derived reads carry `score_kind` | integration | no | `src/query/sort-priority-direction.spec.ts` (the one red→green control, D3 `9a95be96`) |
| 3 `view:"order"` scopes all member kinds | includes outbound `blocks` + dependent count; 2nd `part_of` typed error | integration | yes | `src/query/c2-legibility.spec.ts` |
| 4 C1 contradiction closed | `related` matches its own contract; stale comment gone | unit | no | `src/query/c1-reference.spec.ts`, `card.spec.ts` |
| 5 joins render in the default card | default card shows project/component sets | contract | yes | `src/query/card.spec.ts` |
| 6 structured/FTS precedence + documented params | structured branch never shadowed; params documented | integration | no | `src/query/text-routing.spec.ts` |
| 7 spec-append CAS/head agreement | CAS head == `get`/`spec-check` head | integration | no | `src/write/spec-revision.ts` tests; `983f5971` marked shipped |

### S04 — Anchored attestation & work-product citizenship (9 ACs) — **partly shipped, B1/B2 absent**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 anchored attestation + `stale` on changed anchor | `attest {subject,claim,anchor}`; recheck → `stale` | integration | yes | `src/write/contract-anchors.spec.ts` (2 pass) |
| 2 SPEC item citizen; export verified/drifted/gone | `part_of` work item; export reads revision+digest | integration | yes | partial |
| 3 B1 fragment read (`get state`) | returns revision fragment, not pointer | contract | yes | **surface-absent** (`get state` 0, `state-revision` 0) |
| 4 B2 `byCitationPath` | `list citation --path` returns citing items | contract | yes | **surface-absent** |
| 5 citations-as-assertions | out-of-root exists verifies; nonexistent rejected; abstract anchors recorded | integration | yes | overlap with S02.C1 |
| 6 symlink/out-of-tree integrity | symlink resolved; presence vs content anchor distinguishable | unit | no | surface-absent |
| 7 SPEC adoption metric + e2e | adoption metric queryable; one SPEC item→export→drift e2e | e2e | yes | surface-absent |
| 8 reproducible AC (no machine-local state) | committed-inputs-only; residual-0 decomposition | gate | no | `report/cutover-execution-plan.md` still "675-residual=0" — **red** |
| 9 portable deploy-verify | runs on clean checkout, no abs paths | gate | no | `deploy-verify.sh` residual box-specifics |

### S05 — Obligations, derived verdict, closure gate (6 ACs) — **partly shipped; gate is breaking/gated**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 `obligate` closed predicate core | predicate grammar accepted; no-obligation item unaffected | integration | no | `src/query/verdict.spec.ts`, `card.obligations.spec.ts` |
| 2 terminal transition refused typed `{code,required_kind}` | unsatisfied `block` refuses; commit ref alone insufficient | integration | yes | partial — `ObligationUnsatisfiedError` (U1 grounded) |
| 3 `claim` fails on block; verdict derived | refusal typed; `Verdict`/`Condition` never stored | integration | yes | `src/query/verdict.spec.ts` |
| 4 every gate has a negative control | deliberately-broken variant goes red, reverted | e2e | yes | scattered; not systematized |
| 5 harness fidelity (self-skip without reason fails) | a reason-less skip fails the gate | gate | no | surface-absent |
| 6 spec-lanes real count | count computed from the real suite | gate | no | `spec-lanes.mjs` removed (`f613472b` PARTIAL) |

### S06 — Closed, readable vocabulary & config surface (10 ACs) — **partly shipped; sibling-heavy**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 `list kind` machine-readable | every term + lifecycle/replacement; no absent advertised verb | contract | yes | partial — `c8-vocabulary.spec.ts` |
| 2 docs regenerated + drift check | drift check fails on divergence | gate | no | `src/store/vocabulary-drift.spec.ts` (2 pass) |
| 3 vocabulary cleanup | EPIC retired; bug/BUG reconciled; undefined/MEDIUM removed | integration | no | partial |
| 4 D2 `73d3b97d` repaired | ADR-0006 records `ambiguous_reference`, no invented `update` | doc-gate | no | `73d3b97d` resolved |
| 5 S6 correct docs/model | 1:1 sentence absent; drift check fails if it reappears | doc-gate | no | surface-absent |
| 6 unknown kind/priority fails typed | typed `not_found`; no row minted | integration | yes | partial |
| 7 planning extensibility + plan-value | plugin registration needs no core change; plan-value verdict queryable | cross-repo | no | sibling (`sox-ecosystem/extensions/skills`) |
| 8 catalog header zero false positives | fixture corpus: disallowedTools/role-word | unit | no | sibling (`claude-agents`) |
| 9 post-cutover config surface | no consumer references removed `migration.phase` | gate | no | PARTIAL |
| 10 env→store resolution | seeded `db_path` honoured; unneutralized redirect rejected | integration | no | surface-absent |

### S07 — Make writes atomic & durable (10 ACs) — **surface-shipped; concurrency defect measured**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 exactly-one claim; typed `E_CLAIM_HELD` | two processes race one node with latches | cross-process | **yes** | `src/write/cross-process-write-safety.e2e.ts`, `src/write/claim.spec.ts` (**18 todo**) — **measured defect §5** |
| 2 interrupted write no split WAL; reopen shows pre-write | kill mid-write; reopen; assert | cross-process | yes | `src/store/acked-write-durability.e2e.ts` |
| 3 FTS rebuild idempotent + shadow detected | rebuild twice; detect shadow | integration | no | partial |
| 4 failed write reports failure (no false-success) | negative control | integration | yes | partial |
| 5 R1 rollup counts non-terminal | `resolved` child not counted open | integration | no | `src/query/verdict-list-bound.e2e.ts` |
| 6 R2 orphaned-parent signal | retired parent with live children surfaced | integration | no | surface-absent |
| 7 R3 direction recoverable | `related`/`part_of` distinguish parent/child | unit | no | partial |
| 8 memory-server write races | facet-admit atomic; outcome idempotent by key | cross-repo | no | sibling (`memory-core`) |
| 9 malformed `independence` | rejected / `unknown`, never coerced to `self` | unit | no | sibling (`memory-core/src/outcome.ts:77`) |
| 10 integrity-pass policy on reopen | documented+tested structural-unknown policy | integration | no | sibling (`store-adapter`) |

### S08 — Shipped artifacts match source (9 ACs) — **partly shipped**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 stale `dist/` fails the release-manifest backstop | publish with mismatched dist → fail | gate | yes | `tools/nx-plugins/build/**` |
| 2 `verify-dist-load` default + apigen divergence fails | command + apigen contract gate | gate | yes | **measured: exit 0** |
| 3 pnpm/nx pinned | mismatch fails, no re-resolve | gate | no | `packageManager` pinned |
| 4 runmode strictness + tracing | unsupported runmode errors; trace per op | integration | yes | `src/ir-artifact.spec.ts` (15 pass) |
| 5 apigen plugin docs/help/test contract | contradiction fails gate | cross-repo | no | `packages/apigen/*` |
| 6 runmode undeclared vs malformed | two distinct typed errors | unit | no | surface-absent |
| 7 install/upgrade dependency-absence | fails loudly non-zero typed | integration | yes | partial |
| 8 baked-IR cache hashes `.d.ts` | edit `.d.ts` invalidates cache | integration | no | `src/ir-cache.durability.e2e.ts` |
| 9 release/publish drift | every task+duration; mis-inserted version fails | gate | no | surface-absent |

### S09 — Durable runtime lifecycle & truthful telemetry (7 ACs) — **partly shipped; sibling-heavy**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 durable lifecycle record survives restart | persisted health record | integration | yes | `src/store/embed-drain.e2e.ts` |
| 2 recall stable across reopen | same store, reopen, same result | integration | yes | `src/store/embed-*.e2e.ts` |
| 3 telemetry never reports success for failure | false-metric negative control red | unit | no | `src/server.tracing-six-tags.spec.ts` |
| 4 idempotent start/stop, no orphan | start/stop twice; no orphan socket | integration | yes | `src/serve.readiness.e2e.ts` |
| 5 memory-core recall leaks | read-only FTS → typed failure | cross-repo | no | sibling |
| 6 hybrid-search loadability decision | ADR recorded; optional path loads | cross-repo | no | `91f57dc3` open |
| 7 mass-mislabel guard | threshold guard + negative control | cross-repo | no | sibling (`memory-core/src/cluster.ts`) |

### S10 — Process & tooling self-enforcing (15 ACs) — **partly shipped; sibling-heavy**

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| 1 dispatch grants declared | empty/omitted tools/model fails | gate | no | surface-absent |
| 2 agent-spec required section | missing section fails validation | gate | no | partial |
| 3 worktree provisioning before dep-checks | missing install detected | gate | no | `7b7d5e38` open |
| 4 repo hygiene | clean-or-accounted; no tracked dist/tmp | gate | yes | `git status --porcelain` |
| 5 agent-spec evidence guard | model-qualified outcome without anchor fails | gate | no | sibling (`extensions/`) |
| 6 dispatch grant satisfies lane | unsatisfiable grant refused | gate | no | surface-absent |
| 7 process resource hygiene | duplicate unit refused; mem ceiling; reaped child | cross-repo | no | `d794287f` |
| 8 no removed-field keys | keying on removed field → typed failure | unit | no | surface-absent |
| 9 verb references resolve | every verb/prose ref resolves to a live verb | gate | no | surface-absent |
| 10 TaskCreate enablement | declared + documented/tested | gate | no | `4a41a335` open |
| 11 architect cross-package slot | schema slot + fixture | cross-repo | no | installed copy |
| 12 filed-vs-ready view | distinguishable from store | contract | no | partial (`8db42169`) |
| 13 dashboard theme-aware literals | dark/light fixture, no hard-coded `#fff` | cross-repo | no | sibling (ALREADY-SHIPPED per audit) |
| 14 `rehearse-live-vacuum` flag safety | `--help` refused/no side effect | cross-repo | no | sibling (`dc40a5dc`) |
| 15 `normalize_command` multi-token | classification rate drops | cross-repo | no | sibling (`dc92006f`) |

### S11 — Session & reservation timeline (8 ACs) — **surface-absent (all 8)**

Measured: `"reservations"` and `"timeline"` are **0 matches** in `src`. Every AC is
`unreachable-until-implemented`; the spec's own **Tests** block names the real entrypoint
(`create→claim→transition→release` stamped `--session-id S1`; read back `list reservation` /
`get session`; reopen) and its negative control (pre-change build → unknown verb; no durable
claim-**interval** with `paths[]`/`sessionId`/`leaseExpiry`).

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| R1 claim-interval persistence | append survives reopen | integration | yes | **surface-absent** |
| R2 `list reservation` enumeration | per-active-claim `{path,uid,holder,session,claimedAt,leaseExpiry}` | contract | yes | **surface-absent** |
| R3 session reverse lookup | "what is S holding" | contract | yes | **surface-absent** |
| R4 liveness | lapsed lease not returned | integration | no | **surface-absent** |
| S1 first-class session node | created on start; queryable | integration | yes | **surface-absent** |
| S2 append-only op-event log | every mutating verb appends | integration | yes | **surface-absent** |
| S3 `timeline <session>` | ordered ops + records touched | contract | yes | **surface-absent** |
| S4 child-session rollup | descendants included | integration | yes | **surface-absent** |

### S12 — Expected-state revision (5 ACs) — **surface-absent (E1–E4)**

Measured: `state-revision`, `stateRevision`, `has_state_revision`, `get state` are **0 matches** in
`src`. The `spec-revision` precedent ships (`src/write/spec-revision.ts`).

| AC | Test that proves it | Level | Live? | Status |
|----|--------------------|-------|-------|--------|
| E1 immutable revision + pointer advanced in place | terminal transition mints; uid preserved | integration | yes | **surface-absent** |
| E2 expected-state ledger payload | sorted-key ledger; `coverage_proof.balanced` | integration | yes | **surface-absent** |
| E3 same-tx, non-blocking, CAS | stale base → `precondition_failed`; completion never refused; CAS no lock | cross-process | yes | **surface-absent** |
| E4 fragment read (`get state`) | payload+token; mismatch → `state:'stale'` | contract | yes | **surface-absent** |
| E5 verdict derived on read | obligation mutation changes verdict, no new revision | integration | no | partial (verdict read path ships) |

---

## 4. Evidence & gates

### Evidence each level must return

| Level | Required evidence (or the run did not happen) |
|-------|-----------------------------------------------|
| Unit / Integration / Contract | the **command**, its **exit code**, and the runner's **passed/failed/skipped counts**. An assertion with no observed run is not evidence. |
| Live CLI | the spawn command, exit code, the parsed `{ok,data}`/`{ok,false,error}` on stdout, and the malformed-input arm on stderr where applicable |
| Live MCP-host | the JSON-RPC `tools/list` count and the `tools/call` result's flat `content` payload; the **server process** was the unmodified built `dist/` |
| Cross-process | the latch/barrier counts (`attempted`, per-process `ok`/`threw`, `persisted(fresh reopen)`) — never wall-clock |
| Negative control | the deliberately-broken variant's **red** output, then the reverted **green** output |
| Coverage | the tool's printed number, or the literal words **"coverage not measured"** |

### Definition of Done per level

- **Unit/Integration:** the new test fails on the un-fixed base and passes on the fix (red→green),
  exits 0 on the fixed build, and does not depend on test order.
- **Contract:** both transports return the same envelope for the same failure; the ten codes map to
  the frozen exits; a per-field flag is rejected `invalid_argument` (exit 2).
- **Live:** the **built** artifact/process is exercised — not `src`; the run is default-running and
  unflagged unless it calls a paid/external service.
- **Cross-process:** a latch/barrier proves concurrency; persistence is proven by **reopen**, never
  by a success envelope.
- **Negative control:** the guarded defect, reintroduced, turns the test **red**.

### Anti-patterns to REFUSE (name the rule, stop)

| Refused | Why |
|---------|-----|
| A **proxy test** ("`Promise.all` is present", "the function is called") | asserts implementation shape, not the consumer outcome (`AGENTS.md` §7 bullet 6) |
| An **env-gated** test unless it calls a **paid/external** service | tests that don't run are comments (`AGENTS.md` §7 "Live testing is mandatory"); a local server/build prerequisite is *setup*, not a gate |
| Gating on **`… | grep -q passed`** | ignores the process exit code and hides crashes (`AGENTS.md` §7 bullet 4) |
| **Mocking the thing under test** (store/engine/server) | proves nothing about the real component (`AGENTS.md` §7 bullet 1) |
| **Fixed `sleep`** then assert | a latent flake; wait for a condition with a bounded deadline |
| A **permanent silent retry** to green a flaky test | hides a real failure (`AGENTS.md` §7; repo strategy "Gates") |
| An **estimated** coverage/pass number | numbers come from a tool; else say "not measured" |
| Testing against **production** data/store without explicit authority | `AGENTS.md` §10; use `tmp/backlog/**` |

---

## 5. Measured baseline (run at HEAD `7adea399`, 2026-10-05)

Everything below was observed by executing the commands; nothing is estimated. `nx` cache is left
alone (no `--skip-nx-cache`, per `AGENTS.md` §5); the `test` target itself ran.

| Command | Exit | Observed result |
|---------|------|-----------------|
| `npx nx test backlog` (default lane) | **0** | Vitest: **90 files passed / 35 skipped (125)**; **810 tests passed / 1 skipped / 266 `todo` (1077)**; real run **125.92 s**. nx: 43/45 dependency tasks cached; the `test` task ran. |
| `npx nx run backlog:verify-dist-load` | **0** | all **3/3** entry points loaded cleanly: `dist/index.js` (main), `dist/index.mjs` (module), `dist/index.js` (bin present) |
| `npx nx run backlog:e2e` (resource lane) | **0** | **42 files passed / 282 tests passed**; duration **347.07 s** |
| `vitest --coverage` (default lane) | n/a | **coverage not measured** — the default lane produced no coverage artifact |

### Reading the baseline honestly

- **The lanes are green, but the green is thin.** `266 todo` + **35 fully-skipped files** in the
  default lane are the 1:1 `*.spec.ts` stubs for the 42 `e2e` files (the `Resource lane:` separation).
  The heavy behaviour runs in the e2e lane; the default lane's apparent coverage overstates what is
  asserted. Several **high-value** specs are *entirely* `todo`: `src/cli.spec.ts` (52),
  `src/write/catalog-verbs.spec.ts` (34), `src/query/views/registry.spec.ts` (33),
  `src/write/claim.spec.ts` (18), `src/server.verbs.spec.ts` (15),
  `src/store/vocabulary-guard.spec.ts` (10), `src/cli-envelope.spec.ts` (7),
  `src/api.surface.spec.ts` (5), `src/write/cross-process-write-safety.spec.ts` (4),
  `src/server.mcp.spec.ts` (2).
- **The e2e lane passes _while its own negative controls report a real defect_.** From the e2e
  stdout (measured, not inferred):
  - `[cross-process-write-safety] attempted=400 a.ok=200 a.threw=0 b.ok=191 b.threw=9
    combined-ok=391 persisted(fresh reopen)=391 … b.firstError=Write I/O failure: … Database snapshot
    is stale. You must rollback and retry the whole transaction.`
  - `[claim CAS negative control] winners=1 losers=0 unexpected=1 … — DOWNGRADE MANIFESTED AS
    DRIVER-LEVEL CHAOS instead of a clean CAS rejection … the CONTROL case never produces an
    unclassified error at this concurrency level`.
  These are **S07 AC1 signals**: a claim race surfaces as an **unclassified driver error**, not the
  typed `E_CLAIM_HELD`/`conflict` the contract requires, and concurrent writers hit
  `Database snapshot is stale`. The suite is green because the controls assert *visibility*, not
  *clean typed rejection*. This is the first measured, routes-to-a-bucket failure.
- **AC→test traceability is now generated, but nothing is proven yet.** The mapping artifact
  `docs/plan/backlog-consolidation/ac-traceability.json` (generated by
  `entrypoint/backlog/scripts/gen-ac-traceability.mjs`, gated by the `traceability` nx target, §6)
  classifies all **107/107** ACs as **20 bound / 33 unreachable / 54 unbound / 0 proven**. A `bound`
  row is a *candidate* — a real (non-`it.todo`) test file that exercises the surface but does not
  name the AC id; no row records a `red_sha`/`green_sha`, so `proven` is 0. The design corpus is
  still marked `VERIFIED` with no readable test evidence (`73d0b9c6` citations:0) (see §6).
- **The MCP host path is now driven — C-C is PROVEN.** `entrypoint/backlog/src/mcp-host.e2e.ts`
  (4 tests) spawns the **unmodified built server** (`node dist/index.js serve --transport mcp`),
  performs a real `initialize`, then `tools/list` + `tools/call` against a real store, and runs by
  default in the `e2e` lane (exit 0). `entrypoint/backlog/src/contract-matrix.e2e.ts` (6 tests) runs
  the same success/failure envelopes across **both** transports (CLI process + MCP stdio, exit 0).
  (Both files were added after this section's `7adea399` baseline; the table above is the
  pre-ship snapshot.)

---

## 6. Traceability — naming each test after the item/AC, red→green

**Rule:** every behavioural test names the **plan item id** (and AC id where one exists) in its
title and in a machine-readable tag, so a reviewer can go AC → test → evidence. No test is accepted
for an AC it does not name.

**The mapping artifact is now generated.** `docs/plan/backlog-consolidation/ac-traceability.json`
(schema below) is produced by `entrypoint/backlog/scripts/gen-ac-traceability.mjs` and gated by the
`traceability` nx target (wired into `test.dependsOn`): its `--check` mode re-derives every row from
§3, asserts the AC count is still 107, re-checks that every `bound` test file still exists on disk,
and fails when the committed artifact differs from the generated body (drift). As of `f3d9502f` it
classifies all 107 ACs as **20 bound / 33 unreachable / 54 unbound / 0 proven** — every `bound` row
is a *candidate* (a real test file that exercises the surface, not a test that names the AC id), and
none records a `red_sha`/`green_sha`, so `proven` is 0. **Schema:**

```
docs/plan/backlog-consolidation/ac-traceability.json
{
  "schema": 1,
  "generated_from": "<HEAD sha>",
  "bindings": [
    {
      "spec": "S07",
      "ac": "AC1",
      "item": "4679369b",
      "claim": "two processes racing to claim one node yield exactly one claim; a distinct caller gets typed E_CLAIM_HELD",
      "test": "src/write/cross-process-write-safety.e2e.ts::<test name>",
      "level": "cross-process",
      "live": true,
      "negative_control": "src/write/claim.spec.ts::<control name>",
      "red_sha": "<sha where it fails>",
      "green_sha": "<sha where it passes>",
      "evidence": "<command + exit + counts>"
    }
  ]
}
```

**Red→green discipline (non-negotiable):**
- A binding is `unproven` until it records a `red_sha` (fails on the pre-fix base) **and** a
  `green_sha` (passes on the fix). A test that was never seen red is not a regression test.
- An AC with no test is recorded `unreachable` **with the measured reason** (e.g. `rg -F` = 0
  matches for the verb) — never blank, never a green claim.
- The traceability file is **generated**, never hand-curated; a drift check fails when a bound test
  is deleted or renamed. Its computation is a gate (`S05 AC6`: the lane count comes from the real
  suite, not a hard-coded number).

---

## Provenance

- **Schema version 1** (2026-10-05): initial backlog-client verification strategy, authored at HEAD
  `7adea399`. Created because the plan corpus carried 107 unbound AC bullets and a `VERIFIED`
  design corpus with no readable test evidence; the repository-level
  [`docs/TEST-STRATEGY.md`](../../TEST-STRATEGY.md) already contains every required strategy section
  and is **adopted, not duplicated** — this file adds only the backlog-specific claim decomposition,
  matrix, per-spec binding, and measured baseline.
- No secrets, no machine-local absolute paths, no gate the suite cannot enforce, and no clause whose
  trust root is this file: every gate cites a command, an ADR, or a `file:line`.
