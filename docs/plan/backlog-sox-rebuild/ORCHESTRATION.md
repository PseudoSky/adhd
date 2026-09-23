# Backlog rebuild — orchestration plan (architecture review)

Reviewer deliverable. Scope: HOW to run the remaining work, not the domain design.
Grounded in: `entrypoint/backlog/SPEC.md` (§4, §4a-c, §5, §6.1/6.3/6.7, §7, §8.6-8.8, §9, §10.4),
the committed foundation (`entrypoint/backlog/src/write/{tx,catalog,audit,errors,create-issue}.ts`, 1432 lines),
`.githooks/detect-mass-deletion.js`, `.mcp.json`, `entrypoint/backlog/package.json`.

---

## 0. Three things in the current approach that are wrong

### 0.1 The §10.4 write-safety gate is listed 7th. It is step 2.

SPEC.md:29-33 states BUG-039 disappearing under DB-generated ids is **HYPOTHESIZED**, and
§10.4 (SPEC.md:2285) exists to *confirm* it. It is the only remaining step that can invalidate the
design premise. If UUID identity does not fix cross-process loss, the write-layer composition
changes and every verb fanned out downstream is rework.

It is nearly reachable now: it needs `createIssue` (committed, `src/write/create-issue.ts:1-301`)
plus a component-scoped count for `storedCount` (`concurrency-scale.spec.ts:407-417`). It does
**not** need nine verbs, views, or transports. So slice the query layer as *core read path first*,
gate, then fan out.

### 0.2 The gate harness lives inside the 39.5k lines you are about to delete

`src/store/concurrency-scale.spec.ts` + its `cross-process-writer.cjs` fixture are wipe targets.
§10.4 additionally requires two edits before it can gate anything: remove `describe.skip`
(concurrency-scale.spec.ts:419) and repoint the fixture off `createItem({family,repo})` /
`listItems({repo,family})` (cross-process-writer.cjs:26,52). **Relocating and repointing that
harness into the new namespace is an explicit deliverable of the write slice**, sequenced before
the wipe touches `src/store/`. Wipe first and you lose the gate; relocate without repointing and
it will not compile.

Note also: a `describe.skip` on a cross-process harness is precisely what AGENTS.md's
"Live testing is mandatory — no silent gating" forbids. The same judgment recurs for AC-7
(semantic search). A local embedding provider is **not** a paid external service, so AC-7 runs by
default. Decide this at plan time or a fan-out agent will quietly skip it.

### 0.3 The ETL must not read v1 through in-tree v1 code

This is the constraint that makes the wipe orderable. §8 (SPEC.md:1826-1842) says the live store is
"read through its existing public API" — if that API is in-tree, then v1 code must survive until the
ETL runs, the wipe becomes the last step, and every gate has to be re-run after it.

**Break the dependency: freeze the corpus.** A throwaway, uncommitted extractor produces a frozen
JSONL corpus from the v1 store; the ETL consumes JSONL only. Consequences, all good:

- The wipe is decoupled from the ETL and can happen before it.
- The ETL becomes deterministic and replayable against a fixture — which is what lets you develop
  and test it in parallel with everything else.
- Parity expectations (§8.8 clause 2) become computable from the extract, independently of the ETL.
- Per AGENTS.md ("one-shot migrations / ETL → a temporary, uncommitted throwaway script"), the
  extractor never ships, so it cannot violate the vocabulary criterion.

**Run the extractor twice.** Once early against a snapshot copy, as the dev fixture. Once fresh at
cutover for the real run — migrating from a stale extract silently drops every issue filed between
now and cutover, and this session is required to file at discovery time.

**The extract must reach invalidated nodes.** §8.6 step 5 requires migrating every historically
superseded / dropped-duplicate node *and* its reason text (`"[superseded by X] …"`,
store/structure.ts:280/326), then invalidating it. §8.8 clause 2 measures **live** counts on both
sides — so an extract containing only live rows yields a *green* parity check with all history
gone. Verify whether `@adhd/backlog@0.1.9`'s public surface can reach invalidated nodes; if it
cannot, the extractor reads the v1 SQLite file directly, read-only (acceptable — throwaway script,
file never mutated, §8's "old file is never opened for write" preserved). Either way, assert the
extract's row count against a direct `COUNT(*)` on the v1 file before trusting it.

---

## 1. Slice DAG — what is sequential, what is genuinely parallel

Items 1-8 from the brief re-cut into slices. `→` = hard dependency.

```
S0  Foundation freeze + 3 changes        (SEQUENTIAL, blocks everything)
      │
      ├──────────────┬──────────────┬─────────────────────────┐
      ▼              ▼              ▼                         ▼
S1  Query core   S2 Registry CRUD   S6 Extractor + corpus   S9 Consumer inventory
  (keyset,        (upsert*/rmLoc)     freeze (throwaway)      (pre-wipe survey)
   filters,          │                     │
   counts)           │                     │
      │              │                     │
      ▼              │                     │
S3  §10.4 GATE ◄─────┘                     │   ← HARD BARRIER. Nothing downstream starts.
      │                                    │
      ├────────────┬────────────┐          │
      ▼            ▼            ▼          ▼
S4  Verbs      S5 Query views  S7 Transports   S8 ETL (dev, against frozen fixture)
  (4 agents)     (3 agents)      (1+3 agents)      (1 agent)
      └────────────┴────────────┴──────────┘
                   ▼
S10  Acceptance suites (23 AC → 6 suites, 6 agents)
                   ▼
S11  THE WIPE  (single commit, solo, no parallelism)
                   ▼
S12  Vocabulary gate green + docs
                   ▼
S13  Fresh extract → real ETL run → §8.8 + §9 clause 6 parity
                   ▼
S14  Publish → blind test of the PUBLISHED package → file findings
```

**Genuinely parallel:** S1‖S2‖S6‖S9. Then S4‖S5‖S7‖S8. Then the six S10 suites.
**Hard barriers:** S0 before anything. S3 before S4/S5/S7/S8 (§8's own rule: "never write real data
onto an unproven write path", SPEC.md:1840). S11 solo. S13 after S11 and after S12.

**What can overlap that you may not expect:** the ETL (item 6) develops *fully in parallel* with the
verbs and transports, because the frozen fixture from S6 removes its dependency on live v1 data. Only
its *real run* (S13) is late. And the docs (item 8) are drafted during S10, not after S11.

**What cannot overlap:** the wipe against anything. See §3.

---

## 2. Fan-out shape per slice

Repo rule (AGENTS.md §13): >5 same-shaped items ⇒ `pipeline()`/`parallel()`, one bounded agent per
item, never one agent looping. A prior monolithic dispatch on this job already burned 700k tokens.

| Slice | Agents | Split axis | Each agent's exact deliverable |
|---|---|---|---|
| **S0** | 1 (you, or one senior agent) | — | The three foundation changes in §5 below + a frozen, published export contract |
| **S1 Query core** | **1, not N** | — | `src/query/` : filter compiler, keyset cursor, `queryNodes`/`countNodes`/edge-scoped `countBy` per §5. **Do not fan out.** The cursor encoding, the filter compiler, and the sort/keyset conflict (AC-20) are one design; three agents produce three cursor formats. |
| **S2 Registry CRUD** | **1** | — | `upsertProject`/`upsertComponent`/`upsertLocation`/`rmLocation`. One agent because all four share the edge-scoped uniqueness composition, and `upsertProject`'s `(root)` guarantee (SPEC.md:373-380) is entangled with `createIssue`'s `resolveDefaultComponentTx` (catalog.ts). **`lookup` is NOT here** — it is a read verb, it belongs to S5. |
| **S3 Gate** | 1 | — | Relocated + repointed cross-process harness, un-skipped, green, **and red under the negative control** |
| **S4 Verbs** | **4** | per verb, with one merge | (a) `update` **+** `transition` — *one agent*; §4 routes status through `transition` and AC-14 requires `update` carrying `status` to be rejected *naming* `transition`; two agents draw that boundary differently. (b) `claim` **+** `delete` — one agent; `delete` is ~50 lines of soft-invalidate and `claim`'s CAS is the hard part. (c) `relate`. (d) `move`. (c) and (d) are genuinely independent: both are pure `writeEdgeTx`/`invalidateEdgeTx` compositions over a frozen foundation. |
| **S5 Query views** | **3** | per view family | (a) registry views + `lookup` (§3a, AC-9/10/11). (b) semantic `view:similar`/`relevance`/`_score` (§5a). (c) stats/rollup: status-aware priority matrix (BUG-023), `part_of` rollup (FEAT-005), `validAt` curves. All three consume S1's frozen filter/cursor contract. |
| **S6 Extractor** | 1 | — | Throwaway extractor + frozen JSONL corpus + independently-computed expected counts (`wc -l`/`jq`), + the `COUNT(*)` cross-check against the v1 file |
| **S7 Transports** | **1 + 3** | author, then verify | **One agent authors the single apigen descriptor** (§6.7 — `describeMountedSurface`/`project(op)`, unchanged mechanism, new op list). Four authoring agents = four divergent descriptors. *Then* fan out 3 verification agents (CLI / MCP / HTTP) that drive the **built** artifact as a real client — spawn the CLI, real stdio JSON-RPC to the unmodified MCP server, real HTTP. Per AGENTS.md, never import the server. |
| **S8 ETL** | **1, not N** | — | One agent. The two-pass ordering (§8.6), per-issue transaction granularity (§8.8), the crosswalk, and restart idempotency (§8.7) are one coherent state machine. Splitting Pass 1 from Pass 2 across agents splits the crosswalk, which is the whole mechanism. |
| **S10 Acceptance** | **6** | per AC group | (1) AC-1/2/5 identity+uniqueness. (2) AC-3/4 audit+embedding. (3) AC-13/14/15/23 get/update/transition/default-component. (4) AC-16/17/18 claim/relate/move/delete. (5) AC-7/8/19/20 semantic/keyset/duplicate-gate/sort-conflict. (6) AC-9/10/11/12/21 registry. AC-6 and AC-22 are **not** here: AC-22 is S3, AC-6 is S13. |
| **S11 Wipe** | **1, solo** | — | See §3 |
| **S14 Blind test** | **5** | per surface | Published-package blind test: install `@adhd/backlog@<new>` from npm into a clean dir, one agent per surface (CLI, MCP, HTTP, registry, ETL-restart), each given **only** the published README + the task "exercise this". No spec, no source. Findings → backlog items. |

Peak concurrency: 4 (S1/S2/S6/S9), then 9 (S4×4 + S5×3 + S7 + S8), then 6 (S10). Never more than 9.

---

## 3. The wipe — exact sequencing

**The wipe happens after all gates are green and before the real ETL run.** Not last, not first.

Why it can be deferred safely — and this contradicts the spec in your favour: SPEC.md:2265-2272
claims "there is no intermediate state where both compile." That is already falsified. `package.json`
is *already* bumped (graph-store `^0.9.1`, store-adapter `^0.9.0`, hybrid-search `^0.4.2`,
semantic `^0.1.2`, vector-store `^0.6.0`) and the tree builds green with the old code present
(`nx affected -t build --uncommitted`, exit 0). So the dep bump does not force wipe atomicity.
The new layer grows alongside the old one, in new directories, and the old one is deleted in one
isolated commit at the end.

**Why after the gates, not after the ETL:** the ETL consumes frozen JSONL (§0.3), not v1 code.
So nothing the ETL needs dies in the wipe. Running the real ETL *before* the wipe would mean the
migrated data was produced by a build that still contained 39.5k lines of dead code and 1684
`humanId` occurrences — i.e. an artifact you cannot ship without a second full re-gate.

**Note the poisoned namespace:** `src/v2/` is *old* code (`src/v2/query.ts` 2730 lines,
`src/v2/get.ts`, `src/v2/admin.ts`) and it carries `humanId` itself. New code must never land in
`src/v2/`. The foundation correctly chose `src/write/`. Keep going: `src/query/`, `src/registry/`,
`src/transport/`.

### Wipe procedure

```
W0. Freeze: no other agent has a write lock on entrypoint/backlog. Solo step.
W1. git status --porcelain  →  must be empty except intended staged work.
W2. Run the consumer inventory from S9 (below). Fix external callers FIRST, in a
    separate prior commit — never inside the wipe commit.
W3. Read .githooks/detect-mass-deletion.js:60-62 — DEFAULT_MIN_FILES=5,
    DEFAULT_MIN_DELETIONS=100, DEFAULT_RATIO=1.5. A 39.5k-line / ~106-file deletion
    trips all three. The override is ADHD_CONFIRM_MASS_DELETE=1
    (detect-mass-deletion.js:159). Set it deliberately, ON THE WIPE COMMIT ONLY.
W4. Delete. One commit, containing NOTHING but deletions + the mechanical
    import/build fallout fixes they force. No feature work, no refactors.
W5. npx nx affected -t build --uncommitted   → exit 0
    npx nx affected -t test  --uncommitted   → exit 0
    npx nx run backlog:verify-dist-load      → exit 0   (green nx test resolves to
                                                          source; this loads real dist)
W6. node scripts/check-vocabulary.mjs        → exit 0   (§5.4)
W7. Re-run the full S10 acceptance suite + the S3 gate against the post-wipe build.
```

**Recovery plan = the one-commit isolation.** If W5/W7 goes red in a way you cannot fix in an hour,
`git revert <wipe-sha>`. That is the entire rollback. `git stash` and `git reset --hard` are banned
(AGENTS.md), and with a single-purpose commit you never need them.

### S9 — the consumer inventory (do this BEFORE the wipe, it is the worst available outcome)

`@adhd/backlog` is the tool every agent in this repo uses to file issues. Verified live callers:

- **`.mcp.json:17-21`** mounts `backlog` at `entrypoint/backlog/dist/index.js serve --transport mcp`
  — a **main-worktree relative path**. Good news: the worktree build does not disturb the running
  session's tool, so long as nobody rebuilds main's `dist/`. Make that an explicit rule for every
  fan-out agent: **never `nx build backlog` outside the worktree.**
- **`AGENTS.md`** documents `adhd-backlog admin --input '{"action":"migration_status"}'` as the
  authoritative phase check. §7 deletes migration-phase machinery. AGENTS.md must be updated in the
  wipe commit — and this is also a vocabulary-criterion hit.
- **`docs/plan/backlog-adoption/parity-check.mjs:106`** calls `query` with `filter.excludeArchived`;
  **`import-manifest.mjs:48`** calls `import-from-markdown`, which §7 deletes outright.
- `tools/nx-plugins/**` hits are comments/incident notes only (verified: `compute-real-deps.js:71`,
  `clean-room-smoke.mjs`, `sync-global.mjs`) — no live v1 verb calls. `tools/util/backlog.mjs` is a
  standalone `BACKLOG.md` markdown parser with no v1 API dependency. Both safe.
- The `BACKLOG.md` projection + its parity gate: confirm which surface renders it before the wipe.

---

## 4. Test strategy — the minimum set that genuinely proves this

Bar (AGENTS.md §7): real components not mocks; teeth proven by negative control; deterministic via
latches/barriers never sleeps; trust exit codes never stdout.

### The six suites

1. **Write-safety / cross-process (S3).** The §10.4 harness. Two real OS processes, file barrier,
   fresh-reopen `storedCount`. **This is the only suite that gates data.**
2. **Verb behaviour (S4-owned, per-agent).** Real store on disk, real transactions, no mocks. Each
   verb agent ships its own spec alongside its verb.
3. **Query semantics (S5-owned).** Keyset stability under concurrent insert, filter correctness,
   edge-scoped counts.
4. **Acceptance (S10).** The 23 AC, six suites, each AC one named test.
5. **Transport conformance (S7).** Built artifact driven as a real client, three transports.
6. **ETL replay (S8).** Frozen fixture in, parity out; plus the restart test — kill mid-run at a
   deterministic item boundary, re-run, assert exactly-once.

### Which AC need a negative control to have teeth

Not all 23. These seven do — the rest are ordinary assertions:

| AC | Negative control | Why it is required |
|---|---|---|
| **22** (BUG-039) | Downgrade `immediate` → `deferred`; assert stored count goes **below** expected | Spec mandates it (SPEC.md:2333-2344). The fixture exits 0 on silent loss *by design* — without the control you cannot distinguish "safe" from "not measuring" |
| **16** (claim CAS) | Same `immediate` downgrade; assert two concurrent claims both report `claimed` | A CAS test passes trivially if the two processes never actually overlap |
| **3** (audit) | Remove the transition validator; assert a bare transition is accepted | AC-3's own text says "red without the check" |
| **8** (keyset) | Insert rows *between* page fetches; assert gaps/dupes appear if the cursor is offset-based | An offset-based cursor passes a static-corpus keyset test |
| **15** (closedAt clear) | Skip the reopen-clear; assert the stale-`closedAt` query still matches | AC-15's stale case is the whole point; the unset-on-first-transition case is free |
| **19** (duplicate gate) | Disable the dedupe scan; assert the near-duplicate is admitted | Otherwise a permanently-empty candidate set reads as "correctly suppressed" |
| **§8.8 c.2** (parity) | Run the ETL against a **truncated** extract; assert parity goes red | See §5.5 — the tautology risk |

### Two things the AC list does not currently prove

- **AC-6 parity is a tautology risk.** §8.8 clause 2 compares "v1 source count" to "v2 written
  count." If the expected side comes from the ETL's own counters, it compares the ETL to itself and
  is green on a lossy run. Expected values must be computed **independently** from the frozen JSONL.
- **Restart idempotency has no AC.** §8.7 is load-bearing and untested by §9. Add it as the sixth
  suite's second test: interrupt, resume, assert no duplicate rows.

---

## 5. Failure modes, and the guards

Ordered by (likelihood × damage). The first four I think you are underweighting.

### 5.1 A fan-out agent edits the foundation — **the #1 failure at 9-agent scale**

Nine agents share `tx.ts`/`catalog.ts`/`errors.ts`. One decides `writeEdgeTx` needs a parameter,
edits it, and silently changes semantics under the other eight.

**Guard:** publish the foundation's export list (55 exports across the five files) as a **frozen
contract** in every agent's brief. Any agent that believes the foundation must change **returns with
the request** rather than editing. Enforce mechanically: a pre-flight check in each agent's
verification step that `git diff --stat src/write/{tx,catalog,errors,audit}.ts` is empty.

### 5.2 The negative-control patch is left in the tree — **this repo has already eaten this**

`DEBT-PROCESS-DISPATCH-RESIDUE-001`: an un-reverted negative-control patch in
`apigen-plugin-py-grpc/src/lib/plugin.ts` turned the golden-parity gate red and blocked three
package publishes *while the release reported success*. Seven of your AC now need negative controls.
The probability of leaving one behind across nine agents is high.

**Guard — make it structurally impossible:** the `immediate`-mode switch is a **single point in
`executeWriteTransaction` driven by an env var** (`ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`), not a
source edit. An env-var control reverts itself when the process exits. Same shape for the AC-3
validator and the AC-19 dedupe scan. Then add `git status --porcelain` empty as a hard clause in
every gate script.

### 5.3 The vocabulary criterion is unfalsifiable, and nine agents will each guess differently

"ZERO references to v1/v2/migration" spans at least five surfaces that differ, and there is a
**load-bearing conflict** in the spec itself.

**Guard — pin it, then encode it as `scripts/check-vocabulary.mjs` before any fan-out.** Four tokens,
not three: `humanid`, `\bv1\b`, `\bv2\b`, `migrat` (the stem catches migrated/migrating/migrator).
AC-1's `rg 'humanId'` is the weak version — post-wipe the *whole package* must be clean, not just
the new layer.

The lead must rule on each surface, because they are not the same:

| Surface | Ships? | Ruling needed |
|---|---|---|
| `src/**`, `dist/**` | yes | clearly in scope |
| `skill/**`, `CHANGELOG.md` | **yes** (`package.json` `files:["dist","CHANGELOG.md","skill"]`) | a changelog describing this work *wants* to say "migration" |
| `SPEC.md`, `DATA_MODEL.md` | no | repo-resident; SPEC.md is literally titled "Backlog v2 Application Layer" |
| Git history / branch name | no | out of scope |
| **Persisted store data** | **yes, forever** | see below |

**The load-bearing conflict:** §8.7's restart key is an audit node with `actor:'etl',
action:'migrated'` whose `note` carries `v1Repo`/`v1HumanId` (SPEC.md:2139-2173, §8.4). That is
banned vocabulary written as **data into the shipped store**, and it is the resume mechanism —
renaming it mid-flight strands a half-completed run. **Rename it before the ETL is written:**
`action:'imported'`, note fields `sourceProject`/`sourceRef`. Propagate to §8.4's crosswalk-rebuild
read, which parses the same fields.

### 5.4 Blocking on the wrong dependency edge (wall-clock, not correctness)

The plan has one true barrier (S3). If the S4/S5/S7/S8 agents are dispatched as a barrier wave
instead of a pipeline, the slowest (S8, the ETL) holds eight idle agents. AGENTS.md §13 flags idle
teammates as the wall-clock driver.

**Guard:** `pipeline()`, not `parallel()`, for S4/S5/S7/S8. `TaskStop` each agent the moment its
deliverable is verified — never park it for the next assignment.

### 5.5 Parity green on a lossy run

Covered in §4. Two independent causes: the tautology (expected side from the ETL's own counters) and
the extract silently dropping invalidated history before parity ever looks. Both guarded by
computing expected values from the frozen JSONL and by the truncated-extract negative control.

### 5.6 The stale extract drops in-flight filings

Between the dev extract and cutover, this session keeps filing issues into the live v1 store. A
cutover from the dev extract loses all of them.

**Guard:** fresh extract at S13, immediately before the real run. Keep the freeze window to minutes,
or write filings to a scratch file during the window and replay them after.

### 5.7 `skipDedupe` forgotten on a new verb

§1 requires `skipDedupe:true` on **every** live entity write. AC-2 only checks `createIssue`. A
per-verb agent writing `supersede` will forget.

**Guard:** default it inside `writeNodeTx` for entity kinds. Make it impossible to omit rather than
auditable. This is foundation change #1 below.

### 5.8 The session's own filing tool breaks

Covered in §3/S9. Mitigations: `.mcp.json` points at the **main** worktree's dist, so forbid every
agent from running `nx build backlog` outside `.worktrees/backlog-v2`; `@adhd/backlog@0.1.9` stays
pinned as the rollback CLI; the store is snapshotted.

---

## 6. The three foundation changes to land in S0, before any fan-out

1. **Default `skipDedupe:true` in `writeNodeTx`** for entity kinds (§5.7).
2. **Env-var-driven `immediate`-mode switch** in `executeWriteTransaction` (§5.2) — the single
   switchable point that AC-22 and AC-16's negative controls both drive.
3. **Freeze and publish the foundation export contract** (§5.1) — 55 exports, read-only to fan-out
   agents, enforced by a `git diff --stat` pre-flight in each agent's verification.

Plus one prerequisite that is not code: **rule on the vocabulary surfaces and land
`scripts/check-vocabulary.mjs`** (§5.3), including the §8.7 audit-key rename, before S6/S8 begin.

---

## 7. Kickoff order (do this next, in this order)

1. Rule on the vocabulary surfaces; land `check-vocabulary.mjs`; rename the §8.7 audit key.
2. Land the three S0 foundation changes; publish the frozen export contract.
3. Dispatch S1, S2, S6, S9 in parallel (4 agents).
4. Relocate + repoint + un-skip the §10.4 harness. **Run S3. Confirm green, and red under the
   env-var negative control.** Stop here if it is not green — the design premise is wrong and
   everything downstream is rework.
5. Pipeline S4 (4) ‖ S5 (3) ‖ S7 (1+3) ‖ S8 (1).
6. Fan out the six S10 acceptance suites. Draft docs concurrently.
7. Fix external consumers (S9 output) in their own commit.
8. **The wipe**, solo, W0-W7.
9. Fresh extract → real ETL → §8.8 + §9 clause 6 parity.
10. Publish → 5-agent blind test of the published package → file findings.
