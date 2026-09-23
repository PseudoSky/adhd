# EXECUTION STRATEGY — backlog-v2 remediation

**Status:** consolidation of record. **Written:** 2026-09-23 (session 2), superseding the *plan
content* of `HANDOFF-PROMPT.md`, the sequencing of `packets/SEQUENCE.md`, and the stale claims
identified in §4 below. Those files remain as history; this file is the single source of truth.

**Author role:** dispatcher/orchestrator (not plan-author). Every dispatch in this program is
governed by `AGENTS.md` (repo root) and the standing directives in §5.4.

**Why this file exists.** `HANDOFF-PROMPT.md` claimed to be self-contained but deferred all
operative detail to 11 sibling files, several of which are mutually contradictory and four of
which are **untracked** (destroyable by a worktree cleanup). This document consolidates the
verified state, the defects in the prior plan, the workstream structure, the decision register,
and the exit criteria into one file that survives context compaction.

---

## 0. READ FIRST — post-compaction contract

If you are a fresh session resuming this program:

1. Read this file top to bottom. It is deliberately self-sufficient: §1 (verified state), §6
   (workstreams), §7 (waves), §8 (critical path), §9 (decisions), §15 (exit criteria) together
   are sufficient to dispatch without re-reading the corpus.
2. **Re-run §1's verify block before acting on any state claim.** The corpus contains stale
   claims (§4); only command output is authoritative.
3. **Do not touch the `backlog-v2` worktree's untracked files until §4/DEF-01 is executed.**
   Most of the plan corpus is untracked there.
4. Work §8's critical path. Respect §5.3 (one heavy task at a time) and §10 (verification with
   teeth).
5. Nothing in this program is a `plan-state-machine` plan — there is no `dag.json`/`state.json`,
   no guard scripts, no audit states. Execution is workstream/wave/dispatch (see §5).

---

## 1. Verified state of record

Legend: ✅ = verified by command this session (2026-09-23); ◐ = corpus claim, not re-verified.

### 1.1 Git topology ✅

| Ref / tree | Value | Note |
|---|---|---|
| `origin/main` | `545d7025` — "1.0.0 — one surface, one identity (#9)", 2026-09-22 21:04 | **PR #9 is already merged.** |
| local `main` (primary tree) | `0361798a` — "docs(backlog): point DATA_MODEL_v2…", 2026-09-22 20:56 | **DIVERGED** — not an ancestor of `origin/main`. Never build from it. |
| `.worktrees/restore-min` | `257b146e` `[fix/live-restore]` | **= LIVE production build** (§1.2). |
| `.worktrees/backlog-release` | `545d7025` `[release/backlog-1.0.0]` | Clean build of merged main (see manifest, §1.4). |
| `.worktrees/backlog-cutover` | `ab262d8f` `[cutover/frozen-build-2118d384]` | Frozen OLD build = rollback target (slow baseline 12–35 s). |
| `.worktrees/backlog-v2` | `483fe47e` `[feat/backlog-hard-replacement]` | Holds the plan corpus. HEAD is on `origin/feat/backlog-hard-replacement`. |
| `.worktrees/backlog-post-merge-followups` | `969d9ca9` `[chore/backlog-post-merge-followups]` | PR #13 head. |
| **PR #13** | **OPEN + MERGEABLE**, base `main` | "port the stranded post-squash commits". |

#### 1.1a ⚠️ THE FORK — `origin/main` and the live line are divergent siblings

Verified 2026-09-23. This is the single most important structural fact in the program, and **no
corpus document states it.**

- `stable merge-base(fix/live-restore, origin/main)` = **`b257f715`** (2026-09-04).
- **LIVE is +95 commits** off that base; **`origin/main` is +10**. **Neither contains the other**
  (`git merge-base --is-ancestor` is false in both directions).
- `2118d384` ("close out the hard-replacement rollout") and `ab262d8f` (the *frozen cutover
  build* `cutover/frozen-build-2118d384`) are ancestors of **LIVE** and **not** of `main`.
- `feat/backlog-hard-replacement` (`483fe47e`, the PR #9 source) is **not** an ancestor of either.
- **Content delta, `entrypoint/backlog` only:** 85 files, **+4,094 / −15,003**.
  **Two-way `src` divergence:**
  - **LIVE-only (8):** `src/store/semantic-search.ts` + `.spec`, `semantic-readiness-probe.spec.ts`,
    `semantic-provider-retry.spec.ts`, `serve-lock.ts` + `.spec`, `mutate-metadata.ts`, `rag-e2e.spec.ts`.
  - **release-only (12):** `src/api.semantic-production-seam.spec.ts`, `api.semantic-laziness.spec.ts`,
    `cli.store-check.spec.ts`, `query/search-ranked-zero-filter.spec.ts`,
    `store/embed-drain-real-model.spec.ts`, `vocabulary-guard.ts` + `.spec`,
    `test/helpers/spawn-isolated-bin.ts` + `.spec`, `write/catalog.spec.ts`,
    `write/contract-anchors.spec.ts`.
  - Both lines independently contain `src/write/embed-drain.ts`.

**Three divergent lines exist, not two** (verified 2026-09-23, incl. an opencode-transcript scan
→ `GATE-00-FINDINGS.md`):

| Line | Head | What it is | Unique to it |
|---|---|---|---|
| **A — `origin/main`** | `545d7025` (+10 from `b257f715`) | the **intended authoritative successor**: the 1.0.0 hard replacement (PR #9) | **deletes** `semantic-search.ts`/`serve-lock.ts`, adds the `api.semantic-*` seam + `vocabulary-guard` + `spawn-isolated-bin`; 6 commits local main lacks |
| **B — LIVE `fix/live-restore`** | `257b146e` (+95 from `b257f715`) | a **disposable interim hand-port** built on the frozen cutover (`ab262d8f`), per the prior dispatcher's own words | funnel consumption, close-time drain, readiness probe, `semantic-search.ts`, `serve-lock.ts` |
| **C — local `main`** | `0361798a` (base `0d110a50`) | an **unpushed third line** — a partial *reconciliation attempt* carrying 3 commits on **no other branch** | `50266459` "make the RAG embedding provider lazy; consume the embedding funnel" (touches `src/store/semantic-search.ts` + package/lock), `fcb2f2dd` (MCP → cutover build), `0361798a` (docs) |

Merge-bases: `main↔origin/main = 0d110a50`; `main↔live = b257f715`; `live↔origin/main = b257f715`.
Line C's commits are contained by **no other branch and no remote** (`git branch -a --contains 50266459` → `main` only).

**Intent is resolved by primary evidence (HIGH) — and A's own artifacts corroborate it. A is not
*missing* B's work; it *re-implemented* it.** The opencode transcript scan (`GATE-00-FINDINGS.md`)
establishes the prior dispatcher treated **A as the durable successor** and **B as disposable**
("*The durable fix later is a full re-cutover from the reviewed branch tip*"). Verified in A's tree:
A **deleted** `store/semantic-search.ts` and replaced its seam with `write/bootstrap.ts`'s
`bootstrapSemanticStoreMembers`, shipped with **`src/api.semantic-laziness.spec.ts`** — a spec that
names *the same defect* the funnel work fixed ("*the 'empty vector space at startup ⇒ grep-only for
the whole process lifetime' defect … the process-global … latch in the since-deleted
`store/semantic-search.ts`*") — plus `src/api.semantic-production-seam.spec.ts` (real fastembed,
bge-base-en-v1.5, 768-dim) and `bootstrap.ts:306` "*a rejected derive must not be latched either:
evict, surface now, retry*".

**So the funnel/lazy fix — the "huge" one — is present in `origin/main` by a newer route, not
stranded on B or C.** The deletion of B's modules is *evidence of deliberate replacement*, not of
loss. (Correcting an earlier framing in this file, R2: deletion ≠ regression.)

**Residual risk — narrow and testable.** A pins `@adhd/sox-embedding-provider ^0.5.0`; B pins
`^0.5.3` and carries follow-up `b9b23aea` ("consume unref-safe service-proxy 0.4.3 + retry a
rejected provider memo") which is **NOT in origin/main** (`merge-base --is-ancestor` → false); A
references `sox-service-proxy` **nowhere**. The *retry* half appears re-implemented in A's
`bootstrap.ts`; the *unref-safe service-proxy 0.4.3* rider is the one concrete delta to settle.

**Consequence:** the cutover premise is **intended, and now well-corroborated**. GATE-00 shrinks
from "reconcile two histories" to **"run A's two semantic specs on the real path + settle the
`^0.5.0` vs `^0.5.3` rider delta."** Line C's `50266459` is *likely superseded* by A's replacement —
but it is on no other branch or remote and must be preserved, never dropped by a blind `reset`.

### 1.2 Live production pointers ✅ — five surfaces, all resolving to `restore-min`

| Pointer | Resolves to |
|---|---|
| `~/Library/pnpm/backlog` (the only `backlog` on PATH) | `.worktrees/restore-min/entrypoint/backlog/dist/index.js` |
| `~/.claude.json` → `mcpServers.backlog.args[0]` | same `restore-min` dist |
| `.mcp.json` → `backlog.args[0]` (tracked repo file) | same `restore-min` dist |
| `~/.config/opencode/opencode.json` | **no `backlog` MCP server** (mcp keys: agent, search, memory-server, gitnexus) ✅ |

Confirmed 2026-09-23 (supersedes an earlier "provenance unverified" note):

| Surface | Resolves to |
|---|---|
| `adhd-backlog` (canonical name) | **symlink → `~/.nvm/.../lib/node_modules/@adhd/backlog` → `.worktrees/restore-min/entrypoint/backlog`** |
| the running MCP server | `node …/restore-min/entrypoint/backlog/dist/index.js serve --transport mcp` (pid 33401, ~18 h) |

`sha256` of the canonical name's resolved bytes = **`875bc2aa…` = `restore-min`'s dist exactly**
(≠ the recorded merged-main build `a74a180e…`, ≠ `backlog-cutover`'s `cb403ada…`).
The global install is a **`pnpm link`-style symlink to worktree source** (`npm ls -g`:
`@adhd/backlog@1.0.0 -> .worktrees/restore-min/entrypoint/backlog`), with a preserved
`@adhd/backlog.bak-20260922T214041Z` → `backlog-cutover`. **So `1.0.0` is the local source's
version, not a registry install** — 1.0.0 is not published (GATE-01).

There is **no `~/.adhd/backlog/current` symlink and no `releases/` dir** ✅ — the de-worktree
target topology of `cli-deployment-separation-spec.md` §3 does not exist yet.

### 1.3 Production store (`~/.adhd/backlog/production/`) ✅

- `config.yaml` = `db.path: …/production/data/backlog-v2.db`, `embedding.enabled: true`.
  **`migration.phase` is already absent** (the cutover plan §A's removal step is done).
- `data/backlog-v2.db` = 128 MB, mtime 2026-09-22 23:38, plus a growing set of
  `*.tshm.stale-*` / `-shm.stale-*` sidecar debris (the `4b65f64e`/WAL-churn class).
- ◐ Coverage 15.08 % of vectors missing (273/1810), **growing**; embedding funnel live
  (provider 0.5.3 / service-proxy 0.4.3), peer-spawned & self-reaping (ADR-0020 — never "daemon").

### 1.4 Release manifest (`release-manifest-1.0.0.json`, tracked) ✅

`@adhd/backlog@1.0.0`, `sourceSha 545d7025…`, dist `sha256 a74a180e…`, 722,074 B, mode 755,
built from `.worktrees/backlog-release`. This is what `deploy-verify.sh` asserts against.

### 1.5 Corpus residency — **the preservation hazard** ✅

In `.worktrees/backlog-v2/entrypoint/backlog/report/`:

- **Tracked (11):** `citation-component-linking.md`, `cutover-execution-plan.md`,
  `deferral-cleanup-plan.md`, `deploy-verify.sh`, `embed-durability-fix-spec.md`,
  `jscpd-report.json`, `packets/1-live-deploy-ci.md`, `packets/title-only-bodies.md`,
  `registry-surface-redesign.md`, `release-manifest-1.0.0.json`, `sox-integration-plan.md`.
- **UNTRACKED (would be destroyed by `git worktree remove`):** `HANDOFF-PROMPT.md`,
  `PAUSE-STATE.md`, `cli-deployment-separation-spec.md`, `packets/SEQUENCE.md`,
  `packets/2-embedding-semantic.md`, `packets/3-registry-surface-data.md`,
  `packets/4-store-criticals-waves.md`, `wave-3a-semantic-adoption-spec.md`,
  `wave-3b-tx-elimination-spec.md` — **the four domain packets, the sequence, the pause state,
  the deploy spec, and both wave-3 specs.**
- Also untracked/modified in this worktree: `M AGENTS.md` (the adapted pointer),
  `?? .claude/workflows/backlog-e2e-*.{js,mjs}`, two `packages/**/CHANGELOG.md`.

### 1.6 Re-verify block (run this to re-ground; read-only)

```bash
cd /Users/nix/dev/node/adhd
git log -1 --format='%h %s' origin/main                 # expect 545d7025 1.0.0 (#9)
git log -1 --format='%h %s' main                        # expect 0361798a (diverged)
for w in restore-min backlog-release backlog-cutover backlog-v2 backlog-post-merge-followups; do
  printf '%-30s ' "$w"; git -C ".worktrees/$w" rev-parse --short HEAD; done
command -v backlog; readlink -f "$(command -v backlog)" # expect …/restore-min/…
python3 -c "import json;print(json.load(open('$HOME/.claude.json'))['mcpServers']['backlog']['args'][0])"
cat ~/.adhd/backlog/production/config.yaml               # expect db.path + embedding.enabled only
gh pr view 13 --json state,mergeable
cd .worktrees/backlog-v2 && git status --porcelain | wc -l   # expect ~19; corpus mostly untracked
```

---

## 2. The completion target (unambiguous)

The program is **five waves** (0–4), not "waves 1–3". The prior handoff's "Waves 1–3" was
inconsistent with its own target #1, because the cutover **is Wave 4**.

**Done means all of:**

| # | Target | Delivered by | Human gate? |
|---|---|---|---|
| T1 | Production runs the merged-main build from a **worktree-independent** release; `restore-min` retired; every live pointer resolves outside `.worktrees/`; rollback rehearsed. **Prerequisite: GATE-00 clears** (the release line must first be proven a superset of, or reconciled with, the live line — DEF-18) | WS-DEPLOY (Wave 4) | **yes** — publish + global re-points |
| T2 | The last live embedding defect is fixed: the server **observes a config flip**; member-less is **LOUD**; dead `enableSemanticSearchFromConfig` calls deleted; **RED→GREEN** proven | WS-C (Wave 1) | no |
| T3 | Vector coverage restored and **held** at the §6/WS-EMBED target, with the count surfaced in one health call | WS-EMBED (Wave 2) | one-line gate |
| T4 | Waves 1–3 complete per §7, respecting §5.3 and the §6 file lanes | all | per-item gates |
| T5 | The consolidated decision register (§9) walked and cleared | one pass | **yes** |
| T6 | Close-out: PR #13 merged; RSD-15 re-scope + the `c75facbf` correction; local-`main` reconciliation; corpus committed & worktrees reaped; CHANGELOG entries | WS-CLOSE (Wave 4) | **yes** for merge + reconciliation |

**Explicitly NOT in scope** (flagged, not silently dropped): `sox-integration-plan.md`'s
tx-elimination (`tx.ts`/`claim.ts`/`delete.ts`/`catalog.ts` — ~230 lines) is **blocked on new
upstream sox work** (§12, SOX-1) and is a *post-program* effort; ADR-0015 is PROPOSED/never
accepted and must not be adopted anywhere.

---

## 3. Canonical identifier scheme

The corpus overuses `G`/`D`/`F`/`L` and collides (**`G1` means two different things** —
see DEF-04). Canonical, from here on:

| Space | Form | Meaning |
|---|---|---|
| Packet | `LIVE-n`, `EMBED-n`, `RSD-n`, `STORE-n`, `WAVE-n` | the corpus's existing work packets (unchanged). |
| New live defect | `CORE-n` | the config-freeze / write-stall stream (§6/WS-C). |
| Upstream sox gap | `SOX-n` | `sox-integration-plan.md`'s G1–G7 **renamed** (§12). |
| Decision | `GATE-nn` | §9. Replaces "D1…D47", "Q1…Q8", "OWNER", "a/b/c". |
| Defect in the prior plan/corpus | `DEF-nn` | §4. |
| Verification failure | `F-nn` | per-stream verify output. |

**Bare `G1` is retired.** When a source file says "G1", resolve it by context: in `SEQUENCE.md`
it is the stalled write path → **CORE-1**; in `sox-integration-plan.md` it is the graph-store
tx-scoped primitives → **SOX-1**.

---

## 4. Defect register — what was wrong with the prior plan, and the fix

These are defects in the **plan/corpus**, not in the product. Each is fixed by this strategy or
by a named Wave-0 task.

| # | Defect | Evidence | Fix |
|---|---|---|---|
| **DEF-01** | **Most of the plan corpus is untracked** in `backlog-v2`; a routine worktree cleanup destroys the program. | §1.5 | **Wave 0, first action:** commit the untracked corpus (incl. this file) on `feat/backlog-hard-replacement`; only then may any worktree be reaped. |
| **DEF-02** | `HANDOFF-PROMPT.md` claims "self-contained" but requires 11 sibling files; four are untracked. | §1.5 | This strategy is the self-sufficient entry point; the handoff is history. |
| **DEF-03** | Live-pointer contradiction: `cli-deployment-separation-spec.md` §0/F1 says live = `backlog-cutover`; reality = `restore-min`. | §1.2 | Treat the spec's §0 as **stale** (superseded by the `restore-min` hand-port). Record only §1/§3/§4 topology, which remains valid. |
| **DEF-04** | `G1` collision (`SEQUENCE` write-stall vs `sox-integration` graph-store txs). | §3 | Canonical scheme; `CORE-1` / `SOX-1`. |
| **DEF-05** | Wave-count inconsistency ("5-wave plan" vs "Waves 1–3"; cutover = Wave 4). | §2 | Target restated over all five waves. |
| **DEF-06** | `SEQUENCE.md` D1's "approve PR #9 merge" is **already satisfied** (#9 = `545d7025`). | §1.1 | GATE-01 reduces to **publish only**. |
| **DEF-07** | `SEQUENCE.md` Wave-0 "move the three specs onto the branch" is **already done** (all three are present + tracked). | §1.5 | Wave-0 residue trimmed (§7). |
| **DEF-08** | Staging blocker (`6603272a`) left as a bare user call with no mechanism. | — | **GATE-04** adopts `cli-deployment-separation-spec.md` §3 step 1 (`pnpm pack` + `npm install --prefix releases/<v>`) as the only mechanism meeting LIVE-2's DoD; prove it with a spike before the flip. |
| **DEF-09** | Embedding coverage has **no target** ("15.08 % and growing"). | §1.3 | §6/WS-EMBED sets a measurable target; §15 makes it an exit criterion. |
| **DEF-10** | The cutover procedure (the actual re-point steps) was omitted from the handoff. | — | Incorporate `cutover-execution-plan.md` §A–C + `cli-deployment-separation-spec.md` §3 by reference; steps summarised in §11. |
| **DEF-11** | Rollback was split across three documents with no single rehearsal record. | — | §11 consolidates it; `deploy-verify.sh --negative-control` is the rehearsable proof. |
| **DEF-12** | PR #13 vs the release build unresolved: `545d7025` does **not** contain `483fe47e` (`deploy-verify.sh` + manifest). | §1.1, §1.4 | **GATE-05** — recommend merge #13 → rebuild release from the new main → then cut over; fallback: cut over at `545d7025` and land #13 after (documented, since `deploy-verify.sh`/manifest are independently available). |
| **DEF-13** | "Proceed with the rest" (gate walkthrough) is ambiguous — read literally it means proceed *unapproved*. | — | §9 explicitly splits **answerable-now** vs **needs-evidence-first**; nothing is dispatched on a deferred gate without its recommendation being confirmed. |
| **DEF-14** | `gx` refuses from linked worktrees; the corpus never says how to do impact analysis. | — | Run `gx` from the **primary tree** (`/Users/nix/dev/node/adhd`) against its index, or `npx gitnexus analyze --no-stats` first if stale. See §13. |
| **DEF-15** | Environment hazards listed with no resolution (`gx`, stray `rm`, `--no-verify` push denied, pre-push flake). | — | §13 resolves each. |
| **DEF-16** | `SEQUENCE.md` F1: the cited `semantic-readiness-probe.spec.ts` does not exist. | — | Wave-0 task: locate the real gate-undeclared spec (candidates `src/query/query.ready.spec.ts`, `src/write/bootstrap.spec.ts:194-199`) before WAVE-2 dispatch. |
| **DEF-17** | Program has no whole-program DoD. | — | §15. |
| **DEF-18** | ⚠️ **History divergence — intent resolved, equivalence unproven.** `origin/main` (A, +10) and live `fix/live-restore` (B, +95) are divergent siblings (merge-base `b257f715`). A **supersedes** B by design: A deleted B's `semantic-search.ts`/serve-lock and re-implemented laziness + the production seam, shipping specs that name the same defect (`api.semantic-laziness.spec.ts`). Still unproven: real-path behavioural equivalence, and A's `embedding-provider ^0.5.0` vs B's `^0.5.3` + `b9b23aea` (unref-safe service-proxy 0.4.3) rider — **not in origin/main**. | §1.1a (verified, R2-corrected) | **GATE-00** — run A's `api.semantic-laziness.spec.ts` + `api.semantic-production-seam.spec.ts`; settle the version rider. Blocks T1/GATE-01. |
| **DEF-19** | **Local `main` is a third, unpushed line.** `0361798a` = base `0d110a50` + **3 commits on no other branch or remote**: `50266459` "make the RAG embedding provider lazy; consume the embedding funnel" (the funnel fix ported onto the pre-1.0.0 base — **likely superseded by A's re-implementation**, but unpushed), `fcb2f2dd` (MCP → `backlog-cutover`), `0361798a` (docs). The corpus called local `main` merely "diverged / pre-1.0.0 content"; a naive `reset --soft origin/main` **strands `50266459`**. | §1.1a (verified) | **Preserve on a backup branch before any reconciliation**; classify via GATE-00; fold into GATE-06. |

---

## 5. Operating model

### 5.1 Not a state machine
No `dag.json`, no `state.json`, no per-state guard scripts, no audit hold points. Execution is:
**workstream → wave → dispatch → verify → ledger.** Progress is tracked in the §7 wave table and
the append-only run ledger (§5.5), not in a runtime state file.

### 5.2 Roles
- **Orchestrator (this agent):** chooses workstream/executor/tier, assembles self-contained
  dispatch prompts, verifies **state-side** (git refs, script exit codes, store reads — never a
  summary), and owns the ledger.
- **Executors:** the roster in `AGENTS.md`/the dispatcher agent (typescript, backend, refactor,
  debug, performance, test, review, product, researcher; plus `architect` for spec production and
  `architect-decision` for one-shot verdicts).
- **Sox owner:** a *separate* dispatcher in `/Users/nix/dev/ai/sox-ecosystem` — cross-repo
  packets cannot start on this repo's dispatch alone (§12).

### 5.3 Machine constraint — one heavy task at a time
Observed load ~258 from other agents' suites. Heavy = any `nx build`/`nx test`/`nx affected`,
sox build/publish, real-model run, packed-consumer harness, live-store sweep. **At most one heavy
task in flight.** Light work (graph transitions, doc/type-only edits, spikes, reads) pipelines
around it. This is the binding constraint on wall-clock, not the gate count.

### 5.4 Standing directives (non-negotiable)
- No push without approval; **commits use `--no-verify`** (the packet Tests are the only gate);
  `git push --no-verify` is machine-denied (DEF-15).
- **No destructive git**: never `reset --hard`, `stash`, `clean -f`, `checkout -- .`.
- Never `--skip-nx-cache`, never run `tsc` directly, pnpm only.
- **Production store is live**: any mutation is backup-first (`VACUUM INTO`, never plain `cp`),
  operator-invoked, re-verified, backup path recorded.
- Backlog items **only** via `adhd-backlog` CLI / `mcp__backlog__*`; never hand-edit `BACKLOG.md`.
- ADR-0012 (parallel-process), ADR-0013 (typed config, **never** env toggles), ADR-0020
  (peer-spawned/self-reaping — **never "daemon"**), ADR-0014 (report-first retention);
  ADR-0015 never adopted. Catalog: `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (verified present).
- File every bug/deferral at discovery; **never** declare anything "pre-existing"; verify
  state-side; end every response with the unacknowledged bugs/deferrals list.

### 5.5 Run ledger
Append-only `report/RUN-LEDGER.md` (create at first dispatch): one row per dispatch —
`date · wave · workstream · item id · executor · model/effort · exit/evidence · outcome · notes`.
Evidence column cites the command + its exit code, never prose.

---

## 6. Workstreams

Each workstream is a bounded body of work with one DoD, one verify method, and one owner lane.
Packet ids reference the corpus (`packets/*.md`); read the packet for scope before dispatch.

### WS-0 — Hygiene (Wave 0; light; parallel; no gates)
- **DEF-01:** commit the untracked corpus (first action).
- Title-only item bodies retrieved live before their packets (`packets/title-only-bodies.md`).
- One graph-transition pass: RSD dispositions table + WAVE-3 §6 close list (one owner, not split).
- Gate-hygiene reds: `cd34ba0d` (comment reword) + **DEF-16** (locate the real undeclared spec).
- Draft the hybrid-search ADR (G6/SOX-5 precondition).
- **LIVE-9** — already collapsed to a pointer (no work).

### WS-C — Live embedding defect / config freeze (Wave 1; **gates T1**; no gate)
- **CORE-1** — root-cause + fix the stalled server write path: `startBacklogServer` freezes
  `ctx.env.config.embedding` at startup (`server.ts:776/842` vs `cli.ts:640`); silent member-less
  derive (`bootstrap.ts:256`); no-op gate (`embedding-observer.ts:148-149`). Uids
  `898e0bb2`, `0bc19f0f`, `205cd742`, `97c03dfd`.
- **CORE-2** — member-less must be **LOUD** when enabled; delete the dead
  `enableSemanticSearchFromConfig` calls.
- **CORE-3** — RED→GREEN proof: start disabled → flip → MCP-create asserts no audit row; restart
  → asserts it appears. (Fix is config-fingerprinted cache **or** on-open detect+backfill.)
- **DoD:** `deploy-verify.sh` still green; CORE-3's RED and GREEN runs recorded.
- **Blocks:** LIVE-1 (do not ship the re-cutover before CORE-1 lands).

### WS-EMBED — Embedding truth (Wave 2; delivers T3)
- `adhd` lane: **EMBED-1** (+ G4 `287c301e`) — the fix for the 15.08 % loss — then **EMBED-2** →
  **EMBED-4** (+ G3 `ce98c6c3`); **EMBED-6**; **EMBED-12** (after RSD-4).
- `sox` lane (cross-repo, §12): **EMBED-3**, 7, 8, 9, 10, 11, 13, 14, 15, 16.
- **Target (T3):** un-vectorized live count detected & swept (bounded/resumable/audited) on the
  first enabled open; coverage surfaced in **one** health call; a second sweep is a no-op. Numeric
  floor set at dispatch after EMBED-3's probe lands (gate GATE-14/D10 sets the age threshold N≈10 min).
- **Gates:** EMBED-1 auto-sweep (GATE-08), EMBED-2 table-vs-node (GATE-09), EMBED-3 age N
  (GATE-10), EMBED-5 live repair (GATE-11), EMBED-7 lock path (GATE-12), EMBED-15 threshold 0.65
  (GATE-13).

### WS-STORE — Store/schema correctness (Waves 1, 4; cross-repo)
- **STORE-1..12, 15, 16** in `sox-ecosystem` (`libs/**`). **STORE-13** first (unblocks 15/16).
  **STORE-14** (live store sweep) after 1/10/13 — backup-first, owner-gated.
- **DoD:** the store-adapter 0.10.0 SPEC's §7/§8 arms, incl. the two-process WAL harness
  (`1a95227b`).
- **Gates:** STORE-1 publish (GATE-15), STORE-2/3/4 (GATE-16/17/18), STORE-11 pin (GATE-20),
  STORE-14 live repair (GATE-21), STORE-15 `--apply` (GATE-22).

### WS-SURFACE — Registry / linking / surface (Wave 3)
- **RSD-1..26** in `adhd`; specs `registry-surface-redesign.md` (SPEC-REG) + `citation-component-linking.md` (SPEC-LINK).
- Order: `RSD-2 → RSD-3 → RSD-4 → RSD-25`; `RSD-5 → RSD-6 → {7,8,10}`;
  `RSD-11 → RSD-12 → RSD-9`; then the surface batch; `RSD-15` spike-first.
- **Gates:** SPEC-REG Q1 (GATE-23, blocks the wave), Q2–Q8, SPEC-LINK Q1–Q6, OWNER×8,
  **C13** 14-vs-15-verbs (GATE-24, must clear **before** RSD-3 freezes the surface).

### WS-DEPLOY — Cutover / de-worktree (Wave 4; delivers T1; human-gated)
- **LIVE-1** (re-cutover) → **LIVE-2** (de-worktree) → **LIVE-10** (post-cutover config);
  **LIVE-4** (publish gate), **LIVE-5** (exec-bit/assets), **LIVE-3** (sync-global honesty),
  **LIVE-11** (pre-commit hygiene), **LIVE-8** (docs/skill truth), **LIVE-6** (CI), **LIVE-7**
  (packed-consumer e2e).
- **Verify:** `deploy-verify.sh` (see §10). **Never** ship LIVE-1 before CORE-1.
- **Gates:** GATE-01 (publish), GATE-02 (global re-points), GATE-04 (staging mechanism),
  GATE-05 (PR #13), LIVE-6 a/b/c (GATE-25/26/27).

### WS-CLOSE — Close-out (Wave 4; delivers T6; human-gated)
- PR #13 merge; RSD-15 packet re-scope + `c75facbf` correction;
  local-`main` reconciliation (backup branch → `reset --soft origin/main`, **never** hard reset);
  corpus committed (DEF-01) + worktrees reaped; CHANGELOG entries.
- **Gates:** GATE-05, GATE-06 (local main), GATE-28 (worktree reap list).

---

## 7. Wave plan

| Wave | Content | Heavy | Gates | Done when |
|---|---|---|---|---|
| **0** | DEF-01 corpus commit; title-only bodies; graph transitions; gate-hygiene reds; F1 locate; ADR draft | none | — | corpus tracked; reds closed |
| **1** | WS-C (CORE-1..3) ‖ WS-STORE 1→4 ‖ WAVE-1 → EMBED-5 → EMBED-1 ‖ STORE-13 ‖ STORE-14 | serialized | 15–21 | CORE-3 red/green; STORE-1 published |
| **2** | WS-EMBED 1→2→4; EMBED-6; EMBED-12; sox EMBED-3/7–16 | real-model specs | 08–14 | coverage target met; health-in-one-call |
| **3** | WS-SURFACE RSD-*; LIVE-3/5/6/7/8; WAVE-2; G8 | `nx backlog:test` per change | 23–27 | surface frozen at 14 verbs (or GATE-24's answer) |
| **4** | WS-DEPLOY LIVE-1→2→10; LIVE-4; G5 cleanup; STORE-14 re-verify; PR #13; reconcile; reap; CHANGELOG | cutover window | 01–06, 21, 28 | T1 + T6 |

**File lanes (§2.3 of `SEQUENCE.md` — preserve verbatim).** 14 contended files, e.g.
`cli.ts` (EMBED-5 → EMBED-1 → EMBED-2/4 → RSD-3 → RSD-16/17/26 → RSD-25);
`.github/workflows/ci.yml` (LIVE-6 → WAVE-2); `src/write/create-issue.ts` (WAVE-1 → EMBED-6 →
RSD-20 → RSD-7); `src/write/catalog.ts` (WAVE-1 → RSD-5 → RSD-1 → RSD-10). **Never parallelise
same-lane packets.**

---

## 8. Critical path

```
WS-0 (corpus commit) ──┐
                       ├─► CORE-1 ──► [GATE-00 reconcile] ──► LIVE-1 (re-cutover, gated) ──► LIVE-2 ──► LIVE-10 ──► T1
STORE-13 ─► STORE-1 ───┘                     ▲
   └─► adapter pin bump ─────────────────────┘
EMBED-3 ─► EMBED-2 ─► EMBED-4 ──► T3
WAVE-1 ─► EMBED-5 ─► EMBED-1 ───┘ (Embedding truth)
```

**GATE-00 sits on the critical path to T1** — the reconciliation diff is not optional and not
parallelisable with the cutover. Code waves (1–3) proceed independently of it.

**Immediately startable, ungated (Wave 0/1):** DEF-01 commit · CORE-1 debug · LIVE-5 ·
STORE-13 (sox owner) · RSD-15 spike · WAVE-1 · EMBED-6 · EMBED-5.
**Hard blockers:** CORE-1 → LIVE-1; STORE-1 publish → adapter pin bump; GATE-23 (Q1) → the whole
registry wave; GATE-24 → RSD-3 freezing the surface; **the human publish/re-point gates → T1.**

---

## 9. Decision register (consolidated)

The corpus's 47 gates collapse, after dedupe, into: **answerable now** (recommend a default, walk
in one pass) and **evidence-first** (defer until the named evidence exists). Each replaces its
corpus label in parentheses.

### 9.1 Answerable now — walk in one pass (recommendation in **bold**)

| GATE | Question | Recommendation | Corpus ref |
|---|---|---|---|
| **00** | ⚠️ **Is `origin/main` (A) behaviourally equivalent to the live line (B)?** Intent = A supersedes B, now **corroborated** — A deleted B's `semantic-search.ts` and re-implemented laziness + the production seam (`src/api.semantic-laziness.spec.ts` names the same defect; `src/api.semantic-production-seam.spec.ts` drives the real fastembed stack). **Residual:** A pins `embedding-provider ^0.5.0`; B pins `^0.5.3` and carries `b9b23aea` (unref-safe service-proxy 0.4.3 + rejected-provider retry), **not in origin/main**. | **run A's two semantic specs on the real path**, and **settle the `^0.5.0` vs `^0.5.3` rider delta** before publish/cutover. No longer a reconciliation project — a targeted test + a version decision. | DEF-18, DEF-19, §1.1a, `GATE-00-FINDINGS.md` |
| **01** | Publish `@adhd/backlog` 1.0.0? (PR #9 merge already done — DEF-06) | **not until GATE-00 clears**; then publish **in the Wave-4 window** | SEQUENCE D1 |
| **02** | Approve machine-global bin + MCP re-points (quarantine bare `backlog`, add opencode's missing MCP)? | **yes** — rename, never delete; keep last N releases | D2 |
| **03** | `.prettierrc`: `printWidth:100` + ignore generated? | **both**; do not commit a lock rewrite | D3 |
| **04** | Staging mechanism (`6603272a`)? | **`pnpm pack` + `npm install --prefix releases/<v>`** (spec §3 step 1) — spike to prove self-contained | DEF-08 |
| **05** | Merge PR #13 before the cutover? | **merge first**, rebuild release, then cut over | DEF-12 |
| **06** | Local-`main` reconciliation? | **NOT a plain `reset --soft origin/main`.** Local `main` carries **3 unpushed commits on no other branch**, incl. `50266459` — the only funnel-on-main port (DEF-19). **Preserve them on a backup branch first**, then reconcile; classify `50266459`/`fcb2f2dd` as superseded-or-must-port via GATE-00. | PAUSE-STATE 4 + DEF-19 |
| **07** | CUDA on CI (LIVE-6) | **provision CPU EP, do not disable** (ADR/§7) | D4 |
| **08** | EMBED-1 auto-sweep on enable? | **auto-sweep**, bounded/resumable/audited, no toggle | D8 |
| **09** | EMBED-2 health record: table vs node? | **dedicated `_backlog_health` table** | D9 |
| **11** | EMBED-5 run repair on the **live** store? | **yes**, bounded + reported + after `VACUUM INTO` | D11 |
| **13** | EMBED-15 cluster threshold | **0.65** (measured); typed constant | D13 |
| **15** | STORE-1 sox 0.10.0 minor + changeset (+ C14 scope)? | **ship as specced**; fold `1c9e40d5`, split `06922862` to 0.10.1 | D40 |
| **16** | STORE-2 quiescence-lock primitive | **reuse `store-lease` claim machinery** (one lock implementation) | D41 |
| **17** | STORE-3 id/count invariant level | **detect in adapter, enforce in consumer** | D42 |
| **18** | STORE-4 migration playbook location | **`store-adapter/README` + linked playbook** | D43 |
| **20** | STORE-11 / LIVE-10 pin `@tursodatabase/database` exact | **coordinate; pin exact** | D44 |
| **21** | STORE-14 authorise a live repair? | **backup + read-only sweep now; repair only on approval** | D45 |
| **22** | STORE-15 enable `snapshot-gc --apply`? | **yes, once restore is proven for the full set** | D46 |
| **23** | SPEC-REG **Q1**: 14 verbs (A) vs ~18 (B) — **blocks the registry wave** | **A** | D14 |
| **24** | C13: `restore`/`hard_delete` as verbs (15) vs admin actions (14) — must clear **before** RSD-3 | **admin actions (stay 14)** | D27 |
| **25** | LIVE-6 DeepSource red | **fix the `return`s at source**, never game `.deepsource.toml` | D5 |
| **26** | LIVE-10 keep `migration.phase` removed? | **yes** (already removed — verified) | D7 |
| **28** | Worktree reap list (~50 registered, many stale `agent-*`/`burn-*`) | **reap only after DEF-01**; preserve `restore-min` until LIVE-2, `backlog-cutover` until rollback retired, `backlog-release`, `backlog-v2` | DEF-01/§13 |

### 9.2 Recommend-defaults, low blast radius (confirm in the same pass)
SPEC-REG Q2–Q8 (one generic `registry-upsert`; refuse-if-referenced; `(root)` never deletable;
replace `get --registry`/`query --view`; `lookup` stays top-level; hard cut vs alias; **hard cut**).
SPEC-LINK Q1–Q6 (add `implicatesComponent`; bounded auto-discovery; human upsert merges + clears
`metadata.discovered`; refuse on delete; path-less project **fails**; direction **issue→component**).
RSD-11…RSD-26 OWNER questions (normalize-on-write + alias; derive from workspace/git; approve
report-first orphan cleanup; normalize data **and** filters; require reporter/author on new writes +
`legacy-import` sentinel; **defer** hierarchical rollup + plugin system; backlog-local snapshotting
first; retire `APIGEN_IR_CACHE_ENABLED`).

### 9.3 Evidence-first (do not decide until the named evidence exists)
| GATE | Defer until | Then decide |
|---|---|---|
| **10** | EMBED-3's coverage probe lands | EMBED-3 age threshold N (rec. ~10 min) |
| **12** | EMBED-7's lock-path inspection | lock home + last-writer scope |
| **14** | EMBED-15's measurement | cluster threshold confirmation |
| **19** | STORE-9's dist check | whether ADR-0017/BUG-032 is already fixed (close with evidence) |

**Rule (DEF-13):** a deferred gate is never dispatched past on the strength of "proceed with the
rest". Its recommendation is confirmed first, or the item waits.

---

## 10. Verification architecture

**Template** (generalise `deploy-verify.sh`, which is the reference implementation):

1. **A DoD expressed as observable assertions**, not prose.
2. **A committed verify script** under `report/` (or the package's own target), exiting non-zero
   on failure, keyed on **exit codes** (never `| grep -q passed`).
3. **A negative control that proves the assertion has teeth** — e.g. `deploy-verify.sh
   --negative-control` flips the bin to the frozen build and requires the latency check to go RED,
   then restores the pointer via an `EXIT/INT/TERM` trap.
4. **A load-immune fallback** where the box is contended (the live build must be ≥3× faster than
   the frozen one; still RED when the bin *is* the frozen build).
5. **A recorded run** (RED before, GREEN after) in the run ledger + the packet completion note.

**Existing assets to reuse, not rebuild:** `deploy-verify.sh` (LIVE-1), the two-process WAL
harness `1a95227b` (STORE-1/2/3), `cross-process-write-safety.spec.ts` (AC-22), the real-model
seam spec EMBED-12, `tools/gate/embedding-usage-gate.mjs`.

**Rule:** green unit tests are not proof. Every behavioural DoD must drive the **real entrypoint**
(built bin / loaded MCP tool), assert a **consumer-visible** outcome, and **fail if the bug is
reintroduced**. A default-running test that can silently skip is a defect (AGENTS §7).

---

## 11. Rollback & safety

**Cutover rollback (single switch):** `~/.adhd/backlog/current` → previous release dir, or
restore the quarantined `backlog` shim. **The store is never touched by relocation** — it is pinned
by `production/config.yaml` — so rollback is instantaneous and data-safe. Pre-move: `VACUUM INTO`
backup of `backlog-v2.db` as a belt-and-braces gate (`cutover-execution-plan.md` §B4/B5;
`cli-deployment-separation-spec.md` §3 Rollback).

**Rehearsal:** `EXPECTED_SHA=545d7025… FROZEN_DIST=.worktrees/backlog-cutover/…/dist/index.js
node entrypoint/backlog/report/deploy-verify.sh --negative-control` — must show the frozen bin
going RED (≥12 s) and the pointer restored exactly. Record the run.

**Production-store safety:** every mutation is `VACUUM INTO` backup-first (plain `cp` loses recent
WAL writes — `aa70a2c2`), operator-invoked (ADR-0013 D4), re-verified with `integrity_check` +
a sentinel read, with the backup path recorded.

**Never:** `git worktree remove` on `backlog-v2` before DEF-01; `pnpm link -g` from any worktree
(the mechanism that created the F1 breakage); re-run the ETL while a write is in flight.

---

## 12. Cross-repo workstream (sox-ecosystem)

`/Users/nix/dev/ai/sox-ecosystem` (verified present) is a **separate repo with a separate
owner-dispatch**. These cannot start on this repo's dispatch alone:

- **adhd-side blocked on sox:** STORE-1..12, 15, 16; EMBED-3, 7, 8, 9, 10, 11, 13, 14, 15, 16;
  LIVE-4 (partly), LIVE-10; the G5 contamination cleanup.
- **Upstream gaps (renamed from `sox-integration-plan.md`'s G1–G7):**

| ID | Repo/package | Gap | Effect |
|---|---|---|---|
| **SOX-1** | `sox-graph-store` | expose tx-scoped primitives (`transaction(fn,{mode})` or `*InTx`) | unlocks the ~230-line tx elimination — **post-program**, not this target |
| **SOX-2** | `sox-store-adapter` | export combined `isBusyOrContention(err)` | dedupe error classification |
| **SOX-3** | `sox-hybrid-search` | accept `isSuperseded`/NodeFilter passthrough | kills `dropSupersededResults` + over-fetch |
| **SOX-4** | `sox-graph-store` | fix `migrateToOpenSchema` Turso refusal + `nodeNeedsRebuild` | cutover hardening |
| **SOX-5** | `sox-semantic` | publish 0.1.5 (optional-loadability) + close hybrid-search residual | blocks the semantic adoption (wave-3a) |
| **SOX-6** | graph/vector/hybrid | empty-ids conflation fix | ADR-0017 conformance |
| **SOX-7** | `sox-graph-store` | `SortField` joined-edge column | optional; only if in-memory sort dies |

**Verified version skew (2026-09-22, ◐):** backlog declares `sox-graph-store ^0.10.0` but the
worktree resolves **0.9.2** (main repo 0.8.6). **The declared range is unsatisfied** — a lockfile
re-install is the first prerequisite of the sox track.

**Coordination:** each sox publish is a release-train window; batch sox packets per window
(SEQUENCE §4: `store-adapter` in one changeset; provider/memory-core per EMBED-13).

---

## 13. Environment hazards → resolutions

| Hazard | Resolution |
|---|---|
| `gx` refuses from linked worktrees | Run `gx` (gitnexus MCP) from the **primary tree**; it indexes that tree. If stale: `npx gitnexus analyze --no-stats`. |
| Stray `rm: /Users/nix/dot/bin/node` in most shells | Not from our commands — an environment artifact. **Flag once in the ledger; do not chase.** File it as an env bug if it recurs at cutover. |
| Pre-push flakes under load (`2f117762`) | Prefer a quiet window; `git push --no-verify` is machine-denied — do not attempt it. |
| `--no-verify` on commits | **Intended** (packet Tests are the gate); it is the *push* flag that is denied. |
| Memory MCP may be `backend unavailable` | Retry once; the disk handoff is authoritative. Degrade silently — never block the loop. |
| ~50 registered worktrees (stale `agent-*`, `burn-*`) | Reap **only after DEF-01**; preserve the five named in GATE-28. |
| `backlog-v2` holds untracked corpus | **DEF-01 — commit before any cleanup.** |
| Production store sidecar churn (`*.tshm.stale-*`) | ADR-0014 report-first; never auto-delete; STORE-14 records the count. |

---

## 14. Open questions for the user

1. **GATE-01** — publish `@adhd/backlog` 1.0.0 (the only remaining half of D1; #9 is merged)?
2. **GATE-02** — approve the machine-global bin/MCP re-points?
3. **GATE-04** — confirm `pnpm pack` + `npm install --prefix releases/<v>` as the staging
   mechanism (with the spike as the proof)?
4. **GATE-05** — merge PR #13 before the cutover (recommended) or after?
5. **GATE-06** — approve the local-`main` reconciliation (`reset --soft origin/main`)?
6. **T3** — the acceptable vector-coverage floor (recommend: restore to the pre-loss baseline,
   then hold; EMBED-3's probe supplies the exact number).
7. Any objection to the standing directive set in §5.4?

---

## 15. Exit criteria (program DoD)

- **E1** — `deploy-verify.sh` (default mode) PASSes against the live bin; the negative control
  reproduces RED then restores the pointer exactly.
- **E2** — `rg '\.worktrees/' ~/.claude.json .mcp.json ~/.config/opencode/opencode.json
  "$(command -v adhd-backlog)"` → **no matches**; `command -v backlog` → nothing.
- **E3** — a real `adhd-backlog backlog create` + read-back succeeds against the production store
  via **both** the bin and a loaded `mcp__backlog__*` tool; the store mtime is unchanged by reads.
- **E4** — WS-C's RED/GREEN proof recorded; the server observes a config flip.
- **E5** — vector coverage at/above the T3 floor, surfaced in one health call; a second sweep is a
  no-op.
- **E6** — Waves 1–3 complete per §7 with each packet's committed verify script green.
- **E7** — the §9 decision register walked; every cleared gate's outcome recorded in the ledger.
- **E8** — PR #13 merged; local `main` reconciled with a backup branch; the corpus committed;
  the reap list executed; CHANGELOG entries written; no orphaned dispatch.
- **E9** — `git status --porcelain` in every touched worktree accounted for.
- **E10** — **GATE-00 discharged:** the `origin/main` ↔ live-line reconciliation diff is classified
  and recorded; the release line is either proven a superset of the live line or carries every
  `must-port` delta; **no publish or cutover happened before this**. (DEF-18)

---

## 16. File map

| File | Role |
|---|---|
| **`EXECUTION-STRATEGY.md`** (this) | **Single source of truth.** Entry point post-compaction. |
| `HANDOFF-PROMPT.md` | History — superseded by this file (DEF-02). |
| `PAUSE-STATE.md` | State of record @05:05Z; superseded by §1 (several claims stale). Untracked. |
| `packets/SEQUENCE.md` | Wave plan + 47 gates + 14 lanes + findings F1–F5. Untracked (**commit, DEF-01**). |
| `packets/1-live-deploy-ci.md` | WORK PACKETS: LIVE-1…11. Tracked. |
| `packets/2-embedding-semantic.md` | WORK PACKETS: EMBED-1…16. Untracked. |
| `packets/3-registry-surface-data.md` | WORK PACKETS: RSD-1…26 + item snapshot. Untracked. |
| `packets/4-store-criticals-waves.md` | WORK PACKETS: STORE-1…16 + WAVE-1…3. Untracked. |
| `packets/title-only-bodies.md` | Retrieved bodies for title-only uids. Tracked. |
| `cutover-execution-plan.md` | The cutover procedure (§A–D) + the 7-bug table. Tracked. |
| `cli-deployment-separation-spec.md` | Target topology (§1), relocation (§3), Phase 0 (§4), runbook (§6). Untracked; §0/F1 **stale**. |
| `sox-integration-plan.md` | Cross-repo analysis + upstream gaps G1–G7 → **SOX-1..7**. Tracked. |
| `embed-durability-fix-spec.md` | The landed drain fix (segments A–G) + test plan. Tracked. |
| `wave-3a-semantic-adoption-spec.md` | `sox-semantic` adoption (waits SOX-5). Untracked. |
| `wave-3b-tx-elimination-spec.md` | tx elimination (waits SOX-1; **post-program**). Untracked. |
| `deploy-verify.sh` | The LIVE-1 verify harness + negative control. Tracked. |
| `release-manifest-1.0.0.json` | The LIVE-1 clean-build record. Tracked. |
| `RUN-LEDGER.md` | Created at first dispatch (§5.5). |

---

*Consolidated from the four domain packets, `SEQUENCE.md`, `cutover-execution-plan.md`,
`cli-deployment-separation-spec.md`, `sox-integration-plan.md`, the wave-3 specs, and a
read-only verification pass over git, the live pointers, and the production config (2026-09-23).
No product code, store, or live pointer was modified in producing this document.*

*Revision 2 (2026-09-23, after a challenge to the live-pointer claims): re-verified **all live
surfaces** (shim, canonical symlink, both MCP registrations, and the running serve process) →
`restore-min`, sha `875bc2aa…`; and established the **`origin/main` ↔ live-line fork** (§1.1a,
DEF-18, GATE-00), which the first revision under-reported. GATE-00 is now a blocking gate on the
path to T1.*
