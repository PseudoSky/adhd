# GATE-00 FINDINGS — Intended relationship between the live line and `origin/main`

**Scope:** read-only forensic scan of the prior orchestrator's own session transcript, stored in
`~/.local/share/opencode/opencode.db` (SQLite). No repo, git, or DB state was modified; this file is
the only write.

**Sessions scanned (ranked per the brief):**

| Label | Session id | Agent / title | Used for |
|---|---|---|---|
| **DISPATCH** | `ses_f3587fb11ffexvKr7bDBqGhs4m` | dispatcher, "Resuming backlog-v2 hygiene remediation workflow" (09-22 14:54 → 09-23 16:45) | primary intent |
| **DISPATCH-EARLY** | `ses_f35a336bbffeUPMpFCAIb7skyf` | dispatcher, "Resuming Nx upgrade plan at audit-graph state" (→ 09-23 01:04, wrote `PAUSE-STATE.md`) | corroboration |
| **RECONCILE** | `ses_f33d03b5affeQjYwBhMeJwCdV5` | subagent, "Reconcile main + follow-up PR" | Q3 |
| **MERGE-1.0.0** | `ses_f33f4ba2bffe8oECPeTpzAMMVa` | subagent, "Resolve backlog 1.0.0 merge conflicts" | Q4 |
| **PUSH-GATE** | `ses_f3436511dffe325dOS3DhNMloh` | subagent, "Push docs commit, diagnose gate" | Q4 |
| **WAVE0** | `ses_f340012f8ffent3k6CFhoHvEjI` | subagent, "Wave 0: preflight + hygiene" | Q4 |

Within DISPATCH, `role=assistant` parts are the dispatcher's **own** prose; `role=user` parts at the
same-named timestamps are **subagent task-results** delivered back to the dispatcher (they carry a
`<task_result>` wrapper). Both are labelled below. On-disk artifacts (`PAUSE-STATE.md`,
`HANDOFF-PROMPT.md`, `packets/*.md`, `EXECUTION-STRATEGY.md`) authored by these sessions are cited as
corpus, clearly marked.

---

## Q1. Why was `restore-min` / `fix/live-restore` created? Temporary hand-port to be retired, or authoritative line?

**Answer: a temporary, explicitly disposable hand-port, created to keep LIVE production working until the branch could be cut over — not the authoritative line.**

The dispatcher's own explanation is unambiguous — **DISPATCH, 2026-09-22 17:35:41 (assistant)**:

> "**The hand-port is the live-deployment fix** — a manually re-applied (ported) version of the
> branch's two critical fixes, built on top of the deployed "frozen" cutover build, because the clean
> cherry-pick wasn't constructible. … So the architect-decision verdict's fallback was: **hand-port**
> just the citation fix + a bespoke bounded probe onto that base, build, verify, deploy. … It's the
> **verified, minimal, deployable build** that fixes the live breakage now — without waiting for PR
> #9. **The durable fix later is a full re-cutover from the reviewed branch tip.** Deploy … is your
> gate."

The LIVE-1 packet, produced inside DISPATCH, names the retirement as the goal — **DISPATCH,
2026-09-22 21:35:28 ([subagent task-result] "Packets: live/deploy/CI/docs")**:

> "**LIVE-1** — Re-cutover: deploy the `feat/backlog-hard-replacement` build (via PR #9 on `main`),
> **retire the `restore-min` hand-port**, prove rollback. *(gated)*"

And in the final handoff the dispatcher restates it as the completion target — **DISPATCH,
2026-09-23 16:42:00 (assistant, `HANDOFF-PROMPT.md`)**:

> "**Cutover (LIVE-2):** production runs the merged-main build from a **worktree-independent**
> release; **the `restore-min` hand-port is retired**; publish `@adhd/backlog` 1.0.0; re-point bin +
> `.mcp.json` + `~/.claude.json`; rollback documented and rehearsed."

Corroborating corpus: `packets/1-live-deploy-ci.md:5` and `packets/4-store-criticals-waves.md:5` both
read "**Live build today:** `.worktrees/restore-min` (branch `fix/live-restore`) — a temporary
hand-port, **not** `main`." `PAUSE-STATE.md:8-9,22` (authored by DISPATCH-EARLY) treats the live fix
as landed-but-interim and the cutover as still pending on publish + re-points.

The origin dispatch queue names it as one item among many, not a line — **DISPATCH, 2026-09-22
14:54:18 (user / session resume prompt)**:

> "… review-fix batch, wave group review → push the backlog branch, sox publish 0.3.1/0.5.1,
> **restore hand-port**, deploy/contamination-cleanup/Phase 0, Waves 1–3."

**Q1 verdict: temporary hand-port, to be retired. High confidence.**

---

## Q2. Did the prior dispatcher believe `545d7025` / `feat/backlog-hard-replacement` **supersedes** the live line, or that the live line's work must be **ported/merged** into it?

**Answer: The dispatcher treated the release/branch line (`feat/backlog-hard-replacement` → PR #9 → `origin/main` @ `545d7025`) as the authoritative successor. The live line's *fixes* were hand-ported into the live build only to keep production alive in the interim — i.e. work flowed *from* the branch *to* the interim live build, with the branch as the durable destination.**

- Durable line = branch tip — **DISPATCH, 2026-09-22 17:35:41 (assistant)**: "**The durable fix later is a full re-cutover from the reviewed branch tip.**"
- Merging PR #9 is described as *closing* the split in main's favour — **DISPATCH, 2026-09-22 22:04:08 (assistant)**: "**What merging unlocks:** Wave 4 — the re-cutover (LIVE-1): **build the live binary from main, retire the `restore-min` hand-port**, and **close the "live ≠ main" split** (`42fc1822`/`46d04e3f`) that keeps biting every audit."
- The branch explicitly *deleted* the live-only surfaces and the merge resolutions chose the branch — **DISPATCH, 2026-09-22 21:02:24 ([subagent task-result] "PR #9: sync main + CI green")**: "`serve.singleton.spec.ts` | **branch** | **branch removed the serve-lock** (`af8eaf63`); main's tests drive the deleted lock"; "`stats-surface.spec.ts`, `v2/query.additional-properties.spec.ts` | **branch (deleted)** | branch retired those surfaces in `9fab4938`".

But work was **ported both directions** while live stayed up:
- Branch → live (the hand-port itself) — DISPATCH, 2026-09-22 17:35:41: quoted above.
- Live fix lifted *from* the branch — **DISPATCH, 2026-09-22 22:15:53 (assistant)**: "a bounded 30s close-time drain … (`257b146e`)" and the task-result that delivered it (22:15:30): "**Ported verbatim from the branch:** `write/embed-drain.ts`".
- Mirroring of live edits back onto the branch — **DISPATCH, 2026-09-22 20:58:58 ([subagent task-result] "Document project/component model")**: "I edited **the live build's source** and **mirrored to `feat/backlog-hard-replacement`**."
- Paired commits in both worktrees — **DISPATCH, 2026-09-22 20:01:15 ([subagent task-result] "Fix 65481b78 + suite + push PR #9")**: Part 1 `.worktrees/backlog-v2 @ feat/backlog-hard-replacement` → `49e655bc` **pushed**; Part 2 `.worktrees/restore-min @ fix/live-restore` → `4be35f10` "not pushed".

One genuine uncertainty the dispatcher *did* surface — but about **local `main`, not the live line** —
**DISPATCH, 2026-09-22 22:54:22 ([subagent task-result] "LIVE-1 prep")**:

> "Local `main` (`0361798a`) DIVERGED from `origin/main` (`545d7025`) … **Which ref is authoritative
> for the cutover?**"

That question is local-`main`-vs-`origin/main`. It is **not** "is `main` a superset of `restore-min`"
(see Q6).

**Q2 verdict: supersession — branch/main is the durable successor; live is the interim port. High confidence.**

---

## Q3. Was any reconciliation/merge/port between `fix/live-restore` and `feat/backlog-hard-replacement`/main ever planned or executed? What did "Reconcile main + follow-up PR" actually conclude?

**Answer: A *retirement* was planned (LIVE-1) and *fix-level porting* was executed in both directions, but no git merge/rebase/reconcile of the two histories ever happened. The "Reconcile main + follow-up PR" subagent reconciled a **different** divergence — local `main` (`0361798a`) vs `origin/main` (`545d7025`) — not `fix/live-restore` vs `main`.**

- Planned vehicle = retirement, not merge — DISPATCH, 2026-09-22 21:35:28 (LIVE-1, quoted in Q1); DISPATCH, 2026-09-22 16:53:45 (assistant): hand-port is "not deployed" yet and "Deploy … is your call"; the durable path is "a full re-cutover from the reviewed branch tip" (17:35:41).
- Executed = per-fix porting across two worktrees (Q2 quotes: `49e655bc`/`4be35f10`; `257b146e` "ported verbatim"; "mirrored to `feat/backlog-hard-replacement`").

**What RECONCILE (`ses_f33d03b5affeQjYwBhMeJwCdV5`) actually concluded** — its brief was
**DISPATCH, 2026-09-22 22:54:37 (user / dispatch prompt)**:

> "**CONTEXT (verified):** PR #9 squash-merged → `origin/main` = `545d7025`. The local `main` (in the
> primary tree, HEAD `0361798a`) has **diverged**: merge-base `0d110a50`; local has 3 commits …
> **JOB:** 1. Triage the 3 local-main commits against `origin/main` … 2. Prepare a follow-up PR branch
> from `origin/main` … containing the genuinely-missing work: the 4 post-squash branch commits …
> 4. **Report the local-`main` divergence** with a recommendation for reconciling the primary tree
> (do NOT execute it)."

Its final report — **RECONCILE, 2026-09-22 23:39:05 ([subagent task-result])**:

> "`git diff --stat origin/main 8a756b83` is **empty** — PR #9's squash (`545d7025`) captured the
> branch tree *exactly*, so the post-squash commits cherry-pick with zero conflicts. … **Local main is
> divergent and must NOT be used as a build/release source until reconciled** … (I did NOT execute
> it)."

The dispatcher's summary — **DISPATCH, 2026-09-22 23:39:12 (assistant)**: "**PR #13 opened**
(`chore/backlog-post-merge-followups`) … The primary tree sits on the **divergent local `main`** —
which *lacks* `.githooks/pre-push` entirely and carries the pre-1.0.0 RAG architecture. … **Treat
local `main` as do-not-build.**"

Note the divergence RECONCILE handled is local-`main` ↔ `origin/main`, not `fix/live-restore` ↔
`main`. No session in the set reconciles the live line with the release line.

**Q3 verdict: porting, yes; merge/reconcile of the two histories, never. The "reconcile" subagent addressed the local-main fork only. High confidence.**

---

## Q4. The LIVE-only src files (`semantic-search.ts`, `serve-lock.ts`, `semantic-readiness-probe.spec.ts`) — intentionally removed/replaced on the branch line, or accidentally absent?

**Answer: intentionally removed/replaced by the hard-replacement branch line (the "one surface, one identity, no predecessor left behind" rebuild). They are retained on LIVE because the live architecture still uses them — not accidentally absent from the branch.**

- `serve-lock.ts` — **DISPATCH, 2026-09-22 21:20:08 ([subagent task-result] "Invalidate pre-v2 backlog items")**: "**Serve singleton lock** (`serve-lock.ts`, `inspectServeLock`/`forceReleaseServeLock`) — **removed per STATE.md A17**"; and the merge resolution **DISPATCH, 2026-09-22 21:02:24**: "**branch removed the serve-lock** (`af8eaf63`); main's tests drive the deleted lock".
- `semantic-search.ts` — same 21:20:08 result lists it among deleted "**Old store internals** (`store/{crud,ids,mapping,structure,query,audit-log}.ts`, `ops-v1.ts`, `model.ts`, `migration-*.ts`, **`semantic-search.ts`**, `embed-queue.ts`, `mutate-metadata.ts`, `client.ts`)". The removal is confirmed directly against main — **RECONCILE, 2026-09-22 22:54:59-22:55:xx / final report 23:39:05**: "`50266459` … Patches `entrypoint/backlog/src/store/semantic-search.ts` — **a file deleted by `545d7025`** (`git cat-file -e origin/main:…semantic-search.ts` → absent). `origin/main` implements laziness at the API layer … `src/api.semantic-laziness.spec.ts`."
- `semantic-readiness-probe.spec.ts` — a **restore-min hand-port artifact**, not a branch file — **WAVE0, 2026-09-22 22:02:22 (user / dispatch prompt)**: "`ebb6a733` — the packet cites `src/store/semantic-readiness-probe.spec.ts`, **which does NOT exist** (sequencer Finding F1)". The live-only probe was introduced by the hand-port's `3500c9a0` "bespoke bounded `hasVectors` probe" (DISPATCH, 2026-09-22 17:35:41).
- The merge subagent's instruction generalizes the intent — **MERGE-1.0.0, 2026-09-22 22:14:45 (user / dispatch prompt)**: "`origin/main`'s PR #9 deliberately wiped the backlog v2 predecessor surface ("no predecessor left behind") … accept `origin/main`'s deletions (`git rm <path>`) — the #10/#12 changes to them are moot once the files are gone."

The branch's counterparts are the release-only files (per the corpus's own topology:
`src/api.semantic-production-seam.spec.ts`, `api.semantic-laziness.spec.ts`), and both lines
independently carry `src/write/embed-drain.ts`. So the LIVE-only trio reflects **two different
architectures**, with the branch's having *replaced* (not omitted) the live-only modules.

**Q4 verdict: intentional replacement on the branch line; not accidental. High confidence.**

---

## Q5. Any statement of which line is authoritative for the `@adhd/backlog` 1.0.0 publish?

**Answer: the merged-`main` / release line (`release/backlog-1.0.0` built from `545d7025`).**

- Build vehicle — **DISPATCH, 2026-09-22 22:54:22 ([subagent task-result] "LIVE-1 prep")**:
  > "Clean build of **merged-main `545d7025`** in a dedicated worktree `.worktrees/backlog-release`
  > (branch `release/backlog-1.0.0`) … Recorded source sha `545d7025…`, dist sha256 `a74a180e…`" and
  > "**Publish `@adhd/backlog` (human-gated)** — NOT run".
- End-state target — **DISPATCH, 2026-09-23 16:42:00 (assistant, `HANDOFF-PROMPT.md`)**: "…publish `@adhd/backlog` 1.0.0"; `PAUSE-STATE.md:22`: "(a) user approval to **publish `@adhd/backlog` 1.0.0**".
- The dispatcher repeatedly records the publish as awaiting the user's word on the release line — **DISPATCH, 2026-09-22 22:07:47 (assistant)**: "your two approvals — **publish `@adhd/backlog` 1.0.0** and **the machine-global re-points**".
- Caveat on the version number (not the line): the live `restore-min` build also self-reports `1.0.0`
  (MCP handshake "backlog@1.0.0", DISPATCH 2026-09-22 17:44:47), and `EXECUTION-STRATEGY.md:100`
  observes "1.0.0 is the local source's version, not a registry install — 1.0.0 is not published".
  So `1.0.0` is shared text; the *publish source* the dispatcher named is the merged-main release build.

**Q5 verdict: merged-main release line. High confidence.**

---

## Q6. Did ANYONE actually verify that the release build (`545d7025`) is a **superset** of the live build?

**Answer: NO EVIDENCE FOUND. No transcript statement, task-result, or verification artifact asserts that the merged-main build is a content/behavioural superset of the live build. The only cutover verification is one-directional (it proves the deployed binary is the merged-main build, not that main contains everything live has).**

The closest thing to a verification is the LIVE-1 rehearsal, and its assertions are about *identity*
and *latency*, not containment — **DISPATCH, 2026-09-22 22:54:22 ([subagent task-result] "LIVE-1 prep")**:

> "`deploy-verify.sh` … asserts **(a) the live bin's source is the merged-main sha and not
> restore-min's** (git-worktree HEAD, or a `BUILD-MANIFEST.json` for the post-LIVE-2 release-dir
> topology), **(b) latency ≤ 2 s**, (c) the frozen build answers; exits nonzero on failure."

The deployed script is explicitly **anti-restore-min**, never "main ⊇ live" — `deploy-verify.sh:156-157`,
`:197`:

> `fault "live dist is inside the disposable restore-min hand-port: $LIVE_DIST"`
> `fault "live build source is the restore-min hand-port sha ($RESTORE_MIN_SHA)"`

The sole successful "superset" checks in these sessions are about **apigen**, not backlog —
**DISPATCH, 2026-09-22 21:03:11 (assistant)**: "main's reviewed #11 apigen fixes win as **strict
supersets**" (and the same phrase in the 21:02:24 task-result re `apigen-core-client`/`-engine-runtime`/
`plugin-java-javalin`). A keyword sweep of both dispatcher sessions for `superset` returns **only
these apigen hits**.

Worse, the dispatcher was handed direct evidence that main is **not** a content superset of live, and
folded it into a *different* narrative:
- Main **deletes** a file LIVE depends on — RECONCILE final report, 2026-09-22 23:39:05: `semantic-search.ts` is "a file deleted by `545d7025`"; MERGE-1.0.0's brief, 22:14:45, is built entirely around "`origin/main`'s PR #9 deliberately wiped the backlog v2 predecessor surface".
- The LIVE-only set is broader than the brief's three files — the session's own topology lists **8** (per `EXECUTION-STRATEGY.md:66-67`: `semantic-search.ts` + `.spec`, `semantic-readiness-probe.spec.ts`, `semantic-provider-retry.spec.ts`, `serve-lock.ts` + `.spec`, `mutate-metadata.ts`, `rag-e2e.spec.ts`) — none of which main contains.
- The hand-port itself could not be built by cherry-picking the branch ("the clean cherry-pick wasn't constructible", 17:35:41) — the opposite of a clean superset relationship.

The dispatcher nevertheless asserted the merge would *close* the split (22:04:08, quoted in Q2). At no
point did it (or any subagent) run a "does main contain every live-only behaviour" check before naming
`545d7025` the publish/cutover source.

**Q6 verdict: no superset verification exists. The assumption is untested. High confidence in the negative.**

---

## INTENT VERDICT

**The prior dispatcher treated the release line — `feat/backlog-hard-replacement` → PR #9 → `origin/main` @ `545d7025` — as the authoritative, durable successor and the target for both the production cutover and the `@adhd/backlog` 1.0.0 publish. `restore-min` / `fix/live-restore` (`257b146e`) was an explicitly disposable interim hand-port, created to stop live breakage (latency + citation gate) and to be retired at cutover. Live-line fixes were ported into it and mirrored back to the branch, but the two histories were never merged.**

**Confidence: HIGH.** This is stated by the dispatcher in its own voice at three independent moments
(17:35:41, 22:04:08, 16:42:00 handoff) and is consistent across the packets, `PAUSE-STATE.md`, and
`HANDOFF-PROMPT.md`.

**Strongest single quote — DISPATCH, 2026-09-22 17:35:41 (assistant):**

> "**The durable fix later is a full re-cutover from the reviewed branch tip.**"

**Important boundary:** "authoritative cutover target" (intent) is **not** the same as "verified
superset" (evidence). The dispatcher's *intent* to cut over to `545d7025` matches the corpus
assumption the mission is testing — but the dispatcher never established that `545d7025` contains the
live line's consumer-visible work. Intent: yes. Verification: absent (Q6).

---

## CONTRADICTIONS

Items showing the corpus's "main is the cutover target" assumption was **unverified or knowingly
risky**, and places where the transcript's own evidence cut against it.

1. **The corpus is internally split, and the fork is explicitly flagged as unstated.** The packets
   and `HANDOFF-PROMPT.md` treat `545d7025` as the cutover target; the on-disk
   `EXECUTION-STRATEGY.md:75-77` states the premise is **unverified**: "**Consequence:** the plan's
   cutover premise ("retire `restore-min`, deploy merged-main `545d7025`") is **unverified**. Cutting
   over may regress live-only behaviour, or `main` may be the intended clean successor — **the corpus
   never establishes which.** See **DEF-18** and **GATE-00**." Its §1.1a adds: "This is the single
   most important structural fact in the program, and **no corpus document states it.**"
   (`EXECUTION-STRATEGY.md` appears to be a later/current artifact, not authored by the DISPATCH
   session; flagged as such. It is the artifact that named GATE-00.)

2. **"Merging PR #9 closes the live ≠ main split" is asserted without a containment check.**
   DISPATCH, 2026-09-22 22:04:08 (assistant): "…**close the "live ≠ main" split** (`42fc1822`/
   `46d04e3f`)". Yet the same session's evidence (MERGE-1.0.0 brief 22:14:45; RECONCILE report
   23:39:05) shows main **deleted** files the live build uses. A merge that removes live-only modules
   does not "close" a split in live's favour unless live's behaviour was first shown to be
   re-expressible in main — which was never done.

3. **The split was framed one-directionally as live "behind" the branch.** DISPATCH, 2026-09-22
   16:59:49 (deferral-cleanup-plan task-result): "`42fc1822` | **build 31 commits behind branch** | a |
   L0 deploy/restore" and "`46d04e3f` | live latency (frozen build 12–79s/query)". "Behind" implies the
   branch is the superset; it elides that the histories are **divergent siblings** (the corpus's own
   `EXECUTION-STRATEGY.md:58-63`: merge-base `b257f715`; LIVE +95 / main +10; **neither contains the
   other**). "Behind" and "divergent" are not the same claim, and only the former was ever reasoned from.

4. **The one "which ref is authoritative?" question the dispatcher raised was about a different ref.**
   DISPATCH, 2026-09-22 22:54:22 (LIVE-1 prep): "Local `main` (`0361798a`) DIVERGED from `origin/main`
   (`545d7025`) … Which ref is authoritative for the cutover?" — local-`main` vs `origin/main`.
   No equivalent question was ever asked about `restore-min` vs `origin/main`.

5. **"Reconcile main + follow-up PR" is easily mistaken for the live-vs-main reconciliation.** Its
   name and its PR (#13 "port the stranded post-squash commits") concern **local `main`** vs
   `origin/main` (RECONCILE brief 22:54:37), not `fix/live-restore`. Anyone reading the program could
   conclude the live line was reconciled, when ACTUALLY only 3 local-main commits (all judged
   superseded/rejected) and 5 branch post-squash commits were handled — the live line was untouched.

6. **The cutover's only verification is one-directional.** `deploy-verify.sh` (committed `483fe47e`,
   DISPATCH 2026-09-22 22:54:22) asserts the live binary is *not* `restore-min` (`deploy-verify.sh:156-157,197`)
   and checks latency; it never asserts `main` carries the live line's behaviour. So even a fully
   "green" cutover would not prove superset — it would only prove replacement.

7. **The hand-port's own construction proves non-superset.** It could not be assembled from the branch
   by cherry-pick ("the clean cherry-pick wasn't constructible", DISPATCH 2026-09-22 17:35:41),
   because `d4a72009` depended on the hygiene wave and `a8906d3d` conflicted with the cutover's dep
   bump. A build that cannot absorb the other's commits is, by definition, not established as a
   superset of it.

**Bottom line for GATE-00:** the prior dispatcher's *intent* aligns with "cut over to `545d7025`"
(the corpus assumption is the intended plan), but its own transcript contains **no superset
verification**, and contains explicit counter-evidence (deleted live-only modules; divergent-sibling
topology; un-cherry-pickable hand-port). The gate should not treat `545d7025` as a proven superset of
the live line on this evidence; supersession is *intended*, reconciliation is *undone*.
