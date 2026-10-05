# DEMO — Backlog Consolidation: The Five New Workflows

**A persona-narrated acceptance walkthrough of the target `adhd-backlog` workflow defined by the S01–S12 spec set.**

> **This is an acceptance contract, not a transcript.** The target workflow is **specified but not yet implemented** — Phase 6 (EXECUTE/CLOSE) has not started. Every step in this document is tagged **BUILT** (it runs on today's shipped 29-verb surface) or **SPEC-ONLY** (target behaviour; the command and expected output are shown, and the step is explicitly marked *not yet shipped*). **No passing output is fabricated for a SPEC-ONLY step.** Where an interface is not fixed by the spec corpus, the step carries a `⟦U#⟧` stub and a row in the sibling `UNRESOLVED.md`.

---

## 0. How to Read This Demo

| Marker | Meaning |
|--------|---------|
| **BUILT** | The verb/flag/output exists on the shipped surface today (ADR-0006, 29 verbs + `batch action`). Running the exact command reproduces the exact expected output. |
| **SPEC-ONLY** | The target behaviour from S01–S12. The command is the *specified* interface and the output is the *expected* result **once implemented**. Label reads **not yet shipped** — do not treat the expected output as observed. |
| `(happy)` | The primary success path. |
| `(edge)` | A boundary, ambiguity, concurrency, or negative-input path. |
| `(recovery)` | A path where the system is in a degraded/stale/failed state and must recover gracefully. |
| `⟦U#⟧` | A guessed interface (shape, name, or error-code literal not fixed by the spec corpus). One matching row in `UNRESOLVED.md`. Never appears inside a runnable command or literal. |
| `📎 Source` | What grounds the step: a spec §/AC, an ADR, a research note, or a live-probed fact. Every beat names its source. |

**Reading order.** §1–§2 establish the persona, fixture, and prerequisites. §3–§7 are the five workflows (W1–W5), each an Act of beats. §8 is the climax, §9 the adversarial sweep, §10 teardown, §11 the traceability matrix, §12 the sign-off table.

**Consumer read path.** The real consumer surface is the `adhd-backlog` CLI: one `--input '<json>'` per verb; read the `{"ok":...}` envelope on `stdout`; success exits `0`, failure exits non-zero. `--namespace <production|test|sandbox>` is a global flag valid before any verb.

---

## 1. Cold Open

A platform team has been running the adhd backlog for eight months. Three bugs are filed for the *same* root cause under three different titles. Two epics claim to own the same package. A ticket was closed last week with a commit hash in the note — but the fix never merged. And nobody can answer "who is holding which file right now?" without scrolling `git log`.

The **Backlog Consolidation** initiative (S01–S12) is a twelve-spec programme that turns the backlog from a pile of rows into a *self-defending knowledge graph*: it surfaces collisions at write time, resolves identity through a redirect chain, persists who-holds-what as durable claim intervals, refuses to close work whose obligations are unmet, and mints an immutable, content-addressed snapshot of every completed plan subtree.

**Tonight's demo follows Priya, a staff engineer**, through five real workflows:

1. **W1** — Filing a bug and discovering it collides with two existing tickets, before it lands.
2. **W2** — Pasting a truncated uid and getting a candidate set instead of a silent wrong match; merging a duplicate into a canonical ticket.
3. **W3** — Claiming work and answering "which files does this session hold?" from the store, with a timeline of every op.
4. **W4** — Trying to close a ticket whose required `published-artifact` evidence is missing, and being refused with a typed reason.
5. **W5** — Completing the last ticket in a plan subtree and having the immutable completion snapshot minted in the same transaction.

We will run each workflow **against today's shipped CLI** where it exists, and walk the **specified** commands where it does not — always labelled.

---

## 2. Cast, World & Cold Start

### 2.1 Persona

**Priya Raman — Staff Engineer, Platform.** Priya files and triages bugs daily, occasionally owns a plan subtree, and is the person the team asks when two tickets look like the same thing. Her goal: *never lose work to a duplicate, a false closure, or an ambiguous id again.* Actor identity on every mutating verb is `demo-pm:0001` (the `${agentName}:${instanceId}` format the CLI requires in `by`).

### 2.2 Canonical dataset

All fixture data is defined here once and reused by every beat. Titles are prefixed `DEMO:` so teardown is unambiguous.

| Symbol | Value |
|--------|-------|
| Project | `demo-collision-lab` (path `packages/demo-collision-lab`) |
| Item **A** | `DEMO: flaky auth token refresh on iOS` — `kind: bug`, `priority: high` |
| Item **B** | `DEMO: iOS session drops after token refresh` — near-duplicate of A |
| Item **C** | `DEMO: cache invalidation misses nested keys` — unrelated control |
| Plan item **P** | `DEMO: plan — auth hardening` — the subtree whose completion is snapshotted (W5) |
| Session | `demo-session-0001`, agent `demo-pm` |
| Actor | `demo-pm:0001` |

### 2.3 Prerequisites

- `adhd-backlog` on `PATH` (verified at `/Users/nix/.nvm/versions/node/v24.11.1/bin/adhd-backlog`).
- `python3` available (used only to extract a uid from one step into the next variable).
- A `test` namespace available (a persisted, non-production store). **`sandbox` is a fresh throwaway minted per invocation and cannot carry state between commands, so every multi-step flow uses `--namespace test`.**
- Embedding is **disabled by default**; the CLI prints a stderr notice. Semantic collision detection (W1) is therefore *degraded* on today's default build — this is load-bearing for W1 and is called out in its beats.

### 2.4 Cold start

Every beat that needs a variable first defines it. Run this once; it sets the binary path and shell helper.

```bash
B=/Users/nix/.nvm/versions/node/v24.11.1/bin/adhd-backlog
u() { python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["uid"])'; }
```

**Verify:** `$B --namespace test sandbox-path` prints the resolved store path for the `test` namespace and exits 0.

- [ ] Command exits 0 and prints an envelope whose `data.dbPath` ends in the test store.
- [ ] No production store path is printed.

---

## 3. Act I — W1: Create/Update Collision Surfacing

*Priya files her bug and wants the system to tell her — before it lands — that it looks like two tickets already in the store. The detection has three sites: create-time (SITE 1), update-time (SITE 2), and a read-only view (SITE 3).*

#### 🎬 Scene 1.1 — Stand up the lab and file item A (happy)

**Status: BUILT** — `upsert-project` + `create` are on the shipped surface.

▶️ Do
```bash
PID=$($B --namespace test upsert-project --input '{"name":"demo-collision-lab","path":"packages/demo-collision-lab","by":"demo-pm:0001"}' 2>/dev/null | u)
AUID=$($B --namespace test create --input "{\"title\":\"DEMO: flaky auth token refresh on iOS\",\"body\":\"Token refresh intermittently 401s on iOS after backgrounding.\",\"project\":\"$PID\",\"kind\":\"bug\",\"priority\":\"high\",\"by\":\"demo-pm:0001\"}" 2>/dev/null | u)
echo "PID=$PID AUID=$AUID"
```

👀 Expect — two envelopes on stdout. `upsert-project` returns `{"ok":true,"data":{"uid":...,"created":true,"project":{...}}}`; `create` returns `{"ok":true,"data":{"created":true,"uid":...,"item":{"kind":"BUG","status":"open","priority":"high",...},"placementResolved":"default-root"}}`. Note `kind` is **uppercased** (`bug` → `BUG`) and a default component is auto-created. The final `echo` prints non-empty `PID` and `AUID`.

✅ Verify
- [ ] Both commands exit 0.
- [ ] The create envelope's `data.item.kind` equals `BUG` (uppercase).
- [ ] `echo` prints non-empty `PID` and `AUID`.

🔗 Proves: REQ-001, CAP-001
📎 Source: BUILT — live probe of `adhd-backlog create` / `upsert-project` (observed output shapes).

#### 🎬 Scene 1.2 — File the near-duplicate B (edge)

**Status: BUILT (with a documented gap)** — `create` is shipped; **the fused collision scan does not fire when embeddings are disabled**, so today B is created with no collision warning.

▶️ Do
```bash
BUID=$($B --namespace test create --input "{\"title\":\"DEMO: iOS session drops after token refresh\",\"body\":\"After a token refresh on iOS the session drops and the user is logged out.\",\"project\":\"$PID\",\"kind\":\"bug\",\"priority\":\"high\",\"by\":\"demo-pm:0001\"}" 2>/dev/null | u)
echo "BUID=$BUID"
```

👀 Expect — `create` succeeds: `{"ok":true,"data":{"created":true,"uid":...,...}}`, exit 0.

✅ Verify
- [ ] Create exits 0 and returns `data.created: true`.
- [ ] **Gap assertion:** the envelope carries **no** `warnings[]` array and no duplicate advisory — because the embedding-backed scan is off by default (stderr prints `embedding is DISABLED`).

🔗 Proves: REQ-004, CAP-002
📎 Source: BUILT + ADR-0006 — live probe; default-off embedding notice observed on stderr.

#### 🎬 Scene 1.3 — Create-time RRF-fused collision scan (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (research R1a / SITE 1): `create` runs a reciprocal-rank-fusion scan (`score = Σ 1/(k+rank_i)` over the semantic + keyword + structural signals) and returns advisory `warnings[]` on a still-`ok:true` envelope. The raw cosine stays the gate (default `0.8`); same-project collisions default to `abort | force | comment`.

▶️ Do
```bash
# SPEC-ONLY: expected interface once S03 collision detection ships.
$B --namespace test create --input "{\"title\":\"DEMO: iOS auth token refresh failing\",\"body\":\"Auth refresh failing on iOS.\",\"project\":\"$PID\",\"kind\":\"bug\",\"priority\":\"high\",\"duplicateAction\":\"comment\",\"by\":\"demo-pm:0001\"}"
```

👀 Expect (target) — `{"ok":true,"data":{"created":true,"uid":...,"warnings":[{"kind":"collision","score_kind":"rrf","score":0.0319,"candidateUid":"<A-or-B-uid>","cosine":0.83,"scope":"same-project","suggestedAction":"comment"}]},"..."}` and exit 0. The envelope stays `ok:true`; the warning is advisory.

✅ Verify
- [ ] *(target)* Envelope is `ok:true` and carries a `warnings[]` entry of `kind: "collision"`.
- [ ] *(target)* The warning carries `score_kind: "rrf"` and a `cosine` below/above the `0.8` gate as appropriate.
- [ ] *(target)* No item is auto-merged; `created: true` for the new uid.

🔗 Proves: REQ-004, CAP-002
📎 Source: SPEC-ONLY — SPEC-SET S03; research `collision-detection-strategy.md` SITE 1 / R1a. Advisory `warnings[]` entry shape inferred ⟦U2⟧.

#### 🎬 Scene 1.4 — Update-time advisory scan (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (research R1b / SITE 2): when `update` touches a **body**, the same scan runs **before the write transaction**, is **advisory by default**, respects supersede semantics (excludes the node's own soon-superseded set and its `part_of` ancestors via `dedupeExcludeUid`), and **does not run on citation-only edits** (`citeOnlyIsNotSupersede`).

▶️ Do
```bash
# SPEC-ONLY: expected interface once the update-time scan ships.
$B --namespace test update --input "{\"uid\":\"$BUID\",\"body\":\"Token refresh on iOS logs the user out; same symptom as the flaky refresh bug.\",\"by\":\"demo-pm:0001\"}"
```

👀 Expect (target) — `{"ok":true,"data":{"uid":"<BUID>","updatedFields":["body"]},"warnings":[{"kind":"collision","score_kind":"rrf","candidateUid":"<AUID>","scope":"same-project","suggestedAction":"comment"}]}`. Exit 0; the edit is **not** blocked.

✅ Verify
- [ ] *(target)* Update exits 0 and reports `body` in `updatedFields`.
- [ ] *(target)* A `warnings[]` collision entry names the candidate uid.
- [ ] *(target)* A subsequent **citation-only** `update` (body untouched) returns **no** collision warning (`citeOnlyIsNotSupersede`).

🔗 Proves: REQ-005, CAP-003
📎 Source: SPEC-ONLY — research `collision-detection-strategy.md` SITE 2 / R1b. `warnings[]` entry shape inferred ⟦U2⟧.

#### 🎬 Scene 1.5 — Read-only `collisions` view (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (research R1c / SITE 3): a **read-only** view that never blocks, unioning semantic clusters (union-find over `similar_to`), write-scope overlaps (reusing `view:"overlap"` on axis `file`), and `blocks` cycles.

▶️ Do
```bash
# SPEC-ONLY: the collisions view is not in today's view enum.
$B --namespace test query --input "{\"view\":\"collisions\",\"filter\":{\"project\":\"$PID\"}}"
```

👀 Expect (target) — `{"ok":true,"data":{"collisions":[{"kind":"semantic","members":["<AUID>","<BUID>"],"score_kind":"rrf","score":0.0319},{"kind":"write-scope","axis":"file","path":"packages/demo-collision-lab/src/token.ts","members":["<AUID>"]}],"meta":{"total":2,"returned":2,"truncated":false,"has_more":false}}}`.

✅ Verify
- [ ] **Today (negative control):** the command exits **2** with `error.code: "invalid_argument"` — `collisions` is not in the view enum.
- [ ] *(target)* Once shipped: exit 0, `data.collisions` is an array, and every element carries a `kind`.

🔗 Proves: REQ-006, CAP-004
📎 Source: SPEC-ONLY — research `collision-detection-strategy.md` SITE 3 / R1c. Response object shape inferred ⟦U3⟧. Negative control **verified live** (exit 2).

#### 🎬 Scene 1.6 — Today's read views that DO answer collision questions (edge)

**Status: BUILT** — `query` supports `view:"similar"` and `view:"overlap"` today (narrower than the target `collisions` view).

▶️ Do
```bash
$B --namespace test query --input "{\"view\":\"overlap\",\"overlapAxis\":\"file\",\"overlapUids\":[\"$AUID\",\"$BUID\"],\"filter\":{\"project\":\"$PID\"}}"; echo "exit=$?"
$B --namespace test query --input "{\"view\":\"similar\",\"anchor\":\"$AUID\",\"filter\":{\"project\":\"$PID\"}}"; echo "exit=$?"
```

👀 Expect — both exit 0 with an `ok:true` envelope. `overlap` on axis `file` groups by cited file; `similar` returns semantic neighbours of A.

✅ Verify
- [ ] `overlap` exits 0 and accepts `overlapAxis: "file"` (the only currently-supported axes are `file|project|component|author`).
- [ ] `similar` exits 0 and returns an `ok:true` envelope.

🔗 Proves: REQ-002, REQ-003, CAP-001
📎 Source: BUILT — ADR-0006 frozen surface; `query` `view` enum observed live.

---

## 4. Act II — W2: Identity Resolution

*Priya pastes a truncated uid from a Slack message. She needs the system to refuse to guess, offer candidates, and — once she merges a duplicate — resolve the old uid forever through a redirect chain.*

#### 🎬 Scene 2.1 — Ambiguous uid prefix returns a candidate set (edge)

**Status: BUILT (partial)** — today an ambiguous prefix is refused with `ambiguous_reference`; the explicit *candidate set* payload is the S02 target.

▶️ Do
```bash
# Two items created above share no prefix in this fixture; use the full uid's first 8 chars
# to show the accept path, then a deliberately ambiguous synthetic prefix path.
$B --namespace test get --input "{\"uid\":\"${AUID:0:8}\",\"fields\":[\"uid\",\"title\"]}"; echo "exit=$?"
```

👀 Expect — resolving a **unique** 8-hex prefix succeeds: `{"ok":true,"data":{"uid":"<full-A-uid>","title":"DEMO: flaky auth token refresh on iOS"}}`, exit 0.

✅ Verify
- [ ] An 8-character unique prefix resolves to the full uid and exits 0.
- [ ] *(target)* When a prefix is ambiguous, the refusal carries a **candidate set** rather than a silent first match.

🔗 Proves: REQ-007, CAP-005
📎 Source: BUILT — ADR-0006 (uid prefix, `ambiguous_reference`); candidate-set payload is S02 AC1 target.

#### 🎬 Scene 2.2 — Too-short prefix is refused, not guessed (edge)

**Status: BUILT** — the shipped guard.

▶️ Do
```bash
$B --namespace test get --input '{"uid":"9","fields":["uid"]}' 2>/dev/null; echo "exit=$?"
```

👀 Expect — `{"ok":false,"error":{"code":"invalid_argument","message":"... uid prefix \"9\" is too short — a uid prefix must be at least 8 characters (or pass the full uid)","details":{"retryable":false}}}`, exit **2**.

✅ Verify
- [ ] Exit code is **2**.
- [ ] `error.code` is `invalid_argument` (not a silent match to the first id starting with `9`).

🔗 Proves: REQ-007, CAP-005
📎 Source: BUILT — live probe of the shipped prefix guard.

#### 🎬 Scene 2.3 — Merge a duplicate into the canonical ticket (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S02 AC2/AC3): merge writes exactly **one `Redirect` row**, **soft-retires** the source (never hard-deletes), and a cross-project link requires an explicit `link-duplicate {sourceUid,targetUid,by,reason}`.

▶️ Do
```bash
# SPEC-ONLY: merge/redirect is the S02 target; today only duplicate_of edges via `relate` exist.
$B --namespace test link-duplicate --input "{\"sourceUid\":\"$BUID\",\"targetUid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"reason\":\"same-root-cause\"}"
```

👀 Expect (target) — `{"ok":true,"data":{"redirectUid":"<new-redirect-uid>","from":"<BUID>","to":"<AUID>","softRetired":true}}`.

✅ Verify
- [ ] *(target)* The result names a single redirect row and `softRetired: true`.
- [ ] *(target)* The source uid is **not** in any hard-delete result; a later `get` on the source uid resolves to the chain head.

🔗 Proves: REQ-008, CAP-006
📎 Source: SPEC-ONLY — SPEC-SET S02 AC2/AC3 (`link-duplicate` input is spec-given). Verb name/input shape confirmed by spec; runtime payload fields beyond `{from,to}` inferred ⟦U4⟧.

#### 🎬 Scene 2.4 — A stale uid resolves through the redirect chain (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S02 AC4): **every** uid-taking verb resolves through the `SUPERSEDES`/`Redirect` chain, so the retired source uid keeps working.

▶️ Do
```bash
# SPEC-ONLY: expected once S02 identity resolution ships.
$B --namespace test get --input "{\"uid\":\"$BUID\",\"fields\":[\"uid\",\"title\"]}"
```

👀 Expect (target) — `{"ok":true,"data":{"uid":"<AUID>","title":"DEMO: flaky auth token refresh on iOS","resolvedFrom":"<BUID>"}}`.

✅ Verify
- [ ] *(target)* Resolving the retired uid returns the **chain-head** item, not the retired one.
- [ ] *(target)* The response surfaces `resolvedFrom` (or equivalent) so the caller sees the redirect happened.

🔗 Proves: REQ-009, CAP-007
📎 Source: SPEC-ONLY — SPEC-SET S02 AC4. (`SUPERSEDES`/`duplicate_of` edges are only visible via `get fields:["auditTrail"]` today; `fields:["related"]` deliberately excludes them — ADR-0006.)

---

## 5. Act III — W3: Reservation & Timeline

*Priya claims a ticket. She then needs two questions answered from the store alone: "which files does this session hold right now?" and "what did this session actually do, in order?"*

#### 🎬 Scene 3.1 — Claim writes a durable audit row (happy)

**Status: BUILT** — `claim` is shipped and appends an audit row.

▶️ Do
```bash
$B --namespace test claim --input "{\"uid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"action\":\"claim\"}"; echo "exit=$?"
$B --namespace test get --input "{\"uid\":\"$AUID\",\"fields\":[\"auditTrail\"]}"
```

👀 Expect — `claim` → `{"ok":true,"data":{"uid":"<AUID>","status":"claimed","claimedBy":"demo-pm:0001","claimedAt":"<iso>"}}` exit 0. `get` → `{"ok":true,"data":{"uid":"<AUID>","auditTrail":[...,{"action":"claimed","to":"demo-pm:0001",...}]}}`.

✅ Verify
- [ ] `claim` exits 0 and reports `status: "claimed"`.
- [ ] `auditTrail` includes an entry with `action: "claimed"` and `to: "demo-pm:0001"`.

🔗 Proves: REQ-010, CAP-008
📎 Source: BUILT — **live probe**; note this corrects S11 R1's premise ("auditTrail shows no claim rows").

#### 🎬 Scene 3.2 — Durable claim interval with lease, session and paths (edge)

**Status: SPEC-ONLY — not yet shipped (S11 R1).** The audit row above records *that* a claim happened, but **not** a claim **interval**: no `path(s)`, no `session id`, no `leaseExpiry`. S11 R1 requires the interval to survive a store reopen.

▶️ Do
```bash
# SPEC-ONLY: expected interval record once S11 ships.
$B --namespace test get --input "{\"uid\":\"$AUID\",\"fields\":[\"claimInterval\"]}"
```

👀 Expect (target) — `{"ok":true,"data":{"uid":"<AUID>","claimInterval":{"holder":"demo-pm:0001","sessionId":"demo-session-0001","paths":["packages/demo-collision-lab/src/token.ts"],"claimedAt":"<iso>","leaseExpiry":"<iso>"}}}`. Reopening the store returns the identical interval.

✅ Verify
- [ ] *(target)* The interval carries `holder`, `sessionId`, `paths[]`, `claimedAt`, and `leaseExpiry`.
- [ ] *(target)* After a store reopen the interval is still present and identical.

🔗 Proves: REQ-010, CAP-008
📎 Source: SPEC-ONLY — SPEC-SET S11 R1. Field name `claimInterval` inferred ⟦U5⟧; the *value shape* is spec-given.

#### 🎬 Scene 3.3 — `reservations` view answers "who holds what" (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S11 R2/R3): `view:"reservations"` returns **per active claim**, store-wide, and the same read answers which files the session holds.

▶️ Do
```bash
# SPEC-ONLY: reservations is not in today's view enum.
$B --namespace test query --input "{\"view\":\"reservations\",\"filter\":{\"project\":\"$PID\",\"pathPrefix\":\"packages/demo-collision-lab\"}}"
```

👀 Expect (target) — `{"ok":true,"data":{"reservations":[{"itemUid":"<AUID>","holder":"demo-pm:0001","sessionId":"demo-session-0001","paths":["packages/demo-collision-lab/src/token.ts"],"leaseExpiry":"<iso>"}],"meta":{"total":1,"returned":1,"has_more":false}}}`.

✅ Verify
- [ ] **Today (negative control):** the command exits **2** with `error.code: "invalid_argument"` — `reservations` is not in the view enum.
- [ ] *(target)* Once shipped: exit 0 and each entry carries `itemUid`, `holder`, `sessionId`, `paths[]`.
- [ ] *(target)* The same view satisfies R3 (files held by a session).

🔗 Proves: REQ-011, CAP-009
📎 Source: SPEC-ONLY — SPEC-SET S11 R2/R3. Negative control **verified live** (exit 2).

#### 🎬 Scene 3.4 — `timeline <session>` with child-session rollup (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S11 S1–S4): a first-class session node and an append-only **op-event log** (for every mutating verb), read back by `adhd-backlog timeline <session>`, with child-session rollup.

▶️ Do
```bash
# SPEC-ONLY: `timeline` is an unknown command today.
$B --namespace test timeline --input '{"session":"demo-session-0001"}'; echo "exit=$?"
```

👀 Expect (target) — an ordered op list: `{"ok":true,"data":{"sessionId":"demo-session-0001","agent":"demo-pm","events":[{"t":"<iso>","op":"create","target":"<AUID>"},{"t":"<iso>","op":"claim","target":"<AUID>"}],"recordsTouched":["<AUID>"],"children":[]}}`.

✅ Verify
- [ ] **Today (negative control):** `timeline` is an **unknown command** → `{"ok":false,"error":{"code":"not_found",...}}`, exit **4**.
- [ ] *(target)* Once shipped: exit 0, `data.events` is ordered, and `data.childSessions[]` rolls up children.

🔗 Proves: REQ-012, REQ-013, CAP-010
📎 Source: SPEC-ONLY — SPEC-SET S11 S1–S4. Negative control **verified live** (exit 4).

#### 🎬 Scene 3.5 — A lapsed lease is not reported active (edge)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S11 R4): once `leaseExpiry` passes, the claim is not returned as active.

▶️ Do
```bash
# SPEC-ONLY: expected once reservations + lease expiry ship.
$B --namespace test query --input "{\"view\":\"reservations\",\"filter\":{\"project\":\"$PID\"}}"
```

👀 Expect (target) — after the lease expires, the lapsed claim is **absent** from `data.reservations` (or flagged `active:false`), never returned as a live reservation.

✅ Verify
- [ ] *(target)* A lapsed lease does not appear as an active reservation.
- [ ] *(target)* The item itself is untouched — only the reservation lapses.

🔗 Proves: REQ-010, REQ-011
📎 Source: SPEC-ONLY — SPEC-SET S11 R4.

---

## 6. Act IV — W4: Terminal Closure Gate

*Priya tries to close a ticket. Policy says: a `published-artifact` obligation of severity `block` must be satisfied first. A commit hash in the note is **not** a published artifact.*

#### 🎬 Scene 4.1 — Attach a `block` obligation (happy)

**Status: BUILT** — `obligate` is shipped and returns an `obligationUid`.

▶️ Do
```bash
OID=$($B --namespace test obligate --input "{\"uid\":\"$AUID\",\"applies_to\":{\"to\":\"closed\"},\"requirement\":{\"op\":\"evidence\",\"kind\":\"published-artifact\",\"min\":1},\"on_fail\":\"block\",\"by\":\"demo-pm:0001\"}" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["obligationUid"])')
echo "OID=$OID"
```

👀 Expect — `{"ok":true,"data":{"uid":"<AUID>","obligationUid":"<uuid>"}}`, exit 0; `OID` is non-empty.

✅ Verify
- [ ] `obligate` exits 0 and returns a non-empty `obligationUid`.
- [ ] The predicate core is the closed grammar (`evidence{kind,min?}`, `blockers_terminal()`, `relation{...}`, `all_of`, `any_of`, `not`) — no free-form expression.

🔗 Proves: REQ-014, CAP-011
📎 Source: BUILT — live probe of `obligate`; predicate grammar per SPEC-SET S05 AC1.

#### 🎬 Scene 4.2 — Unsatisfied `block` obligation refuses closure (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S05 AC2): a terminal transition with an unsatisfied `block` obligation is **refused** with a typed `{code, required_kind}` refusal. **Today the gate is absent** — this is the highest-severity gap in the corpus.

▶️ Do
```bash
# SPEC-ONLY: expected once the closure gate ships.
$B --namespace test transition --input "{\"uid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"toStatus\":\"closed\",\"note\":\"closing; commit deadbeef only\"}"; echo "exit=$?"
```

👀 Expect (target) — `{"ok":false,"error":{"code":"precondition_failed","message":"Terminal transition refused: unsatisfied block obligation.","required_kind":"published-artifact","details":{"obligationUid":"<OID>"}}}`, exit non-zero.

✅ Verify
- [ ] **Today (negative control, VERIFIED LIVE):** the transition **succeeds** — `{"ok":true,"data":{"toStatus":"closed","closedAt":"<iso>"}}`, exit 0 — proving the gate does **not** yet bite.
- [ ] *(target)* Once shipped: the refusal carries both an error `code` and a `required_kind`.

🔗 Proves: REQ-014, CAP-011
📎 Source: SPEC-ONLY — SPEC-SET S05 AC2. Negative control **verified live**. Exact refusal `code`/`required_kind` literal inferred ⟦U1⟧.

#### 🎬 Scene 4.3 — A commit ref alone does not satisfy `published-artifact` (edge)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S05 AC2): the evidence must be an actual published artifact; a bare commit hash is insufficient.

▶️ Do
```bash
# SPEC-ONLY: expected once the gate ships.
$B --namespace test attest --input "{\"subject\":{\"id\":\"$AUID\",\"revision\":1},\"claim\":{\"kind\":\"published-artifact\",\"body\":\"commit deadbeef\"},\"anchor\":{\"locator\":\"commit:deadbeef\",\"digest\":\"<hex>\"},\"by\":\"demo-pm:0001\"}"
$B --namespace test transition --input "{\"uid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"toStatus\":\"closed\"}"; echo "exit=$?"
```

👀 Expect (target) — the commit-anchored attestation is recorded but the transition is **still refused** (`required_kind: "published-artifact"`): a `commit:` anchor is not a registry/published artifact.

✅ Verify
- [ ] *(target)* The transition remains refused after a commit-only attestation.
- [ ] *(target)* Only a genuine published-artifact evidence kind satisfies the obligation.

🔗 Proves: REQ-014, CAP-011
📎 Source: SPEC-ONLY — SPEC-SET S05 AC2. (Anchor grammar `path:|url:|query:|registry:|commit:` per spec; refusal literal inferred ⟦U1⟧.)

#### 🎬 Scene 4.4 — Verdict is derived on read, never stored (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S05 AC3): a `Verdict`/`Condition` is **computed on read** from live obligations + attestations; it is never persisted, so mutating an obligation changes the verdict with no separate write.

▶️ Do
```bash
# SPEC-ONLY: expected once derived verdicts ship.
$B --namespace test get --input "{\"uid\":\"$AUID\",\"fields\":[\"verdict\"]}"
```

👀 Expect (target) — `{"ok":true,"data":{"uid":"<AUID>","verdict":{"state":"blocked","conditions":[{"obligationUid":"<OID>","required_kind":"published-artifact","satisfied":false}]}}}`.

✅ Verify
- [ ] *(target)* `verdict` reflects the **current** obligation set.
- [ ] *(target)* After `unobligate`-ing the blocker, a re-read shows the verdict changed **with no new revision row**.

🔗 Proves: REQ-015, CAP-012
📎 Source: SPEC-ONLY — SPEC-SET S05 AC3.

---

## 7. Act V — W5: State-Revision Mint

*Priya completes the last ticket in a plan subtree. The system must mint an immutable, content-addressed snapshot of the whole subtree in the same transaction — and the read path must return the *payload*, not just a pointer.*

#### 🎬 Scene 5.1 — Terminal transition mints a revision in the same tx (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E1/E3): when a terminal transition lands on an item in a plan subtree, a content-addressed **state-revision node** is minted (via an internal `has_state_revision` edge) in the **same transaction**; the ticket uid is preserved; no prior revision is rewritten; mint-or-skip is non-blocking.

▶️ Do
```bash
# SPEC-ONLY: expected once S12 state-revision minting ships.
PUID=$($B --namespace test create --input "{\"title\":\"DEMO: plan — auth hardening\",\"body\":\"plan subtree\",\"project\":\"$PID\",\"kind\":\"plan\",\"by\":\"demo-pm:0001\"}" 2>/dev/null | u)
$B --namespace test transition --input "{\"uid\":\"$PUID\",\"by\":\"demo-pm:0001\",\"toStatus\":\"closed\",\"note\":\"all children complete\"}"
```

👀 Expect (target) — `{"ok":true,"data":{"uid":"<PUID>","toStatus":"closed","stateRevision":"<revision-uid>","stateRevisionToken":"sha256:<hex>","stateRevisionSeq":1}}`.

✅ Verify
- [ ] *(target)* The response carries a `stateRevision` uid plus a `stateRevisionToken`.
- [ ] *(target)* The ticket uid is unchanged (the revision is a new node, not a rewrite).
- [ ] *(target)* A second completion does not rewrite the first revision.

🔗 Proves: REQ-016, CAP-013
📎 Source: SPEC-ONLY — SPEC-SET S12 E1/E3; research `completed-state-representation.md`.

#### 🎬 Scene 5.2 — The payload is a chained, canonical ledger (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E2): the payload is a canonical sorted-key ledger chained by `parent_revision` (`null` on the first), including `expected`, `dispositions`, `coverage_proof`, and per-requirement `spec_revision`.

▶️ Do
```bash
# SPEC-ONLY: expected once state-revision payloads ship.
$B --namespace test get --input "{\"uid\":\"$PUID\",\"fields\":[\"stateRevisionPayload\"]}"
```

👀 Expect (target) — `{"as_of":"<iso>","scope":{"plan_uid":"<PUID>","predicate":"part_of"},"revision":"<n>","parent_revision":null,"expected":{"total":1,"completed":1,"remaining":0,"byKind":[],"byPriority":[],"byStatus":[]},"dispositions":{},"coverage_proof":{"sum":1,"frozen_total":1,"balanced":true},"requirements":[{"uid":"<AUID>","spec_revision":"sha256:<hex>"}],"token":"sha256:<hex>"}`.

✅ Verify
- [ ] *(target)* The payload is chained by `parent_revision` (`null` first, prior revision otherwise).
- [ ] *(target)* `coverage_proof.balanced` is `true` when `sum == frozen_total`.
- [ ] *(target)* Keys are canonically sorted so the token is stable across runs.

🔗 Proves: REQ-017, CAP-013
📎 Source: SPEC-ONLY — SPEC-SET S12 E2; research `completed-state-representation.md`.

#### 🎬 Scene 5.3 — A stale base is refused (CAS), nothing written (edge)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E3): the mint compares-and-swaps against the base revision; a stale base returns `precondition_failed` and **writes nothing**. Two concurrent completions of the same fold yield **one** token, with latch/barrier (no lock).

▶️ Do
```bash
# SPEC-ONLY: expected once CAS minting ships.
$B --namespace test spec-check --input "{\"uid\":\"$PUID\",\"token\":\"sha256:deadbeef\"}"; echo "exit=$?"
```

👀 Expect (target) — `{"ok":false,"error":{"code":"precondition_failed","message":"state-revision base token does not match current head","details":{"expected":"sha256:<current>","got":"sha256:deadbeef"}}}`, exit non-zero, and **no** revision node added.

✅ Verify
- [ ] *(target)* A non-matching base token returns `precondition_failed`.
- [ ] *(target)* Nothing is written (`revision` unchanged after the failed attempt).
- [ ] *(target)* Two latched concurrent completions produce a single token.

🔗 Proves: REQ-018, CAP-015
📎 Source: SPEC-ONLY — SPEC-SET S12 E3 (`ADHD_BACKLOG_UNSAFE_STATE_REVISION=skip` is the negative-control flag).

#### 🎬 Scene 5.4 — B1 closed: the read returns the fragment, not a pointer (happy)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E4; closes recorded absence B1 = item `34b69c69`): `get` returns the **payload + current token**, never a pointer-only stub, via an additive field or a `state-get` verb.

▶️ Do
```bash
# SPEC-ONLY: expected once the B1 reader path ships.
$B --namespace test get --input "{\"uid\":\"$PUID\",\"fields\":[\"stateRevisionPayload\"]}"
```

👀 Expect (target) — the response contains the full `stateRevisionPayload` object **and** a `token`, not just a `stateRevision` uid.

✅ Verify
- [ ] *(target)* The read returns the payload fragment, not a pointer.
- [ ] *(target)* The returned token lets the caller verify freshness.

🔗 Proves: REQ-019, CAP-014
📎 Source: SPEC-ONLY — SPEC-SET S12 E4 / S04 AC3. Additive field name inferred ⟦U5⟧.

#### 🎬 Scene 5.5 — A non-matching token reads as stale, never silently fresh (recovery)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E4): if the caller's token does not match the current head, the read reports **stale** — it never silently claims freshness.

▶️ Do
```bash
# SPEC-ONLY: expected once the staleness ladder ships.
$B --namespace test get --input "{\"uid\":\"$PUID\",\"fields\":[\"stateRevisionPayload\"],\"expectedToken\":\"sha256:stale\"}"; echo "exit=$?"
```

👀 Expect (target) — `{"ok":false,"error":{"code":"stale","message":"state revision token does not match current head","details":{"current":"sha256:<hex>"}}}`, exit non-zero. Degrades to `unknown` when git ancestry cannot be established — never fabricates "fresh".

✅ Verify
- [ ] *(target)* A mismatched token yields a `stale` error, not a fresh payload.
- [ ] *(target)* When ancestry is unknowable the state degrades to `unknown`, never `fresh`.

🔗 Proves: REQ-019, CAP-014
📎 Source: SPEC-ONLY — SPEC-SET S12 E4; research `completed-state-representation.md` (staleness ladder). Exact `stale` code literal inferred ⟦U6⟧.

#### 🎬 Scene 5.6 — No stored verdict; the read derives it live (edge)

**Status: SPEC-ONLY — not yet shipped.** Target behaviour (S12 E5): a mutating `obligate` after a snapshot **changes the derived verdict without minting a new revision**.

▶️ Do
```bash
# SPEC-ONLY: expected once derived verdicts + revisions ship together.
$B --namespace test obligate --input "{\"uid\":\"$AUID\",\"applies_to\":{\"to\":\"closed\"},\"requirement\":{\"op\":\"evidence\",\"kind\":\"published-artifact\",\"min\":1},\"on_fail\":\"warn\",\"by\":\"demo-pm:0001\"}"
$B --namespace test get --input "{\"uid\":\"$PUID\",\"fields\":[\"verdict\"]}"
```

👀 Expect (target) — the verdict changes on re-read; **no** new revision node is minted (the snapshot is immutable; only the derived view moves).

✅ Verify
- [ ] *(target)* The derived verdict reflects the new obligation.
- [ ] *(target)* `stateRevisionSeq` is **unchanged** by the obligation mutation.

🔗 Proves: REQ-020, CAP-012
📎 Source: SPEC-ONLY — SPEC-SET S12 E5.

---

## 8. Climax — The Chain Holds

The payoff is not any single verb; it is that **the snapshot chain is honest**. Priya can hold a `sha256:` token from three sprints ago and the store will tell her — deterministically — whether the subtree still matches it, without ever rewriting history.

#### 🎬 Scene 8.1 — Walk the revision chain to prove immutability (happy)

**Status: SPEC-ONLY — not yet shipped.**

▶️ Do
```bash
# SPEC-ONLY: expected once the chain is readable.
$B --namespace test get --input "{\"uid\":\"$PUID\",\"fields\":[\"stateRevisionPayload\"],\"deriveThrough\":2}"
```

👀 Expect (target) — a chain of ≥2 payloads linked by `parent_revision`, head first, each with a distinct `token` and monotonically increasing `revision`.

✅ Verify
- [ ] *(target)* Every non-head link's `parent_revision` equals the prior link's `revision`.
- [ ] *(target)* No revision in the chain has been mutated after minting (token stability).
- [ ] *(target)* Only the head is referenced by the plan item's mutable pointer.

🔗 Proves: REQ-017, CAP-013
📎 Source: SPEC-ONLY — SPEC-SET S12 E2/E4; research `completed-state-representation.md`.

---

## 9. Resilience Sweep

Adversarial and degraded paths that did not fit the story, plus the *shipped* negative controls that prove the target surface is genuinely absent.

#### 🎬 Scene 9.1 — The four absent surfaces are typed errors today (edge)

**Status: BUILT (negative controls)**. This is the acceptance proof that W1/W3/W4's target surfaces are **not yet implemented**.

▶️ Do
```bash
$B --namespace test query --input '{"view":"collisions"}' 2>/dev/null; echo "collisions exit=$?"
$B --namespace test query --input '{"view":"reservations"}' 2>/dev/null; echo "reservations exit=$?"
$B --namespace test timeline --input '{"session":"demo-session-0001"}' 2>/dev/null; echo "timeline exit=$?"
```

👀 Expect — `collisions` and `reservations` each return `error.code: "invalid_argument"` exit **2**; `timeline` is an unknown command returning `error.code: "not_found"` exit **4**.

✅ Verify
- [ ] `collisions` exits 2 (`invalid_argument`).
- [ ] `reservations` exits 2 (`invalid_argument`).
- [ ] `timeline` exits 4 (`not_found`).

🔗 Proves: REQ-006, REQ-011, REQ-012
📎 Source: BUILT — all three **verified live**.

#### 🎬 Scene 9.2 — Transition without a note is refused by a *different* precondition (edge)

**Status: BUILT.** Distinct from the closure gate: the store's `transition_requires_note` policy fires first.

▶️ Do
```bash
$B --namespace test transition --input "{\"uid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"toStatus\":\"in_progress\"}" 2>/dev/null; echo "exit=$?"
```

👀 Expect — `{"ok":false,"error":{"code":"precondition_failed","message":"A note is required to transition issue ... (project_policy.transition_requires_note)"}}`, exit non-zero.

✅ Verify
- [ ] Exit non-zero and `error.code: "precondition_failed"`.
- [ ] The message names `transition_requires_note` — **not** an obligation shortfall (proving the two gates are distinct today).

🔗 Proves: REQ-014, CAP-011
📎 Source: BUILT — live probe.

#### 🎬 Scene 9.3 — Degraded embedding mode fails closed only for semantic reads (edge)

**Status: SPEC-ONLY (target).** With embeddings disabled, semantic collision work degrades to a `no-embed-query` mode that **fails closed only** for semantic queries; structural and keyword paths keep working.

▶️ Do
```bash
# SPEC-ONLY: expected once degraded-mode handling ships.
$B --namespace test query --input "{\"view\":\"collisions\",\"filter\":{\"project\":\"$PID\"},\"mode\":\"semantic\"}"
```

👀 Expect (target) — `{"ok":false,"error":{"code":"rag_not_configured","message":"semantic collision scan unavailable: embedding disabled"}}` exit non-zero, while a keyword/structural scan still returns results.

✅ Verify
- [ ] *(target)* A semantic-only scan fails closed with `rag_not_configured`.
- [ ] *(target)* Keyword/structural scans continue to succeed.
- [ ] *(today)* Embedding-disabled is announced on stderr — reproduced in §2.4/1.2.

🔗 Proves: REQ-004, CAP-002
📎 Source: SPEC-ONLY — research `collision-detection-strategy.md` (degraded modes). `rag_not_configured` is an ADR-0006 code.

---

## 10. Teardown

**Status: BUILT.** Every fixture node is soft-invalidated and the project retired — matching the shipped verbs' observed behaviour (`delete` → `invalidated:true`; `rm-project` → `retired:true`).

#### 🎬 Scene 10.1 — Remove the fixture (happy)

▶️ Do
```bash
$B --namespace test delete --input "{\"uid\":\"$AUID\",\"by\":\"demo-pm:0001\",\"reason\":\"demo teardown\"}"; echo "exit=$?"
$B --namespace test delete --input "{\"uid\":\"$BUID\",\"by\":\"demo-pm:0001\",\"reason\":\"demo teardown\"}"; echo "exit=$?"
$B --namespace test delete --input "{\"uid\":\"$PUID\",\"by\":\"demo-pm:0001\",\"reason\":\"demo teardown\"}"; echo "exit=$?"
$B --namespace test rm-project --input "{\"uid\":\"$PID\",\"by\":\"demo-pm:0001\",\"reason\":\"demo teardown\"}"; echo "exit=$?"
```

👀 Expect — each `delete` returns `{"ok":true,"data":{"uid":"<uid>","invalidated":true}}`; `rm-project` returns `{"ok":true,"data":{"uid":"<PID>","retired":true}}`. All exit 0.

✅ Verify
- [ ] All three `delete` calls exit 0 with `invalidated: true` (soft, not hard delete).
- [ ] `rm-project` exits 0 with `retired: true`.
- [ ] No production-namespace node was created or mutated at any point (all commands used `--namespace test`).

🔗 Proves: REQ-001, CAP-001
📎 Source: BUILT — live probe.

---

## 11. Coverage & Traceability

### 11.1 Requirements → Beats (mapped to S## AC)

| REQ | Requirement | Spec AC | Beats | H/E/R |
|-----|-------------|---------|-------|-------|
| REQ-001 | Every view carries completeness meta | S03 AC1 | 1.1, 1.6, 10.1 | H |
| REQ-002 | Derived reads carry `score_kind`; `direction:'desc'` works | S03 AC2 | 1.6, 5.x | H |
| REQ-003 | `view:'order'` scopes members + blocks + dependents | S03 AC3 | 1.6 | H |
| REQ-004 | Create-time fused collision scan (RRF) | S03 / R1a | 1.2, 1.3, 9.3 | H/E |
| REQ-005 | Update-time pre-tx advisory scan | S03 / R1b | 1.4 | H |
| REQ-006 | Read-only `collisions` view | S03 / R1c | 1.5, 9.1 | H/E |
| REQ-007 | Ambiguous uid prefix → candidate set | S02 AC1 | 2.1, 2.2 | E |
| REQ-008 | Merge → Redirect + soft-retire | S02 AC2 | 2.3 | H |
| REQ-009 | Every uid verb resolves through chain | S02 AC4 | 2.4 | H |
| REQ-010 | Durable claim-interval persistence | S11 R1 | 3.1, 3.2, 3.5 | H/E |
| REQ-011 | `view:'reservations'` store-wide | S11 R2/R3 | 3.3, 3.5, 9.1 | H/E |
| REQ-012 | Session node + op-event log + `timeline` verb | S11 S1–S3 | 3.4, 9.1 | H/E |
| REQ-013 | Child-session rollup | S11 S4 | 3.4 | H |
| REQ-014 | Terminal closure gate typed refusal | S05 AC2 | 4.1, 4.2, 4.3, 9.2 | H/E |
| REQ-015 | Verdict derived on read, never stored | S05 AC3 | 4.4 | H |
| REQ-016 | State-revision mint on terminal transition | S12 E1 | 5.1 | H |
| REQ-017 | Canonical payload chained by `parent_revision` | S12 E2 | 5.2, 8.1 | H |
| REQ-018 | CAS stale base → `precondition_failed` | S12 E3 | 5.3 | E |
| REQ-019 | B1 fragment read; stale token never fresh | S12 E4 | 5.4, 5.5 | H/R |
| REQ-020 | No stored verdict | S12 E5 | 5.6 | E |

### 11.2 Capabilities → Beats

| CAP | Capability | Beats | H/E/R |
|-----|-----------|-------|-------|
| CAP-001 | Create/update issue + citation | 1.1, 1.6, 10.1 | H |
| CAP-002 | Duplicate-collision surfacing (create-time) | 1.2, 1.3, 9.3 | H/E |
| CAP-003 | Duplicate-collision advisory (update-time) | 1.4 | H |
| CAP-004 | `collisions` read view | 1.5 | H |
| CAP-005 | Ambiguous-reference candidate resolution | 2.1, 2.2 | E |
| CAP-006 | Merge/redirect identity | 2.3 | H |
| CAP-007 | Chain-resolving uid lookup | 2.4 | H |
| CAP-008 | Durable claim intervals | 3.1, 3.2 | H/E |
| CAP-009 | `reservations` view | 3.3, 3.5 | H/E |
| CAP-010 | Session/op-event log + timeline | 3.4 | H |
| CAP-011 | Obligation/closure gate | 4.1, 4.2, 4.3, 9.2 | H/E |
| CAP-012 | Derived verdict | 4.4, 5.6 | H/E |
| CAP-013 | State-revision mint + chain | 5.1, 5.2, 8.1 | H |
| CAP-014 | B1 fragment read | 5.4, 5.5 | H/R |
| CAP-015 | CAS concurrency | 5.3 | E |

### 11.3 Unresolved summary

Six guessed interfaces are tracked in the sibling `UNRESOLVED.md` (stubs ⟦U1⟧–⟦U6⟧): the blocked-transition refusal literal (U1), the update-time `warnings[]` entry shape (U2), the `collisions` response object (U3), the merge verb payload beyond `{from,to}` (U4), the additive `get` field name for the state-revision payload (U5), and the `stale` error-code literal (U6). A one-paragraph **scope finding** (the S11 R1 premise correction) and the assumptions list also live there. All spec-given shapes — S11 session/op-event shapes, S12 payload, S02 `link-duplicate` input, S05 `{code,required_kind}` shape, and the ten ADR-0006 error codes — are grounded and carry **no** stub.

---

## 12. Sign-Off

Fill in when the demo is run top-to-bottom. Leave blank until a human or agent has executed it.

| # | Workflow | Runs (BUILT) pass? | SPEC-ONLY steps reviewed? | Evidence (paste exit codes) | Date | Runner |
|---|----------|--------------------|---------------------------|-----------------------------|------|--------|
| W1 | Create/update collision surfacing | | | | | |
| W2 | Identity resolution | | | | | |
| W3 | Reservation & timeline | | | | | |
| W4 | Terminal closure gate | | | | | |
| W5 | State-revision mint | | | | | |
| — | Negative controls (§9.1) | | | | | |
| — | Teardown (§10) | | | | | |
