# HANDOFF — backlog-v2 remediation

**This is the single authoritative resume doc.** It consolidates and supersedes four
files that each previously claimed to be the resume point — `HANDOFF.md` (session 2),
`HANDOFF-PROMPT.md`, `PAUSE-STATE.md`, and `SESSION-HANDOFF-2026-09-23.md`. Everything
still true is folded in here; the three superseded files are **deleted** (2026-09-23).

Read this first. Go to `EXECUTION-STRATEGY.md` for depth and `packets/SEQUENCE.md`
for the work register. `GATE-00-FINDINGS.md` holds the transcript-scan evidence.

**Status:** `@adhd/backlog` 1.0.0 is built, merged to `main` (squash `545d7025`;
`main == origin/main == 9df2a5c7`), and running in production — but off the
`.worktrees/restore-min` hand-port, not the merged build. The cutover that finishes
the job has **not** run.

---

## 0. Durability warning + the two human gates

**This corpus is NOT durable.** `feat/backlog-hard-replacement` — the branch holding
the wave register, the packets, and this doc — is **3 commits ahead of
`origin/feat/backlog-hard-replacement`** (remote tip `483fe47e`, local `816fa722`;
verified `git rev-list --left-right --count` = `0 3`). A `git worktree remove` or
`git branch -D` loses the register. **Pushing is the only thing that makes it durable;
pushing needs human approval.** The register is **off-trunk**: `origin/main` carries
**4** files under `entrypoint/backlog/report/`; this branch carries **24** — so cite
the register by **branch+sha**, never by bare filename.

**The two human gates left (everything else is agent-executable):**
1. **Approval to publish `@adhd/backlog` 1.0.0** and make the machine-global
   bin / MCP re-points — quarantine the bare `backlog`, never delete.
2. **PR #13** (`chore/backlog-post-merge-followups`, open) — the user's merge call.

**The program register is `packets/SEQUENCE.md`:** **5 waves** (Wave 0 **done**),
**47 consolidated owner gates D1–D47** (§5), **10 immediately-startable items** (§4),
14 file-contention lanes, findings F1–F5.

---

## 1. What this project is

The **v2 (1.0.0) replacement of the `@adhd/backlog` system**: "one surface, one
identity, no predecessor left behind" — a 14-verb CLI under a `backlog` namespace with
`uid` identity. It is built, merged, and running in production — but off a temporary
worktree hand-port, not the merged build.

---

## 2. Corrections applied to stale claims

These three claims were false as of 2026-09-23 and are corrected here and at their
source docs (see the notes in §2 for each correction's second home).

**(a) `SEQUENCE.md` G7's "push/merge `59b08868`" is already satisfied.** `59b08868`
("test(backlog): isolate spawned-bin specs from the production store via HOME
redirect") landed on `main` as **PR #10 → `17236a3a`**, with the shared spawn-isolation
helper + guard as **PR #12 → `29da1926`**. Both are verified ancestors of `origin/main`.
G7's only remaining live part is the **D3 root-fix decision** (§6). *Corrected in
`packets/SEQUENCE.md` §2.2 G7 and §3 Lane 1B, and in `deferral-cleanup-plan.md`.*

**(b) The live global bin is NOT the frozen cutover build.** Measured directly on
2026-09-23: `command -v adhd-backlog` → the nvm shim → `@adhd/backlog/dist/index.js`
→ **`/Users/nix/dev/node/adhd/entrypoint/backlog/dist/index.js`** (the primary tree,
which is `main` = `origin/main` @ `9df2a5c7`); the `backlog` pnpm shim
(`~/Library/pnpm/backlog`) resolves to the same primary-tree build. The item
`fce03d93`'s premise ("the live global bin is the frozen cutover build
(`.worktrees/backlog-cutover`, HEAD `ab262d8f`)") is **stale** — that worktree no
longer exists. (The `~/.claude.json` MCP entry still points at
`.worktrees/restore-min/…`; the repo `.mcp.json` points at the relative primary-tree
path.) *Corrected in item `fce03d93` and in `cli-deployment-separation-spec.md`.*

**(c) `cutover/frozen-build-2118d384` was redundant, not singular.** `git merge-base
--is-ancestor ab262d8f fix/live-restore` → **yes** (and → **yes** against
`origin/fix/live-restore`): the frozen build is already on the remote via the
live-restore line. **The branch and its `.worktrees/backlog-cutover` worktree have
already been deleted** — there is nothing left to preserve, and the prior handoffs'
"single copy / losing it removes the cutover's rollback path" claim is false.
`deploy-verify.sh`'s `FROZEN_DIST` default still points at the deleted worktree and
will `fault` if re-run (noted; filed as a follow-up, see §9).

---

## 3. Live reality (measured 2026-09-23 — re-verify before relying)

### 3.1 The three divergent lines

| Line | Head | Tree | Role |
|---|---|---|---|
| **A — `origin/main`** | **`9df2a5c7`** (= local `main`) | `/Users/nix/dev/node/adhd` (primary), branch label `fix/backlog-funnel-provider-dep` | **intended successor** (1.0.0 squash `545d7025` is an ancestor) |
| **B — LIVE `fix/live-restore`** | `257b146e` (`origin/fix/live-restore` = same) | `.worktrees/restore-min` | **disposable interim hand-port** — production still runs its dist |
| **C — `feat/backlog-hard-replacement`** | `816fa722` (3 ahead of `origin/…` `483fe47e`) | `.worktrees/backlog-v2` | **holds this corpus + the register** |

Merge-bases: `main↔live = b257f715`.

### 3.2 What is LIVE

- **The global bin** (`adhd-backlog`, plus the `backlog` pnpm shim) now resolves to
  the **primary-tree build = `main` @ `9df2a5c7`** — it was `restore-min`, and it has
  been re-pointed.
- **`~/.claude.json` `mcpServers.backlog`** still points at
  `.worktrees/restore-min/entrypoint/backlog/dist/index.js`; the repo `.mcp.json`
  points at the relative `entrypoint/backlog/dist/index.js` (primary tree = `main`).
- **A running `serve` (pid `5193`, started 2026-09-23 17:44) still runs the
  `restore-min` build** — re-pointing the bin does **not** restart a running server.
- **`.worktrees/restore-min` is the LIVE deployed build. NEVER touch it.**
- `adhd-backlog` is a pnpm-link to worktree source, labelled `1.0.0`; npm's latest is
  `0.1.9` → **1.0.0 is unpublished.** No `~/.adhd/backlog/current`, no `releases/`.
  **opencode has no backlog MCP server.**

### 3.3 Production store (live — do not mutate casually)

`~/.adhd/backlog/production/config.yaml` = `db.path: …/production/data/backlog-v2.db`,
`embedding.enabled: true`; **`migration.phase` already removed**. The store is
actively written (~128 MB). Vector coverage **15.08 % missing and growing** (corpus
figure — re-measure). Embeddings are live via the peer-spawned funnel (provider
0.5.3 / service-proxy 0.4.3); read-only verbs spawn zero hosts.

### 3.4 GATE-00 — the equivalence question gating the cutover

Intent is **resolved** (HIGH confidence, primary evidence in `GATE-00-FINDINGS.md`):
the prior dispatcher treated **A as the durable successor** and **B as disposable**.
A is not missing B's work — it re-implemented it (`api.semantic-laziness.spec.ts`,
`api.semantic-production-seam.spec.ts`, `write/bootstrap.ts`). **Residual (narrow):**
A pins `@adhd/sox-embedding-provider ^0.5.0`; B pins `^0.5.3` and carries `b9b23aea`
(not in `origin/main`). GATE-00 = run A's two semantic specs on the real path, and
settle the `^0.5.0` vs `^0.5.3` rider. **Not a reconciliation project.**

### 3.5 Landed since the earlier handoffs (all verified at the time)

PR #9 merged (`545d7025`, "1.0.0 — one surface, one identity"); PRs #10–12 merged
earlier. The embedding funnel is implemented, teeth-proven, published, deployed live,
and embeddings re-enabled. Vector-write loss fixed live (`257b146e`). Dedupe over-match
fixed on the branch (`90a4fc3a`). Wave 0 done (`fdae906f`). LIVE-1 prep done: clean
build of `545d7025` in `.worktrees/backlog-release` (dist sha256 `a74a180e…`, 722,074 B,
mode 755), `deploy-verify.sh` committed (`483fe47e`), rollback rehearsed. PR #13 open.

---

## 4. Immediate next actions (ordered)

1. **Push the corpus** (human-gated) to make this corpus durable — it is 3 commits
   ahead of `origin`, and the whole register lives on it.
2. **PR #13** — the user's merge call; then rebuild the release and cut over.
3. **G1 — the config-freeze fix** (the last live embedding defect): `startBacklogServer`
   freezes `ctx.env.config.embedding` at startup (`server.ts:776/842` vs
   `cli.ts:640`) + a silent member-less derive (`bootstrap.ts:256`) + the no-op gate
   (`embedding-observer.ts:148-149`). Uids `898e0bb2`, `0bc19f0f`, `205cd742`,
   `97c03dfd`. **Gates LIVE-1.**
4. **GATE-00 residual** — A's two semantic specs + the `^0.5.0`/`^0.5.3` rider.
5. **The cutover (LIVE-2)** needs the publish approval (§0) + the **`6603272a`
   staging decision** (no worktree-independent staging exists today; `pnpm deploy`
   symlinks back and omits `@adhd/sox-*`; the worktree-pinned fallback fails LIVE-2's
   DoD; recommendation: `pnpm pack` + `npm install --prefix releases/<v>`).
6. **Waves 1–3 per `SEQUENCE.md`** (correctness/data-integrity → embedding-truth →
   surface/feature), respecting its file lanes and one-heavy-task-at-a-time; then the
   Wave-4 cutover. Start from the 10 ungated items in §4.
7. **Doc/residue corrections:** RSD-15 packet re-scope; `c75facbf` (the packet's false
   "already fixed" claim); the local-`main` reconciliation (user-approved; preserve
   `50266459` first, never a plain `reset --soft`).

---

## 5. Orphaned work — the standing risk (census is a snapshot)

The dominant risk is **work that exists on no remote**. Census run 2026-09-23:
**46 of 85 local branches** carry commits not on `origin/main`; **39 are local-only**
(one `git branch -D` from gone); ~25 worktrees carry uncommitted work. **Re-run the
census before any deletion/worktree-remove** — every number is a snapshot.

- **Backlog-owned branches (this agent's scope):** `feat/backlog-hard-replacement`
  (origin ✅, holds the corpus + register), `fix/backlog-isolation-followups` (origin ✅),
  `chore/backlog-post-merge-followups` (PR #13, origin ✅), `fix/backlog-test-isolation`
  (origin ✅), `fix/backlog-funnel-provider-dep` (fully landed on `main` ✅). Local-only:
  `burn/backlog-a`, `burn/backlog-b`, `bl/bl-apigen`, `fix/backlog-lifecycle-cluster`.
  (`cutover/frozen-build-2118d384` was listed here previously — it is now deleted and
  was redundant, see §2(c).)
- **Files on no ref:** `tools/nx-plugins/test/lib/spec-lanes.mjs` (the `.proc`/`test-proc`
  module — untracked, imported by nothing, item `57e4779e`); `~16` files under
  `.research-trace/`; `tmp/backlog-main-reconcile/*` (gitignored scratch; the **only**
  copy of the 286-line BUG-050 patch).
- **Highest-value, non-destructive mitigations:** push the substantial local-only
  branches as `origin/backup/*`; move `tmp/backlog-main-reconcile/*` into the corpus and
  commit; commit-or-delete `spec-lanes.mjs`.

---

## 6. Standing directives (non-negotiable)

- No push without approval; **commits use `--no-verify`**; `git push --no-verify` is
  machine-denied — a push must run with stdin detached (`</dev/null`) or it dies with
  SIGPIPE(141).
- **No destructive git:** never `reset --hard`, `stash`, `clean -f`, `checkout -- .`.
  Never `git add -A` / `git add .` / `commit -a` — stage only explicit paths
  (concurrent agents share the tree).
- Never `--skip-nx-cache`; never run `tsc` directly; pnpm only.
- **Production store is live:** any mutation is backup-first (`VACUUM INTO`, never plain
  `cp`), operator-invoked, re-verified, with the backup path recorded.
- Backlog items **only** via the `adhd-backlog` CLI / `mcp__backlog__*`; never hand-edit
  `BACKLOG.md`. File every bug/deferral at discovery; never declare anything
  "pre-existing"; verify state-side; end every response with the unacknowledged
  bugs/deferrals list.
- **ADR-0012** (parallel-process), **ADR-0013** (typed config, never env toggles),
  **ADR-0014** (report-first retention), **ADR-0020** (the embedding funnel is
  peer-spawned/self-reaping — **never "daemon"**); ADR-0015 never adopted.

---

## 7. Environment hazards

- The pre-push gate runs the full `nx affected -t test` closure (~63 projects /
  172 tasks / ~10 min) and flakes under load (`2f117762`); `acd4698e` covers the
  worktree-hook gap.
- `create` on the live store can **silently collapse** under the 0.8 semantic-dedupe
  gate (returns `ok:true` with an existing uid) — use `duplicateAction:"force"`.
- **A body edit SUPERSEDES the item and mints a NEW uid** (status/priority carry over).
- `get` **without a `fields` list omits `body`**.
- `nx.json`'s `test.dependsOn` is overridden per project — read `project.json`.
- `tools/nx-plugins/test/**` is a registered plugin but is NOT in `sharedGlobals` →
  plugin edits may not invalidate caches.
- launchd-supervised processes are **PPID 1** — never reap by `ppid==1` alone.
- **opencode does not hot-reload agent config** — a restart is required for any
  agent-config change. (The session-2 incident — 17 agents / 23 files pinned to the
  retired `deepseek-v4-flash`) was fixed via the sox install/render surface.)
- `gx` indexes the primary tree only and refuses from linked worktrees.
- A stray `rm: /Users/nix/dot/bin/node` appears in most shells — environmental, not ours.

---

## 8. Open bugs / deferrals

- **Orphan risk (§5)** — the local-only branches, dirty worktrees, `spec-lanes.mjs`,
  and `tmp/backlog-main-reconcile/*` on no ref.
- **This corpus itself** is 3 commits ahead of `origin` — not durable until pushed.
- **The funnel-spec process leak** (`9434902c`) — root-caused; the fix is uncommitted
  (working tree, primary tree on `fix/backlog-funnel-provider-dep`); **not fixed** until
  it lands and is proven. A **PID-reuse hole** in that fix is filed separately (see §9).
- **Config-isolation** (`82468ca7`) — test-side fix merged; root cause open (see §9).
- **A-vs-B equivalence unproven** (residual `^0.5.0` vs `^0.5.3` + missing `b9b23aea`).
- **Env:** memory MCP's vector channel can degrade (`embed() timed out`); the scalar
  store stays healthy.
- **Doc drift residue:** `deploy-verify.sh`'s dangling `FROZEN_DIST` default; the
  "frozen rollback build" references in `EXECUTION-STRATEGY.md` / `packets/1` /
  `packets/4` that predate the branch's deletion.

---

## 9. File map

| File | Role |
|---|---|
| **`HANDOFF.md`** (this) | **The single resume entry point.** |
| `EXECUTION-STRATEGY.md` | The consolidated plan — state, workstreams, waves, gates, exit criteria. |
| `GATE-00-FINDINGS.md` | Transcript-scan evidence for the A-vs-B intent verdict. |
| `packets/SEQUENCE.md` | **The register:** 5 waves, 47 gates D1–D47, 14 lanes, findings F1–F5. |
| `packets/{1..4}-*.md` | The 72 work packets (LIVE/EMBED/RSD/STORE + WAVE). |
| `packets/title-only-bodies.md` | Retrieved bodies for title-only uids. |
| `cutover-execution-plan.md` | The cutover procedure (§A–D) + the 7-bug table. |
| `cli-deployment-separation-spec.md` | Target topology / relocation / Phase 0 / runbook (§0 is stale). |
| `sox-integration-plan.md` | Cross-repo analysis; upstream gaps G1–G7 → `SOX-1..7`. |
| `deploy-verify.sh` | LIVE-1 verify harness + negative control. |
| `release-manifest-1.0.0.json` | The LIVE-1 clean-build record (`545d7025`, dist `a74a180e…`). |
| ~~`PAUSE-STATE.md`~~ · ~~`HANDOFF-PROMPT.md`~~ · ~~`SESSION-HANDOFF-2026-09-23.md`~~ | **Deleted 2026-09-23** — folded into this file. |
