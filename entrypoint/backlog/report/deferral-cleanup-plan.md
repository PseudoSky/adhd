# Deferral Cleanup Plan — consolidated triage, batching, and sequence

**Status:** PLAN (uncommitted; no code touched). Author: architect, 2026-09-22.
**Scope:** every open deferral handed to this pass — the live production/consumer
issues, the isolation-leak family, the sox-surface items, and the misc items.
**Sources read:** the adhd backlog graph (live reads only — 1701 items, project
`7ee5721e`), `entrypoint/backlog/STATE.md` §H + the 2026-09-22 updates,
`entrypoint/backlog/report/*.md`, `docs/spec/hybrid-search-optional-loadability-spec.md`,
`docs/plan/store-adapter-batch-0.10.0/SPEC.md`, and the cited source files.
**Write location:** this file is written in the **main repo**
(`/Users/nix/dev/node/adhd`); the `.worktrees/backlog-v2` tree is owned by another
executor and was read-only for this pass. Move/commit it onto the branch as the owner sees fit.
**ADR note:** the `adhd` repo has no `docs/decisions/`. The governing catalog is
`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0018). This plan complies
with ADR-0012 (multi-process invariant), ADR-0013 (typed config, never env-var
feature switches), ADR-0014 (sidecar/snapshot retention is report-first), and
ADR-0006/0016 (DI + composer). It introduces **no** env-var feature toggle.

---

## 0. Method + a correctness caveat about the uid list

Every uid was resolved against the live graph. **Several of the uids in the
hand-off are superseded** — the graph returns the live successor, and a body
edit mints a new uid, so the prefix given no longer addresses the live item.
The plan below names the **live uid** and records the supersession. Where the
hand-off's one-line label disagreed with the item body, the **item body wins**
(noted inline). Two items in the hand-off were **already fixed** on the branch
and are reclassified `(e)`.

Live-uid corrections:

| Hand-off prefix | Live item | Why |
|---|---|---|
| `b200542b` | `2e117b1a` | superseded (index desync) |
| `d4b2cc68` | `4ba0d969` | superseded (WAL fold) |
| `bfe3f770` | `be760b45` (orig `edc4f456`) | superseded chain (EForeignSqliteSidecar) |
| `6d332464` | `53eb67a7` | superseded (contamination) |
| `c85c820e` | `e679f8f0` | superseded (orphaned rows) |
| `87ef8bf9` | `e9a094be` | superseded (scratch projects) |
| `2b607b26` | `836d4209` | closed by Seg G |
| `4290b63a` | `4290b63a` (live) | chain `3c376607→29b4578d→6defe186→4290b63a` |
| `92b82a73` | `92b82a73` (live) | — |

---

## 1. Classification table

Classes: **(a)** covered by an existing spec/batch/queue · **(b)** actionable now ·
**(c)** needs upstream/sox work · **(d)** needs a user decision · **(e)** stale/closeable.

| uid (live) | Item | Class | Batch / owner |
|---|---|---|---|
| `46d04e3f` | Live latency: frozen build 12–79s/query (eager semantic + `iter` full-corpus probe) | **a** | **L0 Deployment/restore** |
| `42fc1822` | Live build 31 commits behind branch; fixes undeployed | **a** | **L0 Deployment/restore** |
| `4290b63a` | Deployed `get` body-less + `update` body supersedes UID + citation lockout (38/40 projects path-less) | **a** (+d) | **L0** (branch `7875d848`); see D2 |
| `bfe3f770`→`be760b45` | `EForeignSqliteSidecar` reads blocked by peer | **a** | **L0** (adapter 0.9.2, fixed upstream `6f9ec560`) |
| `276b8f2a` | One-shot embed lost + audit unrecorded | **a** | **embed-durability-fix-spec.md** (M2) |
| `e769bdc4` | Only default-running real-model spec deleted | **a** | **embed-durability-fix-spec.md** Segment F (+ M1 restore) |
| `b200542b`→`2e117b1a` | Index desync / `probeBtreeIndexes` torn read + REINDEX race | **a** | **sox-store-adapter batch 0.10.0** (fix 1) |
| `d4b2cc68`→`4ba0d969` | WAL unlinked/replaced → silent write-loss | **a** | **sox-store-adapter batch 0.10.0** (fix 2) |
| `d677a575` | `close()` doesn't drain `_inFlightOps` | **a** | **sox-store-adapter batch 0.10.0** (fix 3) |
| `0ab0078a` | `isDatabaseError` misses closed-connection `TypeError` | **a** | **sox-store-adapter batch 0.10.0** (fix 4) |
| `82468ca7` | Config-isolation leak (global layer unconditional) | **a** (+d) | **fix/backlog-test-isolation `59b08868`** (HOME redirect); root-cause decision D3 |
| `aede6810` | Citation of a directory (EISDIR) throws instead of degrading | **b** | **L4 backlog wave** |
| `92b82a73` | `gitContext` rendered raw into markdown `Citations:` block | **b** | **L4 backlog wave** |
| `81de39f7` | CI affected set excluded `backlog:test` | **b** | **L5 repo tooling** |
| `f80bf841` | `apigen-java` targets race in shared basedir | **b** | **L5 repo tooling** |
| `82470ae8` | HOME-redirect invariant duplicated ×10 specs, no guard | **b** | **L4 backlog wave** |
| `348cc700` | Fastembed lock has no service identity | **c** | **L2 sox publish** (done at HEAD, held) |
| `1c9e40d5` | `recursive_cte_probe_failed` 2849×/day | **c** | **L1 sox-store-adapter** (fold as fix 5) |
| `06922862` | Side-effectful read-only opens + sidecar churn | **c** | **L1 sox-store-adapter** (fold as fix 6 / 0.10.1) |
| `8b05358e` | `registry/index.json` checksum drift armed | **c** | **L2 sox ops** (sync at deploy) |
| `148acecb` | `memory-core` publishable surface drift, no changeset | **c** | **L2 sox** (changeset) |
| `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` (`e46b7ca0`) | hybrid-search keeps native chain mandatory | **d** | **L3 hybrid-search**; ADR route decision D1 |
| `6d332464` | Contamination (superseded) | **e** | close → `53eb67a7` |
| `c85c820e` | Orphaned-row gap (superseded) | **e** | close → `e679f8f0` |
| `87ef8bf9` | Scratch projects (superseded) | **e** | close → `e9a094be` |
| `40d9da12` | `cli-envelope.spec.ts` afterEach no-op → tmp leak | **e** | already fixed in-tree (`cli-envelope.spec.ts:151-153` `afterAll` rmSync) |
| read-only-CLI-queries-mutate-the-store (unfiled) | reads mutate the store | **e** | **duplicate of `06922862`** — do not file |

**Counts (27 hand-off items):** (a) **11** · (b) **5** · (c) **5** · (d) **1** · (e) **5**.

Cross-referenced extras (filed during the same incident, not in the hand-off list):

| uid | Item | Class | Batch |
|---|---|---|---|
| `53eb67a7` | Active production contamination (~20 rows/gate run) | **d** | **L6 cleanup** (destructive, user-gated) |
| `e679f8f0` | Orphaned test rows invisible to `view:list` | **b** | L6 (+ vocabulary guard already shipped) |
| `e9a094be` | Historical scratch projects in production | **d** | **L6 cleanup** |
| `8a09824c` | `sox-embedding-provider` `^0.4.1` vs `^0.5.0` — two copies | **b** | **L4 backlog wave** |
| `2b1d8a22` | Review-fix batch (predicate ×3, test teeth, cap-miss log) | **b** (partial e) | **L4 backlog wave** |
| `a934e089` | `citationRequiresSha` path-less waiver is a silent no-op | **b** | **L4 backlog wave** |
| `1e12507f` | `CONTRACT.md` line-reference drift | **b** | **L4 backlog wave** |
| `cd34ba0d` | Embedding-usage gate break | **e** | fixed `4bf902fc` |
| `2b607b26` | Stale comments | **e** | closed `836d4209` |
| `d2f11ab6` | Real-HOME opt-out in `install.e2e.spec` | **e** | RESOLVED (`59b08868`) |
| `e68be52c` | One-shot embed loss | **e** | DUPLICATE → merged into `276b8f2a` |
| `edc4f456`, `6defe186` | Superseded intermediates | **e** | close |

---

## 2. (a) Already covered — confirm + cross-reference

| Item | Covered by | Action |
|---|---|---|
| `46d04e3f`, `42fc1822`, `4290b63a`, `bfe3f770` | **L0 Deployment/restore** — `report/cutover-execution-plan.md` §B + `report/cli-deployment-separation-spec.md` §3–4; branch fixes `7875d848` (citation), `d4a72009` (bounded `hasVectors`), `a8906d3d` (dep bumps), adapter `0.9.2` | Deploy (see §7). The minimal cherry-pick **failed pre-flight**; durable path = full re-cutover from branch tip, interim = hand-port. |
| `276b8f2a` | `report/embed-durability-fix-spec.md` §3–6 (close-time drain, loud+recorded) | Implement as written; it is M2. |
| `e769bdc4` | `report/embed-durability-fix-spec.md` **Segment F** (restores real-model coverage) + M1 restore | Implement with M2; no separate plan. |
| `b200542b`, `d4b2cc68`, `d677a575`, `0ab0078a` | `docs/plan/store-adapter-batch-0.10.0/SPEC.md` (fixes 1–4) | One changeset/publish (L1). |
| `82468ca7` | `fix/backlog-test-isolation` `59b08868` (HOME redirect, 10 spec files) | Push/merge (human-gated); root-cause decision D3. |

---

## 3. (b) Actionable now — exact shape, tests with teeth, segments

All (b) items below are **targeted** — no blanket `nx affected`. Unless stated,
verify with `npx nx build backlog` + `npx nx lint backlog` + the named spec(s) only.

### B1 — `aede6810` · EISDIR citation degrade
- **Files:** `entrypoint/backlog/src/write/create-issue.ts:359-361`,
  `entrypoint/backlog/src/write/transition.ts:~244-250`,
  `entrypoint/backlog/tools/etl/citation.ts:91-102`.
- **Change:** widen the absent-target set from `ENOENT|ENOTDIR` to
  `ENOENT|ENOTDIR|EISDIR` in all three copies; extract a single
  `isAbsentCitationTarget(code: string|undefined): boolean` into
  `src/write/catalog.ts` (beside `projectHasKnownPath`) and import it in all three.
  A directory is not a file → `'unverified'`, never a hard `WriteIOError`.
- **Test (teeth):** `create-issue.spec.ts` + `transition.spec.ts` — cite a real
  directory path → the write succeeds and persists `sha:'unverified'`; assert no throw.
  Negative control: revert the EISDIR branch → both go RED.
- **Segments:** 3 edits + 1 new export. Read ~120 tok, out ~90 tok. No deps.

### B2 — `92b82a73` · sanitize/bound `gitContext`
- **Files:** `src/query/markdown.ts:44-58` (render), `src/write/create-issue.ts:598-603`
  and `src/write/transition.ts:551-556` (write-time cap).
- **Change:** a `sanitizeGitContext(s)` that (a) rejects/escapes `]`, `[`, CR/LF
  (a newline would forge a `- [...]` citation line), and (b) caps length (e.g. 200
  chars) — applied at **write** (reject over-long input with `InvalidArgumentError`)
  and at **render** (defence in depth). `Citations: [<sanitized>]` only.
- **Test (teeth):** `markdown.spec.ts` — a `gitContext` containing `]\n- [evil sha:x]`
  must NOT produce a second citation-looking line; overlong input is rejected.
  Negative control: remove sanitize → RED.
- **Segments:** 3 files. Read ~90 tok, out ~80 tok. No deps.

### B3 — `82470ae8` · one shared isolated-spawn helper + guard
- **Files:** new `src/test/helpers/spawn-isolated-bin.ts` (or extend
  `src/test/helpers/spawn-backlog-bin.ts`); migrate the 15 spawn sites across
  `cli.spec.ts`, `cli-envelope.spec.ts`, `stats-surface.spec.ts`,
  `server.v2.spec.ts`, `install.e2e.spec.ts`, `batch-adoption.spec.ts`, and the
  other files from `59b08868`.
- **Change:** the helper owns the invariant **pair** (`HOME=<temp>` **and**
  `ADHD_BACKLOG_SCOPE=project` + temp `cwd`), not HOME alone. Every spawned-bin
  site calls it.
- **Test (teeth):** new `spawn-isolated-bin.spec.ts` — spawn the real bin and
  assert the child's resolved `dbPath` is under the temp HOME, never
  `backlog/production/`. Negative control: drop the HOME redirect → RED.
- **Segments:** helper ~250 out; migration mechanical (~15 sites); guard spec ~200 out.
  Depends on nothing; independent of the other (b) items.

### B4 — `2b1d8a22` + `a934e089` + `8a09824c` + `1e12507f` (fold into the queued review-fix batch)
- **`2b1d8a22`:** (1) delete the inline predicate copies at
  `create-issue.ts:333` / `transition.ts:240`, import `projectHasKnownPath`;
  (2) give `create-issue.spec.ts:256`'s "nothing is written" claim a real
  assertion; (3) `projectHasKnownPath` unit test **already exists**
  (`catalog.spec.ts:25-62`) → this sub-item is stale; (4) log the
  `isVectorSpacePopulated` capability miss (debug level).
- **`a934e089`:** add a warn/debug log on the waiver branch
  (`create-issue.ts:662-668`, `transition.ts:361-367`) — observability only, the
  permissive behavior stays (verdict (A)).
- **`8a09824c`:** `entrypoint/backlog/package.json` optionalDependencies
  `@adhd/sox-embedding-provider` `^0.4.1` → `^0.5.0`; `pnpm install`; assert one
  copy resolves.
- **`1e12507f`:** regenerate the six `errors.ts` anchors in
  `src/write/CONTRACT.md` (doc-only).
- **Test:** `npx vitest run src/write/catalog.spec.ts src/write/create-issue.spec.ts
  src/write/transition.spec.ts`; `node tools/gate/embedding-usage-gate.mjs`.
- **Segments:** 4 small edits; ~1 commit. Read ~200 tok, out ~200 tok.

### B5 — `81de39f7` · CI blind spot (repo tooling)
- **File:** `.github/workflows/ci.yml:54`.
- **Change:** guarantee `backlog:test` actually runs — add an explicit
  `npx nx run backlog:test` step (or correct the `nrwl/nx-set-shas` base/head so
  the affected set cannot exclude it). The whole point is that CI green must be
  evidence about `backlog:test`.
- **Test:** a PR touching only a `backlog` spec must show `backlog:test` in the
  run log. Negative control: revert the step → the run log lacks it.
- **Segments:** 1 file, ~5 lines.

### B6 — `f80bf841` · `apigen-java` target race (repo tooling)
- **File:** `packages/apigen/java/project.json`.
- **Change:** narrow `package.outputs` from `["{projectRoot}/target"]` to
  `["{projectRoot}/target/*.jar"]` so `build`/`package`/`test` no longer claim
  overlapping outputs and can't be scheduled concurrently in the shared basedir.
- **Test:** run `build`+`package`+`test` for `apigen-java` and its two consumers
  under the normal cache twice; assert no `mvn` race. (Add a `dependsOn` ordering
  only if the outputs narrowing proves insufficient.)
- **Segments:** 1 file, ~2 lines. LOW.

---

## 4. (c) Needs upstream / sox work

### L1 — `@adhd/sox-store-adapter` (one changeset, one publish)
Implement `docs/plan/store-adapter-batch-0.10.0/SPEC.md` (fixes 1–4: probe
atomicity, WAL fold, close drain, taxonomy), **and fold two more same-package
items** so they ship in the same 0.10.0 (the standing directive is one
changeset/publish per sox package):

- **`1c9e40d5` (fix 5):** `libs/data/store/store-adapter/src/turso-adapter.ts:2186`
  logs `store_adapter.turso.recursive_cte_probe_failed` on every open (~2849/day).
  The verdict is memoized only per-process, so the short-lived CLI topology
  re-probes every open. Cache the capability verdict across processes (or select
  the fallback by driver identity) so the probe runs once per store, not once per open.
- **`06922862` (fix 6):** side-effect-free read-open — a read verb currently bumps
  `db mtime` and mints `*.stale-*`/`*.tshm` sidecars with no cleanup path
  (~47 in the production data dir). Retention is ADR-0014 (report-first, never
  auto-delete); the code change is to stop the churn on a read-open and expose a
  report. If this cannot be bounded inside the 0.10.0 scope, split it to a
  0.10.1 rather than widening the batch.

**Cascade after publish:** bump `entrypoint/backlog`'s adapter pin to `^0.10.0`
(and the republished graph-store), `pnpm install`, rebuild the frozen build,
smoke-test. This is a **deployment step**, not part of the sox changeset.

### L2 — sox publish / ops (held, low effort)
- **`348cc700`:** the BL-432 service identity **is already implemented at sox HEAD**
  (`fastembedLock.ts:64,83,92`; `sharedFastembedProcess.ts:140,171,388-421`;
  red→green tests in `fastembedProcessHost-lock.spec.ts`). Publish
  `sox-telemetry@0.3.1` + `sox-embedding-provider@0.5.1`, then reinstall in
  `entrypoint/backlog` and verify **no BL-331/BL-404 warnings** in any namespace.
- **`8b05358e`:** `registry/index.json` checksums are stale (member dists rebuilt).
  The confirmation is that `release:prepared` regenerates the index from **local**
  dist, not the published tarball — so the members must be **rebuilt and
  republished**, then the index synced on a clean tree at deploy.
- **`148acecb`:** `@adhd/sox-memory-core` publishable surface drifted with no
  changeset (`check-changeset-surface` fails). Add the changeset for the
  `enrich`/`neardup`/`supersession-chain` `.d.ts` surface (0.10.2 → 0.10.3).

### L3 — `@adhd/sox-hybrid-search` (decision-gated)
- **`BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` (`e46b7ca0`):** implement
  `docs/spec/hybrid-search-optional-loadability-spec.md` (move the heavy two to
  `optionalDependencies`; lazy non-literal dynamic import in `cross-encoder.ts`),
  publish `0.4.9` (patch — floats to the `^0.4.6` consumer with no consumer
  change). **Blocked on decision D1** (ADR route).

---

## 5. (d) Needs a user decision

- **D1 — ADR route for the hybrid-search optional-loadability rule.** New
  **ADR-0019** (recommended; generalizes) **or** amend ADR-0006's Consequences
  sentence. The spec's §8 drafts 0019. The ADR must land **before or with** the
  code. → blocks L3.
- **D2 — `update` with a `body` supersedes the item under a new uid.** The v3
  skill documents this as intentional ("A `body` change supersedes the issue"),
  but `4290b63a` files it as "UIDs are unstable". Confirm by-design (then it is a
  docs item, not a bug) or change to in-place edit. → shapes the `4290b63a` close.
- **D3 — config-isolation root fix.** `59b08868` redirects HOME in the test
  helpers (correct, minimal), but `config-resolver.ts:128,163-167` still applies
  the `global` file layer unconditionally (`gx impact resolveRoots` = CRITICAL).
  Decide: keep HOME-redirect-only (accepted posture), or scope-gate the resolver
  (HIGH blast radius, `packages/environment`).
- **D4 — production contamination cleanup (`53eb67a7`, `e9a094be`).** Destructive
  row removal; needs explicit approval. Root cause already fixed by `59b08868`.
- **D5 — production re-cutover vs interim hand-port (`L0`).** The durable fix is a
  full re-cutover from the reviewed branch tip; the interim is a hand-port of the
  citation fix + a bespoke bounded probe. Both are user-gated (deploy/restart).

---

## 6. (e) Stale / closeable — close with evidence, no code

| uid | Close reason |
|---|---|
| `6d332464` | superseded → live `53eb67a7` |
| `c85c820e` | superseded → live `e679f8f0` |
| `87ef8bf9` | superseded → live `e9a094be` |
| `40d9da12` | already fixed in-tree — `cli-envelope.spec.ts:151-153` has `afterAll` rmSync (verified by read) |
| read-only-CLI-queries-mutate-the-store | **duplicate of `06922862`** — file as a dedupe note, do not create |
| `cd34ba0d` | fixed `4bf902fc` (gates CLEAN) |
| `2b607b26` | closed `836d4209` |
| `d2f11ab6` | RESOLVED (`59b08868`) |
| `e68be52c` | DUPLICATE → merged into `276b8f2a` |
| `edc4f456`, `6defe186` | superseded intermediates |

Also: `2b1d8a22` sub-item (3) is stale — `catalog.spec.ts:25-62` already unit-tests
`projectHasKnownPath`.

---

## 7. Batch grouping (per package / lane) + execution sequence

Standing directives honoured: **one changeset/publish per sox package**;
backlog-side work folds into the wave fix round; nothing dispatches per-item when
it can batch; sox edits are authorized (publish granted for sox packages).

| Lane | Contents | Vehicle | Gate |
|---|---|---|---|
| **L0 — Deployment / restore** | `46d04e3f`, `42fc1822`, `4290b63a`, `bfe3f770` | full re-cutover from branch tip (durable) / hand-port (interim), per `report/cutover-execution-plan.md` + `cli-deployment-separation-spec.md` §3–4 | **user-gated** (deploy/restart) |
| **L1 — sox-store-adapter 0.10.0** | batch SPEC fixes 1–4 + `1c9e40d5` (5) + `06922862` (6) | one changeset → `0.10.0` → publish → backlog pin bump + rebuild | publish allowed; deployment step user-gated |
| **L2 — sox publish/ops** | `348cc700` (publish 0.3.1/0.5.1), `8b05358e` (registry sync at deploy), `148acecb` (memory-core changeset) | changesets | publish allowed |
| **L3 — hybrid-search 0.4.9** | `e46b7ca0` | spec + publish | **blocked on D1** |
| **L4 — backlog wave** | `aede6810`, `92b82a73`, `82470ae8`, `2b1d8a22`, `a934e089`, `8a09824c`, `1e12507f` | one wave commit on `feat/backlog-hard-replacement`; one `@adhd/backlog` bump | review pass before push |
| **L5 — repo tooling** | `81de39f7`, `f80bf841` | 2 tiny commits | independent |
| **L6 — contamination cleanup** | `53eb67a7`, `e679f8f0`, `e9a094be` | destructive; report-first per ADR-0014 | **user-gated** |
| **L7 — housekeeping** | §6 closes | graph transitions | none |

**Recommended execution order (dependencies flagged):**

1. **L7** — close the stale/superseded items now (no code). *Unblocks nothing; removes noise.*
2. **L0-step-1** — deploy the **branch tip** (clears `46d04e3f`, `42fc1822`,
   `4290b63a`, `bfe3f770`). *User-gated.* Prefer this over the interim hand-port:
   it carries the lazy semantic seam + bounded `hasVectors` + citation fix +
   adapter `0.9.2`. Then run the Phase 0.1–0.3 relocation so production leaves the
   worktree.
3. **L4** — backlog wave (independent of sox). If a later re-cutover is chosen,
   L4 must be committed **before** that re-cutover so its fixes are carried.
4. **L1** — sox-store-adapter 0.10.0 (batch + fixes 5/6). *Depends on nothing;
   but its backlog pin-bump + rebuild is a **second** deployment step, so sequence
   it after L0-step-1 to avoid two deploys in one window if possible.*
5. **L2** — sox publish 0.3.1/0.5.1 + memory-core changeset + registry sync
   (batch the release train with L1's publish). Then backlog reinstall + verify
   no BL-331/BL-404.
6. **L5** — repo tooling (parallel, anytime).
7. **L3** — after **D1**; then publish 0.4.9.
8. **L6** — contamination cleanup, after L0 (root cause fixed), on approval.
9. **L0-step-2** — re-cutover to a fresh frozen build once L1+L2+L4 have landed,
   carrying the adapter 0.10.0 + published sox fixes.

**Critical-path dependencies:**
`D1 → L3`; `L1 publish → backlog pin bump → L0-step-2`; `L4 committed → L0-step-2`
(if re-cutover); `L0 → L6`.

---

## 8. Belongs in the upcoming deployment (the restore/re-cutover step)

- **L0-step-1 (now):** branch tip → clears `46d04e3f`, `42fc1822`, `4290b63a`,
  `bfe3f770`. Carries `7875d848`, `d4a72009`, `a8906d3d` + dep bumps
  (vector-store `^0.7.0`, hybrid-search `^0.4.6`, store-adapter `^0.9.2`,
  graph-store `^0.10.1`).
- **L0-step-2 (after L1/L2/L4):** re-cutover carrying adapter `0.10.0` (clears
  `2e117b1a`/`4ba0d969`/`d677a575`/`0ab0078a`/`1c9e40d5`/`06922862`) + the
  published sox fixes.
- **Relocation** (`cli-deployment-separation-spec.md` Phase 0.1–0.3): move bytes
  to `~/.adhd/backlog/current`, create the canonical `adhd-backlog` bin, quarantine
  the ambiguous `backlog` shim, repoint `.mcp.json` + `~/.claude.json` + opencode.
  *User-gated (machine-global).*
- **Verification (real CLI, exit-code keyed):** a real semantic query + a real
  citation write must both succeed; `rg '\.worktrees/backlog'` must find nothing
  in live pointers; item count ≈ parity baseline.

---

## 9. Open questions

1. **D1 (ADR route)** — new ADR-0019 vs amend ADR-0006? (Recommendation: 0019.)
2. **D2** — is `update`-body-supersedes by design? (Shapes the `4290b63a` close.)
3. **D3** — scope-gate the config resolver, or keep HOME-redirect-only?
4. **L1 scope** — do `1c9e40d5` + `06922862` fold into the 0.10.0 batch, or does
   0.10.0 ship as-is with a 0.10.1 follow-up? (Recommendation: fold `1c9e40d5`;
   split `06922862` if it cannot be bounded.)
5. **L0 vehicle** — durable re-cutover now, or interim hand-port then re-cutover?
6. **L5 `81de39f7`** — explicit `nx run backlog:test` CI step (simple, ~500s cost)
   vs fixing the affected base/head computation (cheaper, less certain)?
7. **`4290b63a` sub-defect** — "no verb exposes `project.policy`" is a real
   capability gap (38/40 projects are path-less); is exposing policy in scope, or
   does the observability log (`a934e089`) suffice for now?

---

*No code was written or modified by this pass. The `.worktrees/backlog-v2` tree was
read-only throughout. All uids resolved against the live graph (1701 items,
project `7ee5721e`).*
