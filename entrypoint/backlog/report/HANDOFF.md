# HANDOFF — backlog-v2 remediation

**Written:** 2026-09-23 (session 2). **Supersedes** `HANDOFF-PROMPT.md`'s plan content.
**Status:** paused for an opencode restart. Read this file first after resuming.

**Depth documents (read on demand, not eagerly):**
- `EXECUTION-STRATEGY.md` — the consolidated plan (state of record, workstreams, waves, 47-gate
  register, verification architecture, rollback, exit criteria). §1 is the verified state table.
- `GATE-00-FINDINGS.md` — the opencode-transcript scan that established the prior dispatcher's intent.
- `GATE-00-TRIAGE.md` — the architect triage (if it completed; the dispatch that would produce it was
  blocked by the agent-config incident below).
- `packets/{1,2,3,4}-*.md` — the 72 work packets; `packets/SEQUENCE.md` — waves/gates/lanes.
- `cutover-execution-plan.md`, `cli-deployment-separation-spec.md`, `sox-integration-plan.md`.

---

## 0. RESUME HERE

1. **Confirm the agent roster loaded.** The opencode restart should have picked up the corrected
   agent configs (`deepseek/deepseek-flash` = "DeepSeek V4.1 Flash"). Verify:
   ```bash
   rg -n '^model:' ~/.config/opencode/agents/            # every line a live id
   rg -n 'deepseek-v4-flash(?!-)' ~/.config/opencode/agents/   # expect: zero
   ```
   Then smoke-test a specialist, e.g. `task(subagent_type="architect", prompt="Say OK")`.
2. **Re-run the state re-verify** (below) before trusting any fact in this file — it is a snapshot.
3. Work §5 (next actions) in order. §2 carries the facts you must not re-derive.

---

## 1. What this project is

The **v2 (1.0.0) replacement of the `@adhd/backlog` system** in `/Users/nix/dev/node/adhd`:
"one surface, one identity, no predecessor left behind" — a 14-verb CLI under a `backlog`
namespace with `uid` identity. It is **built, merged, and running in production** — but off a
temporary worktree hand-port, not the merged build. The cutover that finishes it has not happened.

---

## 2. Verified state of record (2026-09-23)

### 2.1 Three divergent lines

| Line | Head | Tree @ | Role |
|---|---|---|---|
| **A — `origin/main`** | **`4dae6ee2`** (moved during the session; the 1.0.0 squash `545d7025` is now an **ancestor**) | `.worktrees/backlog-release` (`545d7025`, `release/backlog-1.0.0`) | **intended successor** |
| **B — LIVE `fix/live-restore`** | `257b146e` | `.worktrees/restore-min` | **disposable interim hand-port** |
| **C — local `main`** | `0361798a` | primary tree `/Users/nix/dev/node/adhd` | **unpushed 3rd line** |

Merge-bases: `main↔origin/main = 0d110a50` · `main↔live = b257f715` · `live↔origin/main = b257f715`.
`main` is **3 ahead / 6 behind** `origin/main` (verified against the live remote via `git ls-remote`).

Other refs: `.worktrees/backlog-cutover` = `ab262d8f` `[cutover/frozen-build-2118d384]` (the frozen
**rollback** build) · `.worktrees/backlog-v2` = `483fe47e` `[feat/backlog-hard-replacement]` (holds
this corpus) · `.worktrees/backlog-post-merge-followups` = `969d9ca9` (**PR #13**, open+mergeable).

**Line C's 3 unpushed commits (on no other branch and no remote):**
- `50266459` — "make the RAG embedding provider lazy; consume the embedding funnel" (the funnel fix
  ported onto the pre-1.0.0 base; touches `src/store/semantic-search.ts` + package + lock)
- `fcb2f2dd` — `fix(mcp): point the backlog MCP server at the cutover build`
- `0361798a` — docs

### 2.2 What is LIVE (5 independent confirmations)

All of these resolve to **`restore-min`**, dist sha256 **`875bc2aa…`**:
the pnpm `backlog` shim · `adhd-backlog` (symlink → `@adhd/backlog` → restore-min) · `~/.claude.json`
`mcpServers.backlog` · repo `.mcp.json` · the running `serve` process.

`adhd-backlog` is a **pnpm-link to worktree source**, labelled `1.0.0`; npm's latest is **`0.1.9`**,
so **1.0.0 is unpublished**. No `~/.adhd/backlog/current`, no `releases/`. **opencode has no backlog
MCP server.** The `.worktrees/backlog-cutover` (frozen rollback) dist is `cb403ada…`.

### 2.3 Production store (live, do not mutate casually)

`~/.adhd/backlog/production/config.yaml` = `db.path: …/production/data/backlog-v2.db`,
`embedding.enabled: true`; **`migration.phase` already removed**. The store is **actively written**
(128 MB, mtime moving). Vector coverage **15.08 % missing and growing** (corpus figure — re-measure).

### 2.4 GATE-00 — the equivalence question (the one thing gating the cutover)

**Intent is resolved (HIGH confidence, primary evidence in `GATE-00-FINDINGS.md`):** the prior
dispatcher treated **A as the durable successor** and **B as disposable** ("*the durable fix later is
a full re-cutover from the reviewed branch tip*").

**And A is not missing B's work — it re-implemented it.** A **deleted** `src/store/semantic-search.ts`
and replaced the seam with `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers`, shipping:
- `src/api.semantic-laziness.spec.ts` — names *the same defect* the funnel work fixed ("*the 'empty
  vector space at startup ⇒ grep-only for the whole process lifetime' defect … the process-global …
  latch in the since-deleted `store/semantic-search.ts`*")
- `src/api.semantic-production-seam.spec.ts` — real fastembed, bge-base-en-v1.5, 768-dim
- `write/bootstrap.ts:306` — "*a rejected derive must not be latched either: evict, surface now, retry*"

**Residual (narrow, testable):** A pins `@adhd/sox-embedding-provider ^0.5.0`; B pins `^0.5.3` and
carries `b9b23aea` ("consume unref-safe service-proxy 0.4.3 + retry a rejected provider memo") which is
**not in `origin/main`**; A references `sox-service-proxy` nowhere directly.

**So GATE-00 = run A's two semantic specs on the real path, and settle the `^0.5.0` vs `^0.5.3`
rider.** Not a reconciliation project — a targeted test + a version decision.

---

## 3. The agent-config incident (why we paused)

**Defect:** 17 agent extensions (**23 source files**) pinned `model: deepseek/deepseek-v4-flash`,
which the provider **retired**. The provider now serves exactly four: **`deepseek-flash`** =
"**DeepSeek V4.1 Flash**", `deepseek-v4-flash` (retired), `deepseek-v4-flash-vision-exp`,
`deepseek-v4-pro`. **There is no `deepseek-v4.1-pro`.** This blocked **every specialist dispatch**.

**Source of truth:** `~/dev/ai/sox-ecosystem/extensions/agents/<name>/` (`<name>.md` frontmatter
carries the model; `extension.json`/`package.json`/`README.md` carry prose mentions).
**Installed copies are RENDERED, not copied** (`libs/host-registry/src/agent-renderers.ts`) — a
hand-edit to `~/.config/opencode/agents/*.md` is never durable; they must be re-rendered via the
sox install/sync surface (`sox install|update|upgrade …`, `npx tsx scripts/install.ts`).

**Hard constraint discovered:** **opencode loads agent config once at startup and does NOT
hot-reload.** Editing an agent file has no effect until a restart (proven: two dispatches failed with
the identical `Model not found` error after the file was corrected on disk).

**In flight:** a `general` task (`ses_f2fc2be17ffe7rGjI1WfQxQRYU`) was dispatched to fix all 23
source files, bump extension patch versions + changelogs, re-render/sync to
`~/.config/opencode/agents/` (and Claude's if affected), and verify. **Let it finish before
restarting.** Its report lands in the session transcript; check
`rg -n '^model:' ~/.config/opencode/agents/` to confirm independently.

**Inert stopgap:** `~/.config/opencode/agents/agent-manager.md` was hand-edited to
`model: deepseek/deepseek-flash` / `mode: all` (so it is `task()`-dispatchable). The sync should
overwrite it from the fixed source with the same result.

---

## 4. Decisions outstanding (need the user) — see `EXECUTION-STRATEGY.md` §9

| Gate | Question | Recommendation |
|---|---|---|
| **00** | Is A behaviourally equivalent to B? | Run A's 2 specs + settle the `^0.5.0`/`^0.5.3` rider |
| **01** | Publish `@adhd/backlog` 1.0.0? (PR #9 merge already done) | **Not before GATE-00**; then in the cutover window |
| **02** | Approve machine-global bin/MCP re-points? | yes — quarantine the bare `backlog`, never delete |
| **04** | Staging mechanism (`6603272a`)? | `pnpm pack` + `npm install --prefix releases/<v>` |
| **05** | Merge PR #13 before the cutover? | merge first, rebuild the release, then cut over |
| **06** | local-`main` reconciliation? | **NOT a plain `reset --soft`** — preserve line C first |
| **T3** | Acceptable vector-coverage floor? | restore to the pre-loss baseline, then hold |

---

## 5. Immediate next actions (ordered)

1. **Verify the roster** (see §0). If any agent still shows the dead id, the sync did not land.
2. **Preserve line C before anything touches `main`** (non-destructive):
   `git -C /Users/nix/dev/node/adhd branch backup/local-main-pre-reconcile 0361798a`
3. **DEF-01 — commit the untracked corpus.** Most of `report/` is **untracked**; a
   `git worktree remove` on `backlog-v2` destroys the plan. Commit `report/**` (incl. this file,
   `EXECUTION-STRATEGY.md`, `GATE-00-FINDINGS.md`) on `feat/backlog-hard-replacement`.
4. **GATE-00 verification** against **A's tree** (`.worktrees/backlog-release` @ `545d7025`):
   run `src/api.semantic-laziness.spec.ts` + `src/api.semantic-production-seam.spec.ts`; inspect the
   lockfile-resolved `@adhd/sox-embedding-provider`; decide whether the `^0.5.3` + `b9b23aea` rider
   needs porting. **One heavy task at a time.**
5. **CORE-1** — fix the config freeze (server caches `ctx.env.config.embedding` at startup, so a
   config flip is not observed). Uids `898e0bb2`, `0bc19f0f`, `205cd742`, `97c03dfd`. **Gates LIVE-1.**
6. Waves 1–3 per `EXECUTION-STRATEGY.md` §7, then the Wave-4 cutover.

---

## 6. Standing directives (non-negotiable)

- No push without approval; **commits use `--no-verify`**; `git push --no-verify` is machine-denied.
- **No destructive git**: never `reset --hard`, `stash`, `clean -f`, `checkout -- .`. Never
  `git add -A`/`git add .`/`commit -a` — stage only explicit paths (concurrent agents share the tree).
- Never `--skip-nx-cache`; never run `tsc` directly; pnpm only.
- **Production store is live**: any mutation is backup-first (`VACUUM INTO`, never plain `cp`),
  operator-invoked, re-verified, with the backup path recorded.
- Backlog items **only** via `adhd-backlog` CLI / `mcp__backlog__*`; never hand-edit `BACKLOG.md`.
- ADR-0012 (parallel-process), ADR-0013 (typed config, **never** env toggles), ADR-0014
  (report-first retention), **ADR-0020** (the embedding funnel is peer-spawned/self-reaping —
  **never "daemon"**); ADR-0015 never adopted. Catalog: `~/dev/ai/sox-ecosystem/docs/decisions/`.
- File every bug/deferral at discovery; never declare anything "pre-existing"; verify state-side;
  end every response with the unacknowledged bugs/deferrals list.
- **`gx`** indexes the primary tree only (which is on line **C**) and refuses from linked worktrees.
- A stray `rm: /Users/nix/dot/bin/node` appears in most shells — environmental, not ours.

---

## 7. Re-verify block (run to re-ground; read-only)

```bash
cd /Users/nix/dev/node/adhd
git log -1 --format='origin/main %h %s' origin/main          # expect 4dae6ee2
git rev-list --left-right --count main...origin/main          # expect 3  6
for w in restore-min backlog-release backlog-cutover backlog-v2 backlog-post-merge-followups; do
  printf '%-30s ' "$w"; git -C ".worktrees/$w" rev-parse --short HEAD; done
command -v backlog; readlink -f "$(command -v backlog)"      # expect …/restore-min/…
cat ~/.adhd/backlog/production/config.yaml                    # db.path + embedding.enabled only
gh pr view 13 --json state,mergeable
cd .worktrees/backlog-v2 && git status --porcelain | wc -l    # corpus largely untracked
rg -n '^model:' ~/.config/opencode/agents/                    # every line a live id
```

---

## 8. File map

| File | Role |
|---|---|
| **`HANDOFF.md`** (this) | **Resume entry point.** |
| `EXECUTION-STRATEGY.md` | The consolidated plan — state, workstreams, waves, gates, exit criteria. |
| `GATE-00-FINDINGS.md` | Transcript-scan evidence for the intent verdict. |
| `HANDOFF-PROMPT.md` | The original handoff (superseded). |
| `PAUSE-STATE.md` | Prior session's state of record @05:05Z (several claims stale). |
| `packets/{1..4}-*.md` | The 72 work packets (LIVE/EMBED/RSD/STORE + WAVE). |
| `packets/SEQUENCE.md` | 5-wave plan, 47 gates, 14 file lanes, findings F1–F5. |
| `packets/title-only-bodies.md` | Retrieved bodies for title-only uids. |
| `cutover-execution-plan.md` | The cutover procedure (§A–D) + the 7-bug table. |
| `cli-deployment-separation-spec.md` | Target topology / relocation / Phase 0 / runbook (§0 is stale). |
| `sox-integration-plan.md` | Cross-repo analysis; upstream gaps G1–G7 → `SOX-1..7`. |
| `deploy-verify.sh` | LIVE-1 verify harness + negative control. |
| `release-manifest-1.0.0.json` | The LIVE-1 clean-build record (`545d7025`, dist `a74a180e…`). |

---

## 9. Open bugs / deferrals (unacknowledged)

**DEF-01** corpus mostly untracked (destruction risk) · **DEF-18** A-vs-B equivalence unproven
(residual: `^0.5.0` vs `^0.5.3` + missing `b9b23aea`) · **DEF-19** line C unpushed (`50266459`) ·
**DEF-02–DEF-17** in `EXECUTION-STRATEGY.md` §4.
**This session's new findings:** opencode **does not hot-reload** agent config (a restart is required
for any agent-config change) · 17 agents pinned to the retired `deepseek-v4-flash` in the sox source
(23 files) — fix in flight · the release build (`545d7025`) is now **2 commits behind** `origin/main`
(`4dae6ee2`) · **my own process defects:** two scan agents raced on one output path, and I dispatched
the first scan at the wrong target (Claude transcripts, not opencode).

---

## 10. Session-2 work log (what changed)

**Created:** `EXECUTION-STRATEGY.md`, `GATE-00-FINDINGS.md`, `HANDOFF.md` (this).
**Edited:** `~/.config/opencode/agents/agent-manager.md` (model→`deepseek-flash`, mode→`all`; stopgap,
to be overwritten by the sync).
**Dispatched:** the sox agent-config fix + sync (`ses_f2fc2be17ffe7rGjI1WfQxQRYU`).
**No product code, no store, and no live pointer was modified.**
