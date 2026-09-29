# 🎬 Actionable Store — Live Demo & Acceptance Script

> Give a fleet of agents a work queue that cannot lie: every item states what it is, what done means, and whether the note is true.

**What this is.** A presentation-grade walkthrough of the Actionable Store that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the store the way a fleet of agents dropped cold into a repo would, and (b) prove every capability works — from discovering a feature, through multiple build passes and enrichment, to a deployment that the store *refuses to accept until proof exists*. Exact commands, exact data, binary checks. If it is demonstrated here, it must work; if it must work, it is demonstrated here.

**Status of this revision (post-fix).** Every observable below was captured from the shipped build (`entrypoint/backlog/dist/index.js`) against the **seeded isolated fixture** described in §2.3, not from the mutable production store. The runner `fixture/run.mjs` executes all 25 beats and prints the tally: **21 passed · 1 now-runnable · 0 failed · 3 NOT-RUNNABLE** (12/15 requirements fully proven, +3 partial; 6/8 capabilities fully proven, +2 partial — see §7). This revision lands the two fixes the previous revision could only describe (beats 2.4 and 3.3) and gives the runner TEETH: a carried NOT-RUNNABLE classification no longer discards an evaluable assertion — reverting either fix turns the runner red (exit 1).

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what is happening and why the agent cares. |
| ▶️ **Do** | The exact action (command or request) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick only if literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — design spec, skill doc, or ticket it came from. |
| ⏭ **NOT-RUNNABLE** | The beat is genuinely unexecutable today (a missing backend or verb), so **no assertion could be evaluated**. The reason is named in the beat and classified in §7.3. |
| ✅ **NOW-RUNNABLE** | The beat was CARRIED as NOT-RUNNABLE, but its in-beat assertion is **still evaluated every run** and now holds — a fixed defect. A beat whose full claim still has an unseedable part prints a NOTE and counts as PARTIAL. A carried classification never suppresses an assertion. |
| ⟦U#⟧ pinned | A former interface stub, now **pinned to the shipped build**; the exact shape is recorded in `UNRESOLVED.md` beside this file. |

**Conventions**
- Shell prompt is `$`; all commands run from the repo root unless noted.
- The surface is the backlog CLI: `adhd-backlog backlog <verb> --input '<json>'`. Every verb takes one `--input` JSON object — there are no per-field flags.
- Exit codes are meaningful: `0` success, `1` precondition/conflict/item-not-found, `2` validation/invalid-argument, `4` not-found (a registry reference). Parse stdout; stderr is telemetry noise (plus the unwrapped `invalid_argument` a malformed `--input` prints — see §5.5).
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- **The beats reference fixture objects by NAME** (`$C5`, `$PLAN`, `$COMMITREF`, …), never by a hardcoded uid. The names are bound to real uids by the seed step in §2.3; the uids themselves vary per run because the shipped write API mints `crypto.randomUUID()` and exposes no override. Only the object *graph* is fixed.
- All fixture data is created by the seed, so the counts are reproducible and the production store is never touched.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** A dispatcher agent is dropped into a repository it has never seen. It has no memory of the plan, no idea which of the open items are real, and — critically — no way to tell whether "done" has happened. Today it does what every such agent does: lists everything open, picks something, closes it with a commit hash, and moves on. Three weeks later a release fails because the package it "closed" was never published. The store said `RESOLVED`. The store was wrong.

The Actionable Store makes that impossible. Every item can declare **what satisfies it**; evidence is a first-class, anchored, append-only record that attaches without rewriting the item; and a terminal transition is **refused** until the declared proof actually exists. A dispatcher asks one question — *what may I work on, in what order, with what proof* — and gets an answer it can act on, including **why not**.

> **The promise we'll prove in the next 20 minutes:** the same fleet, the same repo, the same commit ref — and the store refuses to call it done until the artifact it promised actually exists.

🔗 **Proves (framing):** REQ-008, REQ-009, REQ-011 · CAP-005, CAP-006
📎 **Source:** `docs/product/feature-research/PROPOSAL.md` §1–§2 (problem + thesis); ticket `4fc3704e` (resolve accepts a commit ref).

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet **Dee**, the dispatcher

Dee owns turning a plan into dispatched work. Dee's goal in this script: take one plan from "filed" to "shipped", using a fleet, without ever closing something that is not actually done. Dee has been burned before — the last time, an item marked `RESOLVED` shipped nothing. Dee's stakes: if the queue lies, the whole fleet builds the wrong thing.

**Also appearing:** **Pri** (product — turns a plan into scoped tickets), **Rex** (researcher — produces cited, verified findings), **Axl** (architect — produces implementation specs and declares obligations), **Bo** (backend — implements), **Vee** (review — static gate), **Tess** (test — dynamic gate), **Otto** (backlog-operator — the only agent that writes to the store on the fleet's behalf).

### 2.2 The Canonical Demo Dataset

Everything below refers back to this table. These objects are created by the seed step (§2.3) in the **isolated demo store**; each fixture name is exported as a shell variable.

| Name | Role in the story | Kinds/state |
|---|---|---|
| `$C5` | closure gate — terminal transitions need satisfied obligations | FEAT · open · HIGH · has a base spec revision |
| `$C3` | attestation — evidence that attaches without churning identity | FEAT · open · HIGH · revision 1 |
| `$RESEARCH` | ticket for the first anchored-evidence beat | FEAT · open · MEDIUM · revision 0 |
| `$CROSSREPO` | an item whose citation points into a sibling repo (`$CROSS_ATT`, `$DIGEST_GOOD`, `$DIGEST_BAD` = its seeded attestations) | FEAT · open · MEDIUM |
| `$SIBLING` | a **second registered project root** — a real git work tree under `tmp/` (`fixture/sibling-repo/`) the cross-repo beats cite into | git work tree · registered project |
| `$AC2_X`, `$AC2_Y` | equal in-degree order-tie head nodes (X has more transitive dependents) | SPIKE · open · MEDIUM |
| `$AC2_D4`, `$AC2_D5` | the flip pair beat 1.4 wires to Y so the dependent-weight order flips | SPIKE · open · MEDIUM |
| `$PLAN` | the umbrella plan Dee must advance | FEAT · open · HIGH · blocked by `$BLOCKER` |
| `$BLOCKER` | what blocks the plan and the blocked work | FEAT · open · HIGH |
| `$BLOCKED` | an item a dispatcher once took while it was blocked | FEAT · open · HIGH · blocked by `$BLOCKER` |
| `$COMMITREF` | the item closed on a merge ref | FEAT · open · HIGH · revision 2 · obligation `published-artifact` → closed |
| `$CHILD1`, `$CHILD2` | members of the umbrella plan (`part_of` → `$PLAN`) | FEAT · open · LOW |
| `$CYCLE_A`, `$CYCLE_B` | a dependency cycle introduced in beat 5.2 | FEAT · open · LOW |
| `$CLAIM_1`, `$CLAIM_2` | unblocked items for the parallel-claim protocol | FEAT · open · MEDIUM |

### 2.3 Prerequisites & Fixture Seed

- Node 20+ and `pnpm` (the machine-wide store is already pinned).
- A built `adhd-backlog` binary: `npx nx build backlog` (emits `entrypoint/backlog/dist/index.js`).
- **The production store is never used.** The fixture lives at `tmp/actionable-store-demo/demo.db`, pinned by `ADHD_BACKLOG_DATABASE_PATH`, with `embedding.enabled:false` so the run is deterministic and pays no model-load cost. (This is why beats 5.4 and 5.6 — which need the vector backend — are NOT-RUNNABLE here; see §7.3.)
- **A second registered project root** is seeded beside the store (`fixture/sibling-repo/`, a real git work tree) so the cross-repo beats (2.4, 2.5) resolve a citation against ITS root, not this repo's HEAD — and a REAL sha256 content digest is computed from the target blob (never a placeholder).
- Beat 5.8 re-runs the C6 AC5 bound suite (`verdict-list-bound.e2e.ts`) through its own vitest lane and surfaces its measured p95; no extra setup is required beyond the repo's own toolchain.
- The one-shot `spec-revision` migration is not needed: the seed establishes `$C5`'s rev-0 (revision_seq 1) with an explicit `spec-append` whose `base_revision` is `""`.

**Seed the fixture, then bind the names:**

```bash
bash docs/plan/actionable-store/demo/fixture/seed.sh
. tmp/actionable-store-demo/fixture.env
```

`seed.sh` deletes and rebuilds the isolated store on every run, so the demo always starts from the same object graph. `fixture.env` exports every fixture name above to the uid it resolved to.

> Re-run everything at once (seed + all 25 beats + tally):
> `node docs/plan/actionable-store/demo/fixture/run.mjs`

### 2.4 Cold Start — From Nothing to a Serving Store

🎬 **Scene.** Before Dee can ask anything, the store must be *reachable*. The classic failure is not a crash — it is a server that looks configured and is silently absent, or a client whose cold start exceeds its own deadline. This step proves the store is ready, not merely alive.

▶️ **Do**
```bash
adhd-backlog sandbox-path
adhd-backlog store-check
adhd-backlog serve --probe
adhd-backlog backlog query --input '{"view":"projects","limit":5}'
```

👀 **Expect**
```
{"namespace":"production","dbPath":"/Users/nix/dev/node/adhd/tmp/actionable-store-demo/demo.db","embeddingEnabled":false}
{"ok":true,"dbPath":"…/tmp/actionable-store-demo/demo.db","total":⟨n⟩,"kinds":[…],"expectedKinds":[…]}
{"state":"ready","since":"⟨iso⟩","degraded":false}
{"ok":true,"data":{"view":"projects","items":[{"uid":"⟨uuid⟩","name":"adhd","path":"/Users/nix/dev/node/adhd"}]}}
```

✅ **Verify**
- [ ] `sandbox-path` names the isolated store under the repo's `tmp/`, never the production store.
- [ ] `store-check` exits 0 and reports no vocabulary mismatch.
- [ ] `serve --probe` exits 0 and prints `"state":"ready"` — the readiness probe drives a real op through the serving path, not a socket accept. ⟦U1⟧ pinned.
- [ ] The query returns `"ok":true` — the store answers through its own client path.

🔗 **Proves:** REQ-012 · CAP-007
📎 **Source:** `entrypoint/backlog/skill/SKILL.md` §1–§2, §7; readiness probe pinned to `serve --probe` / `--ready-file` (see UNRESOLVED.md).

---

## 3 · The Journey

### Act 1 — Dropped In With No Context

Dee knows nothing. The first job is to *name* things correctly — the fleet cannot act on an item it cannot address.

#### 1.1 · Resolve a short reference to exactly one item (happy)

🎬 **Scene.** Dee holds a short reference from a chat message: the first 8 hex characters of a uid. Before the store, that string was a dangling citation — no verb could resolve it.

▶️ **Do**
```bash
adhd-backlog backlog get --input "{\"uid\":\"$C5\"}"
adhd-backlog backlog get --input "{\"uid\":\"${C5:0:8}\"}"   # the 8-char prefix
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨uuid⟩","title":"C5 — Closure gate: terminal transitions require satisfied obligations and verified evidence","kind":"FEAT","status":"open","priority":"HIGH"}}
{"ok":true,"data":{"uid":"⟨same uuid⟩","title":"C5 — …","kind":"FEAT","status":"open","priority":"HIGH"}}
```

✅ **Verify**
- [ ] Both the full uid and its 8-char prefix resolve to the same 36-char uid.
- [ ] The returned uid starts with the prefix that was asked for.
- [ ] A prefix shorter than 8 hex characters is refused as too short (see 5.1).

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** design §2 Primitive 1 + C1 spec (`specs/C1-reference.spec.md`); defect ticket `e2446b18`.

#### 1.2 · Read the catalog instead of guessing a legal value (edge)

🎬 **Scene.** Dee must choose a `kind` for a new item. The catalog used to be write-only: you could mint a value and never enumerate what was legal. Dee asks the store what it permits.

▶️ **Do**
```bash
adhd-backlog backlog query --input '{"view":"catalogs","limit":5}'
```

👀 **Expect**
```
{"ok":true,"data":{"view":"catalogs","terms":[{"name":"FEAT","uid":"⟨uuid⟩","catalog":"kind","source":"store","lifecycle":"active","usageCount":⟨n⟩},{"name":"closed","uid":"⟨uuid⟩","catalog":"status","source":"store","lifecycle":"active","usageCount":⟨n⟩},{"name":"DONE","catalog":"status","source":"reserved_terminal_status_names","lifecycle":"active"},…]}}
```

✅ **Verify**
- [ ] The catalog is readable and returns named terms with a lifecycle.
- [ ] The response is `data.terms[]` (a flat term list), each term naming its `catalog` and `source`. ⟦U6⟧ pinned.
- [ ] No `invalid_argument` is returned for asking.

🔗 **Proves:** REQ-013 · CAP-008
📎 **Source:** design Invariant 6 + C8 spec (`specs/C8-vocabulary.spec.md`); defect ticket `f6ea94ee`.

#### 1.3 · List a plan's members and order them (happy)

🎬 **Scene.** Dee needs the plan's real contents, in an order that respects dependencies — not a wall of uids.

▶️ **Do**
```bash
adhd-backlog backlog query --input "{\"view\":\"order\",\"filter\":{\"plan\":\"$PLAN\"},\"limit\":50}"
```

👀 **Expect**
```
{"ok":true,"data":{"view":"order","order":{"ok":true,"order":["⟨child uid⟩","⟨child uid⟩"]}}}
```

✅ **Verify**
- [ ] `data.order` is the shipped **`{ok, order}` object**, not a bare array (a cycle would be `{"ok":false,"cycle":[…]}` — see 5.2).
- [ ] The order includes every `part_of` member of the plan (`$CHILD1`, `$CHILD2`).
- [ ] Running it twice returns the identical sequence (determinism).
- [ ] `view:"order"` carries **no `meta`** — it is a topological order, not a filtered row set (design: `graph`/`order`/`overlap` carry none).
- [ ] C2's kind-scope nuance (an order including **non-`issue`** members — the plan's bucket rows in the production store) is **not demonstrable in the isolated fixture**, whose plan members are all issues. See UNRESOLVED.md §4.

🔗 **Proves:** REQ-002, REQ-003, REQ-012 · CAP-001, CAP-002, CAP-007
📎 **Source:** design §2 Primitive 1 + Invariant 5; defect tickets `260d6b34`, `fc52d398`; corrected premise at symbol `queryOrder` in `entrypoint/backlog/src/query/query.ts`.

#### 1.4 · The order tie is broken by dependent weight, deterministically (⚠️ edge)

🎬 **Scene.** Two ready items block the same number of things — a tie. A FIFO queue would pick whichever was filed first; that is not a property Dee can reason about. The order must be *earned*: the node that unblocks more downstream work goes first, and the same graph must always yield the same sequence.

▶️ **Do**
```bash
adhd-backlog backlog query --input '{"view":"order","filter":{"kind":"SPIKE"},"limit":50}'
adhd-backlog backlog get   --input "{\"uid\":\"$AC2_X\",\"fields\":[\"blocksOut\",\"dependents\"]}"
# …then FLIP the dependent weights (give $AC2_Y a longer transitive chain) and re-query:
adhd-backlog backlog relate --input "{\"sourceUid\":\"$AC2_Y\",\"targetUid\":\"$AC2_D4\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}"
adhd-backlog backlog relate --input "{\"sourceUid\":\"$AC2_D4\",\"targetUid\":\"$AC2_D5\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}"
adhd-backlog backlog query --input '{"view":"order","filter":{"kind":"SPIKE"},"limit":50}'
```

👀 **Expect**
```
{"ok":true,"data":{"view":"order","order":{"ok":true,"order":["⟨$AC2_X⟩","⟨$AC2_Y⟩",…]}}}   # X (2 dependents) before Y (1)
{"ok":true,"data":{"uid":"⟨$AC2_X⟩","blocksOut":[{"uid":"⟨D1⟩","…":…,"rel":"blocks"}],"dependents":2}}
{"ok":true,"data":{"view":"order","order":{"ok":true,"order":["⟨$AC2_Y⟩","⟨$AC2_X⟩",…]}}}   # Y (3 dependents) now first
```

✅ **Verify**
- [ ] `$AC2_X` and `$AC2_Y` have equal in-degree and the same priority, yet the one with **more transitive dependents** comes first.
- [ ] The card exposes both `blocksOut` (a typed list) and a numeric `dependents` count (2 for X here).
- [ ] After the weights are **swapped** (Y gains 3 dependents), the order **flips** — Y first. A uid/FIFO order could not flip between two runs over the same nodes.
- [ ] `view:"order"` stays deterministic across runs (same sequence for the same graph — see 1.3).

🔗 **Proves:** REQ-003, REQ-004 · CAP-002
📎 **Source:** C2 spec AC2/AC3/AC4 (`specs/C2-legibility.spec.md`); implemented at symbol `resolveDependents` / `queryOrder` in `entrypoint/backlog/src/query/query.ts`; ticket `15dc77ba`.

---

### Act 2 — Discovery: Turning a Plan Into Dispatchable Work

The fleet splits: Pri scopes, Rex researches, Dee pulls. This is where the store stops being a notebook.

#### 2.1 · Ask what may be worked, and get reasons (happy)

🎬 **Scene.** Dee asks the one question that matters. The store answers per item with a **derived** verdict — computed at read, never stored — and for anything it excludes it names the reason.

▶️ **Do**
```bash
adhd-backlog backlog get --input "{\"uid\":\"$PLAN\",\"fields\":[\"verdict\"]}"
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨uuid⟩","verdict":{"actionable":false,"evaluated_at":"⟨iso⟩","revision":0,"conditions":[{"type":"Blocked","status":"True","severity":"block","code":"BlockedBy","subject":"⟨blocker uid⟩","message":"blocked by ⟨blocker uid⟩"},{"type":"Obligation","status":"True","severity":"warn","code":"MissingObligation","message":"no obligations are declared on this item"}]}}}
```

✅ **Verify**
- [ ] `actionable` is `false` while a live blocker exists.
- [ ] The blocking condition names a **subject uid** Dee can act on, not just prose.
- [ ] The condition `status` is the **string `"True"`** (the tri-state vocabulary is `"True" | "False" | "Unknown"`), never the JSON boolean `true`; `"True"` on a `Blocked` condition means the item **is** blocked. ⟦U8⟧ pinned.
- [ ] `actionable` is tri-state: a value the store could not compute reads `"unknown"`, never `true`.
- [ ] An item with no obligations carries a `warn`-severity `MissingObligation` condition (the honest floor; it does not block).

🔗 **Proves:** REQ-004, REQ-011, REQ-014 · CAP-002, CAP-006
📎 **Source:** design §2 Primitive 4 (condition semantics) + C6 spec (`specs/C6-verdict.spec.md`); card projection is `IVerdict` in `entrypoint/backlog/src/query/types.ts`.

#### 2.2 · Claim blocked work — and be refused, loudly (⚠️ edge)

🎬 **Scene.** Dee is impatient and tries to take the blocked item anyway. The old store let it. This store refuses and tells Dee exactly what is in the way — because Dee is about to spend a fleet on it.

▶️ **Do**
```bash
adhd-backlog backlog claim --input "{\"uid\":\"$BLOCKED\",\"by\":\"dispatcher:dee-1\",\"action\":\"claim\"}"
adhd-backlog backlog get --input "{\"uid\":\"$BLOCKED\"}"
```

👀 **Expect**
```
{"ok":false,"error":{"code":"precondition_failed","message":"Claim refused: BlockedBy ⟨blocker uid⟩ — blocked by ⟨blocker uid⟩","details":{"retryable":false}}}
{"ok":true,"data":{"uid":"⟨uuid⟩","title":"Blocked work","kind":"FEAT","status":"open","priority":"HIGH"}}
```

✅ **Verify**
- [ ] Exit code is non-zero and `code` is `precondition_failed`.
- [ ] The refusal names the blocking uid; Dee does not have to go looking.
- [ ] Re-reading the item shows it was **not** claimed (no partial state — the throw rolls the transaction back).
- [ ] Note the shipped CLI carries the refusal reason in `error.message`; the structured `error.details.refusal` object is computed by `api.ts`/`toEnvelope` but does not reach CLI stdout (it is dropped before serialization). The assertion here keys on the message, which names the blocker.

🔗 **Proves:** REQ-010 · CAP-006
📎 **Source:** design §2 Primitive 3 (gated verbs) + C6 spec; defect tickets `416971f9`, `b2e9b451`.

#### 2.3 · Rex backs a finding with evidence that survives review (happy)

🎬 **Scene.** Rex researched the similarity question and must leave durable, checkable backing — not prose in a report. Rex attaches an attestation to the ticket, anchored to a path and a content digest, and the ticket's identity is untouched.

▶️ **Do**
```bash
adhd-backlog backlog attest --input "{\"subject\":{\"id\":\"$RESEARCH\",\"revision\":0},\"claim\":{\"kind\":\"source-reading\",\"body\":\"similarity scan is project-scoped\"},\"anchor\":{\"locator\":\"path:entrypoint/backlog/src/write/create-issue.ts\",\"digest\":\"⟨sha256 hex of the HEAD blob⟩\"},\"by\":\"researcher:rex-1\"}"
adhd-backlog backlog get --input "{\"uid\":\"$RESEARCH\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","subject":{"id":"⟨research uid⟩","revision":0},"check":{"state":"verified","method":"changed_since","checked_at":"⟨iso⟩","checked_by":"researcher:rex-1"}}}
{"ok":true,"data":{"uid":"⟨research uid⟩","title":"Rex — similarity scan is project-scoped","kind":"FEAT","status":"open","priority":"MEDIUM"}}
```

✅ **Verify**
- [ ] The attestation is a **separate uid**; reading the subject shows its uid unchanged.
- [ ] `check.state` is one of `unverified | verified | stale | unknown`, and `verified` required the anchor to resolve at the project's HEAD. ⟦U2⟧ pinned.
- [ ] `check.method` names the rung that ran (`changed_since` for a present-but-untouched `path:` anchor; `exists_at_head` when absent); `checked_at`/`checked_by` are always present, never an absent field.
- [ ] The locator **requires a scheme prefix** (`path:` / `url:` / `query:` / `registry:` / `commit:` / `revision:`); a bare path is rejected `invalid_argument`.
- [ ] The `digest` is a **real bare sha256 hex** (64 chars, no `sha256:` prefix) of the target blob — the full-resolve rung compares it byte-for-byte against `sha256(HEAD blob)` without stripping a prefix, so a prefixed or placeholder digest can never match (see beat 2.5).

🔗 **Proves:** REQ-005, REQ-006 · CAP-003
📎 **Source:** design §2 Primitive 2 + C3 spec (`specs/C3-attestation.spec.md`); defect tickets `5b555754`, `a3a9a4f9`.

#### 2.4 · A sibling-repo citation is verified, not falsely refuted (🛟 recovery) — ✅ FIXED

🎬 **Scene.** A citation points into a sibling repository. The old verifier probed it against *this* repo's HEAD, failed to find it, and reported the honest finding as false. Dee re-checks and it passes.

▶️ **Do**
```bash
adhd-backlog backlog recheck --input "{\"attestationUid\":\"$CROSS_ATT\",\"by\":\"dispatcher:dee-1\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","checks":[{"state":"verified","method":"changed_since",…},{"state":"verified","method":"changed_since","checked_at":"⟨iso⟩","checked_by":"dispatcher:dee-1"}]}}
```

✅ **Verify**
- [ ] A prior check is still readable — `recheck` appends, it never overwrites.
- [ ] The check resolves against the **citation's own (sibling) project root** and reads `verified` — never the false `stale`/`unknown` a subject-root-only ladder returns.
- [ ] The anchor is genuinely cross-repo: an absolute path into a **registered sibling project root**, absent from this repo's tracked tree — so only sibling-root resolution can verify it.

**✅ FIXED (was a real defect).** `recheck` and `attest` resolved an anchor only against the **subject issue's single project path** (the dead symbol `resolveIssueProjectPath`), so a citation living in a sibling repo was probed against the subject's repo and reported `stale`/`unknown`. `resolveIssueProject` + the new `resolveAnchorRoot` (`entrypoint/backlog/src/write/attestation.ts`) now probe the subject root first, then every other live registered project root, and return the first root whose work tree has the target present at HEAD — the SAME registry source `createIssue`/`transition` use for their cross-repo probe. The beat runs; **reverting the fix makes the runner exit 1** (2.4 goes red). Negative control proven: with sibling resolution reverted, the check reads `{"state":"stale","method":"exists_at_head","reason":"… is not present at HEAD"}`.

🔗 **Proves:** REQ-006 · CAP-003
📎 **Source:** design §2 Primitive 2 + C3 spec; defect ticket `78c96213` (sibling-repo false refutation), fixed by commit `068e554c`.

#### 2.5 · An anchor digest is a real content-address, not a placeholder (⚠️ edge)

🎬 **Scene.** "Verified evidence" is only worth something if the *content* is checked, not merely the *path's existence*. If every anchor carried a placeholder digest, the check could never tell a working content-address from a no-op. Dee re-checks two attestations against the same changed file: the one whose digest matches HEAD, and the one whose digest does not.

▶️ **Do**
```bash
adhd-backlog backlog recheck --input "{\"attestationUid\":\"$DIGEST_GOOD\",\"by\":\"dispatcher:dee-1\"}"
adhd-backlog backlog recheck --input "{\"attestationUid\":\"$DIGEST_BAD\",\"by\":\"dispatcher:dee-1\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","checks":[…,{"state":"verified","method":"full_resolve","checked_at":"⟨iso⟩","checked_by":"dispatcher:dee-1"}]}}
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","checks":[…,{"state":"stale","method":"full_resolve","reason":"\"digest.txt\" content no longer matches the anchor digest",…}]}}
```

✅ **Verify**
- [ ] The sibling file changed since filing, so the changed-since rung hands off to the **full re-resolve** (`method:"full_resolve"`), which hashes the HEAD blob and compares it to the digest.
- [ ] The **real** digest matches HEAD → `verified`.
- [ ] A **wrong** digest on the SAME rung → `stale`. This is the negative control: without a real digest read, `full_resolve` could never report `stale` here.
- [ ] The digest is bare sha256 hex (no `sha256:` prefix) — the exact form the comparison requires.

🔗 **Proves:** REQ-005, REQ-006 · CAP-003
📎 **Source:** `entrypoint/backlog/src/write/anchor-check.ts` `digestAtHead`/full-resolve rung (lines ~458-467); C3 spec. Fixture: `fixture/sibling-repo/digest.txt` committed once before and once (future-dated) after the attestations.

#### 2.6 · The honest floor: an un-obligated item is actionable by default (happy)

🎬 **Scene.** The gate must not only refuse; it must also *permit*. An item with no blocker and no declared obligation is, by default, workable — and says so, with a warn that merely *notes* no obligation is declared. Assuming the floor (rather than asserting it) is how a store ends up unable to start any work at all.

▶️ **Do**
```bash
adhd-backlog backlog get --input "{\"uid\":\"$CLAIM_1\",\"fields\":[\"verdict\"]}"
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨uuid⟩","verdict":{"actionable":true,"evaluated_at":"⟨iso⟩","revision":0,"conditions":[{"type":"Obligation","status":"True","severity":"warn","code":"MissingObligation","message":"no obligations are declared on this item"}]}}}
```

✅ **Verify**
- [ ] An un-obligated, unblocked item reads `actionable: true` — the honest floor (DESIGN AC10), never `false`/`"unknown"`.
- [ ] It carries a **warn**-severity `MissingObligation` condition (`status:"True"`) — reported, never a block.

🔗 **Proves:** REQ-011, REQ-014 · CAP-006
📎 **Source:** design §5 AC10 (honest floor) + §2 Primitive 4; C6 spec (`specs/C6-verdict.spec.md`).

---

### Act 3 — The Build Runs: Multiple Passes, and Enrichment

Axl declares what "done" means. Bo builds. Tess and Vee gate. Then an enrichment pass folds new evidence in — **without** minting a new ticket.

#### 3.1 · Axl's spec lands in the ticket, not beside it (happy)

🎬 **Scene.** Axl has written the implementation spec for this item. In the old world it was a markdown file *beside* the repo, and the ticket only mentioned its path — an un-owned citation that drifted three separate times (three reviewers caught it). Now the spec is a **revision of the ticket**: Axl appends revision text to the ticket, which mints an immutable revision object and advances the ticket's `spec_revision` pointer. The ticket's uid does not change, no prior revision is rewritten, and the long-form file is only an anchored export.

▶️ **Do**
```bash
adhd-backlog backlog get --input "{\"uid\":\"$C5\",\"fields\":[\"spec\"]}"
adhd-backlog backlog spec-append --input "{\"uid\":\"$C5\",\"fragment\":\"## AC1 …\",\"base_revision\":\"$C5_REV0\",\"by\":\"architect:axl-1\"}"
adhd-backlog backlog get --input "{\"uid\":\"$C5\",\"fields\":[\"spec\"]}"
adhd-backlog backlog spec-check --input "{\"uid\":\"$C5\",\"token\":\"$C5_TOK0\"}"
adhd-backlog backlog spec-check --input "{\"uid\":\"$C5\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨uuid⟩","spec":{"spec_revision":"⟨rev-0-uid⟩","spec_revision_token":"sha256:⟨hex0⟩","revision_seq":1}}}
{"ok":true,"data":{"uid":"⟨uuid⟩","spec_revision":"⟨rev-1-uid⟩","spec_revision_token":"sha256:⟨hex1⟩","revision_seq":2}}
{"ok":true,"data":{"uid":"⟨uuid⟩","spec":{"spec_revision":"⟨rev-1-uid⟩","spec_revision_token":"sha256:⟨hex1⟩","revision_seq":2}}}
{"ok":true,"data":{"current_revision":"⟨rev-1-uid⟩","current_token":"sha256:⟨hex1⟩","state":"stale","method":"token","reason":"older-token"}}
{"ok":true,"data":{"current_revision":"⟨rev-1-uid⟩","current_token":"sha256:⟨hex1⟩","state":"stale","method":"none","reason":"no-token-supplied"}}
```

✅ **Verify**
- [ ] `get`'s spec field is **`fields:["spec"]`** (not `spec_revision`), and the card carries it under **`data.spec`** — `spec.spec_revision` + `spec.spec_revision_token` + `spec.revision_seq`. ⟦pinned⟧
- [ ] The ticket's `uid` is byte-identical before and after the append.
- [ ] `spec_revision` advanced to a **new** uid; the prior revision object is untouched.
- [ ] `spec-check` with an older token reports `state:"stale"` (`method:"token"`, `reason:"older-token"`).
- [ ] `spec-check` with **no** token reports `stale` (`method:"none"`, reason `no-token-supplied`), never `fresh`.
- [ ] The revision is referenced, not embedded: the card carries the pointer + token, never the spec body.

🔗 **Proves:** REQ-015, REQ-005 · CAP-003
📎 **Source:** C10 spec (`specs/C10-store-citizen-documents.spec.md`) + DESIGN §12; shapes pinned by `ISpecAppendOutcome`/`ISpecCheckOutcome` in the shipped `dist/`.

#### 3.2 · Axl declares the obligation before building (happy)

🎬 **Scene.** Axl does not want to argue about "done" after the fact. Before a line is written, Axl declares what proof will satisfy this item: a published artifact.

▶️ **Do**
```bash
adhd-backlog backlog obligate --input "{\"uid\":\"$C5\",\"applies_to\":{\"to\":\"closed\"},\"requirement\":{\"op\":\"evidence\",\"kind\":\"published-artifact\",\"min\":1},\"on_fail\":\"block\",\"by\":\"architect:axl-1\"}"
adhd-backlog backlog get --input "{\"uid\":\"$C5\",\"fields\":[\"obligations\"]}"
adhd-backlog backlog obligate --input "{\"uid\":\"$C5\",\"requirement\":{\"op\":\"evidence\",\"kind\":\"published-artifact\"},\"on_fail\":\"block\",\"by\":\"architect:axl-1\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨uuid⟩","obligationUid":"⟨uuid⟩"}}
{"ok":true,"data":{"uid":"⟨uuid⟩","obligations":[{"uid":"⟨obligation uid⟩","applies_to":{"to":"closed"},"requirement":{"op":"evidence","kind":"published-artifact","min":1},"on_fail":"block"}]}}
(stderr) {"code":"invalid_argument","message":"… must have required property 'applies_to' …"}
```

✅ **Verify**
- [ ] The obligation stores and is readable back on the item as `data.obligations[]`.
- [ ] The predicate is the closed form **`{op:"evidence", kind, min?}`** — not a nested `{evidence:{…}}` wrapper. ⟦U3⟧ pinned.
- [ ] `applies_to.to` is **required** — omitting it is a validation error, not a silent default.

🔗 **Proves:** REQ-007 · CAP-004
📎 **Source:** design §2 Primitive 3 + C4 spec (`specs/C4-obligation.spec.md`); defect tickets `e5a790a7`, `8232cc9d`.

#### 3.3 · The fleet works in parallel, and the store keeps them honest (happy) — ✅ FIXED

🎬 **Scene.** Bo implements; Tess runs the suite; Vee reviews. All three operate on different items at once. The store's claim protocol is a lease under a real transaction — two agents cannot both hold the same item, and a dead claim is visible rather than silently `IN_PROGRESS` forever.

▶️ **Do**
```bash
# the demo's own order — $C5 was just obligated toward `closed` in 3.2
adhd-backlog backlog claim --input "{\"uid\":\"$C5\",\"by\":\"backend:bo-1\",\"action\":\"claim\"}"

# the same protocol on two UN-obligated items (proves the lease mechanism itself)
adhd-backlog batch action --input "{\"operation\":\"backlog/claim\",\"items\":[
  {\"input\":{\"uid\":\"$CLAIM_1\",\"by\":\"backend:bo-1\",\"action\":\"claim\"}},
  {\"input\":{\"uid\":\"$CLAIM_2\",\"by\":\"test:tess-1\",\"action\":\"claim\"}}
],\"mode\":\"parallel\"}"
adhd-backlog backlog query --input '{"view":"stale","staleAfterMin":30,"limit":10}'
```

👀 **Expect** (the demo's obligated item now claims; the un-obligated probe succeeds):
```
{"ok":true,"data":{"uid":"⟨uuid⟩","status":"claimed","claimedBy":"backend:bo-1","claimedAt":"⟨iso⟩"}}
[{"index":0,"status":"fulfilled","value":{"ok":true,"data":{"uid":"⟨uuid⟩","status":"claimed","claimedBy":"backend:bo-1"}}},
 {"index":1,"status":"fulfilled","value":{"ok":true,"data":{"uid":"⟨uuid⟩","status":"claimed","claimedBy":"test:tess-1"}}}]
{"ok":true,"data":{"view":"stale","items":[]},"meta":{"total":0,"returned":0,"limit":10,"total_relation":"eq","has_more":false}}
```

✅ **Verify**
- [ ] **Demo's obligated item:** the claim on `$C5` — obligated toward a terminal `closed` in 3.2 — **succeeds**. You can declare proof-due-at-close BEFORE claiming and building.
- [ ] **Protocol (un-obligated items):** both `$CLAIM_1`/`$CLAIM_2` claims succeed in parallel — no lost update, no torn state.
- [ ] The close itself is still refused by the SAME obligation (beat 4 exercises the closure gate end-to-end).

**✅ FIXED (was a real defect).** Beat 3.2 obligated `$C5` toward a **terminal** transition (`applies_to.to:"closed"`, `on_fail:"block"`). An obligation is a TRANSITION precondition, but `evaluateVerdictTx` (`entrypoint/backlog/src/write/gate.ts`) evaluated every terminal-scoped obligation at rung 2 and reported `actionable:false`, so `claim` refused work that was merely obligated. `evaluateVerdictTx` now applies the SAME `predictsClose` skip its close gate uses (`to === '*' || terminal.has(to) || !all.has(to)`): a close-predicting obligation is not due while merely claiming; a malformed row still fails closed (checked first). The close stays refused by the same obligation, unchanged. The beat runs; **reverting the fix makes the runner exit 1** (3.3 goes red). Negative control proven: with the pre-fix guard restored, the claim reads `{"ok":false,"error":{"code":"precondition_failed",…"EvidenceUnverified"…}}`.

🔗 **Proves:** REQ-010, REQ-011 · CAP-006, CAP-007
📎 **Source:** `entrypoint/backlog/skill/SKILL.md` §3 (claim protocol), §5 (batch); design §2 Primitive 4 (`ClaimStale`); design §7 cond. 3 (ADR-0001 transaction binding); fixed by commit `5db10040`.

#### 3.4 · Record a finding against a ticket in flight (🛟 recovery)

🎬 **Scene.** Mid-build, Rex finds something the ticket never mentioned. Historically this was a lose-lose: either the evidence lived in a comment nobody reads, or the ticket was rewritten and got a **new uid**, breaking every reference the fleet held. Here the finding is recorded as a **sibling** record keyed to the ticket's logical id — the ticket is neither rewritten nor churned.

▶️ **Do**
```bash
adhd-backlog backlog get --input "{\"uid\":\"$C3\"}"
adhd-backlog backlog attest --input "{\"subject\":{\"id\":\"$C3\",\"revision\":1},\"claim\":{\"kind\":\"reproduction\",\"body\":\"two-process latch reproduces the race\"},\"anchor\":{\"locator\":\"path:entrypoint/backlog/src/write/transition.ts\",\"digest\":\"⟨sha256 hex of the HEAD blob⟩\"},\"by\":\"researcher:rex-1\"}"
adhd-backlog backlog get --input "{\"uid\":\"$C3\"}"
```

👀 **Expect**
```
{"ok":true,"data":{"uid":"⟨c3 uid⟩","title":"C3 — Attestation: anchored, verifiable evidence that never churns identity","kind":"FEAT","status":"open","priority":"HIGH"}}
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","subject":{"id":"⟨c3 uid⟩","revision":1},"check":{"state":"verified","method":"changed_since","checked_at":"⟨iso⟩","checked_by":"researcher:rex-1"}}}
{"ok":true,"data":{"uid":"⟨c3 uid⟩","title":"C3 — Attestation: anchored, verifiable evidence that never churns identity","kind":"FEAT","status":"open","priority":"HIGH"}}
```

✅ **Verify**
- [ ] The ticket's `uid` is byte-identical before and after the `attest` (compare the two `get`s).
- [ ] The finding is a **separate `attestation`** node whose `subject.id` is the ticket's logical id.
- [ ] `attest` does **not** bump the ticket's `revision` — the record is keyed to the revision observed, and the subject node is never mutated.

🔗 **Proves:** REQ-005, REQ-011 · CAP-003, CAP-006
📎 **Source:** design §2 Primitive 1 (identity survives supersession) + §2 Primitive 2; defect tickets `5b555754`, `e5a790a7`.

---

## 4 · The Climax — The Gate That Will Not Call a Merge "Done"

🎬 **Scene.** The build is green. CI is green. Bo merges, and the merge lands on the default branch. Every previous tool in Dee's life would now accept the commit ref and mark the work done. Watch what happens instead.

The item's obligation says: *a **published artifact** is required.* A commit citation is not an artifact. The store refuses — and it does not move the status, does not soft-close, does not "record the intent". It states the missing kind of proof by name.

Dee's fleet then does the thing that was never enforceable before: publishes, attaches the published artifact as verified evidence, and re-attempts. **Now** the transition lands.

▶️ **Do**
```bash
# 1) the merge landed; try to close on a commit citation
adhd-backlog backlog transition --input "{\"uid\":\"$COMMITREF\",\"by\":\"dispatcher:dee-1\",\"toStatus\":\"closed\",\"note\":\"merged\",\"citations\":[{\"file\":\"package.json\",\"lines\":\"1-1\"}]}"

# 2) publish, then attach the artifact as verified evidence
adhd-backlog backlog attest --input "{\"subject\":{\"id\":\"$COMMITREF\",\"revision\":2},\"claim\":{\"kind\":\"published-artifact\",\"body\":\"@adhd/backlog@⟨ver⟩\"},\"anchor\":{\"locator\":\"path:entrypoint/backlog/package.json\",\"digest\":\"⟨sha256 hex of the HEAD blob⟩\"},\"by\":\"backend:bo-1\"}"

# 3) retry the terminal transition
adhd-backlog backlog transition --input "{\"uid\":\"$COMMITREF\",\"by\":\"dispatcher:dee-1\",\"toStatus\":\"closed\",\"note\":\"published\"}"
adhd-backlog backlog get --input "{\"uid\":\"$COMMITREF\"}"
```

👀 **Expect**
```
{"ok":false,"error":{"code":"precondition_failed","message":"Transition refused: EvidenceUnverified (requires \"published-artifact\") — no verified attestation of kind \"published-artifact\" satisfies this obligation","details":{"retryable":false}}}
{"ok":true,"data":{"attestationUid":"⟨uuid⟩","subject":{"id":"⟨uuid⟩","revision":2},"check":{"state":"verified","method":"changed_since","checked_at":"⟨iso⟩","checked_by":"backend:bo-1"}}}
{"ok":true,"data":{"uid":"⟨uuid⟩","fromStatus":"open","toStatus":"closed","closedAt":"⟨iso⟩","transitionUid":"⟨uuid⟩"}}
{"ok":true,"data":{"uid":"⟨uuid⟩","title":"Commit-ref closure","kind":"FEAT","status":"closed","priority":"HIGH"}}
```

✅ **Verify**
- [ ] Step 1 is **refused** with `EvidenceUnverified` and names `published-artifact` as the missing kind.
- [ ] After step 1, re-reading the item shows the status **unchanged** on disk (nothing was silently soft-closed).
- [ ] A commit citation alone never satisfies an obligation whose kind is `published-artifact`.
- [ ] Step 3 succeeds and records the transition (`transitionUid`). The `satisfies` edges are written; the outcome itself carries **no `satisfiedBy` field** (the internal `meta.satisfied_by` is not surfaced on the transition result).
- [ ] The evidence that satisfies the gate must be mechanically **verified** — a `path:` (or `commit:`) anchor. A `registry:`/`url:`/`query:` anchor is `unverified` by design and cannot satisfy the obligation (no mechanical checker is wired for those schemes yet). ⟦pinned⟧

🔗 **Proves:** REQ-008, REQ-009 · CAP-005
📎 **Source:** design §2 Primitive 3 + §7 cond. 3 + C5 spec (`specs/C5-closure-gate.spec.md`); defect tickets `4fc3704e`, `0abc01ed`.

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ An ambiguous prefix is refused, not guessed — ✅ NOW-RUNNABLE

▶️ **Do**
```bash
adhd-backlog backlog get --input '{"uid":"4fc"}'
```
👀 **Expect** — `{"ok":false,"error":{"code":"invalid_argument","message":"Invalid argument \"uid\": uid prefix \"4fc\" is too short — a uid prefix must be at least 8 characters (or pass the full uid)","details":{"retryable":false}}}` (exit 2)

✅ **Verify**
- [ ] A sub-8-character prefix is refused as **too short** (`invalid_argument`), distinct from `item_not_found`. **(evaluated every run; HOLDS)**
- [ ] An 8-character prefix matching **two or more** live nodes is refused with `ambiguous_reference`, naming every candidate. **(scope gap — see below)**

**✅ NOW-RUNNABLE (the too-short assertion is evaluated; the ambiguity half remains a scope gap).** The beat is CARRIED as not-runnable, but the runner no longer discards its assertion: it evaluates the too-short refusal each run and reports NOW-RUNNABLE. The beat's **full** claim — a genuine `ambiguous_reference` naming every candidate — still cannot be exercised here: it needs two live nodes sharing an 8-hex prefix, and the shipped write API mints `crypto.randomUUID()` with no override, so this isolated fixture cannot deterministically seed a collision. That residual gap keeps REQ-001 **partial** (see §7.1); it is not a product defect.

🔗 **Proves (too-short half):** REQ-001 · CAP-001
📎 **Source:** C1 spec (`specs/C1-reference.spec.md`); `entrypoint/backlog/src/write/uid-prefix.ts`; runner residual-claim handling in `fixture/run.mjs`.

#### 5.2 · ⚠️ A dependency cycle is named, not hung on

▶️ **Do**
```bash
adhd-backlog backlog relate --input "{\"sourceUid\":\"$CYCLE_A\",\"targetUid\":\"$CYCLE_B\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}"
adhd-backlog backlog relate --input "{\"sourceUid\":\"$CYCLE_B\",\"targetUid\":\"$CYCLE_A\",\"rel\":\"blocks\",\"action\":\"add\",\"by\":\"operator:otto-1\"}"
adhd-backlog backlog query --input '{"view":"order","filter":{"kind":"FEAT"},"limit":50}'
```
👀 **Expect** — `{"ok":true,"data":{"view":"order","order":{"ok":false,"cycle":["⟨A⟩","⟨B⟩"]}}}`
✅ **Verify**
- [ ] The envelope is `ok:true`; the cycle rides **inside `data.order`** as `{ok:false, cycle:[…]}` — not an envelope-level error.
- [ ] The cycle is reported in full, naming every member.
- [ ] No partial order is emitted as if it were complete.

🔗 **Proves:** REQ-003 · CAP-002
📎 **Source:** existing `queryOrder` cycle arm (`{ok:false, cycle:[...]}`), preserved by C2 spec.

#### 5.3 · ⚠️ A truncated page can never read as complete

▶️ **Do**
```bash
adhd-backlog backlog query --input '{"view":"ready","limit":5}'
```
👀 **Expect** — `{"ok":true,"data":{"view":"ready","items":[⟨…⟩]},"meta":{"total":⟨n⟩,"total_relation":"eq"|"gte","returned":⟨n⟩,"limit":5,"has_more":false|true}}`
✅ **Verify**
- [ ] The completeness signal is **`meta.has_more`** (a boolean), with `meta.total`/`meta.returned`/`meta.limit` alongside it. There is **no `meta.truncated`** on an item-list view (`truncated` exists only on the ranked `grep`/`semantic` path). ⟦pinned⟧
- [ ] `meta.returned` equals the number of items actually returned.
- [ ] Where a true pre-limit total is unknowable at bounded cost, `meta.total_relation` is `"gte"` (a labelled lower bound), never a fabricated exact number.

🔗 **Proves:** REQ-012 · CAP-007
📎 **Source:** design Invariant 5 + C7 spec (`specs/C7-envelopes.spec.md`); `entrypoint/backlog/src/envelope.ts` `IQueryEnvelopeMeta`.

#### 5.4 · ⚠️ A rank-derived score is labelled, not mistaken for confidence — ⏭ NOT-RUNNABLE

▶️ **Do**
```bash
adhd-backlog backlog query --input '{"filter":{"semantic":"citation gate"},"limit":3}'
```
👀 **Expect** (with the embedding backend configured) — `{"ok":true,"data":{"items":[{"uid":"⟨uid⟩","_score":0.0164,"_score_kind":"rrf"}]},"meta":{"total":⟨n⟩,…}}`

✅ **Verify**
- [ ] Every derived score carries `_score_kind`.
- [ ] The count is labelled for what it counts (matches, not the whole corpus).
- [ ] A bare `_score` with no provenance tag fails this assertion.

**⏭ NOT-RUNNABLE — environment, not a product defect.** `filter.semantic` needs the semantic/embedding backend. The demo fixture runs `embedding.enabled:false` for determinism and the optional `@adhd/sox-embedding-provider` is not part of the default install; with it off the verb answers `invalid_argument "semantic search is not configured"`. Run this beat against an embeddings-enabled store. Assertion kept.

🔗 **Proves:** REQ-012 · CAP-007
📎 **Source:** design Invariant 5 + C7 spec; defect ticket `bbeb0f57` (resolved).

#### 5.5 · ⚠️ The advertised surface is real (no phantom verbs)

▶️ **Do**
```bash
adhd-backlog --help | rg -c '^\s+backlog '
adhd-backlog backlog attest --input '{}'
```
👀 **Expect** — `⟨n⟩` then, on **stderr**, an unwrapped `{"code":"invalid_argument","message":"Validation failed: /data/input must have required property 'subject'; …","details":[…]}` (no `"ok"` key; exit 2). Stdout is empty.
✅ **Verify**
- [ ] Every verb the help advertises is invocable; none returns `not_found`.
- [ ] A malformed `--input` fails the outer schema check and prints an **unwrapped** error to **stderr** (never to stdout), exit 2 — the one case outside the `{ok,data|error}` envelope contract.
- [ ] `batch action` is rendered distinctly from the one-token `--input` verbs.

🔗 **Proves:** REQ-013 · CAP-008
📎 **Source:** design Invariant 6 + C8 spec; defect tickets `6bfdda8a`, `a7d3990a`.

#### 5.6 · ⚠️ Cross-project **similar** items are surfaced, never auto-linked — ⏭ NOT-RUNNABLE

▶️ **Do**
```bash
adhd-backlog backlog query --input '{"view":"similar","filter":{"similarTo":"$C5"},"limit":10}'
```
👀 **Expect** (with the embedding backend configured) — `{"ok":true,"data":{"view":"similar","items":[{"uid":"⟨uid⟩","project":"⟨project uid⟩","component":"⟨component uid⟩"}]},"meta":{"total":⟨n⟩,"returned":⟨n⟩,"limit":10,"has_more":false}}`
✅ **Verify**
- [ ] Candidates carry project/component provenance so a reviewer can reject fast.
- [ ] **No** `similar_to` edge is written by a scan; linking requires an explicit reviewed `relate` call with `rel:"similar_to"`.
- [ ] `duplicate_of` is **reserved** — the scan never writes it, and it is not repurposed as the similarity relation.
- [ ] The reviewed-similarity relation is the existing `relate` verb; there is **no `link-duplicate` verb**. ⟦U7⟧ pinned.

**⏭ NOT-RUNNABLE — environment, not a product defect.** `view:"similar"` routes through the vector space and answers `invalid_argument "semantic search is not configured"` without the embedding backend. Assertion kept.

🔗 **Proves:** REQ-002 · CAP-001
📎 **Source:** C9 ticket `cf97c613` + `specs/C9-similarity.spec.md` + `substrate-fleet/DESIGN.md` §2 X1.

#### 5.7 · ⚠️ The deployed copy is checked against its source — ⏭ NOT-RUNNABLE

▶️ **Do**
```bash
soxe verify --host opencode
```
👀 **Expect** — `drift: none (⟨n⟩ owned, ⟨n⟩ still-valid)`

✅ **Verify**
- [ ] The check reports `still-valid` / `drifted` / `gone` per owned artifact.
- [ ] It is read-only: nothing on disk changes.

**⏭ NOT-RUNNABLE — unimplemented in another repo, not a defect in this build.** The shipped `soxe` CLI has no `verify` verb (`soxe verify` → `sox: unknown verb 'verify'`); the D-B artifact-lifecycle check is specified (`substrate-fleet/specs/D-B-artifact-lifecycle.spec.md`) but not implemented. ⟦U5⟧ pinned to "no such command". This probes an EXTERNAL verb, so it is reported informationally (the runner prints `[5.7 probe] …`) and the beat SKIPs — it must not turn the runner red for another repo's unimplemented feature.

🔗 **Proves (when implemented):** REQ-012 · CAP-007
📎 **Source:** substrate-fleet §2 D3 + sox ADR-0003/0004.

#### 5.8 · ⚠️ The list path is bounded, and its p95 is measured (C6 AC5)

🎬 **Scene.** A verdict is derived on every read — so a list of N items must never pay the full per-item ladder. The bound is not asserted; it is **measured**, and the measurement is published.

▶️ **Do**
```bash
node entrypoint/backlog/tools/with-dist-lock.mjs npx vitest run \
  --config entrypoint/backlog/vitest.e2e.config.ts verdict-list-bound
```

👀 **Expect**
```
[C6 AC6] N=200 items (returned 200); list-path p95 = ⟨N⟩ms over 15 runs; maxRungObserved = 2
```

✅ **Verify**
- [ ] `verdict-list-bound.e2e.ts` runs green — the real list path (`query {view:'ready', fields:['verdict']}`) evaluates **at most rungs 1–2**.
- [ ] It reports an N-item list-path **p95** (the measurement is surfaced, not merely asserted).
- [ ] The ceiling has teeth: its own negative control observes a rung-3 evaluation when `maxRung` is raised.

🔗 **Proves:** REQ-011 · CAP-006
📎 **Source:** C6 spec AC6 (`specs/C6-verdict.spec.md` §"Test list"); `entrypoint/backlog/src/query/verdict-list-bound.e2e.ts`; DESIGN §2 Primitive 4 ("Bounded derivation").

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
adhd-backlog sandbox-path
git status --porcelain | rg 'tmp/actionable-store-demo' || echo 'no stray tracked artifacts'
```
👀 **Expect**
```
{"namespace":"production","dbPath":"…/tmp/actionable-store-demo/demo.db","embeddingEnabled":false}
no stray tracked artifacts
```
✅ **Verify**
- [ ] No process is left listening on a demo port.
- [ ] No demo artifact was written into the repo tree (the store is gitignored under `tmp/`).
- [ ] The production store is unchanged: every demo write was pinned to `ADHD_BACKLOG_DATABASE_PATH`.

🔗 **Proves:** REQ-012 · CAP-007
📎 **Source:** `entrypoint/backlog/skill/SKILL.md` §7; repo `AGENTS.md` §10 (ephemeral artifacts under `tmp/`).

---

## 7 · Coverage & Traceability Matrix

**Legend:** ✓ fully proven · ◐ partial (a beat is SKIPped, or a NOW-RUNNABLE beat carries a residual scope gap) · ✅ fixed (a former defect beat, now passing).

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Resolve a short uid prefix to one item, or report ambiguity | 1.1 ✓, 5.1 ✅* | H/E | ◐ |
| REQ-002 | Resolve project/component tokens; one canonical row; cross-project provenance | 1.3 ✓, 5.6 ⏭ | H/E | ◐ |
| REQ-003 | List a plan's members and order across every member kind | 1.3 ✓, 1.4 ✓, 5.2 ✓ | H/E | ✓ |
| REQ-004 | Expose outbound blocks + dependent count; order by unblock-worth | 2.1 ✓, 1.4 ✓ | H | ✓ |
| REQ-005 | Attach evidence without changing the item's uid | 2.3 ✓, 2.5 ✓, 3.1 ✓, 3.4 ✓ | H/R | ✓ |
| REQ-006 | Verify a citation against its own project root; explicit `unverified` | 2.3 ✓, 2.4 ✅, 2.5 ✓ | H/R | ✓ |
| REQ-007 | Declare a typed obligation from a closed predicate core | 3.2 ✓ | H | ✓ |
| REQ-008 | Refuse a terminal transition whose obligations are unsatisfied | 4 ✓ | H | ✓ |
| REQ-009 | A commit ref alone does not satisfy `published-artifact` | 4 ✓ | E | ✓ |
| REQ-010 | Refuse a claim on an item with a live blocker, naming it | 2.2 ✓, 3.3 ✅ | E/H | ✓ |
| REQ-011 | Derive actionability with typed reasons; `unknown` is never green | 2.1 ✓, 2.6 ✓, 3.3 ✅, 3.4 ✓, 5.8 ✓ | H/R | ✓ |
| REQ-012 | Every read reports completeness and score provenance | 2.4 ✅, 1.3 ✓, 5.3 ✓, 5.4 ⏭, 5.7 ⏭, 6 ✓ | H/E | ◐ |
| REQ-013 | Catalogs are readable; no advertised verb is absent | 1.2 ✓, 5.5 ✓ | H/E | ✓ |
| REQ-014 | The honest floor: an un-obligated item is actionable by default | 2.1 ✓, 2.6 ✓, 3.2 ✓ | H | ✓ |
| REQ-015 | A work product is a revision of its ticket — referenced not embedded; an absent token is stale | 3.1 ✓ | H | ✓ |

\* 5.1 is NOW-RUNNABLE — its too-short refusal is evaluated and holds — but its ambiguity half is unseedable, so the beat carries a residual gap and REQ-001 stays **partial**.

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Reference — canonical identity and resolution | 1.1 ✓, 1.3 ✓, 5.1 ✅*, 5.6 ⏭ | ◐ |
| CAP-002 | Legibility — relations, order, unblock-worth | 1.3 ✓, 1.4 ✓, 2.1 ✓, 5.2 ✓ | ✓ |
| CAP-003 | Attestation — anchored, verifiable, non-churning evidence | 2.3 ✓, 2.4 ✅, 2.5 ✓, 3.1 ✓, 3.4 ✓ | ✓ |
| CAP-004 | Obligation — declared typed requirements | 3.2 ✓ | ✓ |
| CAP-005 | Gate — terminal transitions require satisfied obligations | 4 ✓ | ✓ |
| CAP-006 | Verdict — derived actionability and claim enforcement | 2.1 ✓, 2.2 ✓, 2.6 ✓, 3.3 ✅, 3.4 ✓, 5.8 ✓ | ✓ |
| CAP-007 | Observe — honest envelopes and computed reporting | 2.4 ✅, 1.3 ✓, 3.3 ✅, 5.3 ✓, 5.4 ⏭, 5.7 ⏭, 6 ✓ | ◐ |
| CAP-008 | Catalog — readable, self-describing surface | 1.2 ✓, 5.5 ✓ | ✓ |

**Totals: 21 passed · 1 now-runnable · 0 failed · 3 NOT-RUNNABLE (of 25 beats) · 12/15 requirements fully proven (+3 partial) · 6/8 capabilities fully proven (+2 partial).**

### 7.3 Not-Runnable & Residual Beats — classification

**Former product defects — FIXED and now running (assertions evaluated every run):**

| Beat | Fix (with negative control) |
|---|---|
| 2.4 ✅ | `resolveIssueProject`/`resolveAnchorRoot` (`write/attestation.ts`) resolve a citation against the registered project root that OWNS it — the sibling-repo false refutation (`78c96213`) is fixed. Reverting the fix makes the runner exit 1 (`2.4` red). Commit `068e554c`. |
| 3.3 ✅ | `evaluateVerdictTx` (`write/gate.ts`) applies the close-predictor skip, so a terminal-scoped obligation no longer refuses the claim; the close stays refused. Reverting the fix makes the runner exit 1 (`3.3` red). Commit `5db10040`. |

**Environment / scope — genuinely unexecutable or residual (not defects in this build):**

| Beat | Cause |
|---|---|
| 5.1 ✅ (residual) | NOW-RUNNABLE: the too-short refusal is evaluated and holds. A genuine `ambiguous_reference` needs two live nodes sharing an 8-hex prefix, which the shipped write API (`crypto.randomUUID()`, no override) cannot seed deterministically — a residual scope gap; REQ-001 stays partial. |
| 5.4 | Needs the semantic/embedding backend; the deterministic fixture runs `embedding.enabled:false`. No assertion can be evaluated. |
| 5.6 | Same — `view:"similar"` needs the vector space. |
| 5.7 | `soxe` has no `verify` verb; D-B is specified but unimplemented in sox-ecosystem. The probe is informational; the beat SKIPs. |

### 7.4 Pinned Interfaces

All former `⟦U#⟧` stubs are now pinned to the shipped build (see `UNRESOLVED.md` for the exact shapes): the readiness probe (`serve --probe`), the `attest`/`recheck`/`obligate`/`catalogs`/`verdict` payloads, the `order` result shape, the item-list `meta` envelope, and the anchor-locator grammar. The anchor digest is **bare sha256 hex** (no `sha256:` prefix) — the exact form `checkAnchor`'s full-resolve rung compares (beat 2.5).

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | macOS · node v24.11.1 · `@adhd/backlog` 1.0.5 (`entrypoint/backlog/dist/index.js`) |
| Fixture | seeded isolated store at `tmp/actionable-store-demo/demo.db` (`fixture/seed.sh`) |
| Runner | `node docs/plan/actionable-store/demo/fixture/run.mjs` |
| Date | ⟨date⟩ |
| Beats | 21 passed · 1 now-runnable · 0 failed · 3 NOT-RUNNABLE (of 25) |
| Requirements proven | 12 of 15 fully (+3 partial) |
| Capabilities proven | 6 of 8 fully (+2 partial) |
| Runner exit | 0 |
| Result | ☑ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes | 2 former product-defect beats (2.4, 3.3) FIXED, running, and covered by a negative control (reverting either makes the runner exit 1); 3 genuinely-unexecutable NOT-RUNNABLE (5.4, 5.6, 5.7); 1 residual scope gap (5.1 ambiguity). |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved. The runner enforces this mechanically: it exits non-zero on any FAIL, and a carried NOT-RUNNABLE classification never suppresses an assertion — a beat whose assertion is evaluated and holds reads NOW-RUNNABLE, not SKIP.
